import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { Pressable } from 'react-native';

import type { AgentInputExtraActionChip, AgentInputExtraActionChipRenderContext } from '@/components/sessions/agentInput/agentInputContracts';
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
    function CheckoutChip(props: { ctx: AgentInputExtraActionChipRenderContext }) {
        const { ctx } = props;

        React.useEffect(() => {
            if (!params.pickerOpen) return;
            if (params.interaction.kind !== 'picker') return;

            // Bridge the legacy auto-open state into the shared overlay controller so the checkout picker
            // participates in the global "only one popover open" behavior.
            ctx.toggleCollapsedPopover?.('new-session-checkout');
            params.setPickerOpen(false);
        }, [ctx.toggleCollapsedPopover, params.interaction.kind, params.pickerOpen, params.setPickerOpen]);

        return (
            <Pressable
                ref={ctx.chipAnchorRef}
                testID="new-session-checkout-chip"
                onPress={() => {
                    if (params.interaction.kind === 'cycle') {
                        params.onApplyOption(params.interaction.nextOptionId);
                        return;
                    }
                    if (params.interaction.kind === 'picker') {
                        if (ctx.toggleCollapsedPopover) {
                            ctx.toggleCollapsedPopover('new-session-checkout');
                            return;
                        }
                        params.setPickerOpen((current) => !current);
                    }
                }}
                hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                style={({ pressed }) => ctx.chipStyle(pressed)}
                accessibilityRole="button"
                accessibilityLabel={params.title}
            >
                {normalizeNodeForView(<Ionicons name="layers-outline" size={16} color={ctx.iconColor} />)}
                {ctx.showLabel ? (
                    <Text numberOfLines={1} style={ctx.textStyle}>
                        {params.selectedLabel}
                    </Text>
                ) : null}
            </Pressable>
        );
    }

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
                maxHeightCap: 620,
                maxWidthCap: 620,
                railWidth: 176,
                railMaxWidth: '32%',
            }
            : undefined,
        render: (ctx) => <CheckoutChip ctx={ctx} />,
    };
}
