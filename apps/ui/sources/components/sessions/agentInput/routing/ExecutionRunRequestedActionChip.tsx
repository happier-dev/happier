import * as React from 'react';
import { Pressable, View } from 'react-native';

import type { ParticipantRecipientV1} from '@happier-dev/protocol/messages/structured/participantMessageV1';
import type { PendingRequestedActionV1 } from '@happier-dev/protocol/sessions/pending/pendingRequestedActionV1';

import type { AgentInputExtraActionChipRenderContext } from '@/components/sessions/agentInput/agentInputContracts';
import { AgentInputSelectionListPopover } from '@/components/sessions/agentInput/components/AgentInputSelectionListPopover';
import { AGENT_INPUT_CHIP_ICON_SIZE_PX, AGENT_INPUT_CHIP_ICON_STYLE } from '@/components/sessions/agentInput/definitions/agentInputChipIconMetrics';
import { Icon } from '@/components/ui/icons/Icon';
import type { SelectionListStep } from '@/components/ui/selectionList';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

import { buildExecutionRunRequestedActionRootStep } from './createExecutionRunRequestedActionChip';
import { resolveExecutionRunRequestedActionLabel } from './executionRunRequestedActionOptions';

export type ExecutionRunRequestedActionChipProps = Readonly<{
    recipient: ParticipantRecipientV1 | null;
    requestedAction: PendingRequestedActionV1;
    onRequestedActionChange: (next: PendingRequestedActionV1) => void;
    ctx: AgentInputExtraActionChipRenderContext;
}>;

export const ExecutionRunRequestedActionChip = React.memo(function ExecutionRunRequestedActionChip(
    props: ExecutionRunRequestedActionChipProps,
) {
    if (!props.recipient || props.recipient.kind !== 'execution_run') return null;

    const [open, setOpen] = React.useState(false);
    const anchorRef = React.useRef<React.ElementRef<typeof View> | null>(null);
    const selectedLabel = resolveExecutionRunRequestedActionLabel(props.requestedAction.kind);
    const rootStep = React.useMemo<SelectionListStep>(
        () => buildExecutionRunRequestedActionRootStep({
            onSelect: (kind) => props.onRequestedActionChange({ v: 1, kind }),
        }),
        [props.onRequestedActionChange],
    );

    return (
        <>
            <View ref={anchorRef} collapsable={false} style={{ alignSelf: 'flex-start' }}>
                <Pressable
                    testID="agent-input-delivery-chip"
                    onPress={() => setOpen((value) => !value)}
                    style={({ pressed }) => props.ctx.chipStyle(Boolean(pressed))}
                    accessibilityRole="button"
                    accessibilityLabel={t('runs.delivery.title')}
                >
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                        <Icon name="sliders-horizontal" size={AGENT_INPUT_CHIP_ICON_SIZE_PX} color={props.ctx.iconColor} style={AGENT_INPUT_CHIP_ICON_STYLE} />
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
                selectedOptionId={props.requestedAction.kind}
                onSelect={() => undefined}
                onRequestClose={() => setOpen(false)}
                maxHeightCap={320}
            />
        </>
    );
});
