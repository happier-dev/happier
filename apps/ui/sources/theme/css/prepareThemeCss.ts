import { isThemeSurfaceAddress, THEME_SURFACE_REGISTRY } from '@happier-dev/plugin-sdk/ui';
import type { SurfaceAddress } from '@happier-dev/plugin-sdk/ui';
import { convertNativeDeclaration } from './nativeDeclarations';
import type { NativeDeclarationStyle } from './nativeDeclarations';
import { themeCssResourceRejection } from './themeCssResourcePolicy';
import { acquireThemeCssParser, isThemeCssParserAcquired, parseThemeCss } from './cssTreeBoundary';
import type { CssNode } from './cssTreeBoundary';
import type {
    PreparedThemeCss, ThemeCssCoverage, ThemeCssDetailedCoverage, ThemeCssRange,
    ThemeCssRuleCoverage, ThemeSurfaceStyleTable,
} from './types';

type Mode = 'light' | 'dark';
type Reason = ThemeCssRuleCoverage['reasons'][number];
type Target = Readonly<{ address: SurfaceAddress; mode: Mode | 'both'; specificity: number }>;
type Candidate = Readonly<{
    target: Target;
    style: NativeDeclarationStyle;
    important: boolean;
    order: number;
    range: ThemeCssRange;
}>;
type Compiled = Readonly<{
    light: ThemeSurfaceStyleTable;
    dark: ThemeSurfaceStyleTable;
    coverage: ThemeCssCoverage;
    detailedCoverage: () => ThemeCssDetailedCoverage;
}>;

function range(node: CssNode): ThemeCssRange {
    if (!node.loc) throw new TypeError('CSS node has no authored source range');
    return { start: node.loc.start.offset, end: node.loc.end.offset, line: node.loc.start.line, column: node.loc.start.column };
}
function text(source: string, node: CssNode | null): string {
    return node?.loc ? source.slice(node.loc.start.offset, node.loc.end.offset) : '';
}
function isDarkClass(node: CssNode | undefined): boolean {
    return node?.type === 'ClassSelector' && node.name === 'dark';
}
function isRoot(node: CssNode | undefined): boolean {
    return node?.type === 'PseudoClassSelector' && node.name === 'root' && node.children.length === 0;
}
function isNotDark(node: CssNode | undefined): boolean {
    if (node?.type !== 'PseudoClassSelector' || node.name !== 'not' || node.children.length !== 1) return false;
    const list = node.children[0];
    const selector = list.children[0];
    return list.type === 'SelectorList' && list.children.length === 1 && selector?.type === 'Selector'
        && selector.children.length === 1 && isDarkClass(selector.children[0]);
}
function isRootSelector(selector: CssNode): boolean {
    const nodes = selector.children;
    return (nodes.length === 1 && (isRoot(nodes[0]) || isDarkClass(nodes[0])))
        || (nodes.length === 2 && isRoot(nodes[0]) && (isNotDark(nodes[1]) || isDarkClass(nodes[1])));
}
function addressKey(address: SurfaceAddress): string {
    return `${address.surface}/${address.part}/${address.state ?? ''}`;
}

/** Selector matching is AST-only; source text is used for values/ranges, never a second matcher. */
function target(selector: CssNode, source: string): Target | null {
    if (selector.type !== 'Selector' || text(source, selector).includes('\\')) return null;
    const nodes = selector.children;
    let offset = 0;
    let mode: Target['mode'] = 'both';
    let specificity = 0;
    if (isDarkClass(nodes[0]) && nodes[1]?.type === 'WhiteSpace') {
        mode = 'dark';
        specificity = 1;
        offset = 2;
    } else if (isRoot(nodes[0]) && isNotDark(nodes[1]) && nodes[2]?.type === 'WhiteSpace') {
        mode = 'light';
        specificity = 2;
        offset = 3;
    }
    const attributes = new Map<string, string>();
    for (const node of nodes.slice(offset)) {
        if (node.type !== 'AttributeSelector' || node.matcher !== '=' || node.flags !== null
            || !node.name || typeof node.name === 'string' || !node.value || typeof node.value === 'string') return null;
        const name = node.name.name;
        const value = node.value;
        if (typeof name !== 'string' || attributes.has(name)
            || (name !== 'data-surface' && name !== 'data-part' && name !== 'data-state')) return null;
        if (value.type === 'Identifier' && typeof value.name === 'string') attributes.set(name, value.name);
        else if (value.type === 'String' && typeof value.value === 'string') attributes.set(name, value.value.slice(1, -1));
        else return null;
        specificity++;
    }
    const surface = attributes.get('data-surface');
    const part = attributes.get('data-part') ?? 'root';
    const state = attributes.get('data-state');
    if (!surface || !isThemeSurfaceAddress(surface, part, state ?? 'default')) return null;
    const parts: Readonly<Record<string, Readonly<{ kind: 'view' | 'text'; platform?: 'web' }>>> = THEME_SURFACE_REGISTRY[surface as keyof typeof THEME_SURFACE_REGISTRY].parts;
    if (parts[part].platform === 'web') return null;
    // The canonical registry has validated the correlated surface/part/state relationship.
    const address = (state === undefined ? { surface, part } : { surface, part, state }) as SurfaceAddress;
    return { address, mode, specificity };
}

