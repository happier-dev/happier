import type { Theme } from '@/theme';
import { tokenThemePaint } from '../../../theme/profiles/themePaint';

/** Both platform bindings use the active thumb, including while the track is off. */
export function resolveAppSwitchPaint(theme: Pick<Theme, 'colors'>) {
    return {
        trackOn: tokenThemePaint(theme, 'control.switch.track.active'),
        trackOff: tokenThemePaint(theme, 'control.switch.track.inactive'),
        thumb: tokenThemePaint(theme, 'control.switch.thumb.active'),
        focusRing: tokenThemePaint(theme, 'border.focus'),
    };
}
