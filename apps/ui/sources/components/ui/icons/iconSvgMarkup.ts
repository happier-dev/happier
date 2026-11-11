import * as React from 'react';

import { getIconFamily, getIconStrokeWidth, useIconFamily, useIconStrokeWidth } from './iconFamily';
import type { IconName } from './Icon';
import { resolveHugeIconGlyph, useHugeIconRegistry } from './resolveHugeIconGlyph';
import { ICON_REGISTRY } from './iconRegistry.generated';

type SvgElementProps = Readonly<
  Record<string, unknown> & { children?: React.ReactNode }
>;

const SVG_ATTRIBUTE_NAMES: Readonly<Record<string, string>> = {
  strokeWidth: 'stroke-width',
  strokeLinecap: 'stroke-linecap',
  strokeLinejoin: 'stroke-linejoin',
  strokeMiterlimit: 'stroke-miterlimit',
  fillRule: 'fill-rule',
  clipRule: 'clip-rule',
};

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;');
}

function attributes(
  props: Readonly<Record<string, unknown>>,
  overrides: Readonly<Record<string, string>> = {},
): string {
  const entries = Object.entries({ ...props, ...overrides }).filter(
    ([name, value]) =>
      name !== 'key' &&
      name !== 'children' &&
      (typeof value === 'string' || typeof value === 'number'),
  );
  return entries
    .map(
      ([name, value]) =>
        ` ${SVG_ATTRIBUTE_NAMES[name] ?? name}="${escapeAttribute(String(value))}"`,
    )
    .join('');
}

/** Phosphor's regular drawing: plain path elements, read from the glyph's weight table. */
function phosphorMarkup(name: IconName): string | null {
  const Glyph = ICON_REGISTRY[name] as unknown as
    | ((
        props: object,
      ) => React.ReactElement<{ weights?: ReadonlyMap<string, unknown> }>)
    | undefined;
  if (typeof Glyph !== 'function') return null;
  const drawing = Glyph({}).props.weights?.get('regular');
  if (!React.isValidElement<SvgElementProps>(drawing)) return null;
  const paths: string[] = [];
  React.Children.forEach(drawing.props.children, (child) => {
    if (
      React.isValidElement<SvgElementProps>(child) &&
      typeof child.props.d === 'string'
    ) {
      paths.push(`<path${attributes({ d: child.props.d })}/>`);
    }
  });
  return paths.length === 0
    ? null
    : `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="black">${paths.join('')}</svg>`;
}

function hugeMarkup(
  drawing: readonly (readonly [string, Readonly<Record<string, unknown>>])[],
  strokeWidth: number,
): string {
  const elements = drawing.map(
    ([tag, props]) =>
      `<${tag}${attributes(props, {
        ...(props.stroke
          ? { stroke: 'black', strokeWidth: String(strokeWidth) }
          : {}),
        ...(props.fill && props.fill !== 'none' ? { fill: 'black' } : {}),
      })}/>`,
  );
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none">${elements.join('')}</svg>`;
}

/**
 * The selected family's drawing of a concept as standalone SVG markup, in black, for places that
 * can only paint a glyph from CSS (a mask over an element the app does not render itself). The
 * family decision is the `Icon` owner's; this only serialises what `Icon` would draw.
 */
export function readIconSvgMarkup(name: IconName): string | null {
  const huge = resolveHugeIconGlyph(name, 'regular', getIconFamily());
  if (huge)
    return hugeMarkup(
      huge as unknown as readonly (readonly [
        string,
        Readonly<Record<string, unknown>>,
      ])[],
      getIconStrokeWidth(),
    );
  return phosphorMarkup(name);
}

const DATA_URI_CACHE = new Map<string, string | null>();

/** `url("data:image/svg+xml,…")` for CSS `mask-image`, or null when the concept has no drawing. */
export function readIconSvgCssUrl(name: IconName): string | null {
  const key = `${getIconFamily()}\u0000${getIconStrokeWidth()}\u0000${name}`;
  if (!DATA_URI_CACHE.has(key)) {
    const markup = readIconSvgMarkup(name);
    DATA_URI_CACHE.set(
      key,
      markup ? `url("data:image/svg+xml,${encodeURIComponent(markup)}")` : null,
    );
  }
  return DATA_URI_CACHE.get(key) ?? null;
}

/** Republish CSS masks when the selected drawing becomes available or changes. */
export function useIconSvgCssUrlReader(enabled = true) {
  const family = useIconFamily();
  const stroke = useIconStrokeWidth();
  const registry = useHugeIconRegistry(enabled && family === 'hugeicons');
  return React.useCallback((name: IconName) => {
    if (family === 'hugeicons' && !registry) return null;
    return readIconSvgCssUrl(name);
  }, [family, stroke, registry]);
}