/** Raw parser recovery is one unresolved authored block; never parse it again. */
function unresolvedRule(node: CssNode, source: string): ThemeCssRuleCoverage {
    return {
        ruleIndex: -1,
        range: range(node),
        selector: text(source, node),
        native: false,
        reasons: [{ kind: 'syntax', range: range(node) }],
    };
}

/** v1 can recover implicit nested selectors as Declaration(property, Raw). */
function unresolvedDeclaration(node: CssNode): boolean {
    return node.type === 'Declaration' && !node.property?.startsWith('--')
        && typeof node.value === 'object' && node.value?.type === 'Raw'
        && typeof node.value.value === 'string' && node.value.value.includes('{');
}

function wins(candidate: Candidate, previous: Candidate): boolean {
    if (candidate.important !== previous.important) return candidate.important;
    if (candidate.target.specificity !== previous.target.specificity) return candidate.target.specificity > previous.target.specificity;
    return candidate.order >= previous.order;
}

function compile(source: string): Compiled {
    const ast = parseThemeCss(source);
    const rules: ThemeCssRuleCoverage[] = [];
    const stripped: ThemeCssDetailedCoverage['stripped'][number][] = [];
    const candidates = new Map<string, Candidate[]>();
    const affected = new Map<string, SurfaceAddress>();
    let sourceOrder = 0;
    const declaration = (node: CssNode): Readonly<{ property: string; value: string; rejection: string | null }> => {
        const authoredProperty = node.property ?? '';
        const property = authoredProperty.startsWith('--') ? authoredProperty : authoredProperty.toLowerCase();
        const value = typeof node.value === 'object' ? text(source, node.value) : node.value ?? '';
        const rejection = themeCssResourceRejection(property) ?? themeCssResourceRejection(value);
        if (rejection) stripped.push({ range: range(node), reason: rejection });
        return { property, value, rejection };
    };
    const visit = (node: CssNode, conditional: boolean): void => {
        if (node.type === 'Raw') {
            if (typeof node.value === 'string' && node.value.includes('{')) rules.push(unresolvedRule(node, source));
            return;
        }
        if (node.type !== 'Rule') {
            if (node.type === 'Declaration') { declaration(node); return; }
            if (node.type === 'Atrule' && node.prelude) {
                const rejection = themeCssResourceRejection(text(source, node.prelude), 'prelude');
                if (rejection) stripped.push({ range: range(node.prelude), reason: rejection });
            }
            for (const child of node.children) visit(child, conditional || node.type === 'Atrule');
            if (node.block) visit(node.block, conditional || node.type === 'Atrule');
            return;
        }
        const authoredRange = range(node);
        const selector = text(source, node.prelude);
        const selectors = node.prelude?.type === 'SelectorList' ? node.prelude.children : [];
        const declarations = node.block?.children.filter((child) => child.type === 'Declaration' && !unresolvedDeclaration(child)) ?? [];
        const converted = declarations.map((item) => ({ node: item, ...declaration(item) }));
        const variableRoot = declarations.length > 0 && declarations.every((item) => item.property?.startsWith('--'))
            && selectors.length > 0 && selectors.every(isRootSelector);
        const reasons: Reason[] = [];
        const rejection = themeCssResourceRejection(selector, 'prelude');
        if (rejection) {
            stripped.push({ range: node.prelude ? range(node.prelude) : authoredRange, reason: rejection });
            reasons.push({ kind: 'stripped', range: node.prelude ? range(node.prelude) : authoredRange });
        }
        const targets = selectors.map((item) => target(item, source));
        const matchable = !rejection && targets.length > 0 && targets.every((item) => item !== null);
        if (conditional) reasons.push({ kind: 'condition', range: authoredRange });
        if (!matchable) reasons.push({ kind: 'selector', range: node.prelude ? range(node.prelude) : authoredRange });
        for (const item of converted) {
            const order = sourceOrder++;
            if (item.rejection) { reasons.push({ kind: 'stripped', range: range(item.node), property: item.property }); continue; }
            const kinds = new Set<'view' | 'text'>();
            for (const selected of targets) {
                if (!selected) continue;
                const parts: Readonly<Record<string, Readonly<{ kind: 'view' | 'text' }>>> = THEME_SURFACE_REGISTRY[selected.address.surface].parts;
                kinds.add(parts[selected.address.part].kind);
            }
            // Unsupported selectors still receive useful property/value diagnostics.
            if (kinds.size === 0) kinds.add('view');
            const conversions = new Map(Array.from(kinds, (kind) => [kind, convertNativeDeclaration(item.property, item.value, kind)] as const));
            for (const conversion of conversions.values()) {
                if (!conversion.supported) reasons.push({ kind: conversion.reason, range: range(item.node), property: item.property });
            }
            if (conditional || !matchable) continue;
            for (const selected of targets) {
                if (!selected) continue;
                const parts: Readonly<Record<string, Readonly<{ kind: 'view' | 'text' }>>> = THEME_SURFACE_REGISTRY[selected.address.surface].parts;
                const conversion = conversions.get(parts[selected.address.part].kind);
                if (!conversion?.supported) continue;
                const key = `${selected.address.surface}/${selected.address.part}`;
                const bucket = candidates.get(key) ?? [];
                bucket.push({ target: selected, style: conversion.style, important: item.node.important, order, range: range(item.node) });
                candidates.set(key, bucket);
                affected.set(addressKey(selected.address), selected.address);
            }
        }
        for (const child of node.block?.children ?? []) {
            if (child.type === 'Raw' && !(typeof child.value === 'string' && child.value.includes('{'))) {
                reasons.push({ kind: 'syntax', range: range(child) });
            }
        }
        if (!variableRoot) rules.push({ ruleIndex: -1, range: authoredRange, selector, native: reasons.length === 0, reasons });
        for (const child of node.block?.children ?? []) {
            if (unresolvedDeclaration(child)) rules.push(unresolvedRule(child, source));
            else if (child.type !== 'Declaration') visit(child, true);
        }
    };
    visit(ast, false);

    const hidden = new Map<string, { address: SurfaceAddress; range: ThemeCssRange; mode: Mode | 'both' }>();
    const table = (mode: Mode): ThemeSurfaceStyleTable => {
        const result: Record<string, Record<string, { base: NativeDeclarationStyle; states: Record<string, NativeDeclarationStyle> }>> = {};
        for (const bucket of candidates.values()) {
            const { surface, part } = bucket[0].target.address;
            const finalDisplays = new Map<string, Readonly<{ candidate: Candidate; value: string | number }>>();
            const resolved = (state: string): NativeDeclarationStyle => {
                const properties = new Map<string, { candidate: Candidate; value: string | number }>();
                for (const candidate of bucket) {
                    if (candidate.target.mode !== 'both' && candidate.target.mode !== mode) continue;
                    if (candidate.target.address.state !== undefined && candidate.target.address.state !== state) continue;
                    for (const [property, value] of Object.entries(candidate.style)) {
                        const previous = properties.get(property);
                        if (!previous || wins(candidate, previous.candidate)) properties.set(property, { candidate, value });
                    }
                }
                const style: Record<string, string | number> = {};
                for (const [property, winner] of properties) style[property] = winner.value;
                const display = properties.get('display');
                if (display) finalDisplays.set(state, display);
                return style;
            };
            const states: Record<string, NativeDeclarationStyle> = {};
            const base = resolved('default');
            for (const state of THEME_SURFACE_REGISTRY[surface].states) {
                if (state !== 'default') states[state] = resolved(state);
            }
            const defaultDisplay = finalDisplays.get('default');
            const uniformlyHidden = defaultDisplay?.value === 'none' && THEME_SURFACE_REGISTRY[surface].states.every((state) => {
                const display = finalDisplays.get(state);
                return display?.value === 'none' && display.candidate.range.start === defaultDisplay.candidate.range.start;
            });
            for (const [state, display] of finalDisplays) {
                if (display.value === 'none' && (!uniformlyHidden || state === 'default')) {
                    // The registry already admits each semantic state enumerated here.
                    // Collapse unqualified uniform hiding; retain explicit default if another state shows.
                    const address = (uniformlyHidden ? { surface, part } : { surface, part, state }) as SurfaceAddress;
                    const key = `${addressKey(address)}/${display.candidate.range.start}/${display.candidate.range.end}`;
                    const existing = hidden.get(key);
                    if (existing && existing.mode !== mode) existing.mode = 'both';
                    else hidden.set(key, { address, range: display.candidate.range, mode });
                }
            }
            (result[surface] ??= {})[part] = { base, states };
        }
        // Addresses came from the registry and values from the conversion owner.
        return result as ThemeSurfaceStyleTable;
    };
    const light = table('light');
    const dark = table('dark');
    const indexedRules = rules.map((item, ruleIndex) => ({ ...item, ruleIndex }));
    const native = indexedRules.filter((item) => item.native).length;
    const coverage: ThemeCssCoverage = {
        total: indexedRules.length,
        native,
        webOnly: indexedRules.length - native,
        affectedSurfaces: Array.from(affected.values()),
        hides: Array.from(hidden.values()),
    };
    let detailed: ThemeCssDetailedCoverage | undefined;
    return {
        light, dark, coverage,
        detailedCoverage: () => detailed ??= { ...coverage, rules: indexedRules, stripped },
    };
}

