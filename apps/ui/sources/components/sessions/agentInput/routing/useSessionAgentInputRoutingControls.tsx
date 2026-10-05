import * as React from 'react';

import type { ParticipantRecipientV1, PendingRequestedActionV1, ScmDiffSummaryDiscussInput } from '@happier-dev/protocol';
import { t } from '@/text';

import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import { createRecipientActionChip } from '@/components/sessions/agentInput/definitions/createRecipientActionChip';
import type { SessionParticipantTarget } from '@/sync/domains/session/participants/participantTargets';
import {
    resolveParticipantRoutingDescriptor,
    type ParticipantRoutingDescriptor,
} from '@/sync/domains/input/participants/resolveParticipantRoutedSend';

import { createExecutionRunRequestedActionChip } from './createExecutionRunRequestedActionChip';

type SessionRecipientStateLike = Readonly<{
    recipient: ParticipantRecipientV1 | null;
    setManualRecipient: (next: ParticipantRecipientV1 | null) => void;
    executionRunRequestedAction: PendingRequestedActionV1;
    setExecutionRunRequestedAction: (next: PendingRequestedActionV1) => void;
    scmDiffSummaryDiscussion?: Omit<ScmDiffSummaryDiscussInput, 'message'> | null;
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
            ...(params.recipientState.scmDiffSummaryDiscussion ? { pendingLabel: t('walkthrough.eyebrow') } : {}),
        });
    }, [
        params.isReadOnly,
        params.participantTargets,
        params.recipientState.recipient,
        params.recipientState.setManualRecipient,
        params.recipientState.scmDiffSummaryDiscussion,
    ]);

    const participantRoutingDescriptor = React.useMemo(() => {
        return resolveParticipantRoutingDescriptor({
            targets: params.participantTargets,
            recipient: params.recipientState.recipient,
        });
    }, [params.participantTargets, params.recipientState.recipient]);

    const deliveryChip = React.useMemo<AgentInputExtraActionChip | undefined>(() => {
        if (params.isReadOnly) return undefined;
        // Targeted Run input now travels through the canonical Session Pending
        // message descriptor. The recipient—not a retired direct-send transport
        // discriminator—decides whether delivery-mode controls are applicable.
        if (params.recipientState.recipient?.kind !== 'execution_run') return undefined;
        return createExecutionRunRequestedActionChip({
            recipient: params.recipientState.recipient,
            requestedAction: params.recipientState.executionRunRequestedAction,
            onRequestedActionChange: params.recipientState.setExecutionRunRequestedAction,
        });
    }, [
        params.isReadOnly,
        participantRoutingDescriptor,
        params.recipientState.executionRunRequestedAction,
        params.recipientState.recipient,
        params.recipientState.setExecutionRunRequestedAction,
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
