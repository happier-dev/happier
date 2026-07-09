import { Conversation } from '@elevenlabs/client';
import type {
    Callbacks,
    Conversation as ElevenLabsConversation,
    Mode,
    PartialOptions,
    Status,
} from '@elevenlabs/client';

import type { RealtimeConversationHandle } from '@/voice/runtime/realtime/realtimeTransportProvider';
import {
    redactRealtimeClientToolResults,
    type RealtimeClientToolMap,
} from './redactRealtimeClientToolResults';

type MessagePayload = Parameters<NonNullable<Callbacks['onMessage']>>[0];

export type ElevenLabsConversationHandleCallbacks = Readonly<{
    onConnect: () => void;
    onDisconnect: () => void;
    onMessage: (data: MessagePayload) => void;
    onError: (error: Parameters<NonNullable<Callbacks['onError']>>[0]) => void;
    onStatusChange: (data: { status: Status }) => void;
    onModeChange: (data: { mode: Mode }) => void;
    onDebug: (message: Parameters<NonNullable<Callbacks['onDebug']>>[0]) => void;
}>;

export type ElevenLabsConversationHandle = RealtimeConversationHandle & Readonly<{
    dispose: () => void;
}>;

function readRecord(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return {};
    }
    return value as Record<string, unknown>;
}

function readConversationId(conversation: ElevenLabsConversation): string | null {
    const conversationId = conversation.getId();
    return typeof conversationId === 'string' && conversationId.trim().length > 0 ? conversationId : null;
}

async function endConversationQuietly(conversation: ElevenLabsConversation): Promise<void> {
    try {
        await conversation.endSession();
    } catch {
        // best-effort cleanup
    }
}

export function createElevenLabsConversationHandle(params: Readonly<{
    callbacks: ElevenLabsConversationHandleCallbacks;
    clientTools: PartialOptions['clientTools'];
}>): ElevenLabsConversationHandle {
    let activeConversation: ElevenLabsConversation | null = null;
    let latestStartSequence = 0;
    let disposed = false;

    // Route every realtime tool result through the canonical provider-bound
    // redaction chokepoint before it reaches the provider. Without this the raw
    // tool result (which can carry session summaries/paths) bypasses the voice
    // privacy prefs that the local follow-up channel already honors.
    const redactedClientTools = (
        params.clientTools && typeof params.clientTools === 'object'
            ? redactRealtimeClientToolResults(params.clientTools as RealtimeClientToolMap)
            : params.clientTools
    ) as PartialOptions['clientTools'];

    const isCurrentStartSequence = (startSequence: number): boolean =>
        !disposed && startSequence === latestStartSequence;

    const buildCallbackOptions = (startSequence: number): Partial<Callbacks> => ({
        onConnect: () => {
            if (!isCurrentStartSequence(startSequence)) return;
            params.callbacks.onConnect();
        },
        onDisconnect: () => {
            if (!isCurrentStartSequence(startSequence)) return;
            activeConversation = null;
            params.callbacks.onDisconnect();
        },
        onMessage: (data) => {
            if (!isCurrentStartSequence(startSequence)) return;
            params.callbacks.onMessage(data);
        },
        onError: (error) => {
            if (!isCurrentStartSequence(startSequence)) return;
            params.callbacks.onError(error);
        },
        onStatusChange: (data) => {
            if (!isCurrentStartSequence(startSequence)) return;
            params.callbacks.onStatusChange(data);
        },
        onModeChange: (data) => {
            if (!isCurrentStartSequence(startSequence)) return;
            params.callbacks.onModeChange(data);
        },
        onDebug: (message) => {
            if (!isCurrentStartSequence(startSequence)) return;
            params.callbacks.onDebug(message);
        },
    });

    return {
        async startSession(config: unknown): Promise<string | null> {
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
        dispose(): void {
            latestStartSequence += 1;
            disposed = true;
            const conversation = activeConversation;
            activeConversation = null;
            if (conversation) {
                void endConversationQuietly(conversation);
            }
        },
    };
}
