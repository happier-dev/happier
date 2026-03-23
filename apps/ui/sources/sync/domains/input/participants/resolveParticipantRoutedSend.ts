import { ParticipantMessageV1Schema, type ParticipantRecipientV1 } from '@happier-dev/protocol';

import type { SessionParticipantTarget } from '@/sync/domains/session/participants/participantTargets';

export type ParticipantRoutingDescriptor =
    | Readonly<{
        type: 'session_message';
        recipient: ParticipantRecipientV1;
    }>
    | Readonly<{
        type: 'execution_run_send';
        recipient: Extract<ParticipantRecipientV1, { kind: 'execution_run' }>;
        runId: string;
    }>;

export type ParticipantRoutedSend =
    | Readonly<{
        type: 'session_message';
        text: string;
        displayText?: string;
        metaOverrides: Record<string, unknown>;
    }>
    | Readonly<{
        type: 'execution_run_send';
        runId: string;
        message: string;
        delivery: 'prompt' | 'steer_if_supported' | 'interrupt';
    }>;

export function isParticipantRecipientAvailable(params: Readonly<{
    targets: readonly SessionParticipantTarget[];
    recipient: ParticipantRecipientV1;
}>): boolean {
    return params.targets.some((target) => {
        const current = target.recipient;
        if (current.kind !== params.recipient.kind) return false;
        if (current.kind === 'execution_run') {
            return current.runId === params.recipient.runId;
        }
        if (current.kind === 'agent_team_broadcast') {
            return current.teamId === params.recipient.teamId;
        }
        return current.memberId === params.recipient.memberId;
    });
}

export function resolveParticipantRoutingDescriptor(params: Readonly<{
    recipient: ParticipantRecipientV1 | null;
    targets?: readonly SessionParticipantTarget[];
}>): ParticipantRoutingDescriptor | null {
    if (!params.recipient) return null;
    if (params.targets && !isParticipantRecipientAvailable({ targets: params.targets, recipient: params.recipient })) {
        return null;
    }
    if (params.recipient.kind === 'execution_run') {
        return {
            type: 'execution_run_send',
            recipient: params.recipient,
            runId: params.recipient.runId,
        };
    }
    return {
        type: 'session_message',
        recipient: params.recipient,
    };
}

export function resolveParticipantRoutedSend(params: Readonly<{
    text: string;
    recipient: ParticipantRecipientV1;
    executionRunDelivery?: 'prompt' | 'steer_if_supported' | 'interrupt';
}>): ParticipantRoutedSend {
    const descriptor = resolveParticipantRoutingDescriptor({ recipient: params.recipient });
    if (descriptor?.type === 'execution_run_send') {
        return {
            type: 'execution_run_send',
            runId: descriptor.runId,
            message: params.text,
            delivery: params.executionRunDelivery ?? 'steer_if_supported',
        };
    }

    const payload = ParticipantMessageV1Schema.parse({ recipient: params.recipient });
    return {
        type: 'session_message',
        text: params.text,
        metaOverrides: {
            happier: {
                kind: 'participant_message.v1',
                payload,
            },
        },
    };
}
