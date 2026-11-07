import Color from 'color';
import type { ReactTestInstance } from 'react-test-renderer';
import { flattenTestStyle } from '../harness/popoverHarness';

/**
 * What a browser paints for a material `backgroundColor` under the document's published glass variables
 * (`resolveGlassPresentationVariables`): resolves `var(--x, fallback)` the way CSS does, then a
 * `color-mix(in srgb, A p%, B)` at the 0%/100% ends the material publishes. A partial mix is composed in sRGB; an unparseable one is returned as is.
 */
export function resolveGlassPaint(paint: string, variables: Readonly<Record<string, string>>): string {
    let out = paint;
    for (let guard = 0; guard < 20 && out.includes('var('); guard += 1) {
        out = out.replace(/var\((--[\w-]+)(?:,\s*((?:[^()]|\((?:[^()]|\([^()]*\))*\))*))?\)/, (_match, name: string, fallback?: string) =>
            variables[name] ?? fallback ?? '');
    }
    const mix = /^color-mix\(in srgb, (.+) ([\d.]+)%, (.+)\)$/.exec(out.trim());
    if (!mix) return out.trim();
    if (Number(mix[2]) === 100) return mix[1];
    if (Number(mix[2]) === 0) return mix[3];
    return mixSrgb(mix[1], mix[3], Number(mix[2]) / 100) ?? out.trim();
}

/** CSS Color 5 `color-mix(in srgb, …)`: alpha-premultiplied interpolation of two parseable colours. */
function mixSrgb(first: string, second: string, weight: number): string | null {
    let a: ReturnType<typeof Color>; let b: ReturnType<typeof Color>;
    try { a = Color(first); b = Color(second); } catch { return null; }
    const alpha = a.alpha() * weight + b.alpha() * (1 - weight);
    if (alpha === 0) return 'transparent';
    const [ar, ag, ab] = a.rgb().array(); const [br, bg, bb] = b.rgb().array();
    const channel = (x: number, y: number) => (x * a.alpha() * weight + y * b.alpha() * (1 - weight)) / alpha;
    return Color.rgb(channel(ar!, br!), channel(ag!, bg!), channel(ab!, bb!)).alpha(alpha).rgb().string();
}

/**
 * The glass variables a browser resolves at `node`: the document's published values, overridden by
 * each ancestor's inline custom properties (nearest wins). A custom property set to `initial` is
 * guaranteed-invalid in CSS, so `var()` falls back past it.
 */
export function readGlassVariablesAt(node: ReactTestInstance, documentVariables: Readonly<Record<string, string>>): Record<string, string> {
    const chain: ReactTestInstance[] = [];
    for (let current: ReactTestInstance | null = node; current; current = current.parent) chain.push(current);
    const variables: Record<string, string> = { ...documentVariables };
    for (const host of chain.reverse()) {
        for (const [name, value] of Object.entries(flattenTestStyle(host.props?.style))) {
            if (!name.startsWith('--') || typeof value !== 'string') continue;
            if (value === 'initial') delete variables[name]; else variables[name] = value;
        }
    }
    return variables;
}
