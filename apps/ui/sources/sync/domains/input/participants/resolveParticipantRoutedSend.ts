import { ParticipantMessageV1Schema, type ParticipantRecipientV1 } from '@happier-dev/protocol';

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

export function resolveParticipantRoutedSend(params: Readonly<{
    text: string;
    recipient: ParticipantRecipientV1;
    executionRunDelivery?: 'prompt' | 'steer_if_supported' | 'interrupt';
}>): ParticipantRoutedSend {
    if (params.recipient.kind === 'execution_run') {
        return {
            type: 'execution_run_send',
            runId: params.recipient.runId,
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
