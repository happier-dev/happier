/** @vitest-environment jsdom */
import * as React from 'react';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { DaemonVoiceInferenceModelsWarmResponseSchema } from '@happier-dev/protocol/daemon/voiceInference';
import { ExecutionRunTurnStreamReadResponseSchema } from '@happier-dev/protocol/execution/runs/streaming';
import { readLocalConversationVoiceSettings } from '@/sync/domains/settings/voiceSettings';
import {
    getStorage, localVoiceHomeId, localVoiceSpeechTranscription, machineRpcWithServerScope,
    registerLocalVoiceEngineHarnessHooks, sessionRpcWithServerScope, warmLocalVoiceEngineHarnessGraph,
} from './localVoiceEngine.testHarness';

const locks = installWebLockManagerMock();
const restoreLoader = await warmLocalVoiceEngineHarnessGraph();
afterAll(() => { restoreLoader(); locks.restore(); });
const [{ useVoiceAttemptControl }, { VoiceStatusLine }, { VoiceCompactTranscript }, { t }] = await Promise.all([
    import('@/components/voice/attempt/useVoiceAttemptControl'),
    import('@/components/voice/presence/VoiceStatusLine'),
    import('@/components/voice/presence/VoiceCompactTranscript'), import('@/text'),
]);

function CompactVoiceStatus() {
    const voice = useVoiceAttemptControl({ kind: 'global' });
    return <><VoiceStatusLine voice={voice} size="pill" /><VoiceCompactTranscript voice={voice} /></>;
}

const retryAtMs = Date.UTC(2026, 10, 14, 15);
const recovery = { v: 1, status: 'waiting', issueFingerprint: 'temporary-throttle:quota',
    armedAtMs: retryAtMs - 60_000, resetAtMs: retryAtMs, nextCheckAtMs: retryAtMs,
    attemptCount: 0, maxAttempts: 0, lastProbeError: null, authSelectionKind: 'profile' };

describe('quota presentation from the local Agent controller', () => {
    registerLocalVoiceEngineHarnessHooks();
    afterEach(() => standardCleanup());

    it.each([
        { name: 'scheduled retry', metadata: { usageLimitRecovery: recovery }, expectedKey: 'session.usageLimitRecovery.banner.retryAt' },
        { name: 'known reset without automatic recovery', metadata: { usageLimitResetAtMs: retryAtMs }, expectedKey: 'message.agentQuotaWait' },
        { name: 'absent metadata', metadata: {}, expectedKey: null },
    ])('keeps $name visible without sending a waiting person to setup', async ({ metadata, expectedKey }) => {
        const storage = await getStorage();
        const voice = storage.getState().settings.voice;
        const local = readLocalConversationVoiceSettings(voice);
        storage.__setState({ settings: { ...storage.getState().settings, voice: {
            ...voice, providerId: 'local_conversation', welcome: { ...voice.welcome, enabled: false }, providers: { ...voice.providers,
                local_conversation: { schemaVersion: 1, config: { ...local, conversationMode: 'agent',
                    agent: { ...local.agent, prewarmOnConnect: false },
                    streaming: { ...local.streaming, enabled: true },
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
                    error: 'usage_limit', ...metadata }],
            })) : session(request));
        const { createLocalConversationVoiceAdapter } = await import('@/voice/adapters/localConversation/localConversationAdapter');
        const { registerVoiceAdapters } = await import('@/voice/session/voiceAdapterRegistry');
        const { createVoiceSessionLifecycleController } = await import('@/voice/session/voiceSessionLifecycleController');
        const { setVoiceSessionLifecycleController } = await import('@/voice/session/voiceSessionLifecycleControllerStore');
        const { getVoiceSessionPresentedAttemptId, setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
        const { executeVoiceConversationAction } = await import('@/sync/ops/actions/voiceConversationAction');
        registerVoiceAdapters([createLocalConversationVoiceAdapter()]);
        const lifecycle = createVoiceSessionLifecycleController();
        setVoiceSessionLifecycleController(lifecycle);
        const unsubscribe = lifecycle.subscribe(() => setVoiceSessionSnapshot(lifecycle.getSnapshot()));
        try {
            lifecycle.setConfiguredProviderId('local_conversation');
            await lifecycle.toggle({ serverId: localVoiceHomeId, sessionId: 's1' });
            localVoiceSpeechTranscription.mockResolvedValueOnce('SAY READY');
            await expect(executeVoiceConversationAction('ui.voice_global.turn_control', {
                expectedAttempt: getVoiceSessionPresentedAttemptId(), control: 'commit_input',
            }, { navigate() {} })).rejects.toMatchObject({ rpcErrorCode: 'usage_limit' });
            expect(lifecycle.getSnapshot()).toMatchObject({ status: 'error', errorCode: 'provider_error',
                errorMessage: 'usage_limit', errorRecoveryAction: 'none' });
            expect(lifecycle.getSnapshot().canCommitInput).not.toBe(true);
            const read = await executeVoiceConversationAction('ui.voice_global.get', {}, { navigate() {} });
            const time = new Date(retryAtMs).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
            const notice = expectedKey === 'session.usageLimitRecovery.banner.retryAt'
                ? t('session.usageLimitRecovery.banner.retryAt', { time })
                : expectedKey ? t('message.agentQuotaWait', { time }) : null;
            expect(read).toMatchObject({ voice: { presentation: { recovery: null,
                failureMessage: notice ? `${t('session.usageLimitRecovery.banner.title')} ${notice}`
                    : t('session.usageLimitRecovery.banner.title') } } });
            const screen = await renderScreen(<CompactVoiceStatus />);
            expect(screen.findByTestId('voice-status-line')?.findAll(node =>
                node.props.children === t('session.usageLimitRecovery.banner.title')).length).toBeGreaterThan(0);
            expect(screen.findByTestId('voice-compact-transcript')?.props.children).toBe(
                notice ? `${t('session.usageLimitRecovery.banner.title')} ${notice}`
                    : t('session.usageLimitRecovery.banner.title'));
        } finally {
            unsubscribe();
            await lifecycle.stop();
        }
    });
});
