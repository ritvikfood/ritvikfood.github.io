import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname } from "node:path";
import vm from "node:vm";

const CATALOG_PATH = "js/catalog.js";
const INDEX_PATH = "index.html";
const SITE_ORIGIN = "https://ritvikfood.com";
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif"]);
const NON_DISH_IMAGES = new Set([
  "images/banner.jpg",
  "images/banner2.jpg",
  "images/salmon_food.jpg",
  "images/salmon_food_mobile.jpg",
  "images/salmon_food_small.jpg"
]);

function loadCatalog() {
  const context = { window: {} };
  vm.runInNewContext(readFileSync(CATALOG_PATH, "utf8"), context, { filename: CATALOG_PATH });
  if (!Array.isArray(context.window.RITVIK_CATALOG)) throw new Error("Catalog is not an array");
  return context.window.RITVIK_CATALOG;
}

function trackedImages() {
  return execFileSync("git", ["ls-files", "-z", "images"], { encoding: "utf8" })
    .split("\0")
    .filter(Boolean)
    .filter((path) => IMAGE_EXTENSIONS.has(extname(path).toLowerCase()))
    .filter((path) => !NON_DISH_IMAGES.has(path));
}

function titleCase(value) {
  return value
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function metadataFromPath(path) {
  const filename = basename(path, extname(path));
  const parts = filename.split("_");
  const dimensions = parts.length >= 2 && /^\d+$/.test(parts.at(-2)) && /^\d+$/.test(parts.at(-1));
  const structured = parts.length >= 5 && /^(?:IMG|DSC|PHOTO)/i.test(parts[0]);

  if (structured) {
    const date = parts[2] || new Date().toISOString().slice(0, 10);
    const name = parts[3] ? titleCase(parts[3]) : titleCase(filename);
    const ingredientPart = dimensions ? parts.slice(4, -2).join("_") : parts.slice(4).join("_");
    return {
      src: `/${path}`,
      name,
      date,
      ingredients: ingredientPart
        ? ingredientPart.split("-").map((item) => item.trim()).filter(Boolean)
        : [],
      ...(dimensions ? { width: Number(parts.at(-1)), height: Number(parts.at(-2)) } : {}),
      category: "all"
    };
  }

  return {
    src: `/${path}`,
    name: titleCase(filename),
    date: new Date().toISOString().slice(0, 10),
    ingredients: [],
    category: "all"
  };
}

function syncSocialImage(catalog) {
  const latest = [...catalog]
    .filter((item) => item?.src && item?.date)
    .sort((a, b) => new Date(b.date) - new Date(a.date))[0];
  if (!latest) return false;

  const imageUrl = new URL(latest.src, SITE_ORIGIN).href;
  const imageAlt = String(latest.name || "Latest Ritvik Food creation")
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  const original = readFileSync(INDEX_PATH, "utf8");
  const catalogVersion = createHash("sha256").update(readFileSync(CATALOG_PATH)).digest("hex").slice(0, 12);
  let updated = original
    .replace(/src="js\/catalog\.js(?:\?v=[^"]*)?"/, `src="js/catalog.js?v=${catalogVersion}"`)
    .replace(
      /<meta property="og:image" content="[^"]*">/,
      `<meta property="og:image" content="${imageUrl}">`
    )
    .replace(
      /<meta property="og:image:alt" content="[^"]*">/,
      `<meta property="og:image:alt" content="${imageAlt}">`
    )
    .replace(
      /<meta name="twitter:image" content="[^"]*">/,
      `<meta name="twitter:image" content="${imageUrl}">`
    )
    .replace(
      /<meta name="twitter:image:alt" content="[^"]*">/,
      `<meta name="twitter:image:alt" content="${imageAlt}">`
    );

  if (updated === original) return false;
  writeFileSync(INDEX_PATH, updated);
  return true;
}

function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function syncDishPages(catalog) {
  for (const item of catalog) {
    if (!Number.isSafeInteger(item.id) || item.id < 1) throw new Error("Invalid catalog dish ID");
    const directory = `dish/${item.id}`;
    const path = `${directory}/index.html`;
    const home = `/?dish=${item.id}`;
    const url = `${SITE_ORIGIN}/${directory}/`;
    const image = escapeHtml(new URL(item.src, SITE_ORIGIN).href);
    const name = escapeHtml(item.name);
    const description = escapeHtml(item.ingredients.join(" · ") || "From the Ritvik Food archive.");
    const page = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${name} — Ritvik Food</title>
  <link rel="canonical" href="${url}">
  <meta property="og:type" content="website">
  <meta property="og:title" content="${name} — Ritvik Food">
  <meta property="og:description" content="${description}">
  <meta property="og:url" content="${url}">
  <meta property="og:image" content="${image}">
  <meta property="og:image:alt" content="${name}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:image" content="${image}">
  <script>location.replace("${home}");</script>
</head>
<body>
  <h1>${name}</h1>
  <p>${description}</p>
  <a href="${home}">Open in the Ritvik Food archive</a>
</body>
</html>
`;
    if (existsSync(path) && readFileSync(path, "utf8") === page) continue;
    mkdirSync(directory, { recursive: true });
    writeFileSync(path, page);
  }
}

const catalog = loadCatalog();
const knownSources = new Set(catalog.map((item) => item.src.replace(/^\/?/, "/")));
let nextId = Math.max(0, ...catalog.map((item) => Number(item.id) || 0)) + 1;
const additions = trackedImages()
  .filter((path) => !knownSources.has(`/${path}`))
  .map((path) => ({ id: nextId++, ...metadataFromPath(path) }));

if (additions.length) {
  catalog.push(...additions);
  writeFileSync(CATALOG_PATH, `window.RITVIK_CATALOG = ${JSON.stringify(catalog, null, 2)};\n`);
  console.log(`Added ${additions.length} image${additions.length === 1 ? "" : "s"} to the catalog:`);
  for (const item of additions) console.log(`- ${item.name} (${item.src})`);
} else {
  console.log("Catalog is already synchronized.");
}

if (syncSocialImage(catalog)) {
  console.log("Updated the social sharing image to the latest creation.");
} else {
  console.log("Social sharing image is already synchronized.");
}
syncDishPages(catalog);
