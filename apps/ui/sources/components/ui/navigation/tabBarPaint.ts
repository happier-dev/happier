import type { SurfacePart, ThemeSurfaceState } from '@happier-dev/plugin-sdk/ui';
import type { Theme } from '@/theme';
import { fixedThemePaint, tokenThemePaint, type ThemePaint, type ThemePaintFacets } from '@/theme/profiles/themePaint';

export function tabBarLabelPaint(theme: Theme, selected: boolean): ThemePaint {
    return tokenThemePaint(theme, selected ? 'text.primary' : 'text.secondary');
}

/** One address spans plain, pill, glass and segmented bars, custom labels and caller-owned glyphs. */
export function resolveTabBarPaint(theme: Theme, part: 'label',
    state?: ThemeSurfaceState<'tab-bar'>, instanceColor?: string): Readonly<{ foreground: ThemePaint }>;
export function resolveTabBarPaint(theme: Theme, part: 'root' | 'tab' | 'icon',
    state?: ThemeSurfaceState<'tab-bar'>, instanceColor?: string): Readonly<{ background: ThemePaint }>;
export function resolveTabBarPaint(theme: Theme, part: SurfacePart<'tab-bar'>,
    state?: ThemeSurfaceState<'tab-bar'>, instanceColor?: string): ThemePaintFacets;
export function resolveTabBarPaint(theme: Theme, part: SurfacePart<'tab-bar'>,
    state: ThemeSurfaceState<'tab-bar'> = 'default', instanceColor?: string): ThemePaintFacets {
    return part === 'label' ? { foreground: fixedThemePaint(instanceColor ?? tabBarLabelPaint(theme, state === 'selected').color) }
        : { background: fixedThemePaint(instanceColor ?? 'transparent') };
}
