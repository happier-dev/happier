import type { Theme } from '@/theme';
import { fixedThemePaint, tokenThemePaint } from '../../../theme/profiles/themePaint';

/** One paint selection for menu, list and command-palette row anatomy. */
export function resolveSelectableRowPaint(theme: Pick<Theme, 'colors' | 'dark'>, input: Readonly<{
    selected?: boolean;
    hovered?: boolean;
    pressed?: boolean;
    disabled?: boolean;
    menu?: boolean;
    selectable?: boolean;
    destructive?: boolean;
}> = {}) {
    const background = input.selected
        ? tokenThemePaint(theme, input.menu ? 'surface.selected' : 'surface.pressedOverlay')
        : input.hovered && !input.disabled
            ? tokenThemePaint(theme, input.selectable ? (theme.dark ? 'surface.elevated' : 'surface.inset') : 'surface.hover')
            : input.pressed && !input.disabled
                ? tokenThemePaint(theme, 'surface.pressed')
                : fixedThemePaint('transparent');
    return {
        background,
        border: input.selected && !input.menu ? tokenThemePaint(theme, 'border.strong') : fixedThemePaint('transparent'),
        foreground: tokenThemePaint(theme, input.destructive ? 'state.danger.foreground' : 'text.primary'),
        secondary: tokenThemePaint(theme, 'text.secondary'),
    };
}
