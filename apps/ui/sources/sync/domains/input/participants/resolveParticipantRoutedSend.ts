import { normalizeParticipantRecipientRoutingIdentityV1, withParticipantRecipientV1, type ParticipantRecipientV1, type PendingRequestedActionV1 } from '@happier-dev/protocol';

import type { SessionParticipantTarget } from '@/sync/domains/session/participants/participantTargets';

export type ParticipantRoutingDescriptor = Readonly<{
    type: 'session_message';
    recipient: ParticipantRecipientV1;
}>;

export type ParticipantRoutedSend = Readonly<{
    type: 'session_message';
    text: string;
    displayText?: string;
    recipient: ParticipantRecipientV1;
    requestedAction?: PendingRequestedActionV1;
    metaOverrides: Record<string, unknown>;
}>;

export function participantRecipientsMatch(a: ParticipantRecipientV1, b: ParticipantRecipientV1): boolean {
    if (a.kind !== b.kind) return false;
    if (a.kind === 'execution_run') {
        return a.runId === (b as Extract<ParticipantRecipientV1, { kind: 'execution_run' }>).runId;
    }
    if (a.kind === 'agent_team_broadcast') {
        return a.teamId === (b as Extract<ParticipantRecipientV1, { kind: 'agent_team_broadcast' }>).teamId;
    }
    return a.memberId === (b as Extract<ParticipantRecipientV1, { kind: 'agent_team_member' }>).memberId;
}

export function isParticipantRecipientAvailable(params: Readonly<{
    targets: readonly SessionParticipantTarget[];
    recipient: ParticipantRecipientV1;
}>): boolean {
    return params.targets.some((target) => participantRecipientsMatch(target.recipient, params.recipient));
}

export function resolveParticipantRoutingDescriptor(params: Readonly<{
    recipient: ParticipantRecipientV1 | null;
    targets?: readonly SessionParticipantTarget[];
}>): ParticipantRoutingDescriptor | null {
    if (!params.recipient) return null;
    // A missing local roster entry is not authoritative target unavailability.
    // Preserve the exact recipient for Pending's daemon-owned classification.
    return {
        type: 'session_message',
        recipient: normalizeParticipantRecipientRoutingIdentityV1(params.recipient),
    };
}

export function resolveParticipantRoutedSend(params: Readonly<{
    text: string;
    displayText?: string;
    metaOverrides?: Record<string, unknown>;
    recipient: ParticipantRecipientV1;
    requestedAction?: PendingRequestedActionV1;
}>): ParticipantRoutedSend {
    const recipient = normalizeParticipantRecipientRoutingIdentityV1(params.recipient);
    return {
        type: 'session_message',
        text: params.text,
        ...(params.displayText !== undefined ? { displayText: params.displayText } : {}),
        recipient,
        ...(params.requestedAction ? { requestedAction: params.requestedAction } : {}),
        metaOverrides: withParticipantRecipientV1(params.metaOverrides ?? {}, recipient),
    };
}
