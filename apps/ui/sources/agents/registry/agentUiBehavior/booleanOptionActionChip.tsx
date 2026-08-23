import * as React from 'react';
import { Pressable, type PressableStateCallbackType } from 'react-native';

import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import { hapticsLight } from '@/components/ui/theme/haptics';
import { tLoose } from '@/text';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { AGENT_INPUT_CHIP_ICON_SIZE_PX, AGENT_INPUT_MENU_ICON_SIZE_PX } from '@/components/sessions/agentInput/definitions/agentInputChipIconMetrics';

/**
 * The composer's declared boolean option chip.
 *
 * An Agent declares which new-session option key the chip edits and what it is
 * called; the host owns the option-state store, the toggle, the glyph metrics
 * and both presentations (chip row and collapsed action menu). Nothing about
 * this control is Agent-specific, so it is reachable by any installed Agent
 * through the same slot declaration a bundled one uses.
 */
export function createBooleanOptionActionChip(opts: Readonly<{
    key: string;
    optionStateKey: string;
    iconName: string;
    onLabelKey: string;
    offLabelKey: string;
    value: boolean;
    setValue: (value: boolean) => void;
}>): AgentInputExtraActionChip {
    const label = tLoose(opts.value ? opts.onLabelKey : opts.offLabelKey);
    const renderIcon = (color: string, size: number): React.ReactNode => (
        <Icon name={opts.iconName as IconName} size={size} color={color} />
    );
    const toggle = () => {
        hapticsLight();
        opts.setValue(!opts.value);
    };

    return {
        key: opts.key,
        controlId: 'providerOption',
        collapsedAction: ({ tint, dismiss }) => ({
            id: opts.key,
            label,
            icon: renderIcon(tint, AGENT_INPUT_MENU_ICON_SIZE_PX),
            onPress: () => {
                dismiss();
                toggle();
            },
        }),
        render: ({ chipStyle, showLabel, iconColor, textStyle }) => {
            const { Text } = require('@/components/ui/text/Text') as typeof import('@/components/ui/text/Text');
            return (
                <Pressable
                    onPress={toggle}
                    accessibilityRole="button"
                    accessibilityLabel={label}
                    hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                    style={(pressableState: PressableStateCallbackType) => chipStyle(pressableState.pressed)}
                >
                    {renderIcon(iconColor, AGENT_INPUT_CHIP_ICON_SIZE_PX)}
                    {showLabel ? (
                        <Text style={textStyle}>
                            {label}
                        </Text>
                    ) : null}
                </Pressable>
            );
        },
    };
}
