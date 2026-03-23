import * as React from 'react';

import type { ParticipantRecipientV1 } from '@happier-dev/protocol';

import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import { createRecipientActionChip } from '@/components/sessions/agentInput/definitions/createRecipientActionChip';
import type { SessionParticipantTarget } from '@/sync/domains/session/participants/participantTargets';
import {
    resolveParticipantRoutingDescriptor,
    type ParticipantRoutingDescriptor,
} from '@/sync/domains/input/participants/resolveParticipantRoutedSend';

import { createExecutionRunDeliveryActionChip } from './createExecutionRunDeliveryActionChip';
import type { ExecutionRunDeliveryMode } from './useSessionRecipientState';

type SessionRecipientStateLike = Readonly<{
    recipient: ParticipantRecipientV1 | null;
    setManualRecipient: (next: ParticipantRecipientV1 | null) => void;
    executionRunDelivery: ExecutionRunDeliveryMode;
    setExecutionRunDelivery: (next: ExecutionRunDeliveryMode) => void;
}>;

export type SessionAgentInputRoutingControls = Readonly<{
    extraActionChips?: ReadonlyArray<AgentInputExtraActionChip>;
    participantRoutingDescriptor: ParticipantRoutingDescriptor | null;
}>;

export function useSessionAgentInputRoutingControls(params: Readonly<{
    isReadOnly: boolean;
    participantTargets: readonly SessionParticipantTarget[];
    recipientState: SessionRecipientStateLike;
}>): SessionAgentInputRoutingControls {
    const recipientChip = React.useMemo<AgentInputExtraActionChip | undefined>(() => {
        return createRecipientActionChip({
            isReadOnly: params.isReadOnly,
            participantTargets: params.participantTargets,
            recipient: params.recipientState.recipient,
            onRecipientChange: params.recipientState.setManualRecipient,
        });
    }, [
        params.isReadOnly,
        params.participantTargets,
        params.recipientState.recipient,
        params.recipientState.setManualRecipient,
    ]);

    const participantRoutingDescriptor = React.useMemo(() => {
        return resolveParticipantRoutingDescriptor({
            targets: params.participantTargets,
            recipient: params.recipientState.recipient,
        });
    }, [params.participantTargets, params.recipientState.recipient]);

    const deliveryChip = React.useMemo<AgentInputExtraActionChip | undefined>(() => {
        if (params.isReadOnly) return undefined;
        if (participantRoutingDescriptor?.type !== 'execution_run_send') return undefined;
        return createExecutionRunDeliveryActionChip({
            recipient: params.recipientState.recipient,
            delivery: params.recipientState.executionRunDelivery,
            onDeliveryChange: params.recipientState.setExecutionRunDelivery,
        });
    }, [
        params.isReadOnly,
        participantRoutingDescriptor,
        params.recipientState.executionRunDelivery,
        params.recipientState.recipient,
        params.recipientState.setExecutionRunDelivery,
    ]);

    const extraActionChips = React.useMemo<ReadonlyArray<AgentInputExtraActionChip> | undefined>(() => {
        const chips = [recipientChip, deliveryChip].filter(Boolean) as AgentInputExtraActionChip[];
        return chips.length > 0 ? chips : undefined;
    }, [deliveryChip, recipientChip]);

    return {
        extraActionChips,
        participantRoutingDescriptor,
    };
}
