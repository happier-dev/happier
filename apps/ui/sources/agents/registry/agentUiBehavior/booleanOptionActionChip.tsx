import * as React from 'react';

import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import { Switch } from '@/components/ui/forms/Switch';
import { hapticsLight } from '@/components/ui/theme/haptics';
import { tLoose } from '@/text';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { AGENT_INPUT_CHIP_ICON_SIZE_PX, AGENT_INPUT_MENU_ICON_SIZE_PX } from '@/components/sessions/agentInput/definitions/agentInputChipIconMetrics';
import { getBooleanOptionActionChipPlacement, type BooleanOptionActionChipDefinition } from './booleanOptionChipPlacement';
import { AgentInputRailChip } from '@/components/sessions/agentInput/definitions/agentInputChipRowReach';

/**
 * The composer's declared boolean option chip.
 *
 * An Agent declares which new-session option key the chip edits and what it is
 * called; the host owns the option-state store, the toggle, the glyph metrics
 * and both presentations (chip row and collapsed action menu). Nothing about
 * this control is Agent-specific, so it is reachable by any installed Agent
 * through the same slot declaration a bundled one uses.
 */
export function createBooleanOptionActionChip(opts: BooleanOptionActionChipDefinition & Readonly<{
    value: boolean;
    setValue: (value: boolean) => void;
}>): AgentInputExtraActionChip {
    const label = tLoose(opts.value ? opts.onLabelKey : opts.offLabelKey);
    const renderIcon = (color: string, size: number): React.ReactNode => (
        <Icon name={opts.iconName as IconName} size={size} color={color} />
    );
    const changeValue = (value: boolean) => {
        hapticsLight();
        opts.setValue(value);
    };
    const toggle = () => changeValue(!opts.value);

    return {
        key: opts.key,
        controlId: 'providerOption',
        placement: getBooleanOptionActionChipPlacement(opts),
        collapsedAction: ({ tint, dismiss }) => ({
            id: opts.key,
            label,
            icon: renderIcon(tint, AGENT_INPUT_MENU_ICON_SIZE_PX),
            right: (
                <Switch
                    value={opts.value}
                    accessibilityLabel={label}
                    onValueChange={(value) => {
                        dismiss();
                        changeValue(value);
                    }}
                />
            ),
            rightElementOutsidePressable: true,
            onPress: () => {
                dismiss();
                toggle();
            },
        }),
        render: ({ chipStyle, showLabel, iconColor, textStyle }) => {
            const { Text } = require('@/components/ui/text/Text') as typeof import('@/components/ui/text/Text');
            return (
                <AgentInputRailChip
                    onPress={toggle}
                    accessibilityRole="button"
                    accessibilityLabel={label}
                    style={chipStyle}
                >
                    {renderIcon(iconColor, AGENT_INPUT_CHIP_ICON_SIZE_PX)}
                    {showLabel ? (
                        <Text style={textStyle}>
                            {label}
                        </Text>
                    ) : null}
                </AgentInputRailChip>
            );
        },
    };
}
