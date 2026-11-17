import type { Theme } from '@/theme';
import { tokenThemePaint, type ThemePaint } from '../../../theme/profiles/themePaint';

/** The host palette and its inspection view consume this same selection. */
export function projectPluginUiControlPalette<Color>(colors: Readonly<{
    border: Readonly<{ strong: Color }>;
    edge: Readonly<{ fill: Color }>;
    input: Readonly<{ placeholder: Color }>;
    switch: Readonly<{ track: Readonly<{ active: Color; inactive: Color }>; thumb: Readonly<{ active: Color }> }>;
}>) {
    return {
        controlBorder: colors.border.strong,
        fieldBackground: colors.edge.fill,
        placeholder: colors.input.placeholder,
        switchTrackOn: colors.switch.track.active,
        switchTrackOff: colors.switch.track.inactive,
        switchThumb: colors.switch.thumb.active,
    };
}

export function resolvePluginUiControlPaints(theme: Pick<Theme, 'colors'>, controlFill: ThemePaint) {
    return projectPluginUiControlPalette({
        border: { strong: tokenThemePaint(theme, 'border.strong') },
        edge: { fill: controlFill },
        input: { placeholder: tokenThemePaint(theme, 'control.input.placeholder') },
        switch: {
            track: {
                active: tokenThemePaint(theme, 'control.switch.track.active'),
                inactive: tokenThemePaint(theme, 'control.switch.track.inactive'),
            },
            thumb: { active: tokenThemePaint(theme, 'control.switch.thumb.active') },
        },
    });
}
