import { Conversation } from '@elevenlabs/client';
import type {
    Callbacks,
    Conversation as ElevenLabsConversation,
    Mode,
    PartialOptions,
    Status,
} from '@elevenlabs/client';

import {
    redactRealtimeClientToolResults,
    type RealtimeClientToolMap,
    type VoiceToolResultRedactionPrefs,
    type VoiceToolResultRedactor,
} from './redactRealtimeClientToolResults.js';

type MessagePayload = Parameters<NonNullable<Callbacks['onMessage']>>[0];

export type ElevenLabsConversationHandleEvent =
    | Readonly<{ type: 'connect' }>
    | Readonly<{ type: 'disconnect'; reason?: string }>
    | Readonly<{ type: 'message'; data: MessagePayload }>
    | Readonly<{ type: 'error'; error: Parameters<NonNullable<Callbacks['onError']>>[0] }>
    | Readonly<{ type: 'status'; data: { status: Status } }>
    | Readonly<{ type: 'mode'; data: { mode: Mode } }>
    | Readonly<{ type: 'debug'; message: Parameters<NonNullable<Callbacks['onDebug']>>[0] }>;

export type ElevenLabsConversationHandle = Readonly<{
    startSession: (config: unknown) => Promise<string | null>;
    endSession: () => Promise<void>;
    getId: () => string | null;
    setMicMuted: (muted: boolean) => void;
    sendUserMessage: (message: string) => void;
    sendContextualUpdate: (update: string) => void;
    readOutboundAudioBytes: () => Promise<number | null>;
    subscribe: (listener: (event: ElevenLabsConversationHandleEvent) => void) => () => void;
    dispose: () => void;
}>;

function extractStatsEntries(report: unknown): unknown[] {
    if (Array.isArray(report)) return report;
    if (report && typeof report === 'object' && Symbol.iterator in report) {
        return Array.from(report as Iterable<unknown>).map((entry) =>
            Array.isArray(entry) && entry.length >= 2 ? entry[1] : entry,
        );
    }
    const forEach = report && typeof report === 'object'
        ? (report as { forEach?: unknown }).forEach
        : null;
    if (typeof forEach !== 'function') return [];
    const entries: unknown[] = [];
    forEach.call(report, (value: unknown) => entries.push(value));
    return entries;
}

function resolveStatsReader(conversation: ElevenLabsConversation): (() => Promise<unknown>) | null {
    const root = conversation as unknown as Record<string, unknown>;
    const connection = root.connection as Record<string, unknown> | undefined;
    const publisher = connection?.publisher as Record<string, unknown> | undefined;
    const candidates: unknown[] = [
        root,
        connection,
        connection?.peerConnection,
        connection?.pc,
        publisher?.pc,
    ];
    for (const candidate of candidates) {
        if (!candidate || typeof candidate !== 'object') continue;
        const getStats = (candidate as { getStats?: unknown }).getStats;
        if (typeof getStats === 'function') {
            return async () => await Promise.resolve(getStats.call(candidate));
        }
    }
    return null;
}

async function readOutboundAudioBytes(conversation: ElevenLabsConversation | null): Promise<number | null> {
    if (!conversation) return null;
    const readStats = resolveStatsReader(conversation);
    if (!readStats) return null;
    const entries = extractStatsEntries(await readStats());
    let bytesSent: number | null = null;
    for (const entry of entries) {
        if (!entry || typeof entry !== 'object') continue;
        const stat = entry as Record<string, unknown>;
        if (stat.type !== 'outbound-rtp') continue;
        const mediaKind = typeof stat.kind === 'string' ? stat.kind : stat.mediaType;
        if (mediaKind !== 'audio' || typeof stat.bytesSent !== 'number' || !Number.isFinite(stat.bytesSent)) continue;
        bytesSent = bytesSent === null ? stat.bytesSent : Math.max(bytesSent, stat.bytesSent);
    }
    return bytesSent;
}

function readRecord(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return {};
    }
    return value as Record<string, unknown>;
}

function readConversationId(conversation: ElevenLabsConversation): string | null {
    const conversationId = conversation.getId();
    return typeof conversationId === 'string'
        && conversationId.length > 0
        && conversationId.trim() === conversationId
        ? conversationId
        : null;
}

async function endConversationQuietly(conversation: ElevenLabsConversation): Promise<void> {
    try {
        await conversation.endSession();
    } catch {
        // best-effort cleanup
    }
}

