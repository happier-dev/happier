import type { PluginTranslate } from './PluginUiProvider.js';

/**
 * The one rule for turning an author's `value` / `valueKey` pair into text.
 *
 * A key the plugin never declared resolves to the author-supplied fallback —
 * never to the raw key — so a missing translation degrades to readable English
 * instead of leaking `acme.plugin.some.key` into the interface. Every
 * plugin-facing component that accepts a translatable string routes through
 * here, so a second component cannot invent a different degradation rule.
 */
export function resolveAuthorText(
  translate: PluginTranslate,
  value: string | undefined,
  valueKey: string | undefined,
  fallback?: string,
): string | undefined {
  if (valueKey === undefined) return value;
  return translate(valueKey, fallback ?? value);
}
