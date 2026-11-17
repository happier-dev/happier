import type { Theme } from '@/theme';
import { tokenThemePaint } from '../../../../theme/profiles/themePaint';
import { glassContentFillPaint } from '../../glass/glassSurfacePaint';

/** The frame owns the inner material fill; code body ink belongs to its content renderer. */
export function resolveCodeBlockFramePaint(theme: Pick<Theme, 'colors'>) {
    return {
        background: glassContentFillPaint(tokenThemePaint(theme, 'surface.inset'), tokenThemePaint(theme, 'surface.selected')),
        border: tokenThemePaint(theme, 'border.default'),
        headerForeground: tokenThemePaint(theme, 'text.secondary'),
    };
}