export function createElevenLabsConversationHandle(params: Readonly<{
    clientTools: PartialOptions['clientTools'];
    resolveRedactionPrefs: () => VoiceToolResultRedactionPrefs;
    redactToolResultValue: VoiceToolResultRedactor;
}>): ElevenLabsConversationHandle {
    let activeConversation: ElevenLabsConversation | null = null;
    let latestStartSequence = 0;
    let disposed = false;
    const listeners = new Set<(event: ElevenLabsConversationHandleEvent) => void>();

    const emit = (event: ElevenLabsConversationHandleEvent): void => {
        for (const listener of [...listeners]) {
            try {
                listener(event);
            } catch {
                // One observer cannot break the provider SDK callback fan-out.
            }
        }
    };

    // Route every realtime tool result through the canonical provider-bound
    // redaction chokepoint before it reaches the provider. Without this the raw
    // tool result (which can carry session summaries/paths) bypasses the voice
    // privacy prefs that the local follow-up channel already honors.
    const redactedClientTools = (
        params.clientTools && typeof params.clientTools === 'object'
            ? redactRealtimeClientToolResults(
                params.clientTools as RealtimeClientToolMap,
                params.resolveRedactionPrefs,
                params.redactToolResultValue,
            )
            : params.clientTools
    ) as PartialOptions['clientTools'];

    const isCurrentStartSequence = (startSequence: number): boolean =>
        !disposed && startSequence === latestStartSequence;

    const buildCallbackOptions = (startSequence: number): Partial<Callbacks> => ({
        onConnect: () => {
            if (!isCurrentStartSequence(startSequence)) return;
            emit({ type: 'connect' });
        },
        onDisconnect: () => {
            if (!isCurrentStartSequence(startSequence)) return;
            activeConversation = null;
            emit({ type: 'disconnect' });
        },
        onMessage: (data) => {
            if (!isCurrentStartSequence(startSequence)) return;
            emit({ type: 'message', data });
        },
        onError: (error) => {
            if (!isCurrentStartSequence(startSequence)) return;
            emit({ type: 'error', error });
        },
        onStatusChange: (data) => {
            if (!isCurrentStartSequence(startSequence)) return;
            emit({ type: 'status', data });
        },
        onModeChange: (data) => {
            if (!isCurrentStartSequence(startSequence)) return;
            emit({ type: 'mode', data });
        },
        onDebug: (message) => {
            if (!isCurrentStartSequence(startSequence)) return;
            emit({ type: 'debug', message });
        },
    });

    return {
        async startSession(config: unknown): Promise<string | null> {
            if (disposed) return null;
            const startSequence = latestStartSequence + 1;
            latestStartSequence = startSequence;

            const previousConversation = activeConversation;
            activeConversation = null;
            if (previousConversation) {
                await endConversationQuietly(previousConversation);
            }

            const conversation = await Conversation.startSession({
                ...readRecord(config),
                ...buildCallbackOptions(startSequence),
                clientTools: redactedClientTools,
            } as PartialOptions);

            if (!isCurrentStartSequence(startSequence)) {
                await endConversationQuietly(conversation);
                return null;
            }

            const conversationId = readConversationId(conversation);
            if (!conversationId) {
                await endConversationQuietly(conversation);
                return null;
            }

            activeConversation = conversation;
            return conversationId;
        },
        async endSession(): Promise<void> {
            latestStartSequence += 1;
            const conversation = activeConversation;
            activeConversation = null;
            if (!conversation) return;
            await endConversationQuietly(conversation);
        },
        getId(): string | null {
            return activeConversation ? readConversationId(activeConversation) : null;
        },
        setMicMuted(muted: boolean): void {
            activeConversation?.setMicMuted(muted);
        },
        sendUserMessage(message: string): void {
            activeConversation?.sendUserMessage(message);
        },
        sendContextualUpdate(update: string): void {
            activeConversation?.sendContextualUpdate(update);
        },
        async readOutboundAudioBytes(): Promise<number | null> {
            try {
                return await readOutboundAudioBytes(activeConversation);
            } catch {
                return null;
            }
        },
        subscribe(listener): () => void {
            if (disposed) return () => {};
            listeners.add(listener);
            let subscribed = true;
            return () => {
                if (!subscribed) return;
                subscribed = false;
                listeners.delete(listener);
            };
        },
        dispose(): void {
            if (disposed) return;
            latestStartSequence += 1;
            disposed = true;
            emit({ type: 'disconnect', reason: 'handle_disposed' });
            listeners.clear();
            const conversation = activeConversation;
            activeConversation = null;
            if (conversation) {
                void endConversationQuietly(conversation);
            }
        },
    };
}
