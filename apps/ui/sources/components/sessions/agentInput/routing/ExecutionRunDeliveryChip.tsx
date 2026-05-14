import * as React from 'react';
import { Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import type { ParticipantRecipientV1 } from '@happier-dev/protocol';

import type { AgentInputExtraActionChipRenderContext } from '@/components/sessions/agentInput/agentInputContracts';
import { AgentInputSelectionListPopover } from '@/components/sessions/agentInput/components/AgentInputSelectionListPopover';
import type { SelectionListStep } from '@/components/ui/selectionList';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

import { buildExecutionRunDeliveryRootStep } from './createExecutionRunDeliveryActionChip';
import type { ExecutionRunDeliveryMode } from './useSessionRecipientState';
import { resolveExecutionRunDeliveryLabel } from './executionRunDeliveryOptions';

export type ExecutionRunDeliveryChipProps = Readonly<{
    recipient: ParticipantRecipientV1 | null;
    delivery: ExecutionRunDeliveryMode;
    onDeliveryChange: (next: ExecutionRunDeliveryMode) => void;
    ctx: AgentInputExtraActionChipRenderContext;
}>;

export const ExecutionRunDeliveryChip = React.memo(function ExecutionRunDeliveryChip(props: ExecutionRunDeliveryChipProps) {
    if (!props.recipient || props.recipient.kind !== 'execution_run') return null;

    const [open, setOpen] = React.useState(false);
    const anchorRef = React.useRef<React.ElementRef<typeof View> | null>(null);
    const selectedLabel = resolveExecutionRunDeliveryLabel(props.delivery);
    // Reuse the shared root-step builder so the inline chip and the action-menu
    // route declare the same option set with per-option onSelect callbacks.
    const rootStep = React.useMemo<SelectionListStep>(
        () => buildExecutionRunDeliveryRootStep({
            onSelect: (selectedId) => props.onDeliveryChange(selectedId),
        }),
        [props.onDeliveryChange],
    );

    return (
        <>
            <View ref={anchorRef} collapsable={false} style={{ alignSelf: 'flex-start' }}>
                <Pressable
                    testID="agent-input-delivery-chip"
                    onPress={() => setOpen((v) => !v)}
                    style={({ pressed }) => props.ctx.chipStyle(Boolean(pressed))}
                    accessibilityRole="button"
                    accessibilityLabel={t('runs.delivery.title')}
                >
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                        <Ionicons name="options-outline" size={16} color={props.ctx.iconColor} />
                        {props.ctx.showLabel ? (
                            <Text numberOfLines={1} style={props.ctx.textStyle}>
                                {t('runs.delivery.cardDelivery', { label: selectedLabel })}
                            </Text>
                        ) : null}
                    </View>
                </Pressable>
            </View>

            <AgentInputSelectionListPopover
                open={open}
                anchorRef={anchorRef}
                rootStep={rootStep}
                selectedOptionId={props.delivery}
                onSelect={() => {
                    // FR4-W1-CHIP: documented no-op. Per-row
                    // `SelectionListOption.onSelect` inside `rootStep`
                    // dispatched the delivery mutation. The wrapper
                    // `AgentInputSelectionListPopover` owns the close path and
                    // defers `onRequestClose` on web internally — calling
                    // `setOpen(false)` here would close the popover
                    // synchronously and allow the click to fall through to
                    // the chip anchor (re-opening it).
                }}
                onRequestClose={() => setOpen(false)}
                maxHeightCap={320}
            />
        </>
    );
});
