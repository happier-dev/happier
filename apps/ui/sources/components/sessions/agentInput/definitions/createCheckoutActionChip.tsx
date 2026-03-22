import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { Pressable } from 'react-native';

import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import { AgentInputChipPickerPopover } from '@/components/sessions/agentInput/components/AgentInputChipPickerPopover';
import type { AgentInputChipPickerOption } from '@/components/sessions/agentInput/components/AgentInputChipPickerTypes';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import { Text } from '@/components/ui/text/Text';

type CheckoutInteraction =
    | Readonly<{
        kind: 'cycle';
        nextOptionId: string;
    }>
    | Readonly<{
        kind: 'none';
    }>
    | Readonly<{
        kind: 'picker';
    }>;

export function createCheckoutActionChip(params: Readonly<{
    interaction: CheckoutInteraction;
    pickerOpen: boolean;
    title: string;
    selectedLabel: string;
    selectedOptionId: string;
    pickerOptions: ReadonlyArray<AgentInputChipPickerOption>;
    onApplyOption: (optionId: string) => void;
    onRequestClose: () => void;
    setPickerOpen: React.Dispatch<React.SetStateAction<boolean>>;
}>): AgentInputExtraActionChip {
    return {
        key: 'new-session-checkout',
        controlId: 'checkout',
        collapsedAction: params.interaction.kind !== 'picker'
            ? ({ dismiss, tint }) => ({
                id: 'new-session-checkout',
                label: params.selectedLabel,
                icon: normalizeNodeForView(<Ionicons name="layers-outline" size={16} color={tint} />),
                onPress: () => {
                    dismiss();
                    if (params.interaction.kind === 'cycle') {
                        params.onApplyOption(params.interaction.nextOptionId);
                    }
                },
            })
            : undefined,
        collapsedOptionsPopover: params.interaction.kind === 'picker'
            ? {
                title: params.title,
                label: params.selectedLabel,
                icon: (tint: string) =>
                    normalizeNodeForView(<Ionicons name="layers-outline" size={16} color={tint} />),
                options: params.pickerOptions,
                selectedOptionId: params.selectedOptionId,
                onSelect: params.onApplyOption,
            }
            : undefined,
        render: ({ chipStyle, iconColor, showLabel, textStyle, popoverAnchorRef }) => (
            <>
                <Pressable
                    testID="new-session-checkout-chip"
                    onPress={() => {
                        if (params.interaction.kind === 'cycle') {
                            params.onApplyOption(params.interaction.nextOptionId);
                            return;
                        }
                        params.setPickerOpen((current) => !current);
                    }}
                    hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                    style={(pressed) => chipStyle(pressed.pressed)}
                    accessibilityRole="button"
                    accessibilityLabel={params.title}
                >
                    {normalizeNodeForView(<Ionicons name="layers-outline" size={16} color={iconColor} />)}
                    {showLabel ? (
                        <Text numberOfLines={1} style={textStyle}>
                            {params.selectedLabel}
                        </Text>
                    ) : null}
                </Pressable>
                {params.interaction.kind === 'picker' ? (
                    <AgentInputChipPickerPopover
                        open={params.pickerOpen}
                        anchorRef={popoverAnchorRef}
                        title={params.title}
                        options={params.pickerOptions}
                        selectedOptionId={params.selectedOptionId}
                        onSelect={params.onApplyOption}
                        onRequestClose={params.onRequestClose}
                    />
                ) : null}
            </>
        ),
    };
}
