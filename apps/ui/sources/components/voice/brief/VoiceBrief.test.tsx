import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, type RenderScreenResult } from '@/dev/testkit';
import { AuthProvider } from '@/auth/context/AuthContext';
import { storage } from '@/sync/domains/state/storage';
import { settingsParse } from '@/sync/domains/settings/settings';
import { normalizeVoiceSettingsLocalDelta } from '@/sync/domains/settings/voiceSettingsPersistence';
import { readLocalConversationVoiceSettings, voiceSettingsParse, writeLocalConversationVoiceSettings } from '@/sync/domains/settings/voiceSettings';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { buildServerFeaturesResponse } from '@/hooks/server/serverFeaturesTestUtils';
import { resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { registerVoiceAdapters, resetVoiceAdapterRegistryForTests } from '@/voice/session/voiceAdapterRegistry';
import { createVoiceSessionLifecycleController, type VoiceSessionLifecycleController } from '@/voice/session/voiceSessionLifecycleController';
import { setVoiceSessionLifecycleController } from '@/voice/session/voiceSessionLifecycleControllerStore';
import { setVoiceSessionSnapshot } from '@/voice/session/voiceSessionStore';
import type { VoiceAdapterController, VoiceSessionSnapshot } from '@/voice/session/types';
import { VoiceBriefBlock } from './VoiceBrief';
import { executeVoiceBriefOperation } from './voiceBriefActionRuntime';
import { getVoiceSessionAttemptId, getVoiceSessionPresentedAttemptId, resetVoiceSessionStoreForTests } from '@/voice/session/voiceSessionStore';
import { useVoiceBriefHomeRequest } from './useVoiceBriefRequest';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { captureActiveServerAccountScopeCurrentness, getActiveServerAccountScope, retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';

installDisconnectedServerSocketBoundary();

const navigation = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ pathname: () => '/', router: { push: navigation.push } }).module;
});
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

// The synthetic adapter is the speech/provider transport boundary. The mounted Inbox,
// start admission, attempt/recovery, lifecycle, context and delivery owners stay real.
function transport() {
    let snapshot: VoiceSessionSnapshot = { adapterId: 'local_conversation', sessionId: null, status: 'disconnected', mode: 'idle', canStop: false };
    const listeners = new Set<() => void>();
    const publish = (next: VoiceSessionSnapshot) => { snapshot = next; for (const listener of listeners) listener(); };
    const starts: Parameters<VoiceAdapterController['start']>[0][] = [];
    const spoken: string[] = [];
    const contexts: string[] = [];
    const retries: string[] = [];
    const interrupted: string[] = [];
    const adapter: VoiceAdapterController = {
        id: 'local_conversation', engineKind: 'local',
        start: async (input) => {
            starts.push(input);
            publish({ adapterId: 'local_conversation', sessionId: input.sessionId || VOICE_AGENT_GLOBAL_SESSION_ID, status: 'connecting', mode: 'idle', canStop: true });
        },
        stop: async () => publish({ ...snapshot, status: 'disconnected', canStop: false }),
        toggle: async () => {}, interrupt: async (input) => { interrupted.push(input.sessionId); }, setMuted: async () => {}, sendContextUpdate: () => {},
        retry: async (input) => { retries.push(input.sessionId); publish({ ...snapshot, status: 'connecting', canStop: true }); },
        getSnapshot: () => snapshot,
        subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
        resolveSurfaceCapabilities: () => ({ allowsGlobalStart: true, controlSessionScope: 'global', requiresVoiceAgentFeature: false, bargeInEnabled: false, cancelResponse: 'immediate' }),
        resolveContextChannel: () => ({ hostAuthoredContext: 'session_context',
                sendContextualUpdate: (value) => { contexts.push(value); }, sendTextMessage: (value) => { spoken.push(value); publish({ ...snapshot, mode: 'thinking' }); } }),
    };
    return { adapter, starts, spoken, contexts, retries, interrupted,
        connect: () => publish({ ...snapshot, status: 'connected', mode: 'listening', canStop: true }),
        fail: () => publish({ ...snapshot, status: 'error', canStop: false, errorRecoveryAction: 'retry' }),
    };
}

