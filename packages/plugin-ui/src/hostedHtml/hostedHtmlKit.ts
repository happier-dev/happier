import type { PluginUiThemeV1 } from '@happier-dev/plugin-sdk/ui';
import { buildPluginUiThemeCssVariables } from '@happier-dev/plugin-sdk/ui/client';

import { resolveHappierUiPalette } from '../environment/hostedRealmPalette.js';
import { HAPPIER_DISCLOSURE_CHEVRON_METRICS } from '../presentation/collection/disclosureChevronMetrics.js';
import { HAPPIER_DATA_METRICS } from '../presentation/data/dataMetrics.js';
import { HAPPIER_FIELD_BOX_GEOMETRY } from '../presentation/form/fieldBoxMetrics.js';
import { HAPPIER_SEGMENTED_GEOMETRY } from '../presentation/form/segmentedMetrics.js';
import { HAPPIER_SLIDER_METRICS } from '../presentation/form/sliderMetrics.js';
import { HAPPIER_SWITCH_METRICS } from '../presentation/form/switchMetrics.js';
import { HAPPIER_BUTTON_METRICS } from '../presentation/interaction/buttonMetrics.js';
import { HAPPIER_FOCUS_RING_V1 } from '../presentation/interaction/focusRingMetrics.js';
import { HAPPIER_MOTION_V1 } from '../presentation/interaction/motion.js';
import { HAPPIER_PAGE_METRICS } from '../presentation/layout/pageMetrics.js';
import { HAPPIER_TYPE_WEIGHT } from '../presentation/text/typeScale.js';

/**
 * The plugin-ui controls drawn for hosted HTML (agent visuals and plugin HTML bundles).
 *
 * A hosted frame cannot run the React primitives, so this draws the same primitives from the same owners:
 * every size, weight and duration below is read from the metric exports the React segmented choice,
 * switch, slider, field box, button, data nodes and focus ring read, and every colour is the palette role
 * plugin-ui gives a hosted realm (`resolveHappierUiPalette`) over the frame's `--happier-plugin-*` theme
 * properties (their names come from the SDK's projection, `buildPluginUiThemeCssVariables`).
 *
 * Authors keep writing native HTML (`<input type="radio">`, `<input type="range">`, `<select>`, `<input
 * type="checkbox">`, `<table>`, `<button>`) inside a `happier-*` wrapper, so the page's own script reads
 * names, values and events as usual and the page still works, plainly, where the kit is absent.
 */

type TypeRoleVariables = Readonly<{ size: string; lineHeight: string; weight: string; family: string }>;

/** The projection's own name for one theme field, as a `var()` reference. */
function themeVariable(
  theme: Partial<Record<keyof PluginUiThemeV1, unknown>>,
): string {
  const names = Object.keys(
    buildPluginUiThemeCssVariables({
      colors: {},
      spacing: {},
      radii: {},
      typography: {},
      ...theme,
    } as unknown as PluginUiThemeV1),
  );
  if (names.length !== 1)
    throw new Error('A theme field projects to exactly one property');
  return `var(${names[0]})`;
}

function typeVariables(
  role: keyof PluginUiThemeV1['typography'],
): TypeRoleVariables {
  const names = Object.keys(
    buildPluginUiThemeCssVariables({
      colors: {},
      spacing: {},
      radii: {},
      typography: { [role]: { fontSize: 0, lineHeight: 0, fontWeight: '400', fontFamily: 'x' } },
    } as unknown as PluginUiThemeV1),
  );
  const read = (suffix: string) =>
    `var(${names.find((name) => name.endsWith(suffix))})`;
  return {
    size: read('-size'),
    lineHeight: read('-line-height'),
    weight: read('-weight'),
    // The family is optional in the snapshot, so its reference keeps the system face as its fallback.
    family: `var(${names.find((name) => name.endsWith('-family'))},system-ui)`,
  };
}

const colors = new Proxy({} as PluginUiThemeV1['colors'], {
  get: (_target, name) =>
    typeof name === 'string'
      ? themeVariable({ colors: { [name]: name } as never })
      : undefined,
});
// The palette reads only the snapshot's colours; here each is the frame's property for that colour.
const palette = resolveHappierUiPalette({
  colors,
} as unknown as PluginUiThemeV1);
const radiusControl = themeVariable({ radii: { control: 0 } as never });
const spacingLarge = themeVariable({ spacing: { large: 0 } as never });
const spacingMedium = themeVariable({ spacing: { medium: 0 } as never });
const body = typeVariables('body');
const label = typeVariables('label');
const caption = typeVariables('caption');

