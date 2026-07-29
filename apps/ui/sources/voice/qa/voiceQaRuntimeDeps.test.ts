import { beforeEach, describe, expect, it, vi } from 'vitest';

const { storageModuleMock } = await vi.hoisted(async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return {
        storageModuleMock: createStorageModuleStub({
            storage: {
                getState: () => ({
                    settings: { voice: { providerId: 'plugin_voice' } },
                }),
            } as any,
        }),
    };
});

const {
    adapterGet,
    adapterSendTextTurn,
    adapterStart,
    appendVoiceConversationUserText,
    contextSendContextualUpdate,
    contextSendTextMessage,
    enqueuePendingMessage,
    markPendingDeliveryHandled,
} = vi.hoisted(() => {
    const adapterSendTextTurn = vi.fn(async (_params: Readonly<{ localId: string }>) => {});
    const adapterStart = vi.fn(async () => {});
    const adapterStop = vi.fn(async () => {});
    return {
        adapterSendTextTurn,
        adapterStart,
        appendVoiceConversationUserText: vi.fn(),
        contextSendContextualUpdate: vi.fn(),
        contextSendTextMessage: vi.fn(),
        enqueuePendingMessage: vi.fn(async (_sessionId, _text, _displayText, _meta, options) => ({
            localId: options.localId,
            accepted: true,
            externalHandoffClaimed: true,
        })),
        markPendingDeliveryHandled: vi.fn(async () => {}),
        adapterGet: vi.fn((_adapterId: string) => ({
            id: 'plugin_voice',
            engineKind: 'realtime',
            start: adapterStart,
            stop: adapterStop,
            getSnapshot: () => ({
                adapterId: 'plugin_voice',
                sessionId: 'target-session',
                status: 'connected',
                mode: 'idle',
                canStop: true,
            }),
            sendContextText: vi.fn(),
            sendContextUpdate: vi.fn(),
            sendTextTurn: adapterSendTextTurn,
        })),
    };
});
vi.mock('@/sync/sync', () => ({
    sync: { enqueuePendingMessage, markPendingDeliveryHandled },
}));
vi.mock('@/voice/session/voiceAdapterRegistry', () => ({
    getVoiceAdapterRegistry: () => ({
        get: (adapterId: string) => adapterGet(adapterId),
    }),
    resolveVoiceAdapterContextChannel: () => ({
        sendTextMessage: contextSendTextMessage,
        sendContextualUpdate: contextSendContextualUpdate,
    }),
}));

vi.mock('@/voice/transcript/voiceConversationTranscript', () => ({
    appendVoiceConversationUserText: (params: unknown) => appendVoiceConversationUserText(params),
}));

vi.mock('@/sync/domains/state/storage', () => storageModuleMock);

import { createDefaultVoiceQaControllerDeps } from './voiceQaRuntimeDeps';
import { voiceAgentSessions } from '@/voice/agent/voiceAgentSessions';

describe('createDefaultVoiceQaControllerDeps', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('forwards exact transcript-custody directives to the canonical voice session owner', async () => {
        const sendTurn = vi.spyOn(voiceAgentSessions, 'sendTurn').mockResolvedValue({
            assistantText: 'ok',
            actions: [],
        });
        const deps = createDefaultVoiceQaControllerDeps();
        const persist = {
            userTranscript: { mode: 'persist', localId: ' durable-outer-id ' },
        } as const;
        const suppress = {
            userTranscript: { mode: 'suppress' },
        } as const;

        await deps.sendLocalTurn('voice-hidden-s1', 'Outer prompt', persist);
        await deps.sendLocalTurn('voice-hidden-s1', 'tool follow-up', suppress);

        expect(sendTurn).toHaveBeenNthCalledWith(1, 'voice-hidden-s1', 'Outer prompt', persist);
        expect(sendTurn).toHaveBeenNthCalledWith(2, 'voice-hidden-s1', 'tool follow-up', suppress);
    });

    it('routes realtime QA through the configured registry adapter without a provider-specific owner', async () => {
        const deps = createDefaultVoiceQaControllerDeps();

        await deps.startRealtime('target-session', 'context', { textOnly: true });

        await deps.sendRealtimeTextTurn({
            controlSessionId: 'voice-global',
            conversationSessionId: 'carrier-s1',
            text: 'hello',
        });
        const session = deps.getRealtimeSession?.();
        session?.sendTextMessage('context text');
        session?.sendContextualUpdate('context update');

        expect(adapterGet).toHaveBeenCalledWith('plugin_voice');
        expect(adapterStart).toHaveBeenCalledWith({
            sessionId: 'target-session',
            initialContext: 'context',
            textOnly: true,
        });
        expect(adapterSendTextTurn).toHaveBeenCalledWith({
            controlSessionId: 'voice-global',
            conversationSessionId: 'carrier-s1',
            text: 'hello',
            localId: expect.any(String),
            deliveryCommand: 'interrupt_and_send',
        });
        const localId = adapterSendTextTurn.mock.calls[0]?.[0]?.localId;
        expect(localId).toEqual(expect.any(String));
        expect(enqueuePendingMessage).toHaveBeenCalledWith('carrier-s1', 'hello', undefined, undefined, {
            localId,
            deliveryMode: 'external_handoff',
            requestedAction: { v: 1, kind: 'send_now' },
        });
        expect(markPendingDeliveryHandled).not.toHaveBeenCalled();
        expect(appendVoiceConversationUserText).not.toHaveBeenCalled();
        expect(contextSendTextMessage).toHaveBeenCalledWith('context text');
        expect(contextSendContextualUpdate).toHaveBeenCalledWith('context update');
    });

    it('keeps QA generic while production composes ElevenLabs only from generated public entries', async () => {
        const { readFile } = await import('node:fs/promises');
        const qaSource = await readFile(
            new URL('./voiceQaRuntimeDeps.ts', import.meta.url),
            'utf8',
        );
        expect(qaSource).not.toContain('realtimeElevenLabs');
        expect(qaSource).not.toContain('realtime_elevenlabs');
        expect(qaSource).not.toContain('/adapters/realtimeElevenLabs/');
        expect(qaSource).not.toContain('sendContextText');

        const compositionSource = await readFile(
            new URL('../adapters/registerBuiltinVoiceAdapters.ts', import.meta.url),
            'utf8',
        );
        expect(compositionSource).not.toContain('createRealtimeElevenLabsVoiceAdapter');
        expect(compositionSource).not.toContain("entry.providerId !== 'realtime_elevenlabs'");
        expect(compositionSource).toContain(
            'input.bundledEntries ?? BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES',
        );
    });
});
