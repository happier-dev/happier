import type { Theme } from '@/theme';
import { tokenThemePaint } from '../../../theme/profiles/themePaint';

/** The bubble supplies its fill to the surrounding floating material owner. */
export function resolveTooltipPaint(theme: Pick<Theme, 'colors'>) {
    return {
        background: tokenThemePaint(theme, 'surface.elevated'),
        foreground: tokenThemePaint(theme, 'text.primary'),
        border: tokenThemePaint(theme, 'border.modal'),
    };
}
