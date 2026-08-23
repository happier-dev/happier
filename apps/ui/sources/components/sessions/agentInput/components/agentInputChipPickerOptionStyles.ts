import Color from "color";

import { shadowLevelStyle, type ShadowElevationToken } from "@/shadowElevation";

export const AGENT_INPUT_CHIP_PICKER_OPTION_ICON_SIZE = 16;
export const AGENT_INPUT_CHIP_PICKER_OPTION_ROW_RADIUS = 12;

/** The picker family shares one platform minimum for every interactive option. */
export function resolveAgentInputChipPickerOptionInteractiveTargetSize(platform: string): 44 | 48 {
    return platform === 'android' ? 48 : 44;
}

type AgentInputChipPickerOptionStyleTheme = Readonly<{
    colors: Readonly<{
        shadowLevels: Readonly<Record<1, ShadowElevationToken>>;
        surface: Readonly<{
            base: string;
            pressed: string;
        }>;
    }>;
}>;

export type AgentInputChipPickerOptionTransientStyles = Readonly<{
    optionRowFocused: Readonly<Record<string, unknown>>;
    optionRowHovered: Readonly<{
        backgroundColor: string;
    }>;
    optionRowPressed: Readonly<{
        opacity: number;
    }>;
    optionRowDisabled: Readonly<{
        opacity: number;
    }>;
}>;

export function createAgentInputChipPickerOptionTransientStyles(
    theme: AgentInputChipPickerOptionStyleTheme,
): AgentInputChipPickerOptionTransientStyles {
    return {
        optionRowFocused: {
            backgroundColor: theme.colors.surface.base,
            ...shadowLevelStyle(theme.colors.shadowLevels[1]),
        },
        optionRowHovered: {
            backgroundColor: (() => {
                try {
                    return Color(theme.colors.surface.base).alpha(0.8).rgb().string();
                } catch {
                    return theme.colors.surface.pressed;
                }
            })(),
        },
        optionRowPressed: {
            opacity: 0.82,
        },
        optionRowDisabled: {
            opacity: 0.45,
        },
    };
}
