export const HAPPIER_UI_FONT_SCALE_CSS_VAR = '--happier-ui-font-scale';
export const HAPPIER_UI_FONT_OVERRIDE_STYLE_ELEMENT_ID = 'happier-ui-font-scale-overrides';

export type UnistylesFontMetric = Readonly<{
    fontSize?: string;
    lineHeight?: string;
    letterSpacing?: string;
}>;

type UnistylesFontRule = Readonly<{
    selectorText: string;
    media: readonly string[];
    metric: UnistylesFontMetric;
}>;

function isCssStyleRule(rule: CSSRule): rule is CSSStyleRule {
    return rule.type === 1;
}

function isCssGroupingRule(rule: CSSRule): rule is CSSGroupingRule {
    return 'cssRules' in rule && rule.type !== 1;
}

function isPx(value: string): boolean {
    return typeof value === 'string' && /^\s*-?\d+(\.\d+)?px\s*$/.test(value);
}

function isUnitlessNumber(value: string): boolean {
    return typeof value === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(value);
}

function normalizeCssNumber(value: string): string | null {
    const trimmed = String(value ?? '').trim();
    if (!trimmed) return null;
    if (isPx(trimmed)) return trimmed.replace(/\s+/g, '');
    if (isUnitlessNumber(trimmed)) return trimmed;
    return null;
}

function pickMetricFromRule(rule: CSSStyleRule): UnistylesFontMetric | null {
    const fontSize = normalizeCssNumber(rule.style.fontSize || rule.style.getPropertyValue('font-size'));
    const lineHeight = normalizeCssNumber(rule.style.lineHeight || rule.style.getPropertyValue('line-height'));
    const letterSpacing = normalizeCssNumber(rule.style.letterSpacing || rule.style.getPropertyValue('letter-spacing'));

    if (!fontSize && !lineHeight && !letterSpacing) return null;
    return {
        ...(fontSize ? { fontSize } : null),
        ...(lineHeight ? { lineHeight } : null),
        ...(letterSpacing ? { letterSpacing } : null),
    };
}

function collectRuleFontMetrics(
    rule: CSSRule,
    cache: Map<string, UnistylesFontRule>,
    observeRule?: (rule: CSSRule) => void,
): number {
    observeRule?.(rule);
    let added = 0;
    if (isCssStyleRule(rule)) {
        const selectorText = rule.selectorText ?? '';
        if (!selectorText.includes('unistyles_')) return 0;
        const metric = pickMetricFromRule(rule);
        if (!metric) return 0;
        // Unistyles emits responsive metrics under @media, and child styles as
        // `.unistyles_hash_child > *`. Keep that exact CSS scope in the override.
        const media: string[] = [];
        for (let parent = rule.parentRule; parent; parent = parent.parentRule) {
            if (parent.type === 4) media.unshift((parent as CSSMediaRule).conditionText);
        }
        const key = JSON.stringify([media, selectorText]);
        const previous = cache.get(key)?.metric;
        if (!previous || previous.fontSize !== metric.fontSize || previous.lineHeight !== metric.lineHeight
            || previous.letterSpacing !== metric.letterSpacing) {
            cache.set(key, { selectorText, media, metric });
            added++;
        }
    } else if (isCssGroupingRule(rule)) {
        for (const child of Array.from(rule.cssRules)) added += collectRuleFontMetrics(child, cache, observeRule);
    }
    return added;
}

function collectSheetFontMetrics(sheet: CSSStyleSheet, cache: Map<string, UnistylesFontRule>, observeRule?: (rule: CSSRule) => void): number {
    try {
        return Array.from(sheet.cssRules).reduce((added, rule) => added + collectRuleFontMetrics(rule, cache, observeRule), 0);
    } catch {
        // Cross-origin sheets can be inaccessible; they were never admitted font sources.
        return 0;
    }
}

function scanDocumentForUnistylesFontMetrics(
    document: Document,
    cache: Map<string, UnistylesFontRule>,
    observeRule?: (rule: CSSRule) => void,
): number {
    let added = 0;
    for (const sheet of Array.from(document.styleSheets)) {
        added += collectSheetFontMetrics(sheet, cache, observeRule);
    }

    return added;
}

function ensureOverrideStyleElement(document: Document): HTMLStyleElement {
    const existing = document.getElementById(HAPPIER_UI_FONT_OVERRIDE_STYLE_ELEMENT_ID);
    if (existing && existing.tagName.toLowerCase() === 'style') {
        return existing as HTMLStyleElement;
    }

    const style = document.createElement('style');
    style.id = HAPPIER_UI_FONT_OVERRIDE_STYLE_ELEMENT_ID;
    style.setAttribute?.('data-happier', 'ui-font-scale-overrides');
    style.textContent = `[data-happier-ui-font-scaling="disabled"] { ${HAPPIER_UI_FONT_SCALE_CSS_VAR}: 1; }\n`;
    document.head.appendChild(style);
    return style;
}

function buildOverrideRule({ selectorText, media, metric }: UnistylesFontRule): string {
    const parts: string[] = [];
    if (metric.fontSize) {
        parts.push(`font-size: calc(${metric.fontSize} * var(${HAPPIER_UI_FONT_SCALE_CSS_VAR})) !important;`);
    }
    if (metric.lineHeight) {
        parts.push(`line-height: calc(${metric.lineHeight} * var(${HAPPIER_UI_FONT_SCALE_CSS_VAR})) !important;`);
    }
    if (metric.letterSpacing) {
        parts.push(`letter-spacing: calc(${metric.letterSpacing} * var(${HAPPIER_UI_FONT_SCALE_CSS_VAR})) !important;`);
    }
    if (parts.length === 0) return '';
    let rule = `${selectorText} { ${parts.join(' ')} }`;
    for (const condition of [...media].reverse()) rule = `@media ${condition} { ${rule} }`;
    return `${rule}\n`;
}

