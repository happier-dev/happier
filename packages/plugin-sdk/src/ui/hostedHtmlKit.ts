/** @moduleRealm browser */

/**
 * The host-styled kit for hosted HTML (agent visuals and plugin HTML bundles).
 *
 * Every hosted document already receives the semantic theme as `--happier-plugin-*`
 * custom properties (see `themeCssVariables.ts`). The kit is the shared Happier look for
 * a handful of controls drawn from those properties: segmented tabs, a slider with its
 * value, stat figures, a field select, a switch, a chart legend, a quiet table and
 * buttons. The author keeps writing native HTML (`<input type="radio">`, `<input
 * type="range">`, `<select>`, `<input type="checkbox">`, `<table>`, `<button>`) inside a
 * `happier-*` wrapper, so the page's own script reads names, values and events exactly
 * as it would without the kit, and the page still works, plainly, wherever the kit is
 * absent (an exported copy). Nothing new crosses the host API.
 *
 * Colours, radii and type come only from the theme properties, read through the same roles
 * plugin-ui gives a hosted realm (`resolveHappierUiPalette`: segment track `control`, thumb and
 * field `surface`, switch `accent`/`control` with an `onAccent` thumb). Geometry the theme does
 * not carry follows the plugin-ui presentation owners and must move with them:
 * segmented track (`HAPPIER_SEGMENTED_METRICS`: 2px inset, 6/12 segment padding, 16px
 * slot), switch (`HAPPIER_SWITCH_METRICS.default`: 40x24 track, 20px thumb), stat figure
 * (`HAPPIER_TYPE_SCALE.title`: 22/28 semibold), motion (`HAPPIER_MOTION_V1`: hover 120,
 * fast 140, base 220, standard curve) and weights (`HAPPIER_TYPE_WEIGHT`).
 */