const px = (value: number) => `${value}px`;
const ms = (value: number) => `${value}ms`;
const ease = HAPPIER_MOTION_V1.standardEasingCss;
const focusRing = `outline:${px(HAPPIER_FOCUS_RING_V1.widthPx)} solid ${colors.focus};outline-offset:${px(HAPPIER_FOCUS_RING_V1.gapPx)}`;
const segmented = HAPPIER_SEGMENTED_GEOMETRY;
const switchBox = HAPPIER_SWITCH_METRICS.default;
const slider = HAPPIER_SLIDER_METRICS;
const field = HAPPIER_FIELD_BOX_GEOMETRY;
const chevron = HAPPIER_DISCLOSURE_CHEVRON_METRICS;
const data = HAPPIER_DATA_METRICS;
const stat = data.statValue;
const chevronArmPx = chevron.glyphPx * chevron.armRatio;
const KIT_TAGS =
  ':is(happier-tabs,happier-slider,happier-stats,happier-stat,happier-select,happier-toggle,happier-legend,happier-table,happier-button)';

export const HAPPIER_HTML_KIT_CSS = [
  `:root{--happier-series-1:${colors.text};--happier-series-2:color-mix(in srgb,${colors.text} ${data.barRestOpacity * 100}%,transparent);--happier-series-3:${colors.dataAccent}}`,
  `${KIT_TAGS}{box-sizing:border-box;min-width:0;font-family:${body.family},system-ui,sans-serif;` +
    `font-size:${body.size};line-height:${body.lineHeight};color:${colors.text};-webkit-font-smoothing:antialiased}`,
  `${KIT_TAGS} :focus-visible{${focusRing}}`,
  // Segmented choice over native radios: arrow keys, form value and change events stay the browser's.
  `happier-tabs{display:inline-flex;width:fit-content;max-width:100%;padding:${px(segmented.trackPaddingPx)};border-radius:${radiusControl};background:${palette.segmentTrack};vertical-align:middle}`,
  `happier-tabs>label{position:relative;display:inline-flex;align-items:center;justify-content:center;min-width:${px(segmented.segmentMinWidthPx)};` +
    `padding:${px(segmented.segmentPaddingVerticalPx.default)} ${px(segmented.segmentPaddingHorizontalPx)};line-height:${px(segmented.labelSlotPx.default)};` +
    `border-radius:calc(${radiusControl} - ${px(segmented.trackPaddingPx)});color:${colors.secondaryText};white-space:nowrap;cursor:pointer;user-select:none;` +
    `transition:color ${ms(HAPPIER_MOTION_V1.fastMs)} ${ease},background-color ${ms(HAPPIER_MOTION_V1.fastMs)} ${ease}}`,
  'happier-tabs>label>input{position:absolute;inset:0;width:100%;height:100%;margin:0;opacity:0;cursor:pointer}',
  `happier-tabs>label:hover{color:${colors.text}}`,
  `happier-tabs>label:has(>input:checked){background:${palette.segmentThumb};color:${colors.text};font-weight:${HAPPIER_TYPE_WEIGHT[segmented.labelActiveEmphasis]}}`,
  `happier-tabs>label:has(>input:focus-visible){${focusRing}}`,
  `happier-tabs>label:has(>input:disabled){opacity:${segmented.disabledOpacity};cursor:default}`,
  // Slider: the readout row is the element's own; the filled part of the track and the thumb are ink.
  'happier-slider{display:block}',
  `happier-slider input[type=range]{-webkit-appearance:none;appearance:none;display:block;width:100%;height:${px(slider.thumbSizePx)};margin:${px(data.axisGapPx)} 0 0;background:transparent;cursor:pointer}`,
  `happier-slider input[type=range]::-webkit-slider-runnable-track{height:${px(slider.trackHeightPx)};border-radius:${px(slider.trackHeightPx / 2)};` +
    `background:linear-gradient(to right,${colors.text} var(--happier-slider-fill,50%),${palette.switchTrackOff} var(--happier-slider-fill,50%))}`,
  `happier-slider input[type=range]::-moz-range-track{height:${px(slider.trackHeightPx)};border-radius:${px(slider.trackHeightPx / 2)};background:${palette.switchTrackOff}}`,
  `happier-slider input[type=range]::-moz-range-progress{height:${px(slider.trackHeightPx)};border-radius:${px(slider.trackHeightPx / 2)};background:${colors.text}}`,
  `happier-slider input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;box-sizing:border-box;width:${px(slider.thumbSizePx)};height:${px(slider.thumbSizePx)};` +
    `margin-top:${px((slider.trackHeightPx - slider.thumbSizePx) / 2)};border-radius:50%;background:${colors.text};border:${px(slider.thumbRingWidthPx)} solid ${palette.page}}`,
  `happier-slider input[type=range]::-moz-range-thumb{box-sizing:border-box;width:${px(slider.thumbSizePx)};height:${px(slider.thumbSizePx)};border-radius:50%;` +
    `background:${colors.text};border:${px(slider.thumbRingWidthPx)} solid ${palette.page}}`,
  `happier-slider input[type=range]:disabled{opacity:${slider.disabledOpacity};cursor:default}`,
  // Stats: a label, the figure in <b>/<strong>, context in <small>; a row of them is one <happier-stats>.
  `happier-stats{display:flex;flex-wrap:wrap;row-gap:${px(data.blockGapPx)}}`,
  `happier-stats>happier-stat{flex:1 1 0;padding:0 ${spacingMedium}}`,
  'happier-stats>happier-stat:first-child{padding-left:0}',
  `happier-stats>happier-stat+happier-stat{border-left:1px solid ${palette.rowDivider}}`,
  'happier-stat{display:block}',
  'happier-stat>*{display:block;margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  `happier-stat>:not(b,strong,small){color:${colors.secondaryText}}`,
  `happier-stat>:is(b,strong){font-size:${px(stat.fontSize)};line-height:${px(stat.lineHeight)};font-weight:${HAPPIER_TYPE_WEIGHT[stat.weight]};` +
    `letter-spacing:${px(stat.letterSpacing)};font-variant-numeric:tabular-nums;color:var(--happier-stat-tone,${colors.text})}`,
  `happier-stat>small{font-size:${caption.size};line-height:${caption.lineHeight};color:${colors.mutedText}}`,
  ...(['success', 'warning', 'attention', 'danger'] as const).map(
    (tone) => `happier-stat[tone=${tone}]{--happier-stat-tone:${colors[tone]}}`,
  ),
  // Field select over the native <select>; the chevron is the disclosure caret's geometry.
  `happier-select{position:relative;display:inline-block;min-width:${px(field.triggerMinWidthPx)};vertical-align:middle}`,
  `happier-select>select{-webkit-appearance:none;appearance:none;box-sizing:border-box;width:100%;min-height:${px(field.minHeightPx)};margin:0;` +
    `padding:0 ${px(field.paddingRightPx + field.triggerGapPx + chevron.glyphPx)} 0 ${px(field.paddingLeftPx)};font:inherit;font-size:${label.size};line-height:${label.lineHeight};` +
    `color:${colors.text};background:${palette.fieldBackground};border:${px(field.borderWidthPx)} solid ${palette.controlBorder};border-radius:${radiusControl};cursor:pointer}`,
  `happier-select>select:disabled{opacity:${segmented.disabledOpacity};cursor:default}`,
  `happier-select::after{content:"";position:absolute;right:${px(field.paddingRightPx + (chevron.glyphPx - chevronArmPx) / 2)};top:50%;width:${px(chevronArmPx)};height:${px(chevronArmPx)};pointer-events:none;` +
    `border-right:${px(chevron.strokePx)} solid ${colors.secondaryText};border-bottom:${px(chevron.strokePx)} solid ${colors.secondaryText};transform:translateY(-70%) rotate(45deg)}`,
  // Switch over a native checkbox; the thumb is a gradient so no pseudo-element on <input> is needed.
  'happier-toggle{display:block}',
  `happier-toggle>label{display:flex;align-items:center;justify-content:space-between;gap:${spacingMedium};cursor:pointer}`,
  `happier-toggle input[type=checkbox]{-webkit-appearance:none;appearance:none;flex:none;width:${px(switchBox.trackWidth)};height:${px(switchBox.trackHeight)};margin:0;border-radius:${px(switchBox.trackHeight / 2)};cursor:pointer;` +
    `background-color:${palette.switchTrackOff};background-image:radial-gradient(circle,${palette.switchThumb} ${px(switchBox.thumbSize / 2 - 0.5)},transparent ${px(switchBox.thumbSize / 2)});` +
    `background-size:${px(switchBox.trackHeight)} ${px(switchBox.trackHeight)};background-repeat:no-repeat;background-position:0 0;` +
    `transition:background-color ${ms(HAPPIER_MOTION_V1.fastMs)} ${ease},background-position ${ms(HAPPIER_MOTION_V1.baseMs)} ${ease}}`,
  `happier-toggle input[type=checkbox]:checked{background-color:${palette.switchTrackOn};background-position:${px(switchBox.trackWidth - switchBox.trackHeight)} 0}`,
  `happier-toggle input[type=checkbox]:disabled{opacity:${HAPPIER_SWITCH_METRICS.disabledOpacity};cursor:default}`,
  // Legend: one swatch per child, in the series order a chart can reuse (--happier-series-N), or --happier-swatch.
  `happier-legend{display:flex;flex-wrap:wrap;align-items:center;column-gap:${px(data.blockGapPx)};row-gap:${px(data.axisGapPx)};font-size:${caption.size};line-height:${caption.lineHeight};color:${colors.secondaryText}}`,
  `happier-legend>*{display:inline-flex;align-items:center;gap:${px(data.axisGapPx)}}`,
  `happier-legend>*::before{content:"";flex:none;width:${px(data.legendSwatchPx)};height:${px(data.legendSwatchPx)};border-radius:${px(data.legendSwatchRadiusPx)};background:var(--happier-swatch,var(--happier-series-1))}`,
  'happier-legend>:nth-child(2)::before{background:var(--happier-swatch,var(--happier-series-2))}',
  'happier-legend>:nth-child(3)::before{background:var(--happier-swatch,var(--happier-series-3))}',
  // Quiet table: the data table's cell padding and column gap; the first column names the row, the rest are figures.
  'happier-table{display:block;overflow-x:auto}',
  'happier-table>table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}',
  `happier-table th{padding:0 ${px(data.columnGapPx)} ${px(data.cellPaddingVerticalPx)} 0;font-weight:${HAPPIER_TYPE_WEIGHT.regular};font-size:${caption.size};line-height:${caption.lineHeight};color:${colors.secondaryText};text-align:start;white-space:nowrap}`,
  `happier-table td{padding:${px(data.cellPaddingVerticalPx)} ${px(data.columnGapPx)} ${px(data.cellPaddingVerticalPx)} 0;border-top:1px solid ${palette.rowDivider};text-align:start;vertical-align:baseline}`,
  'happier-table :is(th,td):not(:first-child){text-align:end}',
  'happier-table :is(th,td):last-child{padding-right:0}',
  // Buttons: bordered secondary by default (field box inside and outline), filled with variant="primary".
  `happier-button{display:inline-flex;width:fit-content;flex-wrap:wrap;gap:${px(HAPPIER_PAGE_METRICS.actionGapPx)}}`,
  `happier-button>button{-webkit-appearance:none;appearance:none;box-sizing:border-box;min-height:${px(HAPPIER_PAGE_METRICS.controlHeightPx)};margin:0;` +
    `padding:${px(HAPPIER_BUTTON_METRICS.paddingVerticalPx)} calc(${spacingLarge} + ${px(HAPPIER_BUTTON_METRICS.edgeWidthPx - 1)});font:inherit;font-size:${label.size};line-height:${label.lineHeight};font-weight:${label.weight};` +
    `color:${colors.text};background:${palette.fieldBackground};border:1px solid ${palette.controlBorder};border-radius:${radiusControl};cursor:pointer;` +
    `transition:background-color ${ms(HAPPIER_MOTION_V1.hoverMs)} ${ease}}`,
  `happier-button[variant=primary]>button{padding:${px(HAPPIER_BUTTON_METRICS.paddingVerticalPx - (HAPPIER_BUTTON_METRICS.edgeWidthPx - 1))} ${spacingLarge};` +
    `color:${colors.onAccent};background:${colors.accent};border:${px(HAPPIER_BUTTON_METRICS.edgeWidthPx)} solid transparent}`,
  `happier-button>button:disabled{opacity:${HAPPIER_BUTTON_METRICS.disabledOpacity};cursor:default}`,
  '@media (prefers-reduced-motion:reduce){happier-tabs>label,happier-toggle input[type=checkbox],happier-button>button{transition:none}}',
].join('');