function syncOverrideStyleElement(
    styleEl: HTMLStyleElement,
    cache: Map<string, UnistylesFontRule>,
): number {
    let appended = 0;
    let next = `[data-happier-ui-font-scaling="disabled"] { ${HAPPIER_UI_FONT_SCALE_CSS_VAR}: 1; }\n`;

    for (const fontRule of cache.values()) {
        const rule = buildOverrideRule(fontRule);
        if (!rule) continue;
        next += rule;
        appended += 1;
    }

    if (next !== styleEl.textContent) {
        styleEl.textContent = next;
    }

    return appended;
}

export function setRootCssVar(document: Document, scale: number): void {
    const root = document.documentElement;
    if (!root?.style?.setProperty) return;
    const value =
        typeof scale === 'number' && Number.isFinite(scale)
            ? String(scale)
            : '1';
    root.style.setProperty(HAPPIER_UI_FONT_SCALE_CSS_VAR, value);
}

type FontObservation = { consumers: number; stop: () => void };
const fontObservations = new WeakMap<Document, FontObservation>();

/** App and embed roots share one document's CSS observation, not a frame clock. */
export function observeDocumentUnistylesFontMetrics(document: Document): () => void {
    let observation = fontObservations.get(document);
    if (!observation) {
        const cache = new Map<string, UnistylesFontRule>();
        const override = ensureOverrideStyleElement(document);
        let active = true;
        let publicationPending = false;
        const publishAdded = (added: number) => {
            if (added === 0 || publicationPending) return;
            publicationPending = true;
            // Preserve one publication for a synchronous CSS burst, before paint,
            // without allocating a frame or rescanning unrelated stylesheets.
            queueMicrotask(() => {
                publicationPending = false;
                if (active) syncOverrideStyleElement(override, cache);
            });
        };
        const refreshElement = (element: Element) => {
            if (element === override) return;
            if (element.tagName === 'STYLE' || element.tagName === 'LINK') {
                const sheet = (element as HTMLStyleElement | HTMLLinkElement).sheet;
                if (sheet) publishAdded(collectSheetFontMetrics(sheet, cache, observeRule));
            }
        };
        const restorers: (() => void)[] = [];
        const patched = new WeakSet<object>();
        // CSSOM writes do not emit DOM mutations. Unistyles inserts empty nested
        // rules and then fills cssText; observe those same boundaries as well.
        const patchProperty = (target: object, key: 'insertRule' | 'cssText', wrap: (descriptor: PropertyDescriptor) => PropertyDescriptor) => {
            let owner: object | null = target;
            while (owner && !Object.getOwnPropertyDescriptor(owner, key)) owner = Object.getPrototypeOf(owner);
            if (!owner || patched.has(owner)) return;
            const descriptor = Object.getOwnPropertyDescriptor(owner, key)!;
            const next = wrap(descriptor);
            Object.defineProperty(owner, key, next);
            patched.add(owner);
            const propertyOwner = owner;
            restorers.push(() => {
                const current = Object.getOwnPropertyDescriptor(propertyOwner, key);
                if (current?.value === next.value && current?.set === next.set) Object.defineProperty(propertyOwner, key, descriptor);
            });
        };
        const observeInsertions = (target: object) => patchProperty(target, 'insertRule', descriptor => ({
            ...descriptor,
            value: function (this: CSSStyleSheet | CSSGroupingRule, rule: string, index = 0) {
                const result = (descriptor.value as CSSStyleSheet['insertRule']).call(this, rule, index);
                if (active) publishAdded(collectRuleFontMetrics(this.cssRules[result]!, cache, observeRule));
                return result;
            },
        }));
        const observeRule = (rule: CSSRule) => {
            if (isCssGroupingRule(rule)) observeInsertions(rule);
            else if (isCssStyleRule(rule) && rule.selectorText.includes('unistyles_')) {
                patchProperty(rule.style, 'cssText', descriptor => ({
                    ...descriptor,
                    set: function (this: CSSStyleDeclaration, value: string) {
                        descriptor.set!.call(this, value);
                        if (active && this.parentRule) publishAdded(collectRuleFontMetrics(this.parentRule, cache, observeRule));
                    },
                }));
            }
        };
        const sheetPrototype = document.defaultView?.CSSStyleSheet?.prototype;
        if (sheetPrototype) observeInsertions(sheetPrototype);
        scanDocumentForUnistylesFontMetrics(document, cache, observeRule);
        syncOverrideStyleElement(override, cache);

        const Observer = document.defaultView?.MutationObserver;
        const observer = Observer ? new Observer(records => {
            for (const record of records) {
                const element = record.target.nodeType === 1 ? record.target as Element : record.target.parentElement;
                if (element) refreshElement(element);
                for (const node of Array.from(record.addedNodes)) {
                    if (node.nodeType === 1) refreshElement(node as Element);
                }
            }
        }) : null;
        observer?.observe(document.head, { childList: true, subtree: true, characterData: true });
        const onLoad = (event: Event) => {
            if (event.target && 'nodeType' in event.target && event.target.nodeType === 1) refreshElement(event.target as Element);
        };
        document.head.addEventListener('load', onLoad, true);
        observation = { consumers: 0, stop: () => {
            active = false;
            observer?.disconnect();
            document.head.removeEventListener('load', onLoad, true);
            for (const restore of restorers.reverse()) restore();
        } };
        fontObservations.set(document, observation);
    }
    observation.consumers++;
    const retained = observation;
    let released = false;
    return () => {
        if (released) return;
        released = true;
        if (--retained.consumers === 0) {
            retained.stop();
            fontObservations.delete(document);
        }
    };
}
