#!/usr/bin/env python3
"""Review root-level food images in a browser and add them to the site."""

from __future__ import annotations

import argparse
import html
import json
import os
import re
import shutil
import struct
import subprocess
import tempfile
import threading
import urllib.parse
import webbrowser
from datetime import date, datetime
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent
IMAGES_DIR = REPO_ROOT / "images"
CATALOG_PATH = REPO_ROOT / "js" / "catalog.js"
IMAGE_EXTENSIONS = {
    ".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif",
    ".bmp", ".tif", ".tiff", ".heic", ".heif",
}
CATEGORIES = ("Seafood", "Baking", "Drinks", "Vegetarian", "All")
CATALOG_PREFIX = "window.RITVIK_CATALOG = "


def root_images() -> list[Path]:
    """Return image files located directly in the repository root."""
    return sorted(
        (
            path for path in REPO_ROOT.iterdir()
            if path.is_file() and path.suffix.lower() in IMAGE_EXTENSIONS
        ),
        key=lambda path: (path.stat().st_mtime, path.name.lower()),
    )


def clean_filename_part(value: str, *, ingredient: bool = False) -> str:
    value = value.replace("_", " ").replace("/", " ").replace("\\", " ")
    if ingredient:
        value = value.replace("-", " ")
    value = re.sub(r"[\x00-\x1f<>:\"|?*]", "", value)
    return re.sub(r"\s+", " ", value).strip().strip(".")


def parse_ingredients(value: str) -> list[str]:
    return [
        cleaned
        for part in re.split(r"[,\n]+", value)
        if (cleaned := re.sub(r"\s+", " ", part).strip())
    ]


def jpeg_dimensions(path: Path) -> tuple[int, int] | None:
    with path.open("rb") as source:
        if source.read(2) != b"\xff\xd8":
            return None
        while True:
            byte = source.read(1)
            while byte == b"\xff":
                byte = source.read(1)
            if not byte:
                return None
            marker = byte[0]
            if marker in {0xD8, 0xD9}:
                continue
            length_data = source.read(2)
            if len(length_data) != 2:
                return None
            segment_length = struct.unpack(">H", length_data)[0]
            if marker in {
                0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7,
                0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF,
            }:
                data = source.read(5)
                if len(data) != 5:
                    return None
                height, width = struct.unpack(">HH", data[1:])
                return width, height
            source.seek(max(segment_length - 2, 0), os.SEEK_CUR)


def standard_dimensions(path: Path) -> tuple[int, int] | None:
    """Read dimensions for common formats without third-party packages."""
    try:
        with path.open("rb") as source:
            header = source.read(32)
        if header.startswith(b"\x89PNG\r\n\x1a\n") and len(header) >= 24:
            return struct.unpack(">II", header[16:24])
        if header[:6] in {b"GIF87a", b"GIF89a"} and len(header) >= 10:
            return struct.unpack("<HH", header[6:10])
        if header.startswith(b"BM") and len(header) >= 26:
            width, height = struct.unpack("<ii", header[18:26])
            return abs(width), abs(height)
        if header.startswith(b"\xff\xd8"):
            return jpeg_dimensions(path)
    except (OSError, struct.error):
        return None
    return None


def image_dimensions(path: Path) -> tuple[int, int] | None:
    dimensions = standard_dimensions(path)
    if dimensions:
        return dimensions

    # macOS can identify formats such as HEIC, TIFF, WebP, and AVIF.
    try:
        result = subprocess.run(
            ["sips", "-g", "pixelWidth", "-g", "pixelHeight", str(path)],
            capture_output=True,
            check=True,
            text=True,
        )
        width_match = re.search(r"pixelWidth:\s*(\d+)", result.stdout)
        height_match = re.search(r"pixelHeight:\s*(\d+)", result.stdout)
        if width_match and height_match:
            return int(width_match.group(1)), int(height_match.group(1))
    except (FileNotFoundError, subprocess.CalledProcessError):
        pass
    return None


def load_catalog() -> list[dict]:
    text = CATALOG_PATH.read_text(encoding="utf-8").strip()
    if not text.startswith(CATALOG_PREFIX) or not text.endswith(";"):
        raise ValueError(f"Unexpected catalog format in {CATALOG_PATH}")
    catalog = json.loads(text[len(CATALOG_PREFIX):-1])
    if not isinstance(catalog, list):
        raise ValueError("Catalog data is not a list")
    return catalog


def write_catalog(catalog: list[dict]) -> None:
    content = f"{CATALOG_PREFIX}{json.dumps(catalog, indent=2, ensure_ascii=False)};\n"
    CATALOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        "w",
        encoding="utf-8",
        dir=CATALOG_PATH.parent,
        prefix=".catalog-",
        suffix=".tmp",
        delete=False,
    ) as temporary:
        temporary.write(content)
        temporary_path = Path(temporary.name)
    temporary_path.replace(CATALOG_PATH)


