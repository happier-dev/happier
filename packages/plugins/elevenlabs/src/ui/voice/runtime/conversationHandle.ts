import { Conversation } from '@elevenlabs/client';
import {
  VoiceRealtimeJsonValueSchema,
  type VoiceRealtimeJsonValue,
} from '@happier-dev/plugin-sdk/voice/client';
import type {
  Callbacks,
  Conversation as ElevenLabsConversation,
  Mode,
  PartialOptions,
  Status,
} from '@elevenlabs/client';

type MessagePayload = Parameters<NonNullable<Callbacks['onMessage']>>[0];
type AgentResponseCorrectionPayload =
    Parameters<NonNullable<Callbacks['onAgentResponseCorrection']>>[0];

export type ElevenLabsConversationHandleEvent =
    | Readonly<{ type: 'connect' }>
    | Readonly<{ type: 'disconnect'; reason?: string }>
    | Readonly<{ type: 'message'; data: MessagePayload }>
    | Readonly<{ type: 'agent_response_correction'; data: AgentResponseCorrectionPayload }>
    | Readonly<{ type: 'error'; error: Parameters<NonNullable<Callbacks['onError']>>[0] }>
    | Readonly<{ type: 'status'; data: { status: Status } }>
    | Readonly<{ type: 'mode'; data: { mode: Mode } }>
    | Readonly<{ type: 'debug'; message: Parameters<NonNullable<Callbacks['onDebug']>>[0] }>;

export type ElevenLabsConversationHandle = Readonly<{
    startSession: (config: unknown) => Promise<string | null>;
    endSession: () => Promise<void>;
    getId: () => string | null;
    setMicMuted: (muted: boolean) => void;
    setOutputVolume: (volume: number) => void;
    sendUserMessage: (message: string) => void;
    sendContextualUpdate: (update: string) => void;
    subscribe: (listener: (event: ElevenLabsConversationHandleEvent) => void) => () => void;
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

function normalizeOutputVolume(volume: number): number {
    return Math.max(0, Math.min(1, Number.isFinite(volume) ? volume : 0));
}

export function createElevenLabsConversationHandle(params: Readonly<{
    tools: readonly Readonly<{
        name: string;
        execute(parameters: VoiceRealtimeJsonValue): Promise<VoiceRealtimeJsonValue>;
    }>[];
}>): ElevenLabsConversationHandle {
    let activeConversation: ElevenLabsConversation | null = null;
    let latestStartSequence = 0;
    let disposed = false;
    let outputVolume = 1;
    let micMuted: boolean | null = null;
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

    const clientTools = Object.freeze(Object.fromEntries(params.tools.map((tool) => [
        tool.name,
        async (parameters: unknown) => await tool.execute(
            VoiceRealtimeJsonValueSchema.parse(parameters),
        ),
    ]))) as PartialOptions['clientTools'];

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
        // A corrected agent turn is its own SDK callback, not a replayed
        // `onMessage`, so subscribing to `onMessage` alone silently drops every
        // correction the provider publishes.
        onAgentResponseCorrection: (data) => {
            if (!isCurrentStartSequence(startSequence)) return;
            emit({ type: 'agent_response_correction', data });
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
                clientTools,
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

            try {
                // A focus change can precede the SDK session resolving. Retain
                // it above and apply it before exposing this conversation as
                // active, so a late provider output cannot briefly play.
                if (outputVolume !== 1) conversation.setVolume({ volume: outputVolume });
                // Mute has the same late-start custody requirement. The host
                // can suspend input while the SDK is still negotiating; apply
                // the latest desired value before publishing the handle.
                if (micMuted !== null) conversation.setMicMuted(micMuted);
            } catch (error) {
                await endConversationQuietly(conversation);
                throw error;
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
            micMuted = muted;
            activeConversation?.setMicMuted(muted);
        },
        setOutputVolume(volume: number): void {
            outputVolume = normalizeOutputVolume(volume);
            activeConversation?.setVolume({ volume: outputVolume });
        },
        sendUserMessage(message: string): void {
            activeConversation?.sendUserMessage(message);
        },
        sendContextualUpdate(update: string): void {
            activeConversation?.sendContextualUpdate(update);
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
