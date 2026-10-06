import { Platform } from 'react-native';
import type { UnistylesThemes } from 'react-native-unistyles';

import { Typography } from '@/constants/Typography';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { resolveThemeSurfaceBorderStyle } from '@/components/ui/surfaces/resolveThemeHairlineBorderStyle';
import { glassSurfaceBackgroundColor } from '@/components/ui/glass/glassSurfacePaint';


type Theme = UnistylesThemes[keyof UnistylesThemes];

/**
 * The composer's own chrome: the panel around the input and the action chips under it. `AgentInput`
 * paints these, and settings previews render the same chips inside the same panel, so the two
 * cannot drift apart.
 */
/** Native rows state their rhythm as margins; chips and the rows around them share this one. */
export const NATIVE_ACTION_CHIP_GAP_Y = 1;
export const AGENT_INPUT_PANEL_PADDING_TOP = 2;
export const AGENT_INPUT_PANEL_PADDING_BOTTOM = 8;

/** The material plane owns paint; this layout is shared by live input and previews. */
export function resolveAgentInputPanelLayoutStyle(theme: Theme, readOnly = false) {
    return {
        // The composer stack's radius (`theme.parts.composer`), shared with the banners above it.
        borderRadius: theme.parts.composer.radius,
        ...resolveThemeSurfaceBorderStyle({
            borderColor: readOnly ? theme.colors.border.default : theme.colors.border.surface,
            highlightColor: theme.colors.effect.surfaceHighlight,
        }),
        overflow: 'hidden' as const,
        paddingTop: AGENT_INPUT_PANEL_PADDING_TOP,
        paddingBottom: AGENT_INPUT_PANEL_PADDING_BOTTOM,
        paddingHorizontal: 8,
    };
}

export function resolveAgentInputPanelStyle(theme: Theme) {
    return {
        ...resolveAgentInputPanelLayoutStyle(theme),
        backgroundColor: glassSurfaceBackgroundColor(theme.colors.input.background, 'content', true),
    };
}

export const AGENT_INPUT_ACTION_CHIP_STYLE = {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    borderRadius: Platform.select({ default: 16, android: 20 }),
    paddingHorizontal: 10,
    paddingVertical: 6,
    justifyContent: 'center' as const,
    height: 32,
    gap: 6,
    ...(Platform.OS === 'web' ? {} : { marginRight: 6, marginBottom: NATIVE_ACTION_CHIP_GAP_Y }),
};

/** A chip while pressed: the standard pressed dip. */
export const AGENT_INPUT_ACTION_CHIP_PRESSED_STYLE = {
    opacity: motionTokens.press.opacity,
};

/** A chip whose label is hidden (icon-only density). */
export const AGENT_INPUT_ACTION_CHIP_ICON_ONLY_STYLE = {
    paddingHorizontal: 8,
    gap: 0,
};

export function resolveAgentInputActionChipTextStyle(theme: Theme) {
    return {
        fontSize: 13,
        color: theme.colors.composer.chipTint,
        fontWeight: '600' as const,
        ...Typography.default('semiBold'),
    };
}