export const HAPPIER_HTML_KIT_CSS = [
  ':root{--happier-series-1:var(--happier-plugin-color-text,CanvasText);',
  '--happier-series-2:color-mix(in srgb,var(--happier-series-1) 18%,transparent);',
  '--happier-series-3:var(--happier-plugin-color-data-accent,LinkText)}',
  ':is(happier-tabs,happier-slider,happier-stats,happier-stat,happier-select,happier-toggle,happier-legend,happier-table,happier-button){',
  '--hk-text:var(--happier-plugin-color-text,CanvasText);',
  '--hk-secondary:var(--happier-plugin-color-secondary-text,GrayText);',
  '--hk-muted:var(--happier-plugin-color-muted-text,GrayText);',
  '--hk-border:var(--happier-plugin-color-border,color-mix(in srgb,CanvasText 18%,transparent));',
  '--hk-divider:var(--happier-plugin-color-divider,color-mix(in srgb,CanvasText 10%,transparent));',
  '--hk-field:var(--happier-plugin-color-surface,Canvas);',
  '--hk-track:var(--happier-plugin-color-control,color-mix(in srgb,CanvasText 6%,transparent));',
  '--hk-thumb:var(--hk-field);',
  '--hk-accent:var(--happier-plugin-color-accent,CanvasText);',
  '--hk-on-accent:var(--happier-plugin-color-on-accent,Canvas);',
  '--hk-focus:var(--happier-plugin-color-focus,Highlight);',
  '--hk-radius:var(--happier-plugin-radius-control,8px);',
    '--hk-line:color-mix(in srgb,var(--hk-text) 14%,transparent);',
  '--hk-small-size:var(--happier-plugin-text-caption-size,11px);',
  '--hk-small-line:var(--happier-plugin-text-caption-line-height,14px);',
  '--hk-ease:cubic-bezier(0.2,0,0,1);',
  'box-sizing:border-box;min-width:0;',
  'font-family:var(--happier-plugin-text-body-family,system-ui),system-ui,sans-serif;',
  'font-size:var(--happier-plugin-text-body-size,13px);line-height:var(--happier-plugin-text-body-line-height,18px);',
  'color:var(--hk-text);-webkit-font-smoothing:antialiased}',
  // On a dark surface a lifted part is lighter than its well; the host marks the scheme it painted.
  ':root[data-happier-scheme=dark] :is(happier-tabs,happier-slider,happier-select,happier-toggle,happier-button){',
  '--hk-field:var(--happier-plugin-color-elevated-surface,Canvas);--hk-track:color-mix(in srgb,var(--hk-text) 6%,transparent);',
  '--hk-thumb:color-mix(in srgb,var(--happier-plugin-color-elevated-surface,Canvas),var(--hk-text) 10%)}',
  ':is(happier-tabs,happier-select,happier-button) :focus-visible,happier-slider input:focus-visible,happier-toggle input:focus-visible{outline:2px solid var(--hk-focus);outline-offset:1px}',
  // Segmented tabs over native radios: arrow keys, form value and change events stay the browser's.
  'happier-tabs{display:inline-flex;width:fit-content;max-width:100%;padding:2px;border-radius:var(--hk-radius);background:var(--hk-track);vertical-align:middle}',
  'happier-tabs>label{position:relative;display:inline-flex;align-items:center;justify-content:center;min-width:24px;padding:6px 12px;line-height:16px;',
  'border-radius:calc(var(--hk-radius) - 2px);color:var(--hk-secondary);white-space:nowrap;cursor:pointer;user-select:none;',
  'transition:color 140ms var(--hk-ease),background-color 140ms var(--hk-ease)}',
  'happier-tabs>label>input{position:absolute;inset:0;width:100%;height:100%;margin:0;opacity:0;cursor:pointer}',
  'happier-tabs>label:hover{color:var(--hk-text)}',
  'happier-tabs>label:has(>input:checked){background:var(--hk-thumb);color:var(--hk-text);font-weight:600;box-shadow:0 1px 2px rgb(0 0 0/0.08)}',
  'happier-tabs>label:has(>input:focus-visible){outline:2px solid var(--hk-focus);outline-offset:1px}',
  'happier-tabs>label:has(>input:disabled){opacity:.5;cursor:default}',
  // Slider: the readout row is the element's own (see below); the track fills to the value.
  'happier-slider{display:block;min-width:120px}',
  'happier-slider input[type=range]{-webkit-appearance:none;appearance:none;display:block;width:100%;height:20px;margin:4px 0 0;background:transparent;cursor:pointer}',
  'happier-slider input[type=range]::-webkit-slider-runnable-track{height:4px;border-radius:2px;',
  'background:linear-gradient(to right,var(--hk-text) var(--happier-slider-fill,50%),var(--hk-line) var(--happier-slider-fill,50%))}',
  'happier-slider input[type=range]::-moz-range-track{height:4px;border-radius:2px;background:var(--hk-line)}',
  'happier-slider input[type=range]::-moz-range-progress{height:4px;border-radius:2px;background:var(--hk-text)}',
  'happier-slider input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:16px;height:16px;margin-top:-6px;border-radius:50%;',
  'background:var(--hk-thumb);border:1px solid var(--hk-border);box-shadow:0 1px 2px rgb(0 0 0/0.18)}',
  'happier-slider input[type=range]::-moz-range-thumb{box-sizing:border-box;width:16px;height:16px;border-radius:50%;',
  'background:var(--hk-thumb);border:1px solid var(--hk-border);box-shadow:0 1px 2px rgb(0 0 0/0.18)}',
  'happier-slider input[type=range]:disabled{opacity:.5;cursor:default}',
  // Stats: label, the figure in <b>/<strong>, context in <small>; a row of them is one <happier-stats>.
  'happier-stats{display:flex;flex-wrap:wrap;row-gap:12px}',
  'happier-stats>happier-stat{flex:1 1 0;padding:0 12px;min-width:96px}',
  'happier-stats>happier-stat:first-child{padding-left:0}',
  'happier-stats>happier-stat+happier-stat{border-left:1px solid var(--hk-divider)}',
  'happier-stat{display:block}',
  'happier-stat>*{display:block;margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  'happier-stat>:not(b,strong,small){color:var(--hk-secondary)}',
  'happier-stat>:is(b,strong){font-size:22px;line-height:28px;font-weight:600;letter-spacing:-0.4px;font-variant-numeric:tabular-nums;color:var(--hk-tone,var(--hk-text))}',
  'happier-stat>small{font-size:var(--hk-small-size);line-height:var(--hk-small-line);color:var(--hk-muted)}',
  'happier-stat[tone=success]{--hk-tone:var(--happier-plugin-color-success)}',
  'happier-stat[tone=warning]{--hk-tone:var(--happier-plugin-color-warning)}',
  'happier-stat[tone=attention]{--hk-tone:var(--happier-plugin-color-attention)}',
  'happier-stat[tone=danger]{--hk-tone:var(--happier-plugin-color-danger)}',
  // Field select over the native <select>; the chevron is the wrapper's.
  'happier-select{position:relative;display:inline-block;min-width:120px;vertical-align:middle}',
  'happier-select>select{-webkit-appearance:none;appearance:none;box-sizing:border-box;width:100%;margin:0;padding:6px 30px 6px 10px;',
  'font:inherit;color:var(--hk-text);background:var(--hk-field);border:1px solid var(--hk-border);border-radius:var(--hk-radius);cursor:pointer}',
  'happier-select>select:disabled{opacity:.5;cursor:default}',
  'happier-select::after{content:"";position:absolute;right:12px;top:50%;width:5px;height:5px;pointer-events:none;',
  'border-right:1.5px solid var(--hk-secondary);border-bottom:1.5px solid var(--hk-secondary);transform:translateY(-70%) rotate(45deg)}',
  // Switch over a native checkbox; the thumb is a gradient so no pseudo-element on <input> is needed.
  'happier-toggle{display:block}',
  'happier-toggle>label{display:flex;align-items:center;justify-content:space-between;gap:12px;cursor:pointer}',
  'happier-toggle input[type=checkbox]{-webkit-appearance:none;appearance:none;flex:none;width:40px;height:24px;margin:0;border-radius:12px;cursor:pointer;',
  'background-color:var(--hk-track);background-image:radial-gradient(circle,var(--hk-on-accent) 9.5px,transparent 10px);',
  'background-size:24px 24px;background-repeat:no-repeat;background-position:0 0;',
  'transition:background-color 140ms var(--hk-ease),background-position 220ms var(--hk-ease)}',
  'happier-toggle input[type=checkbox]:checked{background-color:var(--hk-accent);background-position:16px 0}',
  'happier-toggle input[type=checkbox]:disabled{opacity:.6;cursor:default}',
  // Legend: one swatch per child, in the series order a chart can reuse (--happier-series-N), or --happier-swatch.
  'happier-legend{display:flex;flex-wrap:wrap;align-items:center;gap:4px 16px;font-size:var(--hk-small-size);line-height:var(--hk-small-line);color:var(--hk-secondary)}',
  'happier-legend>*{display:inline-flex;align-items:center;gap:6px}',
  'happier-legend>*::before{content:"";flex:none;width:8px;height:8px;border-radius:2px;background:var(--happier-swatch,var(--happier-series-1))}',
  'happier-legend>:nth-child(2)::before{background:var(--happier-swatch,var(--happier-series-2))}',
  'happier-legend>:nth-child(3)::before{background:var(--happier-swatch,var(--happier-series-3))}',
  // Quiet table: first column names the row, the rest are figures aligned on their end.
  'happier-table{display:block;overflow-x:auto}',
  'happier-table>table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}',
  'happier-table th{padding:0 12px 6px 0;font-weight:400;font-size:var(--hk-small-size);line-height:var(--hk-small-line);color:var(--hk-secondary);text-align:start;white-space:nowrap}',
  'happier-table td{padding:7px 12px 7px 0;border-top:1px solid var(--hk-divider);text-align:start;vertical-align:baseline}',
  'happier-table :is(th,td):not(:first-child){text-align:end}',
  'happier-table :is(th,td):last-child{padding-right:0}',
  // Buttons: bordered by default, filled with variant="primary" (one per view).
  'happier-button{display:inline-flex;width:fit-content;flex-wrap:wrap;gap:8px}',
  'happier-button>button{-webkit-appearance:none;appearance:none;margin:0;padding:6px 12px;font:inherit;font-weight:600;color:var(--hk-text);',
  'background:var(--hk-field);border:1px solid var(--hk-border);border-radius:var(--hk-radius);cursor:pointer;transition:background-color 120ms var(--hk-ease)}',
  'happier-button>button:hover{background:color-mix(in srgb,var(--hk-field),var(--hk-text) 5%)}',
  'happier-button[variant=primary]>button{color:var(--hk-on-accent);background:var(--hk-accent);border-color:transparent}',
  'happier-button[variant=primary]>button:hover{background:color-mix(in srgb,var(--hk-accent),var(--hk-on-accent) 10%)}',
  'happier-button>button:disabled{opacity:.5;cursor:default}',
  '@media (prefers-reduced-motion:reduce){happier-tabs>label,happier-toggle input[type=checkbox],happier-button>button{transition:none}}',
].join('');