let screen: RenderScreenResult | null = null;
let lifecycle: VoiceSessionLifecycleController | null = null;
let unsubscribe: (() => void) | null = null;
let account: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
const initialState = storage.getState();
beforeEach(() => {
    resetVoiceSessionStoreForTests();
    navigation.push.mockReset();
    resetServerFeaturesClientForTests();
    setRuntimeFetch(vi.fn(async () => new Response(JSON.stringify(buildServerFeaturesResponse({ voiceEnabled: true })), {
        status: 200, headers: { 'content-type': 'application/json' },
    })));
    storage.setState({ ...initialState, settings: settingsParse({ voice: { providerId: 'off' } }) }, true);
    setVoiceSessionSnapshot({ adapterId: null, sessionId: null, status: 'disconnected', mode: 'idle', canStop: false });
});
afterEach(async () => {
    await screen?.unmount(); screen = null;
    unsubscribe?.(); unsubscribe = null;
    await lifecycle?.dispose(); lifecycle = null;
    setVoiceSessionLifecycleController(null);
    resetVoiceAdapterRegistryForTests();
    setVoiceSessionSnapshot({ adapterId: null, sessionId: null, status: 'disconnected', mode: 'idle', canStop: false });
    await account?.dispose(); account = null;
});

function installTransport() {
    const speech = transport();
    registerVoiceAdapters([speech.adapter]);
    lifecycle = createVoiceSessionLifecycleController();
    setVoiceSessionLifecycleController(lifecycle);
    lifecycle.setConfiguredProviderId('local_conversation');
    const controller = lifecycle;
    unsubscribe = controller.subscribe(() => setVoiceSessionSnapshot(controller.getSnapshot()));
    return speech;
}
const render = () => <React.StrictMode><AuthProvider initialCredentials={{ token: 'token-1', secret: 'secret-1' }}>
    <VoiceBriefBlock onClose={() => {}} />
</AuthProvider></React.StrictMode>;
function BriefHome(props: Readonly<{ available: boolean }>) {
    const [open, setOpen] = React.useState(false);
    useVoiceBriefHomeRequest({ available: props.available, onOpen: () => setOpen(true) });
    return open ? <VoiceBriefBlock onClose={() => setOpen(false)} /> : null;
}
const renderHome = (available = true) => <React.StrictMode><AuthProvider initialCredentials={{ token: 'token-1', secret: 'secret-1' }}>
    <BriefHome available={available} />
</AuthProvider></React.StrictMode>;
async function selectService() {
    const selected = voiceSettingsParse({ providerId: 'local_conversation' });
    const voice = writeLocalConversationVoiceSettings(selected, readLocalConversationVoiceSettings(selected));
    await act(async () => storage.getState().applySettingsLocal(normalizeVoiceSettingsLocalDelta({ voice }, storage.getState().settings)));
    expect(storage.getState().settings.voice.providerId).toBe('local_conversation');
}

