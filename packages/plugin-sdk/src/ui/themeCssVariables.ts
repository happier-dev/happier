/** @moduleRealm browser */
import type { PluginUiThemeV1 } from './hostApi.js';

/**
 * The `--happier-plugin-*` custom-property projection of the semantic theme
 * (§3.3), for a hosted-web surface.
 *
 * A hosted-web surface runs in its own isolated realm, so the host cannot inject
 * styles into it — only the guest can apply them, and only from the snapshot the
 * host negotiated. This is that projection: pure data in, `custom property ->
 * value` out, with no DOM access, so it is testable and reusable by an author
 * who wants to write the variables somewhere other than a style declaration.
 *
 * Every name derives mechanically from the theme's own field names, so a theme
 * field added at the Protocol owner reaches the variables without a second
 * hand-maintained mapping.
 */
export function buildPluginUiThemeCssVariables(
    theme: PluginUiThemeV1,
): Readonly<Record<string, string>> {
    const variables: Record<string, string> = {};
    for (const [name, value] of Object.entries(theme.colors)) {
        variables[`--happier-plugin-color-${toKebabCase(name)}`] = value;
    }
    for (const [name, value] of Object.entries(theme.spacing)) {
        variables[`--happier-plugin-spacing-${toKebabCase(name)}`] = `${value}px`;
    }
    for (const [name, value] of Object.entries(theme.radii)) {
        variables[`--happier-plugin-radius-${toKebabCase(name)}`] = `${value}px`;
    }
    for (const [style, values] of Object.entries(theme.typography)) {
        const prefix = `--happier-plugin-text-${toKebabCase(style)}`;
        variables[`${prefix}-size`] = `${values.fontSize}px`;
        variables[`${prefix}-line-height`] = `${values.lineHeight}px`;
        if ('fontWeight' in values && typeof values.fontWeight === 'string') {
            variables[`${prefix}-weight`] = values.fontWeight;
        }
        if ('fontFamily' in values && typeof values.fontFamily === 'string') {
            variables[`${prefix}-family`] = values.fontFamily;
        }
    }
    return Object.freeze(variables);
}

/** The minimal element surface this helper needs, so it is testable without a DOM. */
export interface PluginUiThemeVariableTarget {
    readonly style: Readonly<{ setProperty(property: string, value: string): void }>;
}

/**
 * Write the theme onto an element (normally `document.documentElement`).
 *
 * Idempotent and additive: re-applying a new snapshot after a `watchContext`
 * push overwrites the same custom properties, so a theme change repaints without
 * the surface re-rendering itself.
 */
export function applyPluginUiThemeCssVariables(
    theme: PluginUiThemeV1,
    target: PluginUiThemeVariableTarget,
): void {
    for (const [property, value] of Object.entries(buildPluginUiThemeCssVariables(theme))) {
        target.style.setProperty(property, value);
    }
}

function toKebabCase(value: string): string {
    return value.replace(/([a-z0-9])([A-Z])/gu, '$1-$2').toLowerCase();
}
