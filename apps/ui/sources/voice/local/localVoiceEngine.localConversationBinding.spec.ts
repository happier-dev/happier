import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';

const ensureBound = vi.fn(async (_params: {
    adapterId: string;
    controlSessionId: string;
    requestedTargetSessionId: string | null;
}) => null);

vi.mock('@/voice/binding/voiceConversationBindingRuntime', () => ({
    voiceSessionBindingManager: {
        ensureBound: (params: Parameters<typeof ensureBound>[0]) => ensureBound(params),
    },
}));

import { getStorage, loadLocalVoiceEngineWithCompatState, registerLocalVoiceEngineHarnessHooks } from './localVoiceEngine.testHarness';

let localVoiceEngine: Awaited<ReturnType<typeof loadLocalVoiceEngineWithCompatState>>;

async function getLocalConversationSnapshot() {
    const { getVoiceAdapterRegistry } = await import('@/voice/session/voiceAdapterRegistry');
    return getVoiceAdapterRegistry().get('local_conversation')?.getSnapshot();
}

async function configureAgentMode(): Promise<void> {
    const storage = await getStorage();
    storage.__setState({
        settings: {
            ...storage.getState().settings,
            voice: {
                ...storage.getState().settings.voice,
                providerId: 'local_conversation',
                providers: {
                    ...storage.getState().settings.voice.providers,
                    local_conversation: { schemaVersion: 1, config: {
                        ...storage.getState().settings.voice.providers.local_conversation.config,
                        conversationMode: 'agent',
                        agent: {
                            ...storage.getState().settings.voice.providers.local_conversation.config.agent,
                            prewarmOnConnect: false,
                        },
                    } },
                },
            },
        },
    });
}

describe('local voice engine local conversation binding', () => {
    registerLocalVoiceEngineHarnessHooks();

    beforeEach(async () => {
        ensureBound.mockReset();
        ensureBound.mockResolvedValue(null);
        localVoiceEngine = await loadLocalVoiceEngineWithCompatState();
    }, 180_000);

    it('resolves agent-mode local conversation toggles through the hidden global control session', async () => {
        await configureAgentMode();

        await localVoiceEngine.toggleLocalVoiceTurn('session-1');

        await vi.waitFor(() => {
            expect(ensureBound).toHaveBeenCalledWith({
                adapterId: 'local_conversation',
                controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
                requestedTargetSessionId: 'session-1',
            });
        });
    }, 60_000);

    it('publishes connecting while the hidden Voice Home session is being prepared', async () => {
        await configureAgentMode();
        let resolveBinding!: () => void;
        ensureBound.mockImplementationOnce(async () => {
            await new Promise<void>((resolve) => {
                resolveBinding = resolve;
            });
            return null;
        });

        const start = localVoiceEngine.toggleLocalVoiceTurn('');
        await vi.waitFor(() => expect(resolveBinding).toBeTypeOf('function'));
        const preparingSnapshot = await getLocalConversationSnapshot();
        resolveBinding();
        await start;

        expect(preparingSnapshot).toMatchObject({
            adapterId: 'local_conversation',
            sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
            status: 'connecting',
            canStop: true,
        });
    }, 60_000);

    it('surfaces a safe retryable error when hidden Voice Home preparation fails', async () => {
        await configureAgentMode();
        const preparationFailure = Object.assign(
            new Error('machine unavailable at /Users/private/repository'),
            { code: 'VOICE_AGENT_BACKEND_TARGET_UNAVAILABLE' },
        );
        ensureBound.mockRejectedValueOnce(preparationFailure);

        await expect(localVoiceEngine.toggleLocalVoiceTurn('')).rejects.toBe(preparationFailure);

        expect(await getLocalConversationSnapshot()).toMatchObject({
            adapterId: 'local_conversation',
            sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
            status: 'disconnected',
            errorCode: 'provider_error',
            errorMessage: 'VOICE_AGENT_BACKEND_TARGET_UNAVAILABLE',
            errorRecoveryAction: 'retry',
        });
    }, 60_000);

    it('does not start capture when Voice Home preparation settles after Stop', async () => {
        await configureAgentMode();
        let resolveBinding!: () => void;
        ensureBound.mockImplementationOnce(async () => {
            await new Promise<void>((resolve) => {
                resolveBinding = resolve;
            });
            return null;
        });

        const start = localVoiceEngine.toggleLocalVoiceTurn('');
        await vi.waitFor(() => expect(resolveBinding).toBeTypeOf('function'));
        await localVoiceEngine.stopLocalVoiceSession();
        resolveBinding();
        await start;

        expect(await getLocalConversationSnapshot()).toMatchObject({
            adapterId: 'local_conversation',
            sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
            status: 'disconnected',
            canStop: false,
        });
    }, 60_000);

    it('does not overwrite a newer adapter owner when stale Voice Home preparation fails', async () => {
        await configureAgentMode();
        let rejectBinding!: (error: Error) => void;
        ensureBound.mockImplementationOnce(async () => {
            await new Promise<void>((_resolve, reject) => {
                rejectBinding = reject;
            });
            return null;
        });

        const start = localVoiceEngine.toggleLocalVoiceTurn('');
        await vi.waitFor(() => expect(rejectBinding).toBeTypeOf('function'));
        const { voiceConversationRuntimeMachine } = await import('@/voice/runtime/machine/VoiceConversationRuntimeMachine');
        voiceConversationRuntimeMachine.transitionToConnecting({
            adapterId: 'happier.voice.elevenlabs/realtime-elevenlabs',
            controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
        });
        rejectBinding(Object.assign(new Error('stale local failure'), {
            code: 'VOICE_AGENT_BACKEND_TARGET_UNAVAILABLE',
        }));
        await start;

        expect(voiceConversationRuntimeMachine.getSnapshot()).toMatchObject({
            adapterId: 'happier.voice.elevenlabs/realtime-elevenlabs',
            controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
            state: 'connecting',
            error: null,
        });
    }, 60_000);
});
