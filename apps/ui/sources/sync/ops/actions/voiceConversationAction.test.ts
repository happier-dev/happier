import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

import { createVoiceSessionLifecycleController } from '@/voice/session/voiceSessionLifecycleController';
import { setVoiceSessionLifecycleController } from '@/voice/session/voiceSessionLifecycleControllerStore';
import { getVoiceSessionAttemptId, resetVoiceSessionRuntimeStateForTests, setVoiceSessionSnapshot } from '@/voice/session/voiceSessionStore';
import { registerVoiceAdapters } from '@/voice/session/voiceAdapterRegistry';
import { createVoiceCaptureAdmissionController } from '@/voice/runtime/input/VoiceCaptureAdmissionController';
import type { VoiceAdapterController, VoiceSessionSnapshot } from '@/voice/session/types';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { storage } from '@/sync/domains/state/storage';
import { voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';
import { createActionExecutor, FeaturesResponseSchema, VoiceConversationActionOutputSchemas } from '@happier-dev/protocol';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { primeServerFeaturesSnapshot, resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { executeVoiceConversationAction } from './voiceConversationAction';

afterEach(async () => { await resetVoiceSessionRuntimeStateForTests(); resetServerFeaturesClientForTests(); });

async function createHarness(providerId = 'local_conversation', start = true) {
    let snapshot: VoiceSessionSnapshot = { adapterId: providerId, sessionId: null, status: 'disconnected', mode: 'idle', canStop: false };
    const listeners = new Set<() => void>();
    const publish = (next: VoiceSessionSnapshot) => { snapshot = next; listeners.forEach((listener) => listener()); };
    const adapter: VoiceAdapterController = {
        id: providerId, engineKind: 'realtime',
        // The adapter is the media/provider boundary. The Action, manager, lifecycle and store stay real.
        start: async ({ sessionId }) => publish({ adapterId: providerId, sessionId: sessionId || VOICE_AGENT_GLOBAL_SESSION_ID, status: 'connected', mode: 'listening', canStop: true, canCommitInput: true, micMuted: false }),
        stop: async () => publish({ ...snapshot, status: 'disconnected', mode: 'idle', canStop: false }),
        toggle: async () => {}, interrupt: async () => publish({ ...snapshot, mode: 'listening' }),
        bargeIn: async () => publish({ ...snapshot, mode: 'listening' }),
        commitInput: async () => publish({ ...snapshot, mode: 'thinking' }),
        setMuted: async ({ muted }) => publish({ ...snapshot, micMuted: muted }), sendContextUpdate() {},
        getSnapshot: () => snapshot,
        subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
        resolveSurfaceCapabilities: () => ({ allowsGlobalStart: true, controlSessionScope: 'surface', requiresVoiceAgentFeature: false, bargeInEnabled: true, cancelResponse: 'immediate' }),
    };
    registerVoiceAdapters([adapter]);
    const lifecycle = createVoiceSessionLifecycleController({ captureAdmission: createVoiceCaptureAdmissionController() });
    setVoiceSessionLifecycleController(lifecycle);
    lifecycle.subscribe(() => setVoiceSessionSnapshot(lifecycle.getSnapshot()));
    lifecycle.setConfiguredProviderId(adapter.id);
    if (start) await lifecycle.toggle({ serverId: 'home-original', sessionId: 'session-original' });
    const expectedAttempt = getVoiceSessionAttemptId()!;
    const invoke = (action: Parameters<typeof executeVoiceConversationAction>[0], input: unknown) => executeVoiceConversationAction(action, input, { navigate() {} });
    return { lifecycle, expectedAttempt, invoke, publish };
}

describe('local conversation Actions through the lifecycle owner', () => {
    it('starts explicit global/session and default intents through the existing idle-target policy', async () => {
        const previousVoice = storage.getState().settings.voice;
        primeServerFeaturesSnapshot({ snapshot: { status: 'ready', features: FeaturesResponseSchema.parse({ features: { voice: { enabled: true } }, capabilities: {} }) } });
        storage.setState((state) => ({ settings: { ...state.settings, voice: voiceSettingsParse({ providerId: 'local_conversation', ui: { scopeDefault: 'session' },
            providers: { local_conversation: { schemaVersion: 1, config: { conversationMode: 'agent' } } } }) } }));
        const { lifecycle, invoke } = await createHarness('local_conversation', false);
        // This fixture omits unrelated host ports: any accidental non-Voice dispatch fails loudly.
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({
            isActionApprovalRequired: () => false,
            voiceConversationAction: ({ actionId, input }) => executeVoiceConversationAction(actionId, input, { navigate() {} }),
        }));
        const actionContext = { surface: 'ui' as const, authority: 'present_user' as const, actionCaller: { kind: 'host' as const } };
        try {
            useVoiceTargetStore.getState().setLastFocusedSessionAddress({ serverId: 'default-home', sessionId: 'default-session' });
            for (const [target, expectedTarget] of [
                [{ kind: 'session', sessionAddress: { serverId: 'explicit-home', sessionId: 'explicit-session' } }, { kind: 'session', sessionAddress: { serverId: 'explicit-home', sessionId: 'explicit-session' } }],
                [{ kind: 'default' }, { kind: 'session', sessionAddress: { serverId: 'default-home', sessionId: 'default-session' } }],
                [{ kind: 'global' }, { kind: 'global' }],
            ] as const) {
                const startResult = await executor.execute('ui.voice_global.start', { target, expectedAttempt: null }, actionContext);
                expect(startResult.ok, JSON.stringify(startResult)).toBe(true);
                if (!startResult.ok) throw new Error(startResult.errorCode);
                const started = VoiceConversationActionOutputSchemas['ui.voice_global.start'].parse(startResult.result);
                expect(started.status, JSON.stringify(started)).toBe('completed');
                expect(started.voice).toMatchObject({ status: 'connected', canStop: true, target: expectedTarget });
                const currentToken = started.voice.attemptId!;
                expect((await invoke('ui.voice_global.start', { target, expectedAttempt: null })).status).toBe('unavailable');
                const endResult = await executor.execute('ui.voice_global.end', { expectedAttempt: currentToken }, actionContext);
                expect(endResult.ok).toBe(true);
                if (!endResult.ok) throw new Error(endResult.errorCode);
                expect(VoiceConversationActionOutputSchemas['ui.voice_global.end'].parse(endResult.result))
                    .toMatchObject({ status: 'completed', voice: { status: 'disconnected', canDismissEnded: true } });
            }
            let competingStart: Promise<void> | null = null;
            const racedStart = await executeVoiceConversationAction('ui.voice_global.start', {
                target: { kind: 'global' }, expectedAttempt: null,
            }, {
                navigate() {},
                // The host boundary lets another surface start after asynchronous preparation,
                // immediately before this admitted command reaches the same lifecycle owner.
                isCurrent: () => {
                    competingStart ??= lifecycle.toggle({ serverId: 'competing-home', sessionId: 'competing-session' });
                    return true;
                },
            });
            await competingStart;
            expect(racedStart).toMatchObject({ status: 'unavailable', code: 'stale_voice_attempt' });
            expect(lifecycle.getSnapshot()).toMatchObject({ status: 'connected', sessionId: 'competing-session' });
        } finally {
            await lifecycle.dispose();
            storage.setState((state) => ({ settings: { ...state.settings, voice: previousVoice } }));
        }
    });
    it('reads and settles the actual attempt after navigation changes, with Mute separate from End', async () => {
        const { lifecycle, expectedAttempt, invoke, publish } = await createHarness();
        try {
            useVoiceTargetStore.getState().setLastFocusedSessionAddress({ serverId: 'other-home', sessionId: 'other-session' });
            const read = await invoke('ui.voice_global.get', {});
            expect(read.voice).toMatchObject({ attemptId: expectedAttempt, sessionId: 'session-original', canStop: true });
            expect(read.voice.target).toEqual({ kind: 'session', sessionAddress: { serverId: 'home-original', sessionId: 'session-original' } });
            expect((await invoke('ui.voice_global.set_muted', { expectedAttempt, muted: true })).status).toBe('completed');
            expect(lifecycle.getSnapshot()).toMatchObject({ status: 'connected', micMuted: true });
            expect((await invoke('ui.voice_global.turn_control', { expectedAttempt, control: 'commit_input' })).status).toBe('completed');
            expect(lifecycle.getSnapshot().mode).toBe('thinking');
            expect((await invoke('ui.voice_global.turn_control', { expectedAttempt, control: 'cancel' })).status).toBe('completed');
            expect(lifecycle.getSnapshot().mode).toBe('listening');
            publish({ ...lifecycle.getSnapshot(), mode: 'speaking', micMuted: false });
            expect((await invoke('ui.voice_global.turn_control', { expectedAttempt, control: 'interrupt' })).status).toBe('completed');
            expect(lifecycle.getSnapshot().mode).toBe('listening');
            expect((await invoke('ui.voice_global.end', { expectedAttempt })).status).toBe('completed');
            expect(lifecycle.getSnapshot().status).toBe('disconnected');
            const ended = await invoke('ui.voice_global.get', {});
            expect(ended.voice).toMatchObject({ attemptId: expectedAttempt, canDismissEnded: true });
            expect((await invoke('ui.voice_global.dismiss', { expectedAttempt, kind: 'ended' })).status).toBe('completed');
            expect((await invoke('ui.voice_global.get', {})).voice.canDismissEnded).toBe(false);
        } finally { await lifecycle.dispose(); }
    });

    it('refuses dispatch when the invoking Account retired during preparation', async () => {
        const { lifecycle, expectedAttempt } = await createHarness();
        try {
            expect(await executeVoiceConversationAction('ui.voice_global.end', { expectedAttempt }, { navigate() {}, isCurrent: () => false }))
                .toMatchObject({ status: 'unavailable', code: 'voice_action_account_changed' });
            expect(lifecycle.getSnapshot().status).toBe('connected');
        } finally { await lifecycle.dispose(); }
    });

    it('rejects a stale token after a replacement reuses the same session', async () => {
        const { lifecycle, expectedAttempt, invoke } = await createHarness();
        try {
            await lifecycle.stop('session-original');
            await lifecycle.toggle({ serverId: 'home-original', sessionId: 'session-original' });
            expect(getVoiceSessionAttemptId()).not.toBe(expectedAttempt);
            expect(await invoke('ui.voice_global.end', { expectedAttempt })).toMatchObject({ status: 'unavailable', code: 'stale_voice_attempt' });
            expect(await invoke('ui.voice_global.set_muted', { expectedAttempt, muted: true })).toMatchObject({ status: 'unavailable', code: 'stale_voice_attempt' });
            expect(lifecycle.getSnapshot()).toMatchObject({ status: 'connected', micMuted: false });
        } finally { await lifecycle.dispose(); }
    });

    it('retries the failed attempt at its captured target and acknowledges failure without a clean End', async () => {
        const { lifecycle, expectedAttempt, invoke, publish } = await createHarness();
        try {
            publish({ adapterId: 'local_conversation', sessionId: 'session-original', status: 'error', mode: 'idle', canStop: false, errorCode: 'transport_failed', errorRecoveryAction: 'retry' });
            useVoiceTargetStore.getState().setLastFocusedSessionAddress({ serverId: 'other-home', sessionId: 'other-session' });
            expect((await invoke('ui.voice_global.get', {})).voice).toMatchObject({ attemptId: expectedAttempt, canDismissFailedAttempt: true });
            expect((await invoke('ui.voice_global.recover', { expectedAttempt })).status).toBe('completed');
            expect(lifecycle.getSnapshot()).toMatchObject({ sessionId: 'session-original', status: 'connected' });
            const replacement = getVoiceSessionAttemptId()!;
            publish({ adapterId: 'local_conversation', sessionId: 'session-original', status: 'error', mode: 'idle', canStop: false, errorCode: 'transport_failed', errorRecoveryAction: 'retry' });
            expect((await invoke('ui.voice_global.dismiss', { expectedAttempt: replacement, kind: 'failed' })).status).toBe('completed');
            expect((await invoke('ui.voice_global.get', {})).voice).toMatchObject({ canDismissFailedAttempt: false, canDismissEnded: false });
        } finally { await lifecycle.dispose(); }
    });
});