const emptySurfaces: ThemeSurfaceStyleTable = {};
const emptyCoverage: ThemeCssCoverage = { total: 0, native: 0, webOnly: 0, affectedSurfaces: [], hides: [] };
const emptyDetailedCoverage: ThemeCssDetailedCoverage = { ...emptyCoverage, rules: [], stripped: [] };
const emptyCompilation: Compiled = {
    light: emptySurfaces, dark: emptySurfaces, coverage: emptyCoverage,
    detailedCoverage: () => emptyDetailedCoverage,
};

const profilePreparations = new WeakMap<Readonly<{ css?: string }>, PreparedThemeCss>();
// Profile DTOs are cloned by selection and metadata updates. Content is the only
// compiler input; weak values avoid retaining every CSS edit for the app lifetime.
const sourcePreparations = new Map<string, WeakRef<PreparedThemeCss>>();

/** Editor Which navigation retains the compiler's authored ranges and rule identities. */
export function getThemeCssWebOnlyRules(prepared: PreparedThemeCss): readonly ThemeCssRuleCoverage[] {
    return prepared.detailedCoverage.rules.filter(rule => !rule.native);
}

/** A retained profile body is shared by preview facts and native application. */
export function prepareThemeProfileCss(profile: Readonly<{ css?: string }>): PreparedThemeCss {
    const existing = profilePreparations.get(profile);
    if (existing) return existing;
    const prepared = prepareThemeCss(profile.css ?? '');
    profilePreparations.set(profile, prepared);
    return prepared;
}