def formatted_destination(
    source: Path,
    dish_name: str,
    ingredients: list[str],
    made_on: date,
    dimensions: tuple[int, int] | None,
) -> Path:
    safe_name = clean_filename_part(dish_name) or "Untitled Dish"
    safe_ingredients = "-".join(
        part
        for ingredient in ingredients
        if (part := clean_filename_part(ingredient, ingredient=True))
    )
    display_date = f"{made_on.day} {made_on.strftime('%b %Y')}"
    date_key = made_on.strftime("%Y%m%d")
    dimension_part = ""
    if dimensions:
        width, height = dimensions
        dimension_part = f"_{height}_{width}"

    stem = f"IMG_{date_key}_{display_date}_{safe_name}_{safe_ingredients}{dimension_part}"
    extension = source.suffix.lower()
    destination = IMAGES_DIR / f"{stem}{extension}"
    counter = 2
    while destination.exists():
        destination = IMAGES_DIR / f"{stem} {counter}{extension}"
        counter += 1
    return destination


def add_dish(
    source: Path,
    dish_name: str,
    ingredients: list[str],
    made_on: date,
    category: str,
) -> Path:
    if source.parent != REPO_ROOT or source not in root_images():
        raise ValueError("That root image no longer exists.")
    if not dish_name.strip():
        raise ValueError("Please enter the dish name.")
    if category not in CATEGORIES:
        raise ValueError("Please choose one of the available categories.")

    dimensions = image_dimensions(source)
    destination = formatted_destination(
        source, dish_name, ingredients, made_on, dimensions
    )
    catalog = load_catalog()
    source_url = f"/images/{destination.name}"
    if any(item.get("src") == source_url for item in catalog):
        raise ValueError("That destination is already present in the catalog.")

    next_id = max((int(item.get("id", 0)) for item in catalog), default=0) + 1
    entry = {
        "id": next_id,
        "src": source_url,
        "name": re.sub(r"\s+", " ", dish_name).strip(),
        "date": f"{made_on.day} {made_on.strftime('%b %Y')}",
        "ingredients": ingredients,
        "category": category.lower(),
    }
    if dimensions:
        width, height = dimensions
        entry["width"] = width
        entry["height"] = height

    IMAGES_DIR.mkdir(parents=True, exist_ok=True)
    shutil.move(str(source), str(destination))
    try:
        catalog.append(entry)
        write_catalog(catalog)
    except Exception:
        shutil.move(str(destination), str(source))
        raise
    return destination


def default_date(path: Path) -> str:
    return datetime.fromtimestamp(path.stat().st_mtime).date().isoformat()


