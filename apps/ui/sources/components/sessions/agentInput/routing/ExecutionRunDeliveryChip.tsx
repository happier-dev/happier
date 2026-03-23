import * as React from 'react';
import { Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import type { ParticipantRecipientV1 } from '@happier-dev/protocol';

import type { AgentInputExtraActionChipRenderContext } from '@/components/sessions/agentInput/agentInputContracts';
import { AgentInputSimpleOptionsPopover } from '@/components/sessions/agentInput/components/AgentInputSimpleOptionsPopover';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

import type { ExecutionRunDeliveryMode } from './useSessionRecipientState';
import { buildExecutionRunDeliveryPickerOptions, resolveExecutionRunDeliveryLabel } from './executionRunDeliveryOptions';

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
    const deliveryOptions = React.useMemo(() => buildExecutionRunDeliveryPickerOptions(), []);

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

            <AgentInputSimpleOptionsPopover
                open={open}
                anchorRef={anchorRef}
                title={t('runs.delivery.title')}
                options={deliveryOptions}
                selectedOptionId={props.delivery}
                onSelect={(nextId) => {
                    props.onDeliveryChange(nextId as ExecutionRunDeliveryMode);
                    setOpen(false);
                }}
                onRequestClose={() => setOpen(false)}
                maxHeightCap={320}
            />
        </>
    );
});
