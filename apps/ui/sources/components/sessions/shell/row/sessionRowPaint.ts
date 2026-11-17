import type { SurfacePart, ThemeSurfaceState } from '@happier-dev/plugin-sdk/ui';
import { fixedThemePaint, tokenThemePaint, type ThemePaint, type ThemePaintFacets } from '@/theme/profiles/themePaint';
import type { SessionRowTitleColorRole } from './sessionRowTitleColorRole';

type RowTheme = Readonly<{ colors: Readonly<{ text: Readonly<{ primary: string; secondary: string; tertiary: string }> }> }>;
type RowPaintInstance = Readonly<{ color?: string; titleRole?: SessionRowTitleColorRole }>;

/** Selection alone does not select title/status ink: activity, roster and attention belong to each row. */
export function resolveSessionRowPaint(theme: RowTheme, part: 'title' | 'meta' | 'status',
    state?: ThemeSurfaceState<'session-row'>, instance?: RowPaintInstance): Readonly<{ foreground: ThemePaint }>;
export function resolveSessionRowPaint(theme: RowTheme, part: 'root',
    state?: ThemeSurfaceState<'session-row'>, instance?: RowPaintInstance): Readonly<{ background: ThemePaint }>;
export function resolveSessionRowPaint(theme: RowTheme, part: SurfacePart<'session-row'>,
    state?: ThemeSurfaceState<'session-row'>, instance?: RowPaintInstance): ThemePaintFacets;
export function resolveSessionRowPaint(theme: RowTheme, part: SurfacePart<'session-row'>,
    _state: ThemeSurfaceState<'session-row'> = 'default', instance?: RowPaintInstance): ThemePaintFacets {
    const color = instance?.color ?? 'transparent';
    return part === 'root' ? { background: fixedThemePaint(color) } : {
        foreground: instance?.titleRole ? tokenThemePaint(theme, `text.${instance.titleRole}`)
            : part === 'meta' && instance?.color === undefined ? tokenThemePaint(theme, 'text.secondary') : fixedThemePaint(color),
    };
}
