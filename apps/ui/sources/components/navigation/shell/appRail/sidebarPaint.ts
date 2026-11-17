import type { SurfacePart } from '@happier-dev/plugin-sdk/ui';
import type { Theme } from '@/theme';
import { fixedThemePaint, tokenThemePaint, type ThemePaint } from '@/theme/profiles/themePaint';
import { glassSurfacePlaneStyle } from '@/components/ui/glass/glassSurfacePaint';

export function appShellColumnPlanePaint(colors: Readonly<{ background: Readonly<{ canvas: string }> }>): ThemePaint {
    return tokenThemePaint({ colors }, 'background.canvas');
}

export function sidebarWrapperPaint(): ThemePaint {
    return fixedThemePaint('transparent');
}

/** The plane is material-dependent; the header, glyph slot and footer paint no fill themselves. */
export function resolveSidebarPaint(theme: Theme, part: SurfacePart<'sidebar'>): Readonly<{ background: ThemePaint }> {
    return { background: fixedThemePaint(part === 'root'
        ? glassSurfacePlaneStyle(appShellColumnPlanePaint(theme.colors).color, 'sidebar').backgroundColor : sidebarWrapperPaint().color) };
}
