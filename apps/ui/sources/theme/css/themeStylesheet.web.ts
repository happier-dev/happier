import type { ThemeStylesheetInput, ThemeStylesheetResult } from './themeStylesheet';
import { removeEscapedThemeCssTokens, themeCssResourceRejection } from './themeCssResourcePolicy';

type Stripping = ThemeStylesheetResult['stripped'][number];
type RuleContainer = Readonly<{ cssRules: CSSRuleList; deleteRule: (index: number) => void }>;
type StyledRule = CSSRule & Readonly<{ style: CSSStyleDeclaration }>;
type NestedStyleRule = StyledRule & Readonly<{ cssRules?: CSSRuleList; deleteRule?: (index: number) => void }>;

let installed: CSSStyleSheet | null = null;
let fallback: HTMLStyleElement | null = null;
let previousSource: string | null = null;
let previousResult: ThemeStylesheetResult | null = null;
let activeCss: string | null = null;
const subscribers = new Set<() => void>();

export const getThemeStylesheetCss = (): string | null => activeCss;
export function subscribeThemeStylesheet(listener: () => void): () => void {
    subscribers.add(listener);
    return () => { subscribers.delete(listener); };
}
function publishCss(css: string | null): void {
    if (css === activeCss) return;
    activeCss = css;
    for (const listener of subscribers) listener();
}

function sanitizeThemeSheet(sheet: CSSStyleSheet, stripped: Stripping[]): void {
    const declarations = (rule: StyledRule): void => {
        for (const property of Array.from(rule.style)) {
            const reason = themeCssResourceRejection(property) ?? themeCssResourceRejection(rule.style.getPropertyValue(property));
            if (!reason) continue;
            stripped.push({ reason, rule: rule.cssText, property });
            rule.style.removeProperty(property);
        }
    };
    const walk = (container: RuleContainer): void => {
        for (let index = container.cssRules.length - 1; index >= 0; index--) {
            const rule = container.cssRules[index];
            const kind = rule.constructor.name;
            if (kind === 'CSSStyleRule') {
                const styleRule = rule as CSSStyleRule & NestedStyleRule;
                const reason = themeCssResourceRejection(styleRule.selectorText, 'prelude');
                if (reason) { stripped.push({ reason, rule: rule.cssText }); container.deleteRule(index); continue; }
                declarations(styleRule);
                if (styleRule.cssRules && styleRule.deleteRule) {
                    walk({ cssRules: styleRule.cssRules, deleteRule: (childIndex) => styleRule.deleteRule!(childIndex) });
                }
                continue;
            }
            if (kind === 'CSSNestedDeclarations') { declarations(rule as StyledRule); continue; }
            if (kind === 'CSSKeyframesRule') {
                const frames = rule as CSSKeyframesRule;
                if (themeCssResourceRejection(frames.name, 'prelude')) {
                    stripped.push({ reason: 'resource-prelude', rule: rule.cssText }); container.deleteRule(index); continue;
                }
                for (let frameIndex = frames.cssRules.length - 1; frameIndex >= 0; frameIndex--) {
                    const frame = frames.cssRules[frameIndex] as CSSKeyframeRule;
                    if (frame.constructor.name !== 'CSSKeyframeRule' || themeCssResourceRejection(frame.keyText, 'prelude')) {
                        stripped.push({ reason: 'unsupported-keyframe', rule: frame.cssText });
                        frames.deleteRule(frame.keyText);
                    } else declarations(frame);
                }
                continue;
            }
            if (kind === 'CSSPropertyRule') {
                const property = rule as CSSRule & Readonly<{ initialValue: string | null }>;
                if (!property.initialValue || !themeCssResourceRejection(property.initialValue)) continue;
                stripped.push({ reason: 'resource-initial-value', rule: rule.cssText }); container.deleteRule(index); continue;
            }
            if (kind === 'CSSMediaRule' || kind === 'CSSSupportsRule' || kind === 'CSSContainerRule'
                || kind === 'CSSLayerBlockRule' || kind === 'CSSStartingStyleRule') {
                const prelude = rule.cssText.slice(0, rule.cssText.indexOf('{'));
                const reason = themeCssResourceRejection(prelude, 'prelude');
                if (reason) { stripped.push({ reason, rule: rule.cssText }); container.deleteRule(index); continue; }
                walk(rule as CSSGroupingRule);
                continue;
            }
            if (kind === 'CSSLayerStatementRule' && !themeCssResourceRejection(rule.cssText, 'prelude')) continue;
            stripped.push({ reason: 'unsupported-rule', rule: rule.cssText });
            container.deleteRule(index);
        }
    };
    walk(sheet);
}

export function applyThemeStylesheet(prepared: ThemeStylesheetInput | null, _mode: 'light' | 'dark'): ThemeStylesheetResult {
    // Unistyles owns the root mode class, including when no custom stylesheet is selected.
    if (typeof document === 'undefined') return { available: false, stripped: [], error: 'CSS is unavailable in this runtime' };
    if (prepared === null) {
        if (installed) document.adoptedStyleSheets = document.adoptedStyleSheets.filter((sheet) => sheet !== installed);
        fallback?.remove();
        installed = null;
        fallback = null;
        previousSource = null;
        previousResult = null;
        publishCss(null);
        return { available: true, stripped: [] };
    }
    if (prepared.source === previousSource && previousResult) {
        return previousResult;
    }
    let result: ThemeStylesheetResult;
    let sanitizedText: string;
    try {
        if (typeof CSSStyleSheet === 'undefined' || typeof CSSStyleSheet.prototype.replaceSync !== 'function') {
            return { available: false, stripped: [], error: 'This engine has no inert CSS parser' };
        }
        const stripped: Stripping[] = [];
        const escaped = removeEscapedThemeCssTokens(prepared.source);
        for (const rule of escaped.removed) stripped.push({ reason: 'escaped-token', rule });
        const candidate = new CSSStyleSheet();
        candidate.replaceSync(escaped.css);
        sanitizeThemeSheet(candidate, stripped);
        sanitizedText = Array.from(candidate.cssRules, (rule) => rule.cssText).join('\n');
        let adopted = false;
        if ('adoptedStyleSheets' in document) {
            try {
                document.adoptedStyleSheets = [...document.adoptedStyleSheets.filter((sheet) => sheet !== installed), candidate];
                adopted = true;
            } catch { /* A WebView may parse constructable sheets without supporting adoption. */ }
        }
        if (adopted) {
            installed = candidate;
            fallback?.remove();
            fallback = null;
        } else {
            if (installed) throw new Error('The previous theme sheet could not be replaced');
            const next = document.createElement('style');
            next.dataset.happierTheme = '';
            next.textContent = sanitizedText;
            document.head.append(next);
            fallback?.remove();
            fallback = next;
            installed = null;
        }
        previousSource = prepared.source;
        result = { available: true, sanitizedCss: sanitizedText, stripped };
        previousResult = result;
    } catch (error) {
        // A transient editing failure keeps the previous sheet and its appearance.
        return { available: false, stripped: [], error: error instanceof Error ? error.message : 'CSS could not be applied' };
    }
    publishCss(sanitizedText);
    return result;
}
