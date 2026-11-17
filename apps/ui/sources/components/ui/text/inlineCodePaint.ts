import type { Theme } from '@/theme';
import { tokenThemePaint } from '../../../theme/profiles/themePaint';

/** Core's binding of the host-independent inline code primitive. */
export function resolveInlineCodePaint(theme: Pick<Theme, 'colors'>) {
    return {
        foreground: tokenThemePaint(theme, 'text.primary'),
        background: tokenThemePaint(theme, 'surface.selected'),
    };
}