const SLIDER_SHADOW_CSS = [
  ':host{display:block}',
  '.head{display:flex;align-items:baseline;justify-content:space-between;gap:8px}',
  '.head[hidden]{display:none}',
  '.label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--hk-secondary)}',
  '.value{flex:none;font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap}',
].join('');

/** The realm surface the kit needs; a realm without custom elements (a test VM) gets nothing. */
export type HappierHtmlKitRealm = Readonly<{
  document?: Document;
  customElements?: CustomElementRegistry;
  HTMLElement?: typeof HTMLElement;
}>;

/**
 * Install the kit once in a hosted document: the stylesheet first in `<head>` (so the
 * author's own rules still win by order) and the slider element. Stylesheets go in as
 * `data:` links, which every hosted document CSP admits, including generated archives.
 */
export function installHappierHtmlKit(realm: HappierHtmlKitRealm): void {
  const { document, customElements, HTMLElement: Base } = realm;
  if (
    !document?.head ||
    !customElements ||
    !Base ||
    customElements.get('happier-slider')
  )
    return;
  document.head.prepend(createStylesheetLink(document, HAPPIER_HTML_KIT_CSS));

  class HappierSliderElement extends Base {
    static readonly observedAttributes = ['label', 'unit'];
    readonly #head: HTMLElement;
    readonly #label: HTMLElement;
    readonly #value: HTMLElement;

    constructor() {
      super();
      const root = this.attachShadow({ mode: 'open' });
      const ownerDocument = this.ownerDocument;
      this.#head = ownerDocument.createElement('div');
      this.#head.className = 'head';
      // The range input carries the accessible name and value text; the row is its visible twin.
      this.#head.setAttribute('aria-hidden', 'true');
      this.#label = ownerDocument.createElement('span');
      this.#label.className = 'label';
      this.#value = ownerDocument.createElement('span');
      this.#value.className = 'value';
      this.#head.append(this.#label, this.#value);
      const slot = ownerDocument.createElement('slot');
      slot.addEventListener('slotchange', () => this.#sync());
      root.append(
        createStylesheetLink(ownerDocument, SLIDER_SHADOW_CSS),
        this.#head,
        slot,
      );
      this.addEventListener('input', () => this.#sync());
      this.addEventListener('change', () => this.#sync());
    }

    connectedCallback(): void {
      this.#sync();
    }

    attributeChangedCallback(): void {
      this.#sync();
    }

    #sync(): void {
      const input = this.querySelector<HTMLInputElement>('input[type=range]');
      const label = this.getAttribute('label') ?? '';
      const unit = this.getAttribute('unit');
      this.#label.textContent = label;
      if (!input) {
        this.#value.textContent = '';
        this.#head.hidden = label.length === 0;
        return;
      }
      const shown = unit ? `${input.value} ${unit}` : input.value;
      this.#value.textContent = shown;
      this.#head.hidden = false;
      if (label && !input.hasAttribute('aria-label') && !input.labels?.length)
        input.setAttribute('aria-label', label);
      input.setAttribute('aria-valuetext', shown);
      const min = Number(input.min || 0);
      const max = Number(input.max || 100);
      const fill =
        max > min
          ? Math.min(
              100,
              Math.max(0, ((Number(input.value) - min) / (max - min)) * 100),
            )
          : 0;
      this.style.setProperty('--happier-slider-fill', `${fill}%`);
    }
  }

  customElements.define('happier-slider', HappierSliderElement);
}

function createStylesheetLink(
  document: Document,
  css: string,
): HTMLLinkElement {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = `data:text/css;charset=utf-8,${encodeURIComponent(css)}`;
  return link;
}