const SLIDER_SHADOW_CSS = [
  ':host{display:block}',
  `.head{display:flex;align-items:baseline;justify-content:space-between;gap:${px(HAPPIER_PAGE_METRICS.rowContentGapPx)}}`,
  '.head[hidden]{display:none}',
  `.label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:${colors.secondaryText}}`,
  `.value{flex:none;font-weight:${HAPPIER_TYPE_WEIGHT.semiBold};font-variant-numeric:tabular-nums;white-space:nowrap}`,
].join('');

/** The realm surface the kit needs; a realm without custom elements (a test VM) gets nothing. */
export type HappierHtmlKitRealm = Readonly<{
  document?: Document;
  customElements?: CustomElementRegistry;
  HTMLElement?: typeof HTMLElement;
}>;

/**
 * Install the kit once in a hosted document: the stylesheet first in `<head>` (so the author's own rules
 * still win by order) and the slider element. Stylesheets go in as `data:` links, which every hosted
 * document CSP admits, including generated archives.
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
      const labelText = this.getAttribute('label') ?? '';
      const unit = this.getAttribute('unit');
      this.#label.textContent = labelText;
      if (!input) {
        this.#value.textContent = '';
        this.#head.hidden = labelText.length === 0;
        return;
      }
      const shown = unit ? `${input.value} ${unit}` : input.value;
      this.#value.textContent = shown;
      this.#head.hidden = false;
      if (
        labelText &&
        !input.hasAttribute('aria-label') &&
        !input.labels?.length
      )
        input.setAttribute('aria-label', labelText);
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
