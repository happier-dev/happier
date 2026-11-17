import type { Theme } from '@/theme';
import type { SurfacePart, ThemeSurfaceState } from '@happier-dev/plugin-sdk/ui';
import { fixedThemePaint, tokenThemePaint, type ThemePaint, type ThemePaintFacets } from '@/theme/profiles/themePaint';

type PickerPart = SurfacePart<'model-picker'> | SurfacePart<'project-picker'>;
type PickerState = ThemeSurfaceState<'model-picker'> | ThemeSurfaceState<'project-picker'>;

/** The provider heading is stable ink; option content, selection material and root plane belong to the list instance. */
export function resolveSelectionListPaint(theme: Theme, part: 'provider' | 'label', state?: PickerState, instanceColor?: string): Readonly<{ foreground: ThemePaint }>;
export function resolveSelectionListPaint(theme: Theme, part: 'root' | 'row' | 'effort', state?: PickerState, instanceColor?: string): Readonly<{ background: ThemePaint }>;
export function resolveSelectionListPaint(theme: Theme, part: PickerPart, state?: PickerState, instanceColor?: string): ThemePaintFacets;
export function resolveSelectionListPaint(theme: Theme, part: PickerPart, _state: PickerState = 'default', instanceColor = 'transparent'): ThemePaintFacets {
    return part === 'provider' || part === 'label'
        ? { foreground: part === 'provider' ? tokenThemePaint(theme, 'text.secondary') : fixedThemePaint(instanceColor) }
        : { background: fixedThemePaint(instanceColor) };
}
