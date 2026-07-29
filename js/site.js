(() => {
  "use strict";

  const catalog = Array.isArray(window.RITVIK_CATALOG) ? window.RITVIK_CATALOG : [];
  const state = { filter: "all", query: "", sort: "newest", limit: 24, activeId: null };
  const gallery = document.querySelector("[data-gallery]");
  const latestGrid = document.querySelector("[data-latest-grid]");
  const resultCount = document.querySelector("[data-result-count]");
  const loadMore = document.querySelector("[data-load-more]");
  const empty = document.querySelector("[data-empty]");
  const search = document.querySelector("[data-search]");
  const dialog = document.querySelector("[data-dialog]");
  const dialogAnimated = [...dialog.querySelectorAll("[data-dialog-animated]")];
  const formatter = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });
  const mobileQuery = window.matchMedia("(max-width: 760px), (hover: none) and (pointer: coarse)");
  const reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  const imagePreloads = new Map();
  let dishRequest = 0;
  let dishTransitioning = false;

  function updateDeviceMode() {
    document.documentElement.classList.toggle("is-mobile", mobileQuery.matches);
    document.documentElement.dataset.device = mobileQuery.matches ? "mobile" : "desktop";
    const searchInput = document.querySelector("[data-search]");
    if (searchInput) searchInput.placeholder = mobileQuery.matches ? "Search the archive…" : "Search dishes or ingredients…";
  }

  updateDeviceMode();
  mobileQuery.addEventListener?.("change", updateDeviceMode);

  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  }[character]));

  function parseDate(value) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.valueOf()) ? new Date(0) : parsed;
  }

  function displayDate(value) {
    const date = parseDate(value);
    return date.valueOf() ? formatter.format(date) : value;
  }

  function gradientFor(item) {
    const palettes = [
      ["#385e59", "#d1ab72", "#536f5e"],
      ["#435f50", "#b99b70", "#e0c492"],
      ["#60745a", "#c7a36c", "#36584f"],
      ["#4c6143", "#aa875f", "#728679"],
      ["#536b61", "#c6a97c", "#405c51"]
    ];
    const palette = palettes[item.id % palettes.length];
    return `linear-gradient(${120 + item.id % 45}deg, ${palette[0]}, ${palette[1]} 52%, ${palette[2]})`;
  }

  function imageMarkup(item, priority = false) {
    const ingredients = item.ingredients.length ? ` with ${item.ingredients.slice(0, 3).join(", ")}` : "";
    return `<img src="${encodeURI(item.src)}" alt="${escapeHtml(item.name + ingredients)}" width="${item.width || 800}" height="${item.height || 1000}" ${priority ? 'fetchpriority="high"' : 'loading="lazy" decoding="async"'}>`;
  }

  function cardMarkup(item, variant = "dish") {
    const ratio = item.width && item.height ? `${item.width} / ${item.height}` : "4 / 5";
    const ingredients = item.ingredients.length ? item.ingredients.join(" · ") : "From the kitchen";
    if (variant === "latest") {
      return `<article class="latest-card" data-open-dish="${item.id}" tabindex="0" role="button" aria-label="View ${escapeHtml(item.name)}">
        <div class="image-shell" style="background:${gradientFor(item)}">${imageMarkup(item)}</div>
        <h3 class="card-title">${escapeHtml(item.name)}</h3>
        <p class="card-meta">${escapeHtml(displayDate(item.date))} · ${escapeHtml(item.category)}</p>
      </article>`;
    }
    return `<article class="dish-card" style="--ratio:${ratio}">
      <div class="image-shell" style="background:${gradientFor(item)}">${imageMarkup(item)}</div>
      <div class="dish-card-copy">
        <h3>${escapeHtml(item.name)}</h3>
        <p class="ingredients">${escapeHtml(ingredients)}</p>
      </div>
      <button type="button" data-open-dish="${item.id}" aria-label="View ${escapeHtml(item.name)} details"></button>
    </article>`;
  }

  function filteredItems() {
    const terms = state.query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    const result = catalog.filter((item) => {
      const categoryMatch = state.filter === "all" || item.category === state.filter;
      const haystack = `${item.name} ${item.date} ${item.ingredients.join(" ")}`.toLowerCase();
      return categoryMatch && terms.every((term) => haystack.includes(term));
    });
    return result.sort((a, b) => {
      if (state.sort === "az") return a.name.localeCompare(b.name);
      const difference = parseDate(b.date) - parseDate(a.date);
      return state.sort === "oldest" ? -difference : difference;
    });
  }

  function render() {
    const items = filteredItems();
    const shown = items.slice(0, state.limit);
    gallery.innerHTML = shown.map((item) => cardMarkup(item)).join("");
    resultCount.textContent = items.length;
    empty.hidden = items.length !== 0;
    gallery.hidden = items.length === 0;
    loadMore.parentElement.hidden = items.length <= state.limit;
  }

  function setImageFallbacks(container = document) {
    container.querySelectorAll('.image-shell img[src]:not([src=""])').forEach((image) => {
      if (image.complete && image.naturalWidth === 0) {
        image.remove();
        return;
      }
      image.addEventListener("error", () => {
        image.remove();
      }, { once: true });
    });
  }

  function renderFeatures() {
    const ordered = [...catalog].sort((a, b) => parseDate(b.date) - parseDate(a.date));
    latestGrid.innerHTML = ordered.slice(0, 4).map((item) => cardMarkup(item, "latest")).join("");
    const latest = ordered[0];
    const randomPool = ordered.slice(1);
    const firstRandomIndex = Math.floor(Math.random() * randomPool.length);
    let secondRandomIndex = Math.floor(Math.random() * randomPool.length);
    if (secondRandomIndex === firstRandomIndex) secondRandomIndex = (secondRandomIndex + 1) % randomPool.length;
    const featured = {
      latest,
      "random-one": randomPool[firstRandomIndex],
      "random-two": randomPool[secondRandomIndex]
    };
    document.querySelectorAll("[data-feature-card]").forEach((card) => {
      const item = featured[card.dataset.featureCard] || catalog[0];
      if (!item) return;
      const shell = card.querySelector(".image-shell");
      shell.style.background = gradientFor(item);
      shell.innerHTML = imageMarkup(item, true);
      const label = card.querySelector("[data-feature-label]");
      const machineDate = parseDate(item.date).toISOString().slice(0, 10);
      label.innerHTML = `${escapeHtml(item.name)} <time datetime="${machineDate}">· ${escapeHtml(displayDate(item.date))}</time>`;
    });
    const years = catalog.map((item) => parseDate(item.date).getFullYear()).filter((year) => year > 1970);
    document.querySelector("[data-total-count]").textContent = catalog.length;
    document.querySelector("[data-year-count]").textContent = years.length ? Math.max(...years) - Math.min(...years) + 1 : "8";
    setImageFallbacks();
  }

  function preloadDishImage(item) {
    if (imagePreloads.has(item.src)) return imagePreloads.get(item.src);
    const promise = new Promise((resolve) => {
      const preload = new Image();
      preload.onload = async () => {
        try {
          if (preload.decode) await preload.decode();
        } catch (_) {
          // A loaded image is still safe to display if decode() is unavailable.
        }
        resolve(true);
      };
      preload.onerror = () => resolve(false);
      preload.src = encodeURI(item.src);
    });
    imagePreloads.set(item.src, promise);
    return promise;
  }

  function preloadNeighbors(id) {
    const items = filteredItems();
    const index = items.findIndex((item) => item.id === Number(id));
    if (index < 0 || items.length < 2) return;
    for (let offset = 1; offset <= Math.min(2, items.length - 1); offset += 1) {
      preloadDishImage(items[(index - offset + items.length) % items.length]);
      preloadDishImage(items[(index + offset) % items.length]);
    }
  }

  async function openDish(id) {
    const item = catalog.find((entry) => entry.id === Number(id));
    if (!item) return;
    const request = ++dishRequest;
    dialog.classList.add("is-loading");
    dialog.setAttribute("aria-busy", "true");
    if (!dialog.open) {
      document.body.classList.add("dialog-open");
      dialog.showModal();
    }
    const loaded = await preloadDishImage(item);
    if (request !== dishRequest) return;

    const image = dialog.querySelector("[data-dialog-image]");
    if (loaded) image.src = encodeURI(item.src);
    else image.removeAttribute("src");
    image.alt = `${item.name}${item.ingredients.length ? ` with ${item.ingredients.join(", ")}` : ""}`;
    dialog.querySelector(".dialog-image").style.background = gradientFor(item);
    dialog.querySelector("[data-dialog-title]").textContent = item.name;
    dialog.querySelector("[data-dialog-date]").textContent = displayDate(item.date);
    dialog.querySelector("[data-dialog-ingredients]").innerHTML = (item.ingredients.length ? item.ingredients : ["A kitchen experiment"])
      .map((ingredient) => `<li>${escapeHtml(ingredient)}</li>`).join("");
    state.activeId = item.id;
    setImageFallbacks(dialog);
    dialog.classList.remove("is-loading");
    dialog.setAttribute("aria-busy", "false");
    preloadNeighbors(item.id);
  }

  async function stageAnimation(keyframes, options) {
    const finalFrame = keyframes[keyframes.length - 1];
    if (reducedMotionQuery.matches || !dialogAnimated.every((element) => element.animate)) {
      dialogAnimated.forEach((element) => {
        if (finalFrame.transform) element.style.transform = finalFrame.transform;
        if (finalFrame.opacity !== undefined) element.style.opacity = finalFrame.opacity;
      });
      return;
    }
    const animations = dialogAnimated.map((element) => element.animate(keyframes, options));
    await Promise.all(animations.map((animation) => animation.finished.catch(() => {})));
    dialogAnimated.forEach((element) => {
      if (finalFrame.transform) element.style.transform = finalFrame.transform;
      if (finalFrame.opacity !== undefined) element.style.opacity = finalFrame.opacity;
    });
    animations.forEach((animation) => animation.cancel());
  }

  async function stepDialog(direction) {
    if (dishTransitioning) return;
    const items = filteredItems();
    const index = items.findIndex((item) => item.id === state.activeId);
    if (index < 0) return;
    const next = items[(index + direction + items.length) % items.length];
    dishTransitioning = true;
    dialog.classList.add("is-preparing");
    dialog.setAttribute("aria-busy", "true");

    await preloadDishImage(next);
    dialog.classList.remove("is-preparing");
    const distance = Math.max(dialog.getBoundingClientRect().width, 320);
    const outgoingX = direction > 0 ? distance * -.26 : distance * .26;
    const incomingX = direction > 0 ? distance * .2 : distance * -.2;

    await stageAnimation([
      { transform: "translate3d(0, 0, 0) scale(1)", opacity: 1 },
      { transform: `translate3d(${outgoingX}px, 0, 0) scale(.975)`, opacity: .12 }
    ], { duration: 190, easing: "cubic-bezier(.4, 0, 1, 1)", fill: "forwards" });

    dialogAnimated.forEach((element) => {
      element.style.opacity = "0";
      element.style.transform = `translate3d(${incomingX}px, 0, 0) scale(.985)`;
    });
    await openDish(next.id);

    await stageAnimation([
      { transform: `translate3d(${incomingX}px, 0, 0) scale(.985)`, opacity: .12 },
      { transform: "translate3d(0, 0, 0) scale(1)", opacity: 1 }
    ], { duration: 300, easing: "cubic-bezier(.16, 1, .3, 1)", fill: "forwards" });

    dialogAnimated.forEach((element) => {
      element.style.removeProperty("opacity");
      element.style.removeProperty("transform");
    });
    dialog.setAttribute("aria-busy", "false");
    dishTransitioning = false;
  }

  document.querySelector("[data-filter-bar]").addEventListener("click", (event) => {
    const button = event.target.closest("[data-filter]");
    if (!button) return;
    state.filter = button.dataset.filter;
    state.limit = 24;
    document.querySelectorAll("[data-filter]").forEach((filter) => {
      const selected = filter === button;
      filter.classList.toggle("active", selected);
      filter.setAttribute("aria-pressed", selected);
    });
    render();
    setImageFallbacks(gallery);
  });

  search.addEventListener("input", () => {
    state.query = search.value;
    state.limit = 24;
    render();
    setImageFallbacks(gallery);
  });

  document.querySelector("[data-sort]").addEventListener("change", (event) => {
    state.sort = event.target.value;
    render();
    setImageFallbacks(gallery);
  });

  function focusArchiveSearch() {
    if (mobileQuery.matches) {
      // Position first, then focus within the same tap so iOS opens the keyboard
      // without competing against a smooth scroll while the viewport resizes.
      search.scrollIntoView({ behavior: "instant", block: "center" });
      search.focus({ preventScroll: true });
      if (window.visualViewport) {
        window.visualViewport.addEventListener("resize", () => {
          window.requestAnimationFrame(() => {
            search.scrollIntoView({ behavior: "instant", block: "center" });
          });
        }, { once: true });
      }
      return;
    }

    search.focus({ preventScroll: true });
    search.scrollIntoView({ behavior: reducedMotionQuery.matches ? "auto" : "smooth", block: "center" });
  }

  document.querySelector("[data-search-focus]").addEventListener("click", focusArchiveSearch);
  document.querySelector("[data-mobile-search]").addEventListener("click", focusArchiveSearch);

  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      focusArchiveSearch();
    }
    if (event.key === "Escape" && dialog.open) dialog.close();
    if (dialog.open && event.key === "ArrowLeft") {
      event.preventDefault();
      stepDialog(-1);
    }
    if (dialog.open && event.key === "ArrowRight") {
      event.preventDefault();
      stepDialog(1);
    }
  });

  document.addEventListener("click", (event) => {
    const opener = event.target.closest("[data-open-dish]");
    if (opener) openDish(opener.dataset.openDish);
  });

  document.addEventListener("keydown", (event) => {
    const opener = event.target.closest(".latest-card[data-open-dish]");
    if (opener && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      openDish(opener.dataset.openDish);
    }
  });

  loadMore.addEventListener("click", () => {
    state.limit += 24;
    render();
    setImageFallbacks(gallery);
  });

  document.querySelector("[data-clear]").addEventListener("click", () => {
    state.query = "";
    state.filter = "all";
    search.value = "";
    document.querySelector('[data-filter="all"]').click();
  });

  dialog.querySelector("[data-dialog-close]").addEventListener("click", () => dialog.close());
  dialog.querySelector("[data-dialog-prev]").addEventListener("click", () => stepDialog(-1));
  dialog.querySelector("[data-dialog-next]").addEventListener("click", () => stepDialog(1));
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.addEventListener("close", () => {
    dishRequest += 1;
    dialog.classList.remove("is-loading", "is-preparing");
    dialog.setAttribute("aria-busy", "false");
    dialogAnimated.forEach((element) => {
      element.style.removeProperty("transform");
      element.style.removeProperty("opacity");
    });
    dishTransitioning = false;
    document.body.classList.remove("dialog-open");
  });

  const header = document.querySelector("[data-header]");
  const updateHeader = () => header.classList.toggle("stuck", window.scrollY > 50);
  window.addEventListener("scroll", updateHeader, { passive: true });
  document.querySelector("[data-year]").textContent = new Date().getFullYear();

  renderFeatures();
  render();
  setImageFallbacks(gallery);
  updateHeader();
})();
