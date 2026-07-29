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

describe('local voice engine local conversation binding', () => {
    registerLocalVoiceEngineHarnessHooks();

    beforeEach(async () => {
        ensureBound.mockReset();
        localVoiceEngine = await loadLocalVoiceEngineWithCompatState();
    }, 180_000);

    it('resolves agent-mode local conversation toggles through the hidden global control session', async () => {
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

        await localVoiceEngine.toggleLocalVoiceTurn('session-1');

        await vi.waitFor(() => {
            expect(ensureBound).toHaveBeenCalledWith({
                adapterId: 'local_conversation',
                controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
                requestedTargetSessionId: 'session-1',
            });
        });
    }, 60_000);
});
