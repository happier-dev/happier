import type { StreamedTranscriptWriterSession } from '@/api/session/streamedTranscriptWriter';
import type { ACPMessageData, ACPProvider } from '@/api/session/sessionMessageTypes';

export type ClaudeRemoteStreamedTranscriptEphemeralOptions = Readonly<{
    localId: string;
    createdAt: number;
    updatedAt?: number;
    meta?: Record<string, unknown>;
}>;

export type ClaudeRemoteStreamedTranscriptClient = Readonly<{
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
    sendAgentMessageEphemeral?: (
        provider: ACPProvider,
        body: ACPMessageData,
        opts: ClaudeRemoteStreamedTranscriptEphemeralOptions,
    ) => void | Promise<void>;
}>;

export type ClaudeRemoteStreamedTranscriptSession = StreamedTranscriptWriterSession & Readonly<{
    sendAgentMessageEphemeral?: (
        provider: ACPProvider,
        body: ACPMessageData,
        opts: ClaudeRemoteStreamedTranscriptEphemeralOptions,
    ) => void | Promise<void>;
}>;

export function createClaudeRemoteStreamedTranscriptSession(
    client: ClaudeRemoteStreamedTranscriptClient,
): ClaudeRemoteStreamedTranscriptSession {
    return {
        sendAgentMessage: (provider, body, opts) => client.sendAgentMessage(provider, body, opts),
        ...(typeof client.sendAgentMessageCommitted === 'function'
            ? {
                sendAgentMessageCommitted: (provider, body, opts) =>
                    client.sendAgentMessageCommitted?.(provider, body, opts) ?? Promise.resolve(),
            }
            : {}),
        ...(typeof client.sendAgentMessageEphemeral === 'function'
            ? {
                sendAgentMessageEphemeral: (provider, body, opts) =>
                    client.sendAgentMessageEphemeral?.(provider, body, opts),
            }
            : {}),
    };
}
