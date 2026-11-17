import type { SurfacePart } from '@happier-dev/plugin-sdk/ui';
import type { Theme } from '@/theme';
import { fixedThemePaint, tokenThemePaint, type ThemePaint, type ThemePaintFacets } from '@/theme/profiles/themePaint';

/** Card/timeline fills and supplied tool glyphs depend on the rendered instance. */
export function resolveToolRowPaint(theme: Theme, part: 'title' | 'detail', instanceColor?: string): Readonly<{ foreground: ThemePaint }>;
export function resolveToolRowPaint(theme: Theme, part: 'root' | 'icon', instanceColor?: string): Readonly<{ background: ThemePaint }>;
export function resolveToolRowPaint(theme: Theme, part: SurfacePart<'tool-row'>, instanceColor?: string): ThemePaintFacets;
export function resolveToolRowPaint(theme: Theme, part: SurfacePart<'tool-row'>, instanceColor = 'transparent'): ThemePaintFacets {
    return part === 'title' || part === 'detail'
        ? { foreground: tokenThemePaint(theme, part === 'title' ? 'text.primary' : 'text.secondary') }
        : { background: fixedThemePaint(instanceColor) };
}