describe('mounted Voice Brief request', () => {
    it('opens the demand-mounted Inbox from the Home Action and reports unavailable without a current Home', async () => {
        const speech = installTransport();
        await selectService();
        expect(executeVoiceBriefOperation('request')).toEqual({ ok: false, errorCode: 'voice_brief_unavailable' });
        screen = await renderScreen(renderHome(false));
        expect(executeVoiceBriefOperation('request')).toEqual({ ok: false, errorCode: 'voice_brief_unavailable' });
        await screen.update(renderHome());
        expect(speech.starts).toHaveLength(0);
        expect(screen.findAllByTestId('voice-brief')).toHaveLength(0);
        let outcome;
        await act(async () => { outcome = executeVoiceBriefOperation('request'); });
        expect(outcome).toEqual({ ok: true, result: { status: 'waiting', attemptId: null } });
        expect(screen.findByTestId('voice-brief')).toBeTruthy();
        expect(speech.starts).toHaveLength(1);
        await act(async () => speech.connect());
        expect(speech.spoken).toHaveLength(1);
        expect(speech.contexts[0]).toContain('"approval":"tap_only"');
        await screen.pressByTestIdAsync('voice-brief.close');
        await act(async () => lifecycle?.stop(VOICE_AGENT_GLOBAL_SESSION_ID));
        await act(async () => { outcome = executeVoiceBriefOperation('request'); });
        expect(speech.starts).toHaveLength(2);
        await screen.pressByTestIdAsync('voice-brief.close');
        await act(async () => speech.connect());
        expect(speech.spoken).toHaveLength(1);
        expect(lifecycle?.getSnapshot().status).toBe('connected');
        expect(executeVoiceBriefOperation('retry')).toEqual({ ok: false, errorCode: 'voice_brief_unavailable' });
    });
    it('lets Actions request the same connected Brief and stop its turn without ending the conversation', async () => {
        const speech = installTransport();
        await selectService();
        await lifecycle?.toggle(null);
        speech.connect();
        screen = await renderScreen(render());
        const attemptId = getVoiceSessionAttemptId();
        expect(speech.spoken).toHaveLength(1);
        let outcome;
        await act(async () => { outcome = executeVoiceBriefOperation('request', { expectedAttemptId: attemptId! }); });
        expect(outcome).toEqual({ ok: true, result: { status: 'sent', attemptId } });
        expect(speech.spoken).toHaveLength(2);
        expect(speech.contexts[1]).toContain('"approval":"tap_only"');
        await act(async () => { outcome = executeVoiceBriefOperation('stop', { expectedAttemptId: attemptId! }); });
        expect(outcome).toEqual({ ok: true, result: { status: 'stopped', attemptId } });
        expect(speech.interrupted).toEqual([VOICE_AGENT_GLOBAL_SESSION_ID]);
        expect(lifecycle?.getSnapshot().status).toBe('connected');
        expect(executeVoiceBriefOperation('retry')).toEqual({ ok: false, errorCode: 'voice_brief_not_retryable' });
        await screen.unmount(); screen = null;
        expect(executeVoiceBriefOperation('request')).toEqual({ ok: false, errorCode: 'voice_brief_unavailable' });
        expect(speech.spoken).toHaveLength(2);
    });

    it('rejects stale Actions and refuses a pending Brief when a different attempt connects', async () => {
        const speech = installTransport();
        await selectService();
        screen = await renderScreen(render());
        const attemptId = getVoiceSessionAttemptId();
        expect(executeVoiceBriefOperation('stop', { expectedAttemptId: 'previous-attempt' })).toEqual({ ok: false, errorCode: 'stale_voice_attempt' });
        await act(async () => {
            await lifecycle?.stop(VOICE_AGENT_GLOBAL_SESSION_ID);
            await lifecycle?.toggle(null);
            speech.connect();
        });
        expect(getVoiceSessionAttemptId()).not.toBe(attemptId);
        expect(speech.spoken).toHaveLength(0);
        expect(screen.findByTestId('voice-brief')).toBeTruthy();
    });

    it('refuses the old Inbox request after the canonical Account lifetime retires even when the same Account is renewed', async () => {
        // The app entry loads this implementation before mounting Home.
        await import('@/sync/syncEngine');
        account = await restoreServerAccountForTest({
            serverUrl: 'https://brief-account.example.test',
            request: async (url) => new URL(String(url)).pathname === '/v1/features'
                ? new Response(JSON.stringify(buildServerFeaturesResponse({ voiceEnabled: true })), {
                    status: 200, headers: { 'content-type': 'application/json' },
                }) : new Response('{}', { status: 404 }),
        });
        const speech = installTransport();
        await selectService();
        screen = await renderScreen(renderHome());
        const scope = getActiveServerAccountScope();
        expect(scope).not.toBeNull();
        await act(async () => { executeVoiceBriefOperation('request'); });
        expect(speech.starts).toHaveLength(1);
        // Sync's reset owner calls this exact retirement hook. Renew without a
        // render so the old pending Inbox cannot rely on equal Account ids.
        retireActiveServerAccountScopeLifetime();
        expect(captureActiveServerAccountScopeCurrentness().isCurrent()).toBe(true);
        expect(getActiveServerAccountScope()).toEqual(scope);
        expect(executeVoiceBriefOperation('request')).toEqual({ ok: false, errorCode: 'voice_brief_unavailable' });
        await act(async () => speech.connect());
        expect(speech.spoken).toHaveLength(0);
    });

    it('retries through the mounted recovery owner and never starts on a settings repair alone', async () => {
        const speech = installTransport();
        screen = await renderScreen(render());
        await selectService();
        expect(speech.starts).toHaveLength(0);
        await act(async () => {
            expect(executeVoiceBriefOperation('retry').ok).toBe(true);
        });
        expect(speech.starts).toHaveLength(1);
        await act(async () => speech.fail());
        await act(async () => {
            expect(executeVoiceBriefOperation('retry', { expectedAttemptId: getVoiceSessionPresentedAttemptId()! }).ok).toBe(true);
        });
        expect(speech.starts).toHaveLength(2);
        expect(speech.starts[1]?.requestedTargetSessionAddress).toBeNull();
        await act(async () => speech.connect());
        expect(speech.spoken).toHaveLength(1);
        await act(async () => speech.fail());
        await act(async () => {
            expect(executeVoiceBriefOperation('retry').ok).toBe(true);
        });
        expect(speech.starts).toHaveLength(3);
        await act(async () => speech.connect());
        expect(speech.spoken).toHaveLength(2);
    });
    it('keeps the list with setup recovery, then explicitly retries one global start and delivers once on connect', async () => {
        const speech = installTransport();
        screen = await renderScreen(render());
        expect(screen.findByTestId('voice-brief')).toBeTruthy();
        expect(screen.findByTestId('voice-brief.unavailable')).toBeTruthy();
        expect(screen.findByTestId('voice-brief.recover')).toBeTruthy();
        expect(speech.starts).toHaveLength(0);
        await screen.pressByTestIdAsync('voice-brief.recover');
        expect(navigation.push).toHaveBeenCalled();
        await selectService();
        expect(speech.starts).toHaveLength(0);
        await screen.pressByTestIdAsync('voice-brief.retry');
        expect(speech.starts).toHaveLength(1);
        expect(speech.starts[0]?.requestedTargetSessionAddress).toBeNull();
        expect(speech.spoken).toHaveLength(0);
        await act(async () => speech.connect());
        await act(async () => screen?.update(render()));
        await act(async () => speech.connect());
        expect(speech.spoken).toHaveLength(1);
        expect(speech.contexts).toHaveLength(1);
    });

    it('offers terminal failure recovery on the same global target and delivers once on reconnect', async () => {
        const speech = installTransport();
        await selectService();
        await lifecycle?.toggle(null);
        speech.fail();
        screen = await renderScreen(render());
        expect(screen.findByTestId('voice-brief.unavailable')).toBeTruthy();
        await screen.pressByTestIdAsync('voice-brief.recover');
        // The lifecycle owns terminal recovery: it restarts the retained global
        // binding, rather than asking a detached transport to retry itself.
        expect(speech.starts).toHaveLength(2);
        expect(speech.starts[1]?.requestedTargetSessionAddress).toBeNull();
        await act(async () => speech.connect());
        await act(async () => screen?.update(render()));
        expect(speech.spoken).toHaveLength(1);
    });

    it('resolves a brief on an existing conversation without starting another after End', async () => {
        const speech = installTransport();
        await selectService();
        await lifecycle?.toggle(null);
        speech.connect();
        screen = await renderScreen(render());
        expect(speech.spoken).toHaveLength(1);
        await act(async () => lifecycle?.stop(VOICE_AGENT_GLOBAL_SESSION_ID));
        expect(speech.starts).toHaveLength(1);
        expect(speech.spoken).toHaveLength(1);
    });
});