def page_template(
    images: list[Path],
    selected: Path | None,
    *,
    message: str = "",
    error: str = "",
) -> bytes:
    if selected:
        index = images.index(selected)
        previous_image = images[index - 1] if index > 0 else None
        next_image = images[index + 1] if index + 1 < len(images) else None
        preview_url = "/preview?" + urllib.parse.urlencode({"name": selected.name})
        form_content = f"""
          <div class="preview-wrap">
            <img src="{html.escape(preview_url)}" alt="Preview of {html.escape(selected.name)}">
          </div>
          <form method="post" action="/submit" autocomplete="off">
            <input type="hidden" name="source" value="{html.escape(selected.name)}">
            <label>
              <span>Dish name</span>
              <input name="dish_name" required autofocus placeholder="e.g. Summer Peach Galette">
            </label>
            <label>
              <span>Ingredients</span>
              <textarea name="ingredients" rows="3" placeholder="Separate ingredients with commas"></textarea>
            </label>
            <div class="two-up">
              <label>
                <span>Date made</span>
                <input type="date" name="made_on" required value="{default_date(selected)}">
              </label>
              <fieldset>
                <legend>Category</legend>
                <div class="categories">
                  {''.join(
                      f'<label class="category"><input type="radio" name="category" '
                      f'value="{category}" {"checked" if category == "All" else ""}>'
                      f'<span>{category}</span></label>'
                      for category in CATEGORIES
                  )}
                </div>
              </fieldset>
            </div>
            <button class="submit" type="submit">Add this creation <span>→</span></button>
            <p class="note">Submitting moves the original into <code>images/</code> and updates <code>js/catalog.js</code>.</p>
          </form>
        """
        navigation = f"""
          <div class="review-nav">
            <span>{index + 1} of {len(images)}</span>
            <div>
              {f'<a href="/?image={urllib.parse.quote(previous_image.name)}">← Previous</a>' if previous_image else ''}
              {f'<a href="/?image={urllib.parse.quote(next_image.name)}">Next →</a>' if next_image else ''}
            </div>
          </div>
          <p class="filename">{html.escape(selected.name)}</p>
        """
    else:
        form_content = """
          <div class="empty">
            <div>✓</div>
            <h2>Everything is filed.</h2>
            <p>There are no image files waiting in the repository root.</p>
          </div>
        """
        navigation = "<div class='review-nav'><span>0 images waiting</span></div>"

    document = f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Ritvik Food · Add creations</title>
  <style>
    :root {{
      --paper:#f4efe6; --card:#fffdf8; --ink:#211f1b; --muted:#746e64;
      --sage:#557160; --line:#d8d0c2; --serif:Georgia,serif;
      font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
    }}
    * {{ box-sizing:border-box; }}
    body {{ margin:0; color:var(--ink); background:var(--paper); min-height:100vh; }}
    header {{ max-width:1180px; margin:auto; padding:28px 28px 18px; display:flex; justify-content:space-between; align-items:center; }}
    .brand {{ display:flex; gap:12px; align-items:center; font-weight:700; }}
    .mark {{ width:38px; height:38px; display:grid; place-items:center; border:1.5px solid; border-radius:50%; font:24px var(--serif); }}
    .waiting {{ color:var(--muted); font-size:13px; }}
    main {{ max-width:1180px; margin:auto; padding:18px 28px 50px; }}
    .intro {{ display:flex; justify-content:space-between; gap:30px; align-items:end; margin:16px 0 26px; }}
    h1 {{ max-width:680px; margin:0; font:clamp(46px,7vw,82px)/.95 var(--serif); letter-spacing:-.04em; }}
    h1 em {{ color:var(--sage); }}
    .review-nav {{ min-width:235px; display:flex; justify-content:space-between; align-items:center; gap:18px; color:var(--muted); font-size:13px; }}
    .review-nav div {{ display:flex; gap:15px; }}
    a {{ color:var(--sage); font-weight:650; text-decoration:none; }}
    .filename {{ margin:0 0 10px; text-align:right; color:var(--muted); font-size:11px; word-break:break-all; }}
    .panel {{ display:grid; grid-template-columns:minmax(0,1.12fr) minmax(360px,.88fr); min-height:620px; overflow:hidden; border:1px solid var(--line); border-radius:26px; background:var(--card); box-shadow:0 24px 70px rgba(50,40,30,.11); }}
    .preview-wrap {{ min-height:620px; display:grid; place-items:center; padding:20px; background:#ddd5c8; }}
    .preview-wrap img {{ display:block; max-width:100%; max-height:74vh; object-fit:contain; border-radius:16px; box-shadow:0 14px 40px rgba(30,25,20,.18); }}
    form {{ display:flex; flex-direction:column; gap:22px; padding:clamp(30px,5vw,60px); }}
    label>span, legend {{ display:block; margin-bottom:8px; color:var(--muted); font-size:11px; font-weight:750; letter-spacing:.1em; text-transform:uppercase; }}
    input,textarea {{ width:100%; border:1px solid var(--line); border-radius:12px; background:white; color:var(--ink); padding:13px 14px; font:inherit; outline:none; }}
    input:focus,textarea:focus {{ border-color:var(--sage); box-shadow:0 0 0 3px rgba(85,113,96,.13); }}
    textarea {{ resize:vertical; }}
    .two-up {{ display:grid; gap:22px; }}
    fieldset {{ margin:0; padding:0; border:0; }}
    .categories {{ display:flex; flex-wrap:wrap; gap:8px; }}
    .category input {{ position:absolute; opacity:0; pointer-events:none; }}
    .category span {{ display:block; margin:0; padding:9px 13px; border:1px solid var(--line); border-radius:999px; color:var(--ink); background:white; font-size:13px; font-weight:500; letter-spacing:0; text-transform:none; cursor:pointer; }}
    .category input:checked+span {{ color:white; border-color:var(--sage); background:var(--sage); }}
    .submit {{ margin-top:auto; display:flex; justify-content:space-between; align-items:center; border:0; border-radius:14px; background:var(--ink); color:white; padding:16px 18px; font:700 15px inherit; cursor:pointer; }}
    .submit:hover {{ background:var(--sage); }}
    .note {{ margin:0; color:var(--muted); font-size:12px; line-height:1.5; }}
    .notice {{ margin:0 0 18px; padding:12px 15px; border-radius:12px; color:#284b38; background:#dce9df; }}
    .notice.error {{ color:#7b2d26; background:#f2deda; }}
    .empty {{ grid-column:1/-1; min-height:520px; display:grid; place-items:center; align-content:center; text-align:center; padding:50px; }}
    .empty>div {{ width:64px; height:64px; display:grid; place-items:center; border-radius:50%; color:white; background:var(--sage); font-size:30px; }}
    .empty h2 {{ margin:22px 0 7px; font:45px var(--serif); }}
    .empty p {{ color:var(--muted); }}
    code {{ font-size:.92em; }}
    @media(max-width:800px) {{
      header,main {{ padding-left:18px; padding-right:18px; }}
      .intro {{ align-items:start; flex-direction:column; }}
      .review-nav {{ width:100%; }}
      .filename {{ text-align:left; }}
      .panel {{ grid-template-columns:1fr; }}
      .preview-wrap {{ min-height:380px; }}
      form {{ min-height:570px; }}
    }}
  </style>
</head>
<body>
  <header>
    <div class="brand"><span class="mark">R</span><span>Ritvik Food</span></div>
    <span class="waiting">{len(images)} image{"s" if len(images) != 1 else ""} waiting</span>
  </header>
  <main>
    <div class="intro">
      <h1>File a new <em>creation.</em></h1>
      {navigation}
    </div>
    {f'<p class="notice">{html.escape(message)}</p>' if message else ''}
    {f'<p class="notice error">{html.escape(error)}</p>' if error else ''}
    <section class="panel">{form_content}</section>
  </main>
</body>
</html>"""
    return document.encode("utf-8")


class IntakeHandler(BaseHTTPRequestHandler):
    def log_message(self, format: str, *args: object) -> None:
        print(f"[intake] {format % args}")

    def send_bytes(self, content: bytes, content_type: str, status: int = 200) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(content)

    def redirect(self, location: str) -> None:
        self.send_response(HTTPStatus.SEE_OTHER)
        self.send_header("Location", location)
        self.end_headers()

    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        params = urllib.parse.parse_qs(parsed.query)
        images = root_images()

        if parsed.path == "/preview":
            requested_name = params.get("name", [""])[0]
            selected = next((item for item in images if item.name == requested_name), None)
            if not selected:
                self.send_error(HTTPStatus.NOT_FOUND)
                return
            mime = {
                ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
                ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif",
                ".bmp": "image/bmp", ".tif": "image/tiff", ".tiff": "image/tiff",
                ".heic": "image/heic", ".heif": "image/heif",
            }.get(selected.suffix.lower(), "application/octet-stream")
            self.send_bytes(selected.read_bytes(), mime)
            return

        if parsed.path != "/":
            self.send_error(HTTPStatus.NOT_FOUND)
            return

        requested_name = params.get("image", [""])[0]
        selected = next((item for item in images if item.name == requested_name), None)
        if not selected:
            selected = images[0] if images else None
        message = params.get("message", [""])[0]
        error = params.get("error", [""])[0]
        self.send_bytes(page_template(images, selected, message=message, error=error), "text/html; charset=utf-8")

    def do_POST(self) -> None:
        if urllib.parse.urlparse(self.path).path != "/submit":
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
            if content_length > 64_000:
                raise ValueError("Submitted form is too large.")
            form = urllib.parse.parse_qs(
                self.rfile.read(content_length).decode("utf-8"),
                keep_blank_values=True,
            )
            source_name = form.get("source", [""])[0]
            source = REPO_ROOT / source_name
            if source.name != source_name:
                raise ValueError("Invalid source image.")
            dish_name = form.get("dish_name", [""])[0]
            ingredients = parse_ingredients(form.get("ingredients", [""])[0])
            made_on = date.fromisoformat(form.get("made_on", [""])[0])
            category = form.get("category", [""])[0]
            destination = add_dish(source, dish_name, ingredients, made_on, category)
            message = urllib.parse.quote(f"Added {dish_name.strip()} as images/{destination.name}")
            self.redirect(f"/?message={message}")
        except (OSError, ValueError, json.JSONDecodeError) as exc:
            error = urllib.parse.quote(str(exc))
            self.redirect(f"/?error={error}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Review root-level images in a local browser and add them to Ritvik Food."
    )
    parser.add_argument("--host", default="127.0.0.1", help="Local host to bind (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8765, help="Local port (default: 8765)")
    parser.add_argument("--no-browser", action="store_true", help="Do not open the browser automatically")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    server = ThreadingHTTPServer((args.host, args.port), IntakeHandler)
    url = f"http://{args.host}:{server.server_port}/"
    print(f"Ritvik Food intake is running at {url}")
    print("Press Control-C when you are finished.")
    if not args.no_browser:
        threading.Timer(0.35, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping intake tool.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
