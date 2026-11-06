/** @vitest-environment jsdom */
import * as React from 'react';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { DaemonVoiceInferenceModelsWarmResponseSchema } from '@happier-dev/protocol/daemon/voiceInference';
import { ExecutionRunTurnStreamReadResponseSchema } from '@happier-dev/protocol/execution/runs/streaming';
import { readLocalConversationVoiceSettings } from '@/sync/domains/settings/voiceSettings';
import {
    getStorage, loadLocalVoiceEngineWithCompatState, machineRpcWithServerScope,
    registerLocalVoiceEngineHarnessHooks, sessionRpcWithServerScope, warmLocalVoiceEngineHarnessGraph,
} from './localVoiceEngine.testHarness';

const locks = installWebLockManagerMock();
const restoreLoader = await warmLocalVoiceEngineHarnessGraph();
afterAll(() => { restoreLoader(); locks.restore(); });
const [{ useVoiceAttemptControl }, { VoiceStatusLine }, { t }] = await Promise.all([
    import('@/components/voice/attempt/useVoiceAttemptControl'),
    import('@/components/voice/presence/VoiceStatusLine'), import('@/text'),
]);

function CompactVoiceStatus() {
    const voice = useVoiceAttemptControl({ kind: 'global' });
    return <VoiceStatusLine voice={voice} size="pill" />;
}

describe('quota presentation from the local Agent controller', () => {
    registerLocalVoiceEngineHarnessHooks();
    afterEach(() => standardCleanup());

    it('renders the quota reason in compact Voice status after the real turn stream fails', async () => {
        const storage = await getStorage();
        const voice = storage.getState().settings.voice;
        const local = readLocalConversationVoiceSettings(voice);
        storage.__setState({ settings: { ...storage.getState().settings, voice: {
            ...voice, providerId: 'local_conversation', providers: { ...voice.providers,
                local_conversation: { schemaVersion: 1, config: { ...local, conversationMode: 'agent',
                    tts: { ...local.tts, autoSpeakReplies: false } } },
            },
        } } });
        // Only the genuine daemon Socket boundary supplies the recorded provider refusal.
        const machine = machineRpcWithServerScope.getMockImplementation();
        const session = sessionRpcWithServerScope.getMockImplementation();
        if (!machine || !session) throw new Error('Local Voice transport boundary unavailable');
        machineRpcWithServerScope.mockImplementation(request => request.method === RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_WARM
            ? Promise.resolve(DaemonVoiceInferenceModelsWarmResponseSchema.parse({ ok: true, models: [] })) : machine(request));
        sessionRpcWithServerScope.mockImplementation(request => request.method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_READ
            ? Promise.resolve(ExecutionRunTurnStreamReadResponseSchema.parse({
                streamId: 'stream-1', nextCursor: 1, done: true,
                events: [{ t: 'error', errorCode: 'usage_limit',
                    error: 'Codex usage limit reached. Try another connected account or try again after your limit resets.' }],
            })) : session(request));
        const engine = await loadLocalVoiceEngineWithCompatState();
        await engine.toggleLocalVoiceTurn(VOICE_AGENT_GLOBAL_SESSION_ID);
        await expect(engine.sendLocalVoiceAgentTextTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'SAY READY', {
            localId: 'quota-presentation', deliveryCommand: 'interrupt_and_send',
        }, async () => {})).rejects.toMatchObject({ rpcErrorCode: 'usage_limit' });
        const { voiceConversationRuntimeMachine } = await import('@/voice/runtime/machine/VoiceConversationRuntimeMachine');
        const { deriveLocalVoiceSessionSnapshot } = await import('@/voice/runtime/machine/deriveLocalVoiceSessionSnapshot');
        const { setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
        // VoiceSessionRuntime publishes this controller projection to the same store port.
        const snapshot = deriveLocalVoiceSessionSnapshot('local_conversation', 'local', voiceConversationRuntimeMachine.getSnapshot());
        expect(snapshot).toMatchObject({ errorCode: 'provider_error', errorMessage: 'usage_limit' });
        setVoiceSessionSnapshot(snapshot);
        const screen = await renderScreen(<CompactVoiceStatus />);
        expect(screen.findByTestId('voice-status-line')?.findAll(node =>
            node.props.children === t('session.usageLimitRecovery.banner.title')).length).toBeGreaterThan(0);
        expect(screen.findByTestId('voice-status-line')?.findAll(node =>
            node.props.accessibilityLabel === snapshot.errorProviderMessage).length).toBeGreaterThan(0);
    });
});