/** Async entry points acquire the parser before exposing synchronous projections. */
export async function prepareThemeCssAsync(source: string): Promise<PreparedThemeCss> {
    if (source.trim() !== '') await acquireThemeCssParser();
    return prepareThemeCss(source);
}

export async function prepareThemeProfileCssAsync(profile: Readonly<{ css?: string }>): Promise<PreparedThemeCss> {
    if (profile.css?.trim()) await acquireThemeCssParser();
    return prepareThemeProfileCss(profile);
}

/** Rendering/startup can keep its palette while first-use acquisition is pending. */
export function readPreparedThemeCss(source: string): PreparedThemeCss | null {
    return source.trim() === '' || isThemeCssParserAcquired() ? prepareThemeCss(source) : null;
}

export function readPreparedThemeProfileCss(profile: Readonly<{ css?: string }>): PreparedThemeCss | null {
    return readPreparedThemeCss(profile.css ?? '') ? prepareThemeProfileCss(profile) : null;
}

/** Source-only web application does no native parse; projection reads share one compilation. */
export function prepareThemeCss(source: string): PreparedThemeCss {
    const existing = sourcePreparations.get(source)?.deref();
    if (existing) return existing;
    let compilation: Readonly<{ ok: true; value: Compiled } | { ok: false; error: unknown }> | undefined;
    const get = (): Compiled => {
        if (!compilation) {
            try { compilation = { ok: true, value: source.trim() === '' ? emptyCompilation : compile(source) }; }
            catch (error) { compilation = { ok: false, error }; }
        }
        if (!compilation.ok) throw compilation.error;
        return compilation.value;
    };
    const prepared: PreparedThemeCss = {
        source,
        get light() { return get().light; },
        get dark() { return get().dark; },
        get coverage() { return get().coverage; },
        get detailedCoverage() { return get().detailedCoverage(); },
    };
    const ref = new WeakRef(prepared);
    // Retired profile bodies no longer retain their CSS or AST projections.
    for (const [key, value] of sourcePreparations) if (!value.deref()) sourcePreparations.delete(key);
    sourcePreparations.set(source, ref);
    return prepared;
}
