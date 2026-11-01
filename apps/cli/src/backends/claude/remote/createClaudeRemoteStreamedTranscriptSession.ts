import type { StreamedTranscriptWriterSession } from '@/api/session/streamedTranscriptWriter';
import type { ACPMessageData, ACPProvider } from '@/api/session/sessionMessageTypes';
import type { EphemeralSendResult } from '@/api/session/ephemeralSendOutcome';
import type { SessionTranscriptObservationProvenanceV1 } from '@happier-dev/protocol';

export type ClaudeRemoteStreamedTranscriptEphemeralOptions = Readonly<{
    localId: string;
    createdAt: number;
    updatedAt?: number;
    meta?: Record<string, unknown>;
    tick?: number;
}>;

export type ClaudeRemoteStreamedTranscriptEphemeralDeltaOptions = Readonly<{
    localId: string;
    tick: number;
    baseLength: number;
    createdAt: number;
    updatedAt?: number;
    meta?: Record<string, unknown>;
}>;

export type ClaudeRemoteStreamedTranscriptClient = Readonly<{
    subscribeToSessionConnectionState?: StreamedTranscriptWriterSession['subscribeToSessionConnectionState'];
    sendAgentMessage: (
        provider: ACPProvider,
        body: ACPMessageData,
        opts?: { localId?: string; meta?: Record<string, unknown> },
    ) => void;
    sendAgentMessageCommitted?: (
        provider: ACPProvider,
        body: ACPMessageData,
        opts: { localId: string; meta?: Record<string, unknown> },
    ) => Promise<void>;
    enqueueAgentMessageCommitted?: (
        provider: ACPProvider,
        body: ACPMessageData,
        opts: {
            localId: string;
            meta?: Record<string, unknown>;
            provenance: SessionTranscriptObservationProvenanceV1;
        },
    ) => Promise<Readonly<{ persisted: boolean; delivered: boolean }>>;
    sendAgentMessageEphemeral?: (
        provider: ACPProvider,
        body: ACPMessageData,
        opts: ClaudeRemoteStreamedTranscriptEphemeralOptions,
    ) => EphemeralSendResult;
    sendAgentMessageEphemeralDelta?: (
        provider: ACPProvider,
        body: ACPMessageData,
        opts: ClaudeRemoteStreamedTranscriptEphemeralDeltaOptions,
    ) => EphemeralSendResult;
    getEphemeralStreamConnectionEpoch?: () => number;
}>;

export type ClaudeRemoteStreamedTranscriptSession = StreamedTranscriptWriterSession & Readonly<{
    sendAgentMessageEphemeral?: (
        provider: ACPProvider,
        body: ACPMessageData,
        opts: ClaudeRemoteStreamedTranscriptEphemeralOptions,
    ) => EphemeralSendResult;
}>;

export function createClaudeRemoteStreamedTranscriptSession(
    client: ClaudeRemoteStreamedTranscriptClient,
): ClaudeRemoteStreamedTranscriptSession {
    const sendEphemeral = client.sendAgentMessageEphemeral?.bind(client);
    const sendEphemeralDelta = client.sendAgentMessageEphemeralDelta?.bind(client);
    return {
        subscribeToSessionConnectionState: client.subscribeToSessionConnectionState?.bind(client),
        sendAgentMessage: (provider, body, opts) => client.sendAgentMessage(provider, body, opts),
        ...(typeof client.sendAgentMessageCommitted === 'function'
            ? {
                sendAgentMessageCommitted: (provider, body, opts) =>
                    client.sendAgentMessageCommitted?.(provider, body, opts) ?? Promise.resolve(),
            }
            : {}),
        ...(typeof client.enqueueAgentMessageCommitted === 'function'
            ? {
                enqueueAgentMessageCommitted: (provider, body, opts) =>
                    client.enqueueAgentMessageCommitted?.(provider, body, opts)
                    ?? Promise.resolve({ persisted: false, delivered: false }),
            }
            : {}),
        ...(typeof sendEphemeral === 'function'
            ? {
                sendAgentMessageEphemeral: (provider, body, opts) =>
                    sendEphemeral(provider, body, opts),
            }
            : {}),
        ...(typeof sendEphemeralDelta === 'function'
            ? {
                sendAgentMessageEphemeralDelta: (
                    provider: ACPProvider,
                    body: ACPMessageData,
                    opts: ClaudeRemoteStreamedTranscriptEphemeralDeltaOptions,
                ) => sendEphemeralDelta(provider, body, opts),
            }
            : {}),
        ...(typeof client.getEphemeralStreamConnectionEpoch === 'function'
            ? {
                getEphemeralStreamConnectionEpoch: () => client.getEphemeralStreamConnectionEpoch?.() ?? 0,
            }
            : {}),
    };
}
