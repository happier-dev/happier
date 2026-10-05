import Color from 'color';
import type { XtermFindColors } from './findEngine';

/** SearchAddon requires opaque #RRGGBB; composite the shared translucent tokens over this terminal. */
export function resolveXtermFindColors(colors: XtermFindColors, background: string): XtermFindColors {
    const opaque = (value: string) => {
        const foreground = Color(value);
        return Color(background).alpha(1).mix(foreground.alpha(1), foreground.alpha()).hex();
    };
    return { matchAll: opaque(colors.matchAll), matchCurrent: opaque(colors.matchCurrent) };
}
