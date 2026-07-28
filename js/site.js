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
  const formatter = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });

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
    container.querySelectorAll(".image-shell img").forEach((image) => {
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
      card.querySelector("[data-feature-label]").textContent = item.name;
    });
    const years = catalog.map((item) => parseDate(item.date).getFullYear()).filter((year) => year > 1970);
    document.querySelector("[data-total-count]").textContent = catalog.length;
    document.querySelector("[data-year-count]").textContent = years.length ? Math.max(...years) - Math.min(...years) + 1 : "8";
    setImageFallbacks();
  }

  function openDish(id) {
    const item = catalog.find((entry) => entry.id === Number(id));
    if (!item) return;
    state.activeId = item.id;
    const image = dialog.querySelector("[data-dialog-image]");
    image.src = encodeURI(item.src);
    image.alt = `${item.name}${item.ingredients.length ? ` with ${item.ingredients.join(", ")}` : ""}`;
    dialog.querySelector(".dialog-image").style.background = gradientFor(item);
    dialog.querySelector("[data-dialog-title]").textContent = item.name;
    dialog.querySelector("[data-dialog-date]").textContent = displayDate(item.date);
    dialog.querySelector("[data-dialog-ingredients]").innerHTML = (item.ingredients.length ? item.ingredients : ["A kitchen experiment"])
      .map((ingredient) => `<li>${escapeHtml(ingredient)}</li>`).join("");
    setImageFallbacks(dialog);
    document.body.classList.add("dialog-open");
    dialog.showModal();
  }

  function stepDialog(direction) {
    const items = filteredItems();
    const index = items.findIndex((item) => item.id === state.activeId);
    if (index < 0) return;
    openDish(items[(index + direction + items.length) % items.length].id);
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

  document.querySelector("[data-search-focus]").addEventListener("click", () => {
    search.focus();
    document.querySelector("#archive").scrollIntoView({ behavior: "smooth" });
  });

  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      search.focus();
      document.querySelector("#archive").scrollIntoView({ behavior: "smooth" });
    }
    if (event.key === "Escape" && dialog.open) dialog.close();
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
  dialog.addEventListener("close", () => document.body.classList.remove("dialog-open"));

  const header = document.querySelector("[data-header]");
  const updateHeader = () => header.classList.toggle("stuck", window.scrollY > 50);
  window.addEventListener("scroll", updateHeader, { passive: true });
  document.querySelector("[data-year]").textContent = new Date().getFullYear();

  renderFeatures();
  render();
  setImageFallbacks(gallery);
  updateHeader();
})();
