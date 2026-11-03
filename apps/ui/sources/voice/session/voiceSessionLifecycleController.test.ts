import {
    getStorage,
    loadLocalVoiceEngineWithCompatState,
    localVoiceAgentRpc,
    localVoiceHomeId,
    localVoiceSpeechOutputBoundary,
    machineRpcWithServerScope,
    registerLocalVoiceEngineHarnessHooks,
    setPlatformOs,
    waitForLocalVoiceBoundaryEvent,
} from '@/voice/local/localVoiceEngine.testHarness';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { createDeferred, waitForTestEvent } from '@/dev/testkit';

// This file statically imports Socket consumers before the mixed native/Web
// recipe is installed; use the testkit's documented hoisted transport boundary.
vi.mock('socket.io-client', async importOriginal => (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));

import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { createBundledConversationRuntimeHostLease } from '@/voice/registry/bundledConversationRuntimeHost';
import { createVoiceCaptureAdmissionController } from '@/voice/runtime/input/VoiceCaptureAdmissionController';
import { storage } from '@/sync/domains/state/storage';
function isControlRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

import type { VoiceAdapterController, VoiceSessionSnapshot } from './types';

type VoiceAdapterRegistry = Readonly<{
    get: (id: string) => VoiceAdapterController | null;
    list: () => ReadonlyArray<VoiceAdapterController>;
    subscribe?: (listener: () => void) => () => void;
}>;

const OPENAI_PROVIDER_ID = 'happier.voice.openai/realtime-openai';
const CODEX_PROVIDER_ID = 'happier.agent.codex/realtime-codex';

const sessionAddress = (sessionId: string) => ({ serverId: 'server-1', sessionId });

afterEach(async () => {
    const { resetVoiceSessionRuntimeStateForTests } = await import('./voiceSessionStore');
    await resetVoiceSessionRuntimeStateForTests();
});

function createAdapter(params: Readonly<{
    id: string;
    snapshot: VoiceSessionSnapshot;
    engineKind?: VoiceAdapterController['engineKind'];
    freshSnapshots?: boolean;
    retry?: () => Promise<void>;
    start?: () => Promise<void>;
    stop?: () => Promise<void>;
}>): Readonly<{
    controller: VoiceAdapterController;
    setSnapshot: (snapshot: VoiceSessionSnapshot) => void;
    stop: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>;
    retry: ReturnType<typeof vi.fn>;
    toggle: ReturnType<typeof vi.fn>;
    bargeIn: ReturnType<typeof vi.fn>;
    setMuted: ReturnType<typeof vi.fn>;
    listenerCount: () => number;
}> {
    let snapshot = params.snapshot;
    const listeners = new Set<() => void>();
    const notify = () => {
        for (const listener of listeners) {
            listener();
        }
    };
    const start = vi.fn(async () => {
        if (params.start) {
            await params.start();
        }
    });
    const stop = vi.fn(async () => {
        if (params.stop) {
            await params.stop();
        }
    });
    const retry = vi.fn(async () => {
        if (params.retry) {
            await params.retry();
        }
    });
    const toggle = vi.fn(async () => {});
    const bargeIn = vi.fn(async () => {});
    const setMuted = vi.fn(async () => {});

    return {
        controller: {
            id: params.id,
            engineKind: params.engineKind ?? 'realtime',
            start,
            stop,
            toggle,
            retry,
            interrupt: vi.fn(async () => {}),
            bargeIn,
            setMuted,
            sendContextUpdate: vi.fn(() => {}),
            getSnapshot: () => params.freshSnapshots ? { ...snapshot } : snapshot,
            subscribe: (listener: () => void) => {
                listeners.add(listener);
                return () => {
                    listeners.delete(listener);
                };
            },
        },
        setSnapshot: (next: VoiceSessionSnapshot) => {
            snapshot = next;
            notify();
        },
        stop,
        start,
        retry,
        toggle,
        bargeIn,
        setMuted,
        listenerCount: () => listeners.size,
    };
}

async function createActualLifecycle(input: Readonly<{ currentUiContext?: boolean }> = {}) {
    setPlatformOs('web');
    const { createOpenAiVoiceRuntimeEnvironment } = await import('@/dev/testkit/harness/openAiVoiceRuntime');
    const { installVoiceWebRtcBrowserBoundary, TestVoiceAudioContext } = await import('@/dev/testkit/harness/voiceWebRtcHarness');
    const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
    const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
    const environment = await createOpenAiVoiceRuntimeEnvironment();
    let uiScreen: Awaited<ReturnType<typeof import('@/dev/testkit')['renderScreen']>> | null = null;
    const currentUiContext: { current: ReturnType<typeof import('@/components/appShell/currentUiContext/currentUiContextVoiceToolPort')['useCurrentUiContextVoiceToolPort']> } = { current: null };
    if (input.currentUiContext) {
        const React = await import('react');
        const { renderScreen } = await import('@/dev/testkit');
        const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
        const { MainAppTabStateProvider } = await import('@/components/navigation/mobile/chrome/MainAppTabStateProvider');
        const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
        const { CurrentUiContextProvider, usePublishCurrentUiContext } = await import('@/components/appShell/currentUiContext/CurrentUiContextProvider');
        const { PluginSurfaceFocusEligibilityProvider } = await import('@/components/ui/presentation/PluginSurfaceFocusEligibility');
        const { useCurrentUiContextVoiceToolPort } = await import('@/components/appShell/currentUiContext/currentUiContextVoiceToolPort');
        const enrichment = { commands: [] };
        function Publication() {
            usePublishCurrentUiContext(enrichment);
            currentUiContext.current = useCurrentUiContextVoiceToolPort();
            return null;
        }
        const settings = storage.getState().settings;
        await environment.publishAccountSettings({ ...settings, featureToggles: { ...settings.featureToggles, voice: true } });
        uiScreen = await renderScreen(React.createElement(InjectedAuthProvider, {
            credentials: environment.accountConnection.credentials,
            children: React.createElement(MainAppTabStateProvider, { children: React.createElement(AppPaneProvider, {
                children: React.createElement(CurrentUiContextProvider, { children: React.createElement(PluginSurfaceFocusEligibilityProvider, {
                    active: true, currentUiContextActive: true, children: React.createElement(Publication),
                }) }),
            }) }),
        }));
        if (!currentUiContext.current) throw new Error('Actual mounted AppShell Voice port unavailable');
    }
    const audioContext = new TestVoiceAudioContext();
    const audioContexts: InstanceType<typeof TestVoiceAudioContext>[] = [];
    const browser = installVoiceWebRtcBrowserBoundary({ createAudioContext: () => {
        const context = audioContexts.length === 0 ? audioContext : new TestVoiceAudioContext();
        audioContexts.push(context);
        return context as unknown as AudioContext;
    } });
    const runtime = await environment.createRuntime(browser, { ...(currentUiContext.current ? { currentUiContext: currentUiContext.current } : {}) });
    const captureAdmission = createVoiceCaptureAdmissionController();
    const lifecycle = createVoiceSessionLifecycleController({ captureAdmission });
    lifecycle.setConfiguredProviderId(OPENAI_PROVIDER_ID);
    const target = { serverId: getActiveServerSnapshot().serverId, sessionId: runtime.historySessionId };
    return {
        environment, browser, runtime, audioContext, captureAdmission, lifecycle, target,
        async start(global = false) {
            const peerIndex = browser.peers.length;
            const starting = lifecycle.toggle(global ? null : target);
            const peer = await Promise.race([browser.peerCreated(peerIndex), starting.then(() => {
                const snapshot = lifecycle.getSnapshot();
                const observation = { status: snapshot.status, errorCode: snapshot.errorCode,
                    requests: environment.providerFetch.mock.calls.map(([input]) => new URL(String(input)).pathname),
                    accountOperations: runtime.requestAccountOperation.mock.calls.length,
                };
                expect(observation, JSON.stringify(observation)).toMatchObject({ status: 'connected' });
                return browser.peer;
            })]);
            await Promise.race([peer.dataChannelCreated, starting]);
            expect(peer.createDataChannel).toHaveBeenCalledWith('oai-events');
            peer.channel.open();
            await starting;
            expect(lifecycle.getSnapshot()).toMatchObject({ status: 'connected', canStop: true });
        },
        async dispose() {
            await lifecycle.dispose();
            await runtime.runtime.dispose();
            runtime.hostLease.revoke();
            await uiScreen?.unmount();
            browser.restore();
            await environment.dispose();
        },
    };
}

describe('createVoiceSessionLifecycleController', () => {
    it('removes native suspension without undoing a user mute chosen while suspended', async () => {
        const fixture = await createActualLifecycle();
        try {
            await fixture.start();
            const suspension = await fixture.lifecycle.suspendInput(fixture.runtime.historySessionId);
            expect(fixture.browser.micTrack.enabled).toBe(false);
            await fixture.lifecycle.setMuted(fixture.runtime.historySessionId, true);
            await suspension?.release();
            expect(fixture.browser.micTrack.enabled).toBe(false);
            expect(fixture.lifecycle.getSnapshot().micMuted).toBe(true);
            await fixture.lifecycle.setMuted(fixture.runtime.historySessionId, false);
            expect(fixture.browser.micTrack.enabled).toBe(true);
            expect(fixture.lifecycle.getSnapshot().micMuted === true).toBe(false);
        } finally { await fixture.dispose(); }
    });


    it('does not apply a stale session mute or suspension to the current session', async () => {
        const fixture = await createActualLifecycle();
        try {
            await fixture.start();
            await fixture.lifecycle.setMuted('another-session', true);
            expect(await fixture.lifecycle.suspendInput('another-session')).toBeNull();
            expect(fixture.browser.micTrack.enabled).toBe(true);
            expect(fixture.lifecycle.getSnapshot().micMuted === true).toBe(false);
        } finally { await fixture.dispose(); }
    });

    it('reports the configured provider consumed by the lifecycle owner', async () => {
        const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
        const controller = createVoiceSessionLifecycleController();
        try {
            expect(controller.getConfiguredProviderId()).toBeNull();
            controller.setConfiguredProviderId('local_conversation');
            expect(controller.getConfiguredProviderId()).toBe('local_conversation');
        } finally { await controller.dispose(); }
    });

    it('stays silent when Voice is switched off rather than misreporting a refusal', async () => {
        const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
        const controller = createVoiceSessionLifecycleController();
        controller.setConfiguredProviderId('off');
        const { log } = await import('@/log');
        const logSpy = vi.spyOn(log, 'log');
        try {
            await controller.toggle(sessionAddress('session-1'));
            expect(controller.getSnapshot()).toMatchObject({ status: 'disconnected', canStop: false });
            expect(logSpy.mock.calls.map((call) => String(call[0])).filter(line => line.includes('[voiceRuntimeFailure]'))).toEqual([]);
        } finally { logSpy.mockRestore(); await controller.dispose(); }
    });

    it('publishes the configured provider recoverable error after it disconnects', async () => {
        const fixture = await createActualLifecycle();
        try {
            const media = navigator.mediaDevices;
            vi.spyOn(media, 'getUserMedia').mockRejectedValueOnce(new DOMException('Microphone blocked', 'NotAllowedError'));
            await fixture.lifecycle.toggle(fixture.target).catch(() => undefined);
            await waitForTestEvent(fixture.lifecycle.subscribe, () => fixture.lifecycle.getSnapshot(), snapshot => snapshot.canStop === false);
            expect(fixture.lifecycle.getSnapshot().canStop).toBe(false);
            const failure = fixture.lifecycle.getSnapshot();
            expect(failure).toMatchObject({ adapterId: OPENAI_PROVIDER_ID, sessionId: fixture.runtime.historySessionId,
                errorCode: 'mic_permission_denied', errorRecoveryAction: 'open_settings', errorPresentation: 'permission_required' });
            fixture.lifecycle.rearmAfterCredentialAuthorityChange();
            expect(fixture.lifecycle.getSnapshot()).toEqual(failure);
        } finally { await fixture.dispose(); }
    });

    it('does not let a terminal error from the previous provider override the newly configured provider', async () => {
        const fixture = await createActualLifecycle();
        try {
            fixture.environment.providerFetch.mockResolvedValueOnce(Response.json({ error: { type: 'invalid_request_error', code: 'invalid_api_key', message: 'Invalid API key' } }, { status: 401 }));
            await fixture.lifecycle.toggle(fixture.target).catch(() => undefined);
            expect(fixture.lifecycle.getSnapshot()).toMatchObject({ adapterId: OPENAI_PROVIDER_ID, canStop: false, errorCode: 'provider_auth_invalid' });
            fixture.lifecycle.setConfiguredProviderId(CODEX_PROVIDER_ID);
            expect(fixture.lifecycle.getSnapshot()).toEqual({ adapterId: null, sessionId: null, status: 'disconnected', mode: 'idle', canStop: false });
            expect(fixture.browser.peers).toHaveLength(0);
        } finally { await fixture.dispose(); }
    });

    it('rearms only a terminal provider-auth failure and waits for the next explicit start', async () => {
        const fixture = await createActualLifecycle();
        try {
            fixture.environment.providerFetch.mockResolvedValueOnce(Response.json({ error: { code: 'invalid_api_key', message: 'Invalid API key' } }, { status: 401 }));
            await fixture.lifecycle.toggle(fixture.target).catch(() => undefined);
            expect(fixture.lifecycle.getSnapshot()).toMatchObject({ canStop: false, errorCode: 'provider_auth_invalid' });
            const before = fixture.environment.providerFetch.mock.calls.length;
            fixture.lifecycle.rearmAfterCredentialAuthorityChange();
            expect(fixture.lifecycle.getSnapshot()).toEqual({ adapterId: null, sessionId: null, status: 'disconnected', mode: 'idle', canStop: false });
            expect(fixture.environment.providerFetch).toHaveBeenCalledTimes(before);
            await fixture.start();
            expect(fixture.browser.micTrack.enabled).toBe(true);
        } finally { await fixture.dispose(); }
    });

    it('fences an active attachment when its credential authority changes', async () => {
        const fixture = await createActualLifecycle();
        try {
            await fixture.start();
            fixture.lifecycle.rearmAfterCredentialAuthorityChange({ exactSessionAccountScopeChanged: true });
            await waitForTestEvent(fixture.lifecycle.subscribe, () => fixture.lifecycle.getSnapshot(), snapshot => snapshot.canStop === false);
            expect(fixture.browser.micTrack.stop).toHaveBeenCalled();
            expect(fixture.lifecycle.getSnapshot().canStop).toBe(false);
            expect(fixture.browser.peer.close).toHaveBeenCalled();
            expect(fixture.lifecycle.getSnapshot().status).toBe('disconnected');
        } finally { await fixture.dispose(); }
    });

    it('keeps a connecting ordinary attachment when the change applies only to the next start', async () => {
        const fixture = await createActualLifecycle();
        let starting: Promise<void> | null = null;
        try {
            starting = fixture.lifecycle.toggle(fixture.target);
            void starting.catch(() => undefined);
            await (await fixture.browser.peerCreated()).dataChannelCreated;
            expect(fixture.browser.peer.createDataChannel).toHaveBeenCalledWith('oai-events');
            fixture.lifecycle.rearmAfterCredentialAuthorityChange({ exactSessionAccountScopeChanged: false, globalBindingAuthorityChanged: false });
            expect(fixture.browser.peer.close).not.toHaveBeenCalled();
            fixture.browser.peer.channel.open();
            await starting;
            expect(fixture.lifecycle.getSnapshot()).toMatchObject({ status: 'connected', sessionId: fixture.runtime.historySessionId });
            expect(fixture.browser.micTrack.enabled).toBe(true);
        } finally { await fixture.dispose(); await starting?.catch(() => undefined); }
    });

    it('keeps in-flight ordinary preparation when the change applies only to the next start', async () => {
        const fixture = await createActualLifecycle();
        const mint = createDeferred<Response>();
        const mintStarted = createDeferred<void>();
        fixture.environment.providerFetch.mockImplementationOnce(() => {
            mintStarted.resolve();
            return mint.promise;
        });
        let starting: Promise<void> | null = null;
        try {
            starting = fixture.lifecycle.toggle(fixture.target);
            void starting.catch(() => undefined);
            await mintStarted.promise;
            expect(fixture.environment.providerFetch).toHaveBeenCalled();
            fixture.lifecycle.rearmAfterCredentialAuthorityChange({ exactSessionAccountScopeChanged: false, globalBindingAuthorityChanged: false });
            expect(fixture.browser.peers).toHaveLength(0);
            mint.resolve(Response.json(fixture.environment.createClientAuthProviderResponse('ek_source_composed', Math.floor(Date.now() / 1000) + 60)));
            await (await fixture.browser.peerCreated()).dataChannelCreated;
            expect(fixture.browser.peer.createDataChannel).toHaveBeenCalledWith('oai-events');
            fixture.browser.peer.channel.open();
            await starting;
            expect(fixture.lifecycle.getSnapshot()).toMatchObject({ status: 'connected', canStop: true });
        } finally { mint.resolve(new Response('{}')); await fixture.dispose(); await starting?.catch(() => undefined); }
    });

    it('fences a connecting attachment when its exact credential authority changes', async () => {
        const fixture = await createActualLifecycle();
        let starting: Promise<void> | null = null;
        try {
            starting = fixture.lifecycle.toggle(null);
            void starting.catch(() => undefined);
            await (await fixture.browser.peerCreated()).dataChannelCreated;
            expect(fixture.browser.peer.createDataChannel).toHaveBeenCalledWith('oai-events');
            fixture.lifecycle.rearmAfterCredentialAuthorityChange({ globalBindingAuthorityChanged: true });
            await starting.catch(() => undefined);
            expect(fixture.browser.peer.close).toHaveBeenCalled();
            expect(fixture.browser.micTrack.stop).toHaveBeenCalled();
            expect(fixture.lifecycle.getSnapshot().canStop).toBe(false);
        } finally { await fixture.dispose(); await starting?.catch(() => undefined); }
    });

    it('fences in-flight preparation when its exact credential authority changes', async () => {
        const fixture = await createActualLifecycle();
        const mint = createDeferred<Response>();
        const mintStarted = createDeferred<void>();
        fixture.environment.providerFetch.mockImplementationOnce(() => {
            mintStarted.resolve();
            return mint.promise;
        });
        let starting: Promise<void> | null = null;
        try {
            starting = fixture.lifecycle.toggle(null);
            void starting.catch(() => undefined);
            await mintStarted.promise;
            expect(fixture.environment.providerFetch).toHaveBeenCalled();
            fixture.lifecycle.rearmAfterCredentialAuthorityChange({ exactSessionAccountScopeChanged: true });
            mint.resolve(Response.json(fixture.environment.createClientAuthProviderResponse('ek_source_composed', Math.floor(Date.now() / 1000) + 60)));
            await starting.catch(() => undefined);
            expect(fixture.browser.peers).toHaveLength(0);
            expect(fixture.browser.micSession.getStream()).toBeNull();
            expect(fixture.lifecycle.getSnapshot().canStop).toBe(false);
        } finally { mint.resolve(new Response('{}')); await fixture.dispose(); await starting?.catch(() => undefined); }
    });

    it('fences a pending Global Agent start when its selected global binding changes before publication', async () => {
        const fixture = await createActualLifecycle();
        const mint = createDeferred<Response>();
        const mintStarted = createDeferred<void>();
        fixture.environment.providerFetch.mockImplementationOnce(() => {
            mintStarted.resolve();
            return mint.promise;
        });
        let starting: Promise<void> | null = null;
        try {
            starting = fixture.lifecycle.toggle(null);
            void starting.catch(() => undefined);
            await mintStarted.promise;
            expect(fixture.environment.providerFetch).toHaveBeenCalled();
            fixture.lifecycle.rearmAfterCredentialAuthorityChange({ exactSessionAccountScopeChanged: false, globalBindingAuthorityChanged: true });
            mint.resolve(Response.json(fixture.environment.createClientAuthProviderResponse('ek_source_composed', Math.floor(Date.now() / 1000) + 60)));
            await starting.catch(() => undefined);
            expect(fixture.browser.peers).toHaveLength(0);
            expect(fixture.browser.micSession.getStream()).toBeNull();
            expect(fixture.lifecycle.getSnapshot().canStop).toBe(false);
        } finally { mint.resolve(new Response('{}')); await fixture.dispose(); await starting?.catch(() => undefined); }
    });

    it('retains an established ordinary OpenAI attachment until terminal after a next-start-only change', async () => {
        const fixture = await createActualLifecycle();
        try {
            await fixture.start();
            fixture.lifecycle.rearmAfterCredentialAuthorityChange({ exactSessionAccountScopeChanged: false, globalBindingAuthorityChanged: false });
            expect(fixture.lifecycle.getSnapshot()).toMatchObject({ status: 'connected', canStop: true });
            expect(fixture.browser.micTrack.enabled).toBe(true);
            expect(fixture.browser.peer.close).not.toHaveBeenCalled();
        } finally { await fixture.dispose(); }
    });

    it('routes barge-in only through the active adapter capability', async () => {
        const fixture = await createActualLifecycle();
        try {
            await fixture.start();
            fixture.browser.peer.channel.message(JSON.stringify({ type: 'output_audio_buffer.started', event_id: 'lifecycle-output-started', response_id: 'lifecycle-response' }));
            await waitForTestEvent(fixture.lifecycle.subscribe, () => fixture.lifecycle.getSnapshot(), snapshot => snapshot.mode === 'speaking');
            expect(fixture.lifecycle.getSnapshot().mode).toBe('speaking');
            const before = fixture.browser.peer.channel.sent.length;
            await fixture.lifecycle.bargeIn('another-visible-session');
            expect(fixture.browser.peer.channel.sent.slice(before).map(frame => JSON.parse(frame).type)).toContain('response.cancel');
            expect(fixture.lifecycle.getSnapshot()).toMatchObject({ sessionId: fixture.runtime.historySessionId, status: 'connected', canStop: true });
        } finally { await fixture.dispose(); }
    });

    it('routes output focus only through the exact active realtime adapter', async () => {
        const fixture = await createActualLifecycle();
        try {
            await fixture.start();
            expect(fixture.lifecycle.setOutputFocusState).toBeDefined();
            await expect(fixture.lifecycle.setOutputFocusState?.('another-visible-session', 'suspended')).resolves.toBe('applied');
            expect(fixture.browser.micTrack.enabled).toBe(true);
            expect(fixture.lifecycle.getSnapshot()).toMatchObject({ sessionId: fixture.runtime.historySessionId, status: 'connected', canStop: true });
            expect(fixture.browser.peer.close).not.toHaveBeenCalled();
            await expect(fixture.lifecycle.setOutputFocusState?.('another-visible-session', 'active')).resolves.toBe('applied');
        } finally { await fixture.dispose(); }
    });

    it('fails closed through the captured realtime adapter when active output restoration is unsupported', async () => {
        setPlatformOs('web');
        const { createXaiVoiceRuntimeEnvironment, XaiVoiceWebSocket } = await import('@/dev/testkit/harness/xaiVoiceRuntime');
        const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
        const environment = await createXaiVoiceRuntimeEnvironment();
        await environment.installSettings(false);
        const runtime = await environment.createRuntime();
        const controller = createVoiceSessionLifecycleController();
        controller.setConfiguredProviderId(runtime.runtime.adapter.id);
        try {
            await controller.toggle(null);
            expect(controller.getSnapshot()).toMatchObject({ adapterId: runtime.runtime.adapter.id,
                sessionId: runtime.controlSessionId, status: 'connected', canStop: true });
            const socket = environment.physicalSockets.at(-1);
            const output = environment.audioContexts.find(context => context.createGain.mock.calls.length > 0);
            if (!socket || !output) throw new Error('Actual xAI output device missing');
            // AudioParam is an OS boundary. The real connection catches its
            // failed restore and reports unsupported to the lifecycle owner.
            output.gain.setTargetAtTime.mockImplementationOnce(() => {
                throw new DOMException('Output device unavailable', 'InvalidStateError');
            });
            await expect(controller.setOutputFocusState?.('stale-visible-session', 'active')).resolves.toBe('unsupported');
            expect(controller.getSnapshot().canStop).toBe(false);
            expect(environment.browser.micTrack.stop).toHaveBeenCalled();
            expect(socket.readyState).toBeGreaterThanOrEqual(XaiVoiceWebSocket.CLOSING);
            expect(output.close).toHaveBeenCalled();
        } finally {
            await controller.dispose();
            await runtime.dispose();
            await environment.dispose();
        }
    });

    it('fails closed through the captured realtime adapter when active output restoration throws', async () => {
        const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
        const active = createAdapter({
            id: 'active',
            snapshot: { adapterId: 'active', sessionId: 'session-1', status: 'connected', mode: 'speaking', canStop: true },
        });
        const adapter: VoiceAdapterController = {
            ...active.controller,
            setOutputFocusState: vi.fn(() => { throw new Error('output_restore_failed'); }),
        };
        const controller = createVoiceSessionLifecycleController({ getRegistry: () => ({
            get: (id: string) => id === 'active' ? adapter : null,
            list: () => [adapter],
        }) });
        controller.setConfiguredProviderId('active');

        const applyOutputFocusState = controller.setOutputFocusState;
        if (!applyOutputFocusState) throw new Error('voice_output_focus_owner_missing');
        await expect(applyOutputFocusState('fallback', 'active')).resolves.toBe('unsupported');
        expect(active.stop).toHaveBeenCalledWith({ sessionId: 'session-1', signal: expect.any(AbortSignal) });
    });

    it('does not stop a same-session replacement after delayed unsupported output focus', async () => {
        const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
        const incumbent = createAdapter({
            id: 'active',
            snapshot: { adapterId: 'active', sessionId: 'session-1', status: 'connected', mode: 'speaking', canStop: true },
        });
        const replacement = createAdapter({
            id: 'active',
            snapshot: { adapterId: 'active', sessionId: 'session-1', status: 'connected', mode: 'speaking', canStop: true },
        });
        const incumbentAdapter: VoiceAdapterController = {
            ...incumbent.controller,
            setOutputFocusState: vi.fn(() => 'unsupported' as const),
        };
        const replacementAdapter: VoiceAdapterController = {
            ...replacement.controller,
            setOutputFocusState: vi.fn(() => 'applied' as const),
        };
        let currentAdapter = incumbentAdapter;
        const controller = createVoiceSessionLifecycleController({ getRegistry: () => ({
            get: (id: string) => id === 'active' ? currentAdapter : null,
            list: () => [currentAdapter],
        }) });
        controller.setConfiguredProviderId('active');

        const applyOutputFocusState = controller.setOutputFocusState;
        if (!applyOutputFocusState) throw new Error('voice_output_focus_owner_missing');
        const apply = applyOutputFocusState('fallback', 'suspended');
        expect(incumbentAdapter.setOutputFocusState).toHaveBeenCalledTimes(1);

        currentAdapter = replacementAdapter;

        await expect(apply).resolves.toBe('unsupported');
        expect(incumbent.stop).not.toHaveBeenCalled();
        expect(replacement.stop).not.toHaveBeenCalled();
    });

    it('does not stop a later same-adapter attempt after unsupported output focus from the prior attempt', async () => {
        const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
        const captureAdmission = createVoiceCaptureAdmissionController();
        const sessionId = 'session-1';
        let fixture!: ReturnType<typeof createAdapter>;
        fixture = createAdapter({
            id: 'active',
            snapshot: {
                adapterId: 'active',
                sessionId: null,
                status: 'disconnected',
                mode: 'idle',
                canStop: false,
            },
            start: async () => {
                fixture.setSnapshot({
                    adapterId: 'active',
                    sessionId,
                    status: 'connected',
                    mode: 'listening',
                    canStop: true,
                });
            },
            stop: async () => {
                fixture.setSnapshot({
                    adapterId: 'active',
                    sessionId: null,
                    status: 'disconnected',
                    mode: 'idle',
                    canStop: false,
                });
            },
        });
        const adapter: VoiceAdapterController = {
            ...fixture.controller,
            setOutputFocusState: vi.fn((): 'unsupported' => 'unsupported'),
        };
        const controller = createVoiceSessionLifecycleController({
            captureAdmission,
            getRegistry: () => ({
                get: (id: string) => id === adapter.id ? adapter : null,
                list: () => [adapter],
            }),
        });
        controller.setConfiguredProviderId(adapter.id);

        await controller.toggle(sessionAddress(sessionId));
        const applyOutputFocusState = controller.setOutputFocusState;
        if (!applyOutputFocusState) throw new Error('voice_output_focus_owner_missing');
        const staleApplication = applyOutputFocusState(sessionId, 'suspended');
        expect(adapter.setOutputFocusState).toHaveBeenCalledOnce();

        await controller.stop(sessionId);
        await controller.toggle(sessionAddress(sessionId));
        expect(fixture.start).toHaveBeenCalledTimes(2);
        expect(fixture.stop).toHaveBeenCalledOnce();

        await expect(staleApplication).resolves.toBe('unsupported');
        expect(fixture.stop).toHaveBeenCalledOnce();
        expect(controller.getSnapshot()).toMatchObject({
            adapterId: adapter.id,
            sessionId,
            status: 'connected',
            canStop: true,
        });
    });

    it('still stops the same owned attempt after an ordinary snapshot update', async () => {
        const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
        const active = createAdapter({
            id: 'active',
            snapshot: { adapterId: 'active', sessionId: 'session-1', status: 'connected', mode: 'speaking', canStop: true },
        });
        const adapter: VoiceAdapterController = {
            ...active.controller,
            setOutputFocusState: vi.fn(() => 'unsupported' as const),
        };
        const controller = createVoiceSessionLifecycleController({ getRegistry: () => ({
            get: (id: string) => id === 'active' ? adapter : null,
            list: () => [adapter],
        }) });
        controller.setConfiguredProviderId('active');

        const applyOutputFocusState = controller.setOutputFocusState;
        if (!applyOutputFocusState) throw new Error('voice_output_focus_owner_missing');
        const apply = applyOutputFocusState('fallback', 'suspended');
        expect(adapter.setOutputFocusState).toHaveBeenCalledTimes(1);

        active.setSnapshot({
            adapterId: 'active',
            sessionId: 'session-1',
            status: 'connected',
            mode: 'listening',
            canStop: true,
        });
        await expect(apply).resolves.toBe('unsupported');
        expect(active.stop).toHaveBeenCalledWith({ sessionId: 'session-1', signal: expect.any(AbortSignal) });
    });
    it('does not republish a pending switch after dispose', async () => {
        const fixture = await createActualLifecycle();
        const cleanup = createDeferred<void>();
        const cleanupStarted = createDeferred<void>();
        fixture.audioContext.close.mockImplementation(() => {
            cleanupStarted.resolve();
            return cleanup.promise;
        });
        try {
            fixture.lifecycle.setCurrentUiContextToolSetEnabled(false);
            await fixture.start();
            fixture.lifecycle.setCurrentUiContextToolSetEnabled(true);
            await cleanupStarted.promise;
            expect(fixture.audioContext.close).toHaveBeenCalled();
            const disposal = fixture.lifecycle.dispose();
            const frozen = fixture.lifecycle.getSnapshot();
            const requests = fixture.environment.providerFetch.mock.calls.length;
            cleanup.resolve();
            await disposal;
            expect(fixture.lifecycle.getSnapshot()).toBe(frozen);
            expect(fixture.environment.providerFetch).toHaveBeenCalledTimes(requests);
            expect(fixture.browser.micSession.getStream()).toBeNull();
        } finally { cleanup.resolve(); await fixture.dispose(); }
    });

    it('discards an Account-retired pending provider switch before source stop settles', async () => {
        const fixture = await createActualLifecycle();
        const cleanup = createDeferred<void>();
        const cleanupStarted = createDeferred<void>();
        fixture.audioContext.close.mockImplementation(() => {
            cleanupStarted.resolve();
            return cleanup.promise;
        });
        try {
            fixture.lifecycle.setCurrentUiContextToolSetEnabled(false);
            await fixture.start();
            fixture.lifecycle.setCurrentUiContextToolSetEnabled(true);
            await cleanupStarted.promise;
            expect(fixture.audioContext.close).toHaveBeenCalled();
            fixture.lifecycle.rearmAfterCredentialAuthorityChange({ exactSessionAccountScopeChanged: true });
            const requests = fixture.environment.providerFetch.mock.calls.length;
            cleanup.resolve();
            await waitForTestEvent(fixture.lifecycle.subscribe, () => fixture.lifecycle.getSnapshot(), snapshot => snapshot.canStop === false);
            expect(fixture.lifecycle.getSnapshot().canStop).toBe(false);
            expect(fixture.browser.micSession.getStream()).toBeNull();
            expect(fixture.environment.providerFetch).toHaveBeenCalledTimes(requests);
            expect(fixture.lifecycle.getSnapshot()).toEqual({ adapterId: null, sessionId: null, status: 'disconnected', mode: 'idle', canStop: false });
        } finally { cleanup.resolve(); await fixture.dispose(); }
    });

    it('keeps ownership disconnected while a provider switch is pending and ignores stale source reconnects', async () => {
        const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
        const { getVoiceSessionSnapshot, setVoiceSessionSnapshot } = await import('./voiceSessionStore');

        const stopDeferred = createDeferred<void>();
        const sourceAdapter = createAdapter({
            id: 'local_direct',
            snapshot: {
                adapterId: 'local_direct',
                sessionId: 'session-1',
                status: 'connected',
                mode: 'listening',
                canStop: true,
            },
            stop: async () => {
                sourceAdapter.setSnapshot({
                    adapterId: 'local_direct',
                    sessionId: null,
                    status: 'disconnected',
                    mode: 'idle',
                    canStop: false,
                });
                await stopDeferred.promise;
            },
        });
        const targetStartDeferred = createDeferred<void>();
        const targetAdapter = createAdapter({
            id: 'local_conversation',
            snapshot: {
                adapterId: 'local_conversation',
                sessionId: null,
                status: 'disconnected',
                mode: 'idle',
                canStop: false,
            },
            start: async () => {
                await targetStartDeferred.promise;
            },
        });
        const registry: VoiceAdapterRegistry = {
            get: (id) => {
                if (id === sourceAdapter.controller.id) return sourceAdapter.controller;
                if (id === targetAdapter.controller.id) return targetAdapter.controller;
                return null;
            },
            list: () => [sourceAdapter.controller, targetAdapter.controller],
        };

        setVoiceSessionSnapshot({
            adapterId: 'local_direct',
            sessionId: 'session-1',
            status: 'connected',
            mode: 'listening',
            canStop: true,
        });

        const controller = createVoiceSessionLifecycleController({
            getRegistry: () => registry,
        });

        controller.setConfiguredProviderId('local_conversation');
        expect(sourceAdapter.stop).toHaveBeenCalledTimes(1);
        expect(targetAdapter.start).not.toHaveBeenCalled();
        expect(controller.getSnapshot()).toMatchObject({
            adapterId: null,
            sessionId: null,
            status: 'disconnected',
            mode: 'idle',
            canStop: false,
        });

        sourceAdapter.setSnapshot({
            adapterId: 'local_direct',
            sessionId: 'session-1',
            status: 'connecting',
            mode: 'idle',
            canStop: true,
        });

        expect(controller.getSnapshot()).toMatchObject({
            adapterId: null,
            sessionId: null,
            status: 'disconnected',
            mode: 'idle',
            canStop: false,
        });
        expect(targetAdapter.start).not.toHaveBeenCalled();

        stopDeferred.resolve();
        await vi.waitFor(() => expect(targetAdapter.start).toHaveBeenCalledTimes(1));

        targetAdapter.setSnapshot({
            adapterId: 'local_conversation',
            sessionId: 'session-1',
            status: 'connecting',
            mode: 'idle',
            canStop: true,
        });

        expect(controller.getSnapshot()).toMatchObject({
            adapterId: 'local_conversation',
            sessionId: 'session-1',
            status: 'connecting',
            mode: 'idle',
            canStop: true,
        });

        await sourceAdapter.stop.mock.results[0]?.value;
        targetStartDeferred.resolve();
        await targetAdapter.start.mock.results[0]?.value;
        await controller.dispose();
    });

    it('stays disconnected after switching off even if the old source later reconnects', async () => {
        const fixture = await createActualLifecycle();
        const cleanup = createDeferred<void>();
        const cleanupStarted = createDeferred<void>();
        fixture.audioContext.close.mockImplementation(() => {
            cleanupStarted.resolve();
            return cleanup.promise;
        });
        try {
            await fixture.start();
            fixture.lifecycle.setConfiguredProviderId('off');
            await cleanupStarted.promise;
            expect(fixture.audioContext.close).toHaveBeenCalled();
            cleanup.resolve();
            await waitForTestEvent(fixture.lifecycle.subscribe, () => fixture.lifecycle.getSnapshot(), snapshot => snapshot.status === 'disconnected');
            expect(fixture.lifecycle.getSnapshot().status).toBe('disconnected');
            // A stale browser task from the retired peer cannot restore authority.
            fixture.browser.peer.connectionState = 'connected';
            fixture.browser.peer.dispatchEvent(new Event('connectionstatechange'));
            fixture.browser.peer.channel.message(JSON.stringify({ type: 'session.created', event_id: 'stale-connection', session: { id: 'stale-session', type: 'realtime' } }));
            expect(fixture.lifecycle.getSnapshot()).toEqual({ adapterId: null, sessionId: null, status: 'disconnected', mode: 'idle', canStop: false });
            expect(fixture.browser.micSession.getStream()).toBeNull();
        } finally { cleanup.resolve(); await fixture.dispose(); }
    });

    it('stops the owned adapter through the canonical lifecycle controller seam', async () => {
        const fixture = await createActualLifecycle();
        const cleanup = createDeferred<void>();
        const cleanupStarted = createDeferred<void>();
        const endedTrackStates: MediaStreamTrackState[] = [];
        const unsubscribe = fixture.lifecycle.subscribe(() => {
            const snapshot = fixture.lifecycle.getSnapshot();
            if (snapshot.status === 'disconnected' && !snapshot.canStop) {
                endedTrackStates.push(fixture.browser.micTrack.readyState);
            }
        });
        fixture.audioContext.close.mockImplementation(() => {
            cleanupStarted.resolve();
            return cleanup.promise;
        });
        try {
            await fixture.start();
            const stop = fixture.lifecycle.stop('stale-session');
            await cleanupStarted.promise;
            expect(fixture.browser.micTrack.stop).toHaveBeenCalled();
            cleanup.resolve();
            await stop;
            expect(fixture.browser.peer.close).toHaveBeenCalled();
            expect(fixture.lifecycle.getSnapshot()).toMatchObject({ status: 'disconnected', canStop: false });
            expect(endedTrackStates.length).toBeGreaterThan(0);
            expect(endedTrackStates.every(state => state === 'ended')).toBe(true);
        } finally { unsubscribe(); cleanup.resolve(); await fixture.dispose(); }
    });

    it.each(['stop', 'toggle'] as const)('%s cancels a queued provider replacement before source cleanup settles', async (operation) => {
        const fixture = await createActualLifecycle();
        const { registerVoiceAdapters } = await import('./voiceAdapterRegistry');
        const { createLocalConversationVoiceAdapter } = await import('@/voice/adapters/localConversation/localConversationAdapter');
        // Keep both real adapters and their host wiring; hold only the physical
        // Web Audio cleanup that serializes the provider handoff.
        registerVoiceAdapters([fixture.runtime.adapter, createLocalConversationVoiceAdapter()]);
        const cleanup = createDeferred<void>();
        const cleanupStarted = createDeferred<void>();
        fixture.audioContext.close.mockImplementation(() => {
            cleanupStarted.resolve();
            return cleanup.promise;
        });
        try {
            await fixture.start();
            fixture.lifecycle.setConfiguredProviderId('off');
            await cleanupStarted.promise;
            expect(fixture.audioContext.close).toHaveBeenCalled();
            await fixture.environment.configureVoice({ ...storage.getState().settings.voice, providerId: 'local_conversation' });
            fixture.lifecycle.setConfiguredProviderId('local_conversation');
            const ending = operation === 'stop'
                ? fixture.lifecycle.stop(fixture.runtime.historySessionId)
                : fixture.lifecycle.toggle(fixture.target);
            cleanup.resolve();
            await ending;
            expect(fixture.lifecycle.getSnapshot()).toEqual({ adapterId: null, sessionId: null, status: 'disconnected', mode: 'idle', canStop: false });
            expect(fixture.browser.micSession.getStream()).toBeNull();
        } finally { cleanup.resolve(); await fixture.dispose(); }
    });

    it('starts the configured adapter when toggled from a disconnected state', async () => {
        const fixture = await createActualLifecycle();
        try {
            await fixture.start();
            expect(fixture.lifecycle.getSnapshot()).toMatchObject({ adapterId: OPENAI_PROVIDER_ID, sessionId: fixture.runtime.historySessionId, status: 'connected', mode: 'idle', canStop: true });
            expect(fixture.lifecycle.getAttemptTargetSessionAddress()).toEqual(fixture.target);
            expect(fixture.browser.micTrack.enabled).toBe(true);
            expect(fixture.browser.peer.channel.sent.map(frame => JSON.parse(frame).type)).toContain('session.update');
        } finally { await fixture.dispose(); }
    });

    it('settles a current terminal retryable connection failure after the adapter publishes recovery', async () => {
        const fixture = await createActualLifecycle();
        try {
            fixture.environment.providerFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
            await expect(fixture.lifecycle.toggle(fixture.target)).resolves.toBeUndefined();
            expect(fixture.lifecycle.getSnapshot()).toMatchObject({ adapterId: OPENAI_PROVIDER_ID, sessionId: fixture.runtime.historySessionId,
                status: 'error', canStop: false, errorCode: 'voice_connection_failed', errorRecoveryAction: 'retry' });
            expect(fixture.browser.micSession.getStream()).toBeNull();
        } finally { await fixture.dispose(); }
    });

    it('settles a blank global Start only after the canonical global session enters and leaves the attempt', async () => {
        const fixture = await createActualLifecycle();
        const published: VoiceSessionSnapshot[] = [];
        const unsubscribe = fixture.lifecycle.subscribe(() => published.push(fixture.lifecycle.getSnapshot()));
        try {
            fixture.environment.providerFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
            await expect(fixture.lifecycle.toggle(null)).resolves.toBeUndefined();
            expect(published.some(snapshot => snapshot.sessionId === VOICE_AGENT_GLOBAL_SESSION_ID && snapshot.canStop)).toBe(true);
            expect(fixture.lifecycle.getSnapshot()).toMatchObject({ sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
                status: 'error', canStop: false, errorCode: 'voice_connection_failed', errorRecoveryAction: 'retry' });
        } finally { unsubscribe(); await fixture.dispose(); }
    });

    it('rethrows an unannounced failure after an unrelated registry republish refreshes a prior retryable error', async () => {
        const fixture = await createActualLifecycle();
        try {
            fixture.environment.providerFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
            await fixture.lifecycle.toggle(fixture.target);
            expect(fixture.lifecycle.getSnapshot()).toMatchObject({ errorCode: 'voice_connection_failed', errorRecoveryAction: 'retry' });
            fixture.runtime.hostLease.revoke();
            const { registerVoiceAdapters } = await import('./voiceAdapterRegistry');
            registerVoiceAdapters([fixture.runtime.adapter]);
            await expect(fixture.lifecycle.toggle(fixture.target)).rejects.toMatchObject({ code: 'voice_runtime_generation_revoked' });
            expect(fixture.browser.peers).toHaveLength(0);
        } finally { await fixture.dispose(); }
    });

    it('rethrows a blank global Start when a registry republish only carries a prior direct-session retryable error', async () => {
        const fixture = await createActualLifecycle();
        try {
            fixture.environment.providerFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
            await fixture.lifecycle.toggle(fixture.target);
            expect(fixture.lifecycle.getSnapshot()).toMatchObject({ sessionId: fixture.runtime.historySessionId, errorCode: 'voice_connection_failed' });
            fixture.runtime.hostLease.revoke();
            const { registerVoiceAdapters } = await import('./voiceAdapterRegistry');
            registerVoiceAdapters([fixture.runtime.adapter]);
            await expect(fixture.lifecycle.toggle(null)).rejects.toMatchObject({ code: 'voice_runtime_generation_revoked' });
            expect(fixture.lifecycle.getSnapshot().sessionId).not.toBe(VOICE_AGENT_GLOBAL_SESSION_ID);
            expect(fixture.browser.peers).toHaveLength(0);
        } finally { await fixture.dispose(); }
    });

    it('rethrows a retryable failure that was already published before this Start', async () => {
        const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
        const previousFailure = Object.assign(new Error('voice_connection_failed'), {
            code: 'voice_connection_failed',
        });
        const adapter = createAdapter({
            id: OPENAI_PROVIDER_ID,
            snapshot: {
                adapterId: OPENAI_PROVIDER_ID,
                sessionId: 'previous-session',
                status: 'error',
                mode: 'idle',
                canStop: false,
                errorCode: 'voice_connection_failed',
                errorMessage: 'voice_connection_failed',
                errorRecoveryAction: 'retry',
                errorPresentation: 'error',
            },
            start: async () => {
                throw previousFailure;
            },
        });
        const controller = createVoiceSessionLifecycleController({ getRegistry: () => ({
            get: (id: string) => id === adapter.controller.id ? adapter.controller : null,
            list: () => [adapter.controller],
        }) });
        controller.setConfiguredProviderId(OPENAI_PROVIDER_ID);

        await expect(controller.toggle(sessionAddress('session-1'))).rejects.toBe(previousFailure);
    });

    it('rethrows a current terminal failure without retryable recovery', async () => {
        const fixture = await createActualLifecycle();
        const respond = fixture.environment.providerFetch.getMockImplementation();
        if (!respond) throw new Error('Actual OpenAI HTTP boundary unavailable');
        fixture.environment.providerFetch.mockImplementation((input: URL | RequestInfo, init?: RequestInit) => (
            String(input).endsWith('/v1/realtime/calls')
                ? Promise.resolve(Response.json({ error: 'unauthorized' }, { status: 401 }))
                : respond(input, init)
        ));
        try {
            await expect(fixture.lifecycle.toggle(fixture.target)).rejects.toMatchObject({ code: 'credential_unavailable' });
            expect(fixture.lifecycle.getSnapshot()).toMatchObject({
                adapterId: OPENAI_PROVIDER_ID, sessionId: fixture.runtime.historySessionId,
                status: 'error', canStop: false, errorCode: 'provider_auth_invalid',
                errorMessage: 'credential_unavailable', errorRecoveryAction: 'review_credentials',
            });
            expect(fixture.browser.peers).toHaveLength(1);
            expect(fixture.browser.peer.createOffer).toHaveBeenCalled();
            expect(fixture.browser.peer.close).toHaveBeenCalled();
            expect(fixture.browser.micTrack.stop).toHaveBeenCalled();
            expect(fixture.browser.micSession.getStream()).toBeNull();
        } finally { await fixture.dispose(); }
    });

    it('rethrows a cancellation after the attempted adapter settles disconnected', async () => {
        const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
        const cancelled = Object.assign(new Error('voice_connection_aborted'), { name: 'AbortError' });
        let adapter!: ReturnType<typeof createAdapter>;
        adapter = createAdapter({
            id: OPENAI_PROVIDER_ID,
            snapshot: {
                adapterId: OPENAI_PROVIDER_ID,
                sessionId: null,
                status: 'disconnected',
                mode: 'idle',
                canStop: false,
            },
            start: async () => {
                adapter.setSnapshot({
                    adapterId: OPENAI_PROVIDER_ID,
                    sessionId: null,
                    status: 'disconnected',
                    mode: 'idle',
                    canStop: false,
                });
                throw cancelled;
            },
        });
        const controller = createVoiceSessionLifecycleController({ getRegistry: () => ({
            get: (id: string) => id === adapter.controller.id ? adapter.controller : null,
            list: () => [adapter.controller],
        }) });
        controller.setConfiguredProviderId(OPENAI_PROVIDER_ID);

        await expect(controller.toggle(sessionAddress('session-1'))).rejects.toBe(cancelled);
    });

    it('rethrows an old adapter failure after the configured provider changes', async () => {
        const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
        const staleFailure = Object.assign(new Error('voice_connection_failed'), {
            code: 'voice_connection_failed',
        });
        let controller!: ReturnType<typeof createVoiceSessionLifecycleController>;
        let source!: ReturnType<typeof createAdapter>;
        source = createAdapter({
            id: OPENAI_PROVIDER_ID,
            snapshot: {
                adapterId: OPENAI_PROVIDER_ID,
                sessionId: null,
                status: 'disconnected',
                mode: 'idle',
                canStop: false,
            },
            start: async () => {
                controller.setConfiguredProviderId(CODEX_PROVIDER_ID);
                source.setSnapshot({
                    adapterId: OPENAI_PROVIDER_ID,
                    sessionId: 'session-1',
                    status: 'error',
                    mode: 'idle',
                    canStop: false,
                    errorCode: 'voice_connection_failed',
                    errorMessage: 'voice_connection_failed',
                    errorRecoveryAction: 'retry',
                    errorPresentation: 'error',
                });
                throw staleFailure;
            },
        });
        const target = createAdapter({
            id: CODEX_PROVIDER_ID,
            snapshot: {
                adapterId: CODEX_PROVIDER_ID,
                sessionId: null,
                status: 'disconnected',
                mode: 'idle',
                canStop: false,
            },
        });
        controller = createVoiceSessionLifecycleController({ getRegistry: () => ({
            get: (id: string) => {
                if (id === source.controller.id) return source.controller;
                if (id === target.controller.id) return target.controller;
                return null;
            },
            list: () => [source.controller, target.controller],
        }) });
        controller.setConfiguredProviderId(OPENAI_PROVIDER_ID);

        await expect(controller.toggle(sessionAddress('session-1'))).rejects.toBe(staleFailure);
    });

    it('rethrows a start rejection that published no terminal recovery', async () => {
        const fixture = await createActualLifecycle();
        try {
            fixture.runtime.hostLease.revoke();
            await expect(fixture.lifecycle.toggle(fixture.target)).rejects.toMatchObject({ code: 'voice_runtime_generation_revoked' });
            expect(fixture.environment.providerFetch).not.toHaveBeenCalled();
            expect(fixture.browser.micSession.getStream()).toBeNull();
            expect(fixture.lifecycle.getSnapshot()).toMatchObject({ status: 'disconnected', canStop: false });
        } finally { await fixture.dispose(); }
    });

    it('stops the owned adapter when toggled from an active state', async () => {
        const fixture = await createActualLifecycle();
        try {
            await fixture.start();
            await fixture.lifecycle.toggle({ ...fixture.target, sessionId: 'another-visible-session' });
            expect(fixture.lifecycle.getSnapshot()).toMatchObject({ status: 'disconnected', canStop: false });
            expect(fixture.browser.micTrack.stop).toHaveBeenCalled();
            expect(fixture.browser.peer.close).toHaveBeenCalled();
            expect(fixture.browser.peer.createDataChannel).toHaveBeenCalledTimes(1);
        } finally { await fixture.dispose(); }
    });

    it('routes Retry for an owned reconnect through the same adapter without toggling its lifecycle', async () => {
        const fixture = await createActualLifecycle();
        const { TestVoiceWebRtcPeer } = await import('@/dev/testkit/harness/voiceWebRtcHarness');
        const reconnectPeer = new TestVoiceWebRtcPeer();
        try {
            await fixture.start();
            vi.stubGlobal('RTCPeerConnection', vi.fn(() => reconnectPeer));
            fixture.browser.peer.connectionState = 'failed';
            fixture.browser.peer.dispatchEvent(new Event('connectionstatechange'));
            await reconnectPeer.dataChannelCreated;
            expect(reconnectPeer.createDataChannel).toHaveBeenCalledWith('oai-events');
            const retry = fixture.lifecycle.retry('another-visible-session');
            reconnectPeer.channel.open();
            await retry;
            await waitForTestEvent(fixture.lifecycle.subscribe, () => fixture.lifecycle.getSnapshot(), snapshot => snapshot.status === 'connected' && snapshot.canStop === true);
            expect(fixture.lifecycle.getSnapshot()).toMatchObject({ adapterId: OPENAI_PROVIDER_ID,
                sessionId: fixture.runtime.historySessionId, status: 'connected', canStop: true });
            expect(reconnectPeer.close).not.toHaveBeenCalled();
            expect(reconnectPeer.createDataChannel).toHaveBeenCalledTimes(1);
            expect(fixture.environment.providerFetch.mock.calls.filter(([url]) => String(url).endsWith('/v1/realtime/client_secrets'))).toHaveLength(1);
            expect(fixture.lifecycle.getAttemptTargetSessionAddress()).toEqual(fixture.target);
        } finally { reconnectPeer.channel.open(); await fixture.dispose(); }
    });

    it('reconnects a realtime attempt with the current UI tool set only when disclosure crosses the off boundary', async () => {
        const fixture = await createActualLifecycle({ currentUiContext: true });
        const { StrictJsonValueSchema } = await import('@happier-dev/protocol/json/strictJsonValue');
        const currentUiToolNames = new Set([
            String(getActionSpec('ui.current_context.read').bindings?.voiceClientToolName ?? ''),
            String(getActionSpec('ui.current_context.command.invoke').bindings?.voiceClientToolName ?? ''),
        ]);
        const toolsAt = (index: number): string[] => {
            const peer = fixture.browser.peers[index];
            if (!peer) throw new Error('Actual OpenAI peer missing');
            const controls = peer.channel.sent.map(raw => StrictJsonValueSchema.parse(JSON.parse(raw)));
            const update = controls.find((value): value is Readonly<Record<string, ReturnType<typeof StrictJsonValueSchema.parse>>> => isControlRecord(value) && value.type === 'session.update');
            if (!isControlRecord(update)) throw new Error('OpenAI session.update missing');
            const session = update.session;
            if (!isControlRecord(session) || !Array.isArray(session.tools)) {
                throw new Error('OpenAI tool configuration missing');
            }
            return session.tools.flatMap(tool => tool && typeof tool === 'object' && !Array.isArray(tool)
                && typeof tool.name === 'string' && currentUiToolNames.has(tool.name) ? [tool.name] : []);
        };
        const setMode = async (mode: 'off' | 'on_demand' | 'automatic') => {
            const voice = storage.getState().settings.voice;
            await fixture.environment.configureVoice({ ...voice, privacy: { ...voice.privacy, currentUiContextMode: mode } });
            fixture.lifecycle.setCurrentUiContextToolSetEnabled(mode !== 'off');
        };
        const finishRestart = async (peers: number) => {
            const peer = await fixture.browser.peerCreated(peers - 1);
            expect(fixture.browser.peers).toHaveLength(peers);
            await peer.dataChannelCreated;
            peer.channel.open();
            await waitForTestEvent(fixture.lifecycle.subscribe, () => fixture.lifecycle.getSnapshot(), snapshot => snapshot.status === 'connected' && snapshot.canStop === true);
            expect(fixture.lifecycle.getSnapshot()).toMatchObject({
                adapterId: OPENAI_PROVIDER_ID, sessionId: fixture.runtime.historySessionId,
                status: 'connected', canStop: true,
            });
        };
        try {
            await setMode('off');
            await fixture.start();
            expect(toolsAt(0)).toEqual([]);
            await setMode('on_demand');
            await finishRestart(2);
            expect(toolsAt(1)).toEqual(expect.arrayContaining([...currentUiToolNames]));
            expect(fixture.browser.peers[0]?.connectionState).toBe('closed');
            const incumbent = fixture.browser.peer;
            await setMode('automatic');
            await setMode('on_demand');
            expect(fixture.browser.peers).toHaveLength(2);
            expect(incumbent.connectionState).not.toBe('closed');
            expect(fixture.lifecycle.getSnapshot()).toMatchObject({ status: 'connected', canStop: true });
            await setMode('off');
            await finishRestart(3);
            expect(toolsAt(2)).toEqual([]);
            expect(incumbent.connectionState).toBe('closed');
        } finally { await fixture.dispose(); }
    });

    it('restarts a realtime provider-switch target when current-UI disclosure changes while it connects', async () => {
        const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
        const { setVoiceSessionSnapshot } = await import('./voiceSessionStore');
        const previousSettings = storage.getState().settings;
        const currentUiContext = {
            readCurrentUiContext: () => ({
                navigation: { area: 'app' as const, screen: 'home' },
                commands: [],
            }),
            resolveCurrentUiCommand: () => null,
            subscribe: () => () => {},
            invokeCurrentUiCommand: async () => ({ ok: true as const }),
        };
        const hostLease = createBundledConversationRuntimeHostLease({ currentUiContext });
        const currentUiToolNames = new Set([
            String(getActionSpec('ui.current_context.read').bindings?.voiceClientToolName ?? '').trim(),
            String(getActionSpec('ui.current_context.command.invoke').bindings?.voiceClientToolName ?? '').trim(),
        ]);
        const targetToolSetsSeenByProvider: string[][] = [];
        const targetFirstStart = createDeferred<void>();
        let targetStarts = 0;
        let sourceSnapshot: VoiceSessionSnapshot = {
            adapterId: 'realtime-source',
            sessionId: 'voice-session',
            status: 'connected',
            mode: 'listening',
            canStop: true,
        };
        let targetSnapshot: VoiceSessionSnapshot = {
            adapterId: 'realtime-target',
            sessionId: null,
            status: 'disconnected',
            mode: 'idle',
            canStop: false,
        };
        const sourceListeners = new Set<() => void>();
        const targetListeners = new Set<() => void>();
        const sourceAdapter: VoiceAdapterController = {
            id: 'realtime-source',
            engineKind: 'realtime',
            start: vi.fn(async () => {}),
            stop: vi.fn(async ({ sessionId }) => {
                sourceSnapshot = {
                    adapterId: 'realtime-source',
                    sessionId,
                    status: 'disconnected',
                    mode: 'idle',
                    canStop: false,
                };
                for (const listener of sourceListeners) listener();
            }),
            toggle: vi.fn(async () => {}),
            interrupt: vi.fn(async () => {}),
            bargeIn: vi.fn(async () => {}),
            setMuted: vi.fn(async () => {}),
            sendContextUpdate: vi.fn(),
            getSnapshot: () => sourceSnapshot,
            subscribe: (listener) => {
                sourceListeners.add(listener);
                return () => sourceListeners.delete(listener);
            },
        };
        const targetAdapter: VoiceAdapterController = {
            id: 'realtime-target',
            engineKind: 'realtime',
            start: vi.fn(async ({ sessionId }) => {
                targetStarts += 1;
                targetToolSetsSeenByProvider.push(
                    hostLease.host.getRealtimeClientToolDefinitions({ effectCalls: 'stable_ids', exposure: 'voice_assistant' })
                        .map((tool) => tool.name)
                        .filter((name) => currentUiToolNames.has(name)),
                );
                if (targetStarts === 1) {
                    await targetFirstStart.promise;
                }
                targetSnapshot = {
                    adapterId: 'realtime-target',
                    sessionId,
                    status: 'connected',
                    mode: 'listening',
                    canStop: true,
                };
                for (const listener of targetListeners) listener();
            }),
            stop: vi.fn(async ({ sessionId }) => {
                targetSnapshot = {
                    adapterId: 'realtime-target',
                    sessionId,
                    status: 'disconnected',
                    mode: 'idle',
                    canStop: false,
                };
                for (const listener of targetListeners) listener();
            }),
            toggle: vi.fn(async () => {}),
            interrupt: vi.fn(async () => {}),
            bargeIn: vi.fn(async () => {}),
            setMuted: vi.fn(async () => {}),
            sendContextUpdate: vi.fn(),
            getSnapshot: () => targetSnapshot,
            subscribe: (listener) => {
                targetListeners.add(listener);
                return () => targetListeners.delete(listener);
            },
        };
        const controller = createVoiceSessionLifecycleController({ getRegistry: () => ({
            get: (id) => {
                if (id === sourceAdapter.id) return sourceAdapter;
                if (id === targetAdapter.id) return targetAdapter;
                return null;
            },
            list: () => [sourceAdapter, targetAdapter],
        }) });
        const setMode = (currentUiContextMode: 'off' | 'on_demand' | 'automatic') => {
            storage.setState((state) => ({
                ...state,
                settings: {
                    ...state.settings,
                    experiments: true,
                    featureToggles: {
                        ...state.settings.featureToggles,
                        voice: true,
                    },
                    voice: {
                        ...state.settings.voice,
                        privacy: {
                            ...state.settings.voice.privacy,
                            currentUiContextMode,
                        },
                    },
                },
            }));
        };

        try {
            setVoiceSessionSnapshot(sourceSnapshot);
            setMode('on_demand');
            controller.setCurrentUiContextToolSetEnabled(true);
            controller.setConfiguredProviderId(sourceAdapter.id);
            controller.setConfiguredProviderId(targetAdapter.id);
            await vi.waitFor(() => expect(targetAdapter.start).toHaveBeenCalledTimes(1));

            setMode('off');
            controller.setCurrentUiContextToolSetEnabled(false);
            targetFirstStart.resolve();

            await vi.waitFor(() => expect(targetAdapter.start).toHaveBeenCalledTimes(2));
            expect(targetToolSetsSeenByProvider).toEqual([
                ['readCurrentUiContext', 'invokeCurrentUiCommand'],
                [],
            ]);
        } finally {
            targetFirstStart.resolve();
            await controller.dispose();
            hostLease.revoke();
            storage.setState((state) => ({ ...state, settings: previousSettings }));
        }
    });

    describe('actual local model-session disclosure', () => {
        registerLocalVoiceEngineHarnessHooks({ serverIdentityId: 'srv_voice_recovery_home' });

        beforeEach(async () => {
            const { RPC_METHODS } = await import('@happier-dev/protocol/rpc');
            const { DaemonVoiceInferenceModelsWarmResponseSchema } = await import('@happier-dev/protocol/daemon/voiceInference');
            const incumbent = machineRpcWithServerScope.getMockImplementation();
            if (!incumbent) throw new Error('Actual local Voice Socket responder missing');
            machineRpcWithServerScope.mockImplementation((request: Readonly<{ method: string }>) => (
                request.method === RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_WARM
                    ? Promise.resolve(DaemonVoiceInferenceModelsWarmResponseSchema.parse({ ok: true, models: [] }))
                    : incumbent(request)
            ));
        });

        it.each(['explicit New', 'idle Start with new lifetime'] as const)(
            'retries an unknown New conversation creation with the same ordinary Session creation key: %s', async (entry) => {
            const state = await getStorage();
            const { readLocalConversationVoiceSettings } = await import('@/sync/domains/settings/voiceSettings');
            const { RPC_METHODS } = await import('@happier-dev/protocol/rpc');
            const { SessionSpawnNewInputV2Schema } = await import('@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2');
            const { SessionSpawnNewResultV1Schema } = await import('@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1');
            const { createUiSessionSpawnUserAttemptId } = await import('@/sync/domains/session/spawn/spawnSessionNonce');
            const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
            const settings = state.getState().settings;
            const config = readLocalConversationVoiceSettings(settings.voice);
            state.__setState({ settings: { ...settings, voice: { ...settings.voice, providerId: 'local_conversation',
                executionMachine: { mode: 'fixed', machineId: 'machine-1' },
                providers: { ...settings.voice.providers, local_conversation: { schemaVersion: 1, config: { ...config,
                    conversationMode: 'agent', agent: { ...config.agent, agentSource: 'agent', agentId: 'codex',
                        rootSessionPolicy: 'new' } } } },
            } } });
            await loadLocalVoiceEngineWithCompatState();
            const incumbent = machineRpcWithServerScope.getMockImplementation();
            if (!incumbent) throw new Error('Actual local Voice Socket responder missing');
            const creationKeys: Array<string | undefined> = [];
            // The receiving daemon can retain a creation after its acknowledgement
            // is lost. Its real DTO requires retries to use the original key.
            const unknownCreation = SessionSpawnNewResultV1Schema.parse({
                type: 'pending', retryWithSameCreationKey: true, outcome: 'unknown',
            });
            machineRpcWithServerScope.mockImplementation((request: Readonly<{ method: string; payload: unknown }>) => {
                if (request.method !== RPC_METHODS.SESSION_SPAWN_NEW) return incumbent(request);
                creationKeys.push(SessionSpawnNewInputV2Schema.parse(request.payload).creationKey);
                return Promise.resolve(unknownCreation);
            });
            const explicitCreationKey = createUiSessionSpawnUserAttemptId();
            const controller = createVoiceSessionLifecycleController();
            controller.setConfiguredProviderId('local_conversation');
            try {
                await controller.toggle(null, entry === 'explicit New'
                    ? { kind: 'new', creationKey: explicitCreationKey } : undefined).catch(() => undefined);
                const creationKey = entry === 'explicit New' ? explicitCreationKey : creationKeys[0];
                expect(creationKey).toEqual(expect.stringMatching(/^ui-session-attempt-/));
                expect(creationKeys).toEqual([creationKey]);
                expect(controller.getSnapshot()).toMatchObject({ status: 'disconnected', canStop: false,
                    errorMessage: 'VOICE_CONVERSATION_SPAWN_PENDING' });
                expect(localVoiceSpeechOutputBoundary.fileRecording.start).not.toHaveBeenCalled();

                // Preference edits govern the next deliberate Start, not an
                // unfinished creation whose outcome the daemon cannot yet prove.
                const retrySettings = state.getState().settings;
                const retryConfig = readLocalConversationVoiceSettings(retrySettings.voice);
                state.__setState({ settings: { ...retrySettings, voice: { ...retrySettings.voice,
                    providers: { ...retrySettings.voice.providers, local_conversation: { schemaVersion: 1,
                        config: { ...retryConfig, agent: { ...retryConfig.agent, rootSessionPolicy: 'continue' } } } },
                } } });
                await controller.retry(VOICE_AGENT_GLOBAL_SESSION_ID).catch(() => undefined);

                // A different key starts another ordinary Session; retrying the
                // same deliberate New must instead rejoin the unknown creation.
                expect(creationKeys).toEqual([creationKey, creationKey]);
                expect(controller.getSnapshot()).toMatchObject({ status: 'disconnected', canStop: false,
                    errorMessage: 'VOICE_CONVERSATION_SPAWN_PENDING' });
                expect(localVoiceSpeechOutputBoundary.fileRecording.start).not.toHaveBeenCalled();
            } finally { await controller.dispose(); }
        });

        it('retries an exact Continue after an unknown Resume without applying a new lifetime preference', async () => {
            const state = await getStorage();
            const { readLocalConversationVoiceSettings } = await import('@/sync/domains/settings/voiceSettings');
            const { RPC_ERROR_CODES, RPC_METHODS } = await import('@happier-dev/protocol/rpc');
            const { createRpcCallError } = await import('@happier-dev/protocol/rpcErrors');
            const { SessionSpawnNewInputV2Schema } = await import('@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2');
            const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
            const { voiceSessionBindingStore } = await import('@/voice/binding/voiceConversationBindingStore');
            const settings = state.getState().settings;
            const config = readLocalConversationVoiceSettings(settings.voice);
            state.__setState({ settings: { ...settings, voice: { ...settings.voice, providerId: 'local_conversation',
                providers: { ...settings.voice.providers, local_conversation: { schemaVersion: 1, config: { ...config,
                    conversationMode: 'agent', agent: { ...config.agent, prewarmOnConnect: false,
                        rootSessionPolicy: 'continue' }, tts: { ...config.tts, autoSpeakReplies: false } } } },
            } } });
            await loadLocalVoiceEngineWithCompatState();
            const incumbent = machineRpcWithServerScope.getMockImplementation();
            if (!incumbent) throw new Error('Actual local Voice Socket responder missing');
            const creationKeys: Array<string | undefined> = [];
            const resumeRequests: Array<Readonly<{ serverId: string; payload: unknown }>> = [];
            let failNextResume = true;
            machineRpcWithServerScope.mockImplementation(async (request: Readonly<{
                method: string; payload: unknown; serverId: string;
            }>) => {
                if (request.method === RPC_METHODS.SESSION_SPAWN_NEW) {
                    creationKeys.push(SessionSpawnNewInputV2Schema.parse(request.payload).creationKey);
                }
                if (request.method === RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE
                    || request.method === RPC_METHODS.SPAWN_HAPPY_SESSION) {
                    resumeRequests.push({ serverId: request.serverId, payload: request.payload });
                    if (failNextResume) {
                        failNextResume = false;
                        // The daemon may have resumed this exact Session before
                        // the transport lost its reply. Do not substitute a New.
                        throw createRpcCallError({ error: 'Resume acknowledgement unavailable',
                            errorCode: RPC_ERROR_CODES.OUTCOME_UNKNOWN });
                    }
                }
                return incumbent(request);
            });
            const controller = createVoiceSessionLifecycleController();
            controller.setConfiguredProviderId('local_conversation');
            const target = { serverId: localVoiceHomeId, sessionId: 's1' };
            try {
                await controller.toggle(target);
                expect(controller.getSnapshot()).toMatchObject({ status: 'connected', canStop: true });
                const binding = voiceSessionBindingStore.getState().getByControlSessionId(VOICE_AGENT_GLOBAL_SESSION_ID);
                if (!binding) throw new Error('Real executable Voice conversation did not bind');
                const originalCreationKeys = [...creationKeys];
                expect(originalCreationKeys).toHaveLength(1);
                await controller.stop(VOICE_AGENT_GLOBAL_SESSION_ID);

                await expect(controller.toggle(target, { kind: 'continue',
                    conversationSessionAddress: binding.conversationSessionAddress,
                })).rejects.toMatchObject({ code: RPC_ERROR_CODES.OUTCOME_UNKNOWN });
                expect(controller.getSnapshot()).toMatchObject({ status: 'disconnected', canStop: false,
                    errorCode: 'provider_error', errorMessage: RPC_ERROR_CODES.OUTCOME_UNKNOWN,
                    errorRecoveryAction: 'retry' });
                expect(resumeRequests).toEqual([{ serverId: binding.conversationSessionAddress.serverId,
                    payload: expect.objectContaining({ type: 'resume-session', sessionId: binding.conversationSessionId }) }]);
                expect(creationKeys).toEqual(originalCreationKeys);
                const captureStartsBeforeRetry = localVoiceSpeechOutputBoundary.fileRecording.start.mock.calls.length;

                const retrySettings = state.getState().settings;
                const retryConfig = readLocalConversationVoiceSettings(retrySettings.voice);
                state.__setState({ settings: { ...retrySettings, voice: { ...retrySettings.voice,
                    providers: { ...retrySettings.voice.providers, local_conversation: { schemaVersion: 1,
                        config: { ...retryConfig, agent: { ...retryConfig.agent, rootSessionPolicy: 'new' } } } },
                } } });
                await controller.retry(VOICE_AGENT_GLOBAL_SESSION_ID).catch(() => undefined);

                // A retry cannot replace the explicitly selected conversation
                // merely because the person's next-Start preference changed.
                expect(creationKeys).toEqual(originalCreationKeys);
                expect(resumeRequests).toEqual(Array.from({ length: 2 }, () => ({
                    serverId: binding.conversationSessionAddress.serverId,
                    payload: expect.objectContaining({ type: 'resume-session', sessionId: binding.conversationSessionId }),
                })));
                expect(voiceSessionBindingStore.getState().getByControlSessionId(VOICE_AGENT_GLOBAL_SESSION_ID)
                    ?.conversationSessionAddress).toEqual(binding.conversationSessionAddress);
                expect(controller.getSnapshot()).toMatchObject({ status: 'connected', canStop: true });
                expect(localVoiceSpeechOutputBoundary.fileRecording.start).toHaveBeenCalledTimes(captureStartsBeforeRetry + 1);
            } finally { await controller.dispose(); }
        });

        it('keeps Global sign-in recovery on the admitted Agent and machine after preferences change', async () => {
            const state = await getStorage();
            const { readLocalConversationVoiceSettings } = await import('@/sync/domains/settings/voiceSettings');
            const { RPC_METHODS } = await import('@happier-dev/protocol/rpc');
            const { renderHook, renderScreen } = await import('@/dev/testkit');
            const { VoiceSessionRuntime } = await import('./VoiceSessionRuntime');
            const { getVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleControllerStore');
            const { useVoiceAttemptControl } = await import('@/components/voice/attempt/useVoiceAttemptControl');
            const { executeVoiceConversationAction } = await import('@/sync/ops/actions/voiceConversationAction');
            const { getVoiceSessionPresentedAttemptId } = await import('./voiceSessionStore');
            const { t } = await import('@/text');
            const settings = state.getState().settings;
            const config = readLocalConversationVoiceSettings(settings.voice);
            state.__setState({ settings: { ...settings, voice: { ...settings.voice, providerId: 'local_conversation',
                executionMachine: { mode: 'fixed', machineId: 'machine-1' },
                providers: { ...settings.voice.providers, local_conversation: { schemaVersion: 1, config: { ...config,
                    conversationMode: 'agent', agent: { ...config.agent, agentSource: 'agent', agentId: 'codex' } } } },
            } } });
            await loadLocalVoiceEngineWithCompatState();
            const incumbent = machineRpcWithServerScope.getMockImplementation()!;
            machineRpcWithServerScope.mockImplementation((request: Readonly<{ method: string }>) => request.method === RPC_METHODS.SESSION_SPAWN_NEW
                ? Promise.resolve({ type: 'error', errorCode: 'agent_signed_out', errorMessage: 'agent_signed_out' }) : incumbent(request));
            const runtime = await renderScreen(React.createElement(VoiceSessionRuntime));
            const controller = getVoiceSessionLifecycleController();
            if (!controller) throw new Error('Mounted Voice lifecycle unavailable');
            const hook = await renderHook(() => useVoiceAttemptControl({ kind: 'global' }));
            try {
                await act(async () => { await controller.toggle(null).catch(() => undefined); });
                expect(controller.getSnapshot()).toMatchObject({ errorCode: 'authentication_required', errorMessage: 'agent_signed_out', canStop: false });
                const caption = hook.getCurrent().captionLabel;
                expect(caption).toContain('Codex');
                const next = state.getState().settings;
                await act(async () => { state.__setState({ settings: { ...next, voice: { ...next.voice,
                    executionMachine: { mode: 'fixed', machineId: 'machine-unobserved' },
                    providers: { ...next.voice.providers, local_conversation: { schemaVersion: 1, config: { ...config,
                        conversationMode: 'agent', agent: { ...config.agent, agentSource: 'agent', agentId: 'claude' } } } },
                } } }); });
                expect(hook.getCurrent().captionLabel).toBe(caption);
                expect(hook.getCurrent().recoveryLabel).toBe(t('voiceSurface.setUpAgent', { agent: 'Codex' }));
                let destination: unknown;
                const result = await executeVoiceConversationAction('ui.voice_global.recover', {
                    expectedAttempt: getVoiceSessionPresentedAttemptId(),
                }, { navigate: href => { destination = href; } });
                expect(result.status).toBe('completed');
                expect(destination).toMatchObject({ pathname: '/(app)/settings/agents/[agentId]', params: {
                    agentId: 'codex', machineId: 'machine-1', pluginId: 'happier.agent.codex',
                    serverIdentityId: 'srv_voice_recovery_home',
                } });
            } finally { await hook.unmount(); await runtime.unmount(); }
        });

        it('rearms a fixed-Agent refusal only when its effective default changes, without opening capture', async () => {
            const state = await getStorage();
            const { readLocalConversationVoiceSettings } = await import('@/sync/domains/settings/voiceSettings');
            const { RPC_METHODS } = await import('@happier-dev/protocol/rpc');
            const { renderScreen } = await import('@/dev/testkit');
            const { VoiceSessionRuntime } = await import('./VoiceSessionRuntime');
            const { getVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleControllerStore');
            const { withConnectedAccountCatalogAccount } = await import('@/sync/api/account/apiConnectedAccountCatalog');
            const { mutateConnectedAccountPurposeDefaultsInContext } = await import('@/sync/ops/connectedAccounts/connectedAccountPurposeDefaults');
            const { writeAgentConnectedAccountPurposeDefault } = await import('@happier-dev/protocol/account/settings/connected-services');
            const { resolveAgentCatalogProjection } = await import('@/agents/backendCatalog/agentCatalogProjection');
            const { getConnectedAccountCatalogValue, subscribeConnectedAccountCatalogSnapshots } = await import(
                '@/sync/store/settings/connectedAccountCatalogSnapshot'
            );
            const settings = state.getState().settings;
            const config = readLocalConversationVoiceSettings(settings.voice);
            state.__setState({ settings: { ...settings, voice: { ...settings.voice, providerId: 'local_conversation',
                executionMachine: { mode: 'fixed', machineId: 'machine-1' },
                providers: { ...settings.voice.providers, local_conversation: { schemaVersion: 1, config: { ...config,
                    conversationMode: 'agent', agent: { ...config.agent, agentSource: 'agent', agentId: 'codex' } } } },
            } } });
            await loadLocalVoiceEngineWithCompatState();
            const incumbent = machineRpcWithServerScope.getMockImplementation()!;
            const spawnChoices: unknown[] = [];
            machineRpcWithServerScope.mockImplementation((request: Readonly<{ method: string; payload: unknown }>) => {
                if (request.method !== RPC_METHODS.SESSION_SPAWN_NEW) return incumbent(request);
                spawnChoices.push(request.payload);
                return spawnChoices.length === 1
                    ? Promise.resolve({ type: 'error', errorCode: 'agent_signed_out', errorMessage: 'agent_signed_out' }) : incumbent(request);
            });
            const runtime = await renderScreen(React.createElement(VoiceSessionRuntime));
            const controller = getVoiceSessionLifecycleController();
            if (!controller) throw new Error('Mounted Voice lifecycle unavailable');
            const selectDefault = async (agent: string, accountId = 'work') => {
                const scope = state.getState().profileScope;
                if (!scope) throw new Error('Restored Voice Account unavailable');
                const entry = resolveAgentCatalogProjection(agent, { enabledAgentIds: [] });
                const declaration = entry.connectedAccounts[0];
                const consumer = entry.identity;
                if (!consumer || !declaration) throw new Error('Agent purpose declaration unavailable');
                const previousRevision = getConnectedAccountCatalogValue(scope, 'purposes').revision;
                await act(async () => { await withConnectedAccountCatalogAccount(scope, undefined, context =>
                    mutateConnectedAccountPurposeDefaultsInContext(context, (current, legacySettings) => {
                        const next = writeAgentConnectedAccountPurposeDefault({ settings: legacySettings, purposeBindings: current,
                            agentId: agent, consumer, declarations: entry.connectedAccounts,
                            purpose: declaration.purpose, target: { kind: 'account', account: { service: declaration.service, accountId } },
                        });
                        return { purposeBindings: next.connectedAccountPurposeBindingsV1, legacySettingsDelta: {
                            connectedServicesDefaultAuthByAgentIdV1: next.connectedServicesDefaultAuthByAgentIdV1,
                            connectedServicesAdditionalDefaultAuthByAgentIdV1: next.connectedServicesAdditionalDefaultAuthByAgentIdV1,
                        } };
                    }));
                });
                // The write acknowledges durable custody before its asynchronous
                // catalog revalidation publishes the current default to Voice.
                await act(async () => { await waitForTestEvent(subscribeConnectedAccountCatalogSnapshots,
                    () => getConnectedAccountCatalogValue(scope, 'purposes'),
                    snapshot => snapshot.status === 'ready' && !snapshot.stale
                        && snapshot.revision !== previousRevision); });
            };
            try {
                await act(async () => { await controller.toggle(null).catch(() => undefined); });
                expect(controller.getSnapshot()).toMatchObject({ errorCode: 'authentication_required', errorMessage: 'agent_signed_out', canStop: false });
                const scope = state.getState().profileScope;
                if (!scope) throw new Error('Restored Voice Account unavailable');
                await act(async () => { await waitForTestEvent(subscribeConnectedAccountCatalogSnapshots,
                    () => getConnectedAccountCatalogValue(scope, 'purposes'),
                    snapshot => snapshot.status === 'ready' && !snapshot.stale); });
                const recordings = localVoiceSpeechOutputBoundary.fileRecording.start.mock.calls.length;
                await selectDefault('claude');
                expect(controller.getSnapshot()).toMatchObject({ errorMessage: 'agent_signed_out' });
                await selectDefault('codex');
                expect(controller.getSnapshot()).toMatchObject({ status: 'disconnected', adapterId: null, canStop: false });
                expect(localVoiceSpeechOutputBoundary.fileRecording.start).toHaveBeenCalledTimes(recordings);
                expect(spawnChoices).toHaveLength(1);
                await act(async () => { await controller.toggle(null); });
                expect(spawnChoices).toHaveLength(2);
                expect(spawnChoices[1]).toMatchObject({ connectedServices: { v: 2, bindingsByServiceId: {
                    'happier.agent.codex/openai-codex': { source: 'connected', selection: 'profile', profileId: 'work' },
                } } });
                expect(controller.getSnapshot()).toMatchObject({ status: 'connected', canStop: true });
                const activeRecordings = localVoiceSpeechOutputBoundary.fileRecording.start.mock.calls.length;
                await selectDefault('codex', 'other-work');
                expect(controller.getSnapshot()).toMatchObject({ status: 'connected', canStop: true });
                expect(localVoiceSpeechOutputBoundary.fileRecording.start).toHaveBeenCalledTimes(activeRecordings);
                expect(spawnChoices).toHaveLength(2);
            } finally { await runtime.unmount(); }
        });

        it('fences a late suspension release from a same-id replacement adapter', async () => {
            const state = await getStorage();
            const settings = state.getState().settings;
            state.__setState({ settings: { ...settings, voice: { ...settings.voice, providerId: 'local_direct' } } });
            await loadLocalVoiceEngineWithCompatState();
            const { createLocalDirectVoiceAdapter } = await import('@/voice/adapters/localDirect/localDirectAdapter');
            const { registerVoiceAdapters } = await import('./voiceAdapterRegistry');
            const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
            const recording = localVoiceSpeechOutputBoundary.fileRecording;
            recording.start.mockResolvedValueOnce({ recordingId: 'suspension-incumbent' })
                .mockResolvedValueOnce({ recordingId: 'suspension-replacement' });
            registerVoiceAdapters([createLocalDirectVoiceAdapter()]);
            const controller = createVoiceSessionLifecycleController();
            controller.setConfiguredProviderId('local_direct');
            const target = { serverId: localVoiceHomeId, sessionId: 's1' };
            try {
                await controller.toggle(target);
                const suspension = await controller.suspendInput('s1');
                expect(recording.setMuted).toHaveBeenCalledWith({ recordingId: 'suspension-incumbent', muted: true });
                await controller.stop('s1');
                expect(recording.stop).toHaveBeenCalledWith({ recordingId: 'suspension-incumbent' });
                // Actual remount creates a new adapter object at the public
                // registry and a fresh physical recording for the same id.
                registerVoiceAdapters([createLocalDirectVoiceAdapter()]);
                await controller.toggle(target);
                expect(recording.start).toHaveBeenCalledTimes(2);
                expect(controller.getSnapshot()).toMatchObject({ adapterId: 'local_direct', sessionId: 's1',
                    status: 'connected', canStop: true });
                expect(controller.getSnapshot().micMuted === true).toBe(false);
                const muteOperations = recording.setMuted.mock.calls.length;
                const stopOperations = recording.stop.mock.calls.length;
                await suspension?.release();
                expect(recording.setMuted).toHaveBeenCalledTimes(muteOperations);
                expect(recording.stop).toHaveBeenCalledTimes(stopOperations);
                expect(controller.getSnapshot()).toMatchObject({ status: 'connected', canStop: true });
                expect(controller.getSnapshot().micMuted === true).toBe(false);
            } finally { await controller.dispose(); }
        });

        it.each(['on_demand', 'automatic'] as const)(
            'retires and reseeds an active local Agent model session when current-UI disclosure returns from off to %s',
            async (restoredMode) => {
                const state = await getStorage();
                const { readLocalConversationVoiceSettings } = await import('@/sync/domains/settings/voiceSettings');
                const settings = state.getState().settings;
                const voice = settings.voice;
                const config = readLocalConversationVoiceSettings(voice);
                state.__setState({ settings: { ...settings, voice: { ...voice, providerId: 'local_conversation',
                    privacy: { ...voice.privacy, currentUiContextMode: restoredMode },
                    executionMachine: { mode: 'fixed', machineId: 'machine-1' },
                    providers: { ...voice.providers, local_conversation: { schemaVersion: 1, config: { ...config,
                        conversationMode: 'agent', agent: { ...config.agent, prewarmOnConnect: true,
                            rootSessionPolicy: 'new' } } } },
                } } });
                await loadLocalVoiceEngineWithCompatState();
                const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
                const { ExecutionRunEnsureOrStartRequestSchema } = await import('@happier-dev/protocol/execution/runs/index');
                const { SESSION_RPC_METHODS } = await import('@happier-dev/protocol/rpc');
                const { voiceSessionBindingStore } = await import('@/voice/binding/voiceConversationBindingStore');
                const controller = createVoiceSessionLifecycleController();
                controller.setConfiguredProviderId('local_conversation');
                controller.setCurrentUiContextToolSetEnabled(true);
                const seeds = () => localVoiceAgentRpc.requests.filter(request => (
                    request.method === SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START
                    || request.method === SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START_PROVIDER_SAFE_V1
                )).map(request => ExecutionRunEnsureOrStartRequestSchema.parse(request.input).start);
                const currentUiActionIds = ['ui.current_context.read', 'ui.current_context.command.invoke'];
                const setMode = (mode: 'off' | 'on_demand' | 'automatic') => {
                    const settings = state.getState().settings;
                    state.__setState({ settings: { ...settings, voice: { ...settings.voice,
                        privacy: { ...settings.voice.privacy, currentUiContextMode: mode } } } });
                    controller.setCurrentUiContextToolSetEnabled(mode !== 'off');
                };
                try {
                    await controller.toggle({ serverId: localVoiceHomeId, sessionId: 's1' });
                    await waitForLocalVoiceBoundaryEvent('agent-start', 1);
                    const { voiceAgentSessions } = await import('@/voice/agent/voiceAgentSessions');
                    await voiceAgentSessions.ensureRunning(VOICE_AGENT_GLOBAL_SESSION_ID);
                    expect(seeds()).toHaveLength(1);
                    expect(seeds()[0]?.disabledActionIds ?? []).not.toEqual(expect.arrayContaining(currentUiActionIds));
                    const initialRunId = localVoiceAgentRpc.readRetainedRun()?.runId;
                    expect(initialRunId).toBeDefined();
                    const conversationAddress = voiceSessionBindingStore.getState()
                        .getByControlSessionId(VOICE_AGENT_GLOBAL_SESSION_ID)?.conversationSessionAddress;
                    expect(conversationAddress).toBeDefined();
                    const controlSessionId = controller.getSnapshot().sessionId;
                    const captureStarts = localVoiceSpeechOutputBoundary.fileRecording.start.mock.calls.length;
                    const captureStops = localVoiceSpeechOutputBoundary.fileRecording.stop.mock.calls.length;
                    setMode('off');
                    await waitForLocalVoiceBoundaryEvent('agent-start', 2);
                    await voiceAgentSessions.ensureRunning(VOICE_AGENT_GLOBAL_SESSION_ID);
                    expect(seeds()).toHaveLength(2);
                    expect(voiceSessionBindingStore.getState().getByControlSessionId(VOICE_AGENT_GLOBAL_SESSION_ID)
                        ?.conversationSessionAddress).toEqual(conversationAddress);
                    expect(seeds()[1]?.disabledActionIds).toEqual(expect.arrayContaining(currentUiActionIds));
                    expect(localVoiceAgentRpc.requests.filter(request => request.method === SESSION_RPC_METHODS.EXECUTION_RUN_STOP))
                        .toEqual([{ method: SESSION_RPC_METHODS.EXECUTION_RUN_STOP, input: { runId: initialRunId } }]);
                    expect(controller.getSnapshot()).toMatchObject({ adapterId: 'local_conversation', status: 'connected', canStop: true });
                    expect(controller.getSnapshot().sessionId).toBe(controlSessionId);
                    expect(localVoiceSpeechOutputBoundary.fileRecording.start).toHaveBeenCalledTimes(captureStarts + 1);
                    expect(localVoiceSpeechOutputBoundary.fileRecording.stop).toHaveBeenCalledTimes(captureStops + 1);
                    setMode(restoredMode);
                    await waitForLocalVoiceBoundaryEvent('agent-start', 3);
                    await voiceAgentSessions.ensureRunning(VOICE_AGENT_GLOBAL_SESSION_ID);
                    expect(seeds()).toHaveLength(3);
                    expect(voiceSessionBindingStore.getState().getByControlSessionId(VOICE_AGENT_GLOBAL_SESSION_ID)
                        ?.conversationSessionAddress).toEqual(conversationAddress);
                    expect(seeds()[2]?.disabledActionIds ?? []).not.toEqual(expect.arrayContaining(currentUiActionIds));
                    expect(localVoiceAgentRpc.requests.filter(request => request.method === SESSION_RPC_METHODS.EXECUTION_RUN_STOP)).toHaveLength(2);
                    expect(localVoiceSpeechOutputBoundary.fileRecording.start).toHaveBeenCalledTimes(captureStarts + 2);
                    expect(localVoiceSpeechOutputBoundary.fileRecording.stop).toHaveBeenCalledTimes(captureStops + 2);
                    expect(controller.getSnapshot()).toMatchObject({ adapterId: 'local_conversation', sessionId: controlSessionId,
                        status: 'connected', canStop: true });
                    expect(localVoiceAgentRpc.readRetainedRun()?.status).toBe('running');
                } finally { await controller.dispose(); }
            },
        );

        it('does not interrupt a local direct attempt with no model-session tool catalog', async () => {
            const state = await getStorage();
            const settings = state.getState().settings;
            state.__setState({ settings: { ...settings, voice: { ...settings.voice, providerId: 'local_direct' } } });
            await loadLocalVoiceEngineWithCompatState();
            const { createLocalDirectVoiceAdapter } = await import('@/voice/adapters/localDirect/localDirectAdapter');
            const { registerVoiceAdapters } = await import('./voiceAdapterRegistry');
            registerVoiceAdapters([createLocalDirectVoiceAdapter()]);
            const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
            const controller = createVoiceSessionLifecycleController();
            controller.setConfiguredProviderId('local_direct');
            controller.setCurrentUiContextToolSetEnabled(true);
            try {
                await controller.toggle({ serverId: localVoiceHomeId, sessionId: 's1' });
                expect(controller.getSnapshot()).toMatchObject({ adapterId: 'local_direct', sessionId: 's1', status: 'connected', canStop: true });
                const captureStarts = localVoiceSpeechOutputBoundary.fileRecording.start.mock.calls.length;
                for (const mode of ['off', 'automatic'] as const) {
                    const settings = state.getState().settings;
                    state.__setState({ settings: { ...settings, voice: { ...settings.voice,
                        privacy: { ...settings.voice.privacy, currentUiContextMode: mode } } } });
                    controller.setCurrentUiContextToolSetEnabled(mode !== 'off');
                    expect(controller.getSnapshot()).toMatchObject({ adapterId: 'local_direct', sessionId: 's1', status: 'connected', canStop: true });
                    expect(controller.getAttemptTargetSessionAddress()).toEqual({ serverId: localVoiceHomeId, sessionId: 's1' });
                    expect(localVoiceSpeechOutputBoundary.fileRecording.start).toHaveBeenCalledTimes(captureStarts);
                    expect(localVoiceSpeechOutputBoundary.fileRecording.stop).not.toHaveBeenCalled();
                }
            } finally { await controller.dispose(); }
        });
        it.each(['local', 'realtime'] as const)(
            'retires an exact %s provider withdrawn while Start is still pending and fences late activation',
            async (engineKind) => {
                const { registerVoiceAdapters } = await import('./voiceAdapterRegistry');
                if (engineKind === 'realtime') {
                    const fixture = await createActualLifecycle();
                    const mint = createDeferred<Response>();
                    const mintStarted = createDeferred<void>();
                    fixture.environment.providerFetch.mockImplementationOnce(() => {
                        mintStarted.resolve();
                        return mint.promise;
                    });
                    let starting: Promise<void> | null = null;
                    let startSettled = false;
                    try {
                        starting = fixture.lifecycle.toggle(fixture.target);
                        void starting.then(() => { startSettled = true; }, () => { startSettled = true; });
                        await mintStarted.promise;
                        expect(fixture.environment.providerFetch).toHaveBeenCalled();
                        expect(fixture.captureAdmission.acquire('dictation').status).toBe('busy');
                        const { getExternalVoiceProviderRegistration, removeExternalVoiceProviderRegistration } = await import('@/voice/registry/externalVoiceProviderRegistrations');
                        const registration = getExternalVoiceProviderRegistration(OPENAI_PROVIDER_ID);
                        if (!registration) throw new Error('Actual OpenAI registration missing');
                        removeExternalVoiceProviderRegistration(registration.token);
                        registerVoiceAdapters([]);
                        await waitForTestEvent(fixture.lifecycle.subscribe, () => fixture.lifecycle.getSnapshot(), snapshot => snapshot.status === 'error' && snapshot.canStop === false);
                        expect(fixture.lifecycle.getSnapshot()).toMatchObject({
                            adapterId: OPENAI_PROVIDER_ID, sessionId: fixture.runtime.historySessionId,
                            status: 'error', canStop: false, errorCode: 'service_temporarily_unavailable',
                            errorMessage: 'voice_provider_adapter_not_registered',
                        });
                        expect(startSettled).toBe(false);
                        const dictation = fixture.captureAdmission.acquire('dictation');
                        expect(dictation.status).toBe('acquired');
                        if (dictation.status === 'acquired') dictation.lease.release();
                        // The real HTTP operation can settle after its first
                        // retirement; its credential must not revive media.
                        mint.resolve(Response.json(fixture.environment.createClientAuthProviderResponse('ek_source_composed', Math.floor(Date.now() / 1000) + 60)));
                        await starting;
                        expect(fixture.browser.peers).toHaveLength(0);
                        expect(fixture.browser.captures).toHaveLength(0);
                        expect(fixture.lifecycle.getSnapshot()).toMatchObject({ status: 'error', canStop: false,
                            errorCode: 'service_temporarily_unavailable', errorRecoveryAction: 'retry' });
                    } finally {
                        mint.resolve(new Response('{}'));
                        await fixture.dispose();
                        await starting?.catch(() => undefined);
                    }
                    return;
                }

                const state = await getStorage();
                const settings = state.getState().settings;
                state.__setState({ settings: { ...settings, voice: { ...settings.voice, providerId: 'local_direct' } } });
                await loadLocalVoiceEngineWithCompatState();
                const { createLocalDirectVoiceAdapter } = await import('@/voice/adapters/localDirect/localDirectAdapter');
                registerVoiceAdapters([createLocalDirectVoiceAdapter()]);
                const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
                const { voiceCaptureAdmissionController } = await import('@/voice/runtime/input/VoiceCaptureAdmissionController');
                const recording = createDeferred<{ recordingId: string }>();
                localVoiceSpeechOutputBoundary.fileRecording.start.mockImplementationOnce(() => recording.promise);
                const controller = createVoiceSessionLifecycleController();
                controller.setConfiguredProviderId('local_direct');
                let starting: Promise<void> | null = null;
                let startSettled = false;
                try {
                    starting = controller.toggle({ serverId: localVoiceHomeId, sessionId: 's1' });
                    void starting.then(() => { startSettled = true; }, () => { startSettled = true; });
                    await waitForLocalVoiceBoundaryEvent('audio-start');
                    expect(localVoiceSpeechOutputBoundary.fileRecording.start).toHaveBeenCalled();
                    expect(voiceCaptureAdmissionController.acquire('dictation').status).toBe('busy');
                    registerVoiceAdapters([]);
                    // Observe the native owner's bounded terminal retirement
                    // while its OS Start reply remains pending.
                    await waitForTestEvent(controller.subscribe, () => {
                        const dictation = voiceCaptureAdmissionController.acquire('dictation');
                        if (dictation.status === 'acquired') dictation.lease.release();
                        expect(dictation.status).toBe('acquired');
                    });
                    expect(startSettled).toBe(false);
                    expect(localVoiceSpeechOutputBoundary.fileRecording.stop).not.toHaveBeenCalled();
                    expect(controller.getSnapshot()).toMatchObject({ adapterId: 'local_direct', sessionId: 's1',
                        status: 'error', canStop: false, errorCode: 'service_temporarily_unavailable',
                        errorMessage: 'voice_provider_adapter_not_registered' });
                    recording.resolve({ recordingId: 'withdrawn-during-native-start' });
                    await starting;
                    await waitForLocalVoiceBoundaryEvent('recording-stop');
                    expect(localVoiceSpeechOutputBoundary.fileRecording.stop)
                        .toHaveBeenCalledWith({ recordingId: 'withdrawn-during-native-start' });
                    expect(controller.getSnapshot()).toMatchObject({ status: 'error', canStop: false,
                        errorCode: 'service_temporarily_unavailable', errorRecoveryAction: 'retry' });
                    await controller.toggle({ serverId: localVoiceHomeId, sessionId: 's1' });
                    expect(localVoiceSpeechOutputBoundary.fileRecording.start).toHaveBeenCalledTimes(1);
                } finally {
                    recording.resolve({ recordingId: 'withdrawn-during-native-start' });
                    await starting?.catch(() => undefined);
                    await controller.dispose();
                }
            },
        );
    });

    it('keeps the withdrawn provider owning its live attempt until that exact adapter terminalizes', async () => {
        const fixture = await createActualLifecycle();
        const cleanup = createDeferred<void>();
        const cleanupStarted = createDeferred<void>();
        fixture.audioContext.close.mockImplementation(() => {
            cleanupStarted.resolve();
            return cleanup.promise;
        });
        try {
            await fixture.start();
            const { getExternalVoiceProviderRegistration, removeExternalVoiceProviderRegistration } = await import('@/voice/registry/externalVoiceProviderRegistrations');
            const registration = getExternalVoiceProviderRegistration(OPENAI_PROVIDER_ID);
            if (!registration) throw new Error('Actual OpenAI registration missing');
            removeExternalVoiceProviderRegistration(registration.token);
            const { registerVoiceAdapters } = await import('./voiceAdapterRegistry');
            registerVoiceAdapters([]);
            await cleanupStarted.promise;
            expect(fixture.audioContext.close).toHaveBeenCalled();
            expect(fixture.captureAdmission.acquire('dictation').status).toBe('busy');
            expect(fixture.lifecycle.getSnapshot()).toMatchObject({ adapterId: OPENAI_PROVIDER_ID, canStop: true });
            cleanup.resolve();
            await waitForTestEvent(fixture.lifecycle.subscribe, () => fixture.lifecycle.getSnapshot(), snapshot => snapshot.status === 'error' && snapshot.canStop === false);
            expect(fixture.lifecycle.getSnapshot()).toMatchObject({ adapterId: OPENAI_PROVIDER_ID,
                sessionId: fixture.runtime.historySessionId, status: 'error', canStop: false,
                errorCode: 'service_temporarily_unavailable', errorRecoveryAction: 'retry' });
            const dictation = fixture.captureAdmission.acquire('dictation');
            expect(dictation.status).toBe('acquired');
            if (dictation.status === 'acquired') dictation.lease.release();
        } finally { cleanup.resolve(); await fixture.dispose(); }
    });


    it('tracks current and retained adapter subscriptions by object identity across a same-ID replacement', async () => {
        const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
        const captureAdmission = createVoiceCaptureAdmissionController();
        const releaseRetiredStop = createDeferred<void>();
        const retiredStopStarted = createDeferred<void>();
        const adapterId = 'realtime-replacement';
        const sessionId = 'voice-session';
        let retired!: ReturnType<typeof createAdapter>;
        retired = createAdapter({
            id: adapterId,
            snapshot: {
                adapterId,
                sessionId: null,
                status: 'disconnected',
                mode: 'idle',
                canStop: false,
            },
            start: async () => {
                retired.setSnapshot({
                    adapterId,
                    sessionId,
                    status: 'connected',
                    mode: 'listening',
                    canStop: true,
                });
            },
            stop: async () => {
                retiredStopStarted.resolve();
                await releaseRetiredStop.promise;
                retired.setSnapshot({
                    adapterId,
                    sessionId: null,
                    status: 'disconnected',
                    mode: 'idle',
                    canStop: false,
                });
            },
        });
        let replacement!: ReturnType<typeof createAdapter>;
        replacement = createAdapter({
            id: adapterId,
            snapshot: {
                adapterId,
                sessionId: null,
                status: 'disconnected',
                mode: 'idle',
                canStop: false,
            },
            stop: async () => {
                replacement.setSnapshot({
                    adapterId,
                    sessionId: null,
                    status: 'disconnected',
                    mode: 'idle',
                    canStop: false,
                });
            },
        });
        let current = retired.controller;
        const registryListeners = new Set<() => void>();
        const registry: VoiceAdapterRegistry = {
            get: (id) => id === adapterId ? current : null,
            list: () => [current],
            subscribe: (listener) => {
                registryListeners.add(listener);
                return () => registryListeners.delete(listener);
            },
        };
        const controller = createVoiceSessionLifecycleController({
            captureAdmission,
            getRegistry: () => registry,
        });

        try {
            controller.setConfiguredProviderId(adapterId);
            await controller.toggle(sessionAddress(sessionId));
            expect(retired.listenerCount()).toBe(1);

            current = replacement.controller;
            for (const listener of [...registryListeners]) listener();
            await retiredStopStarted.promise;

            // While the old real-time attempt is stopping, it remains retained
            // for terminalization and the replacement must already be current.
            expect(retired.listenerCount()).toBe(1);
            expect(replacement.listenerCount()).toBe(1);

            const stopResult = retired.stop.mock.results.at(-1);
            if (stopResult?.type !== 'return') throw new Error('Retired adapter stop did not return its completion');
            let retiredStopSettled = false;
            const stopSettled = stopResult.value.then(() => { retiredStopSettled = true; });
            const retiredPublication = waitForTestEvent(controller.subscribe, () => retiredStopSettled, Boolean);
            releaseRetiredStop.resolve();
            await stopSettled;
            await retiredPublication;
            await waitForTestEvent(controller.subscribe, controller.getSnapshot, snapshot => snapshot.status === 'disconnected' && !snapshot.canStop);
            const admission = captureAdmission.acquire('dictation');
            expect(admission).toMatchObject({ status: 'acquired' });
            if (admission.status === 'acquired') admission.lease.release();

            // Retention ends with the old attempt. Its subscription must not
            // wait for an unrelated later registry publication to disappear.
            expect(retired.listenerCount()).toBe(0);
            expect(replacement.listenerCount()).toBe(1);

            replacement.setSnapshot({
                adapterId,
                sessionId,
                status: 'connected',
                mode: 'listening',
                canStop: true,
            });
            expect(controller.getSnapshot()).toMatchObject({
                adapterId,
                sessionId,
                status: 'connected',
                canStop: true,
            });

            await controller.stop('stale-session');
            expect(replacement.stop).toHaveBeenCalledWith({ sessionId, signal: expect.any(AbortSignal) });
            expect(controller.getSnapshot().status).toBe('disconnected');
        } finally {
            releaseRetiredStop.resolve();
            await controller.dispose();
        }
    });

    it.each(['stop', 'toggle'] as const)(
        '%s stops a pending realtime Start before its first active snapshot and releases capture admission',
        async (operation) => {
            const fixture = await createActualLifecycle();
            const mint = createDeferred<Response>();
            const mintStarted = createDeferred<void>();
            fixture.environment.providerFetch.mockImplementationOnce(() => {
                mintStarted.resolve();
                return mint.promise;
            });
            let starting: Promise<void> | null = null;
            try {
                starting = fixture.lifecycle.toggle(fixture.target);
                void starting.catch(() => undefined);
                await mintStarted.promise;
                expect(fixture.environment.providerFetch).toHaveBeenCalled();
                expect(fixture.captureAdmission.acquire('dictation').status).toBe('busy');
                const end = operation === 'stop'
                    ? fixture.lifecycle.stop('another-visible-session')
                    : fixture.lifecycle.toggle({ ...fixture.target, sessionId: 'another-visible-session' });
                mint.resolve(Response.json(fixture.environment.createClientAuthProviderResponse('ek_source_composed', Math.floor(Date.now() / 1000) + 60)));
                await end;
                await starting.catch(() => undefined);
                expect(fixture.browser.peers).toHaveLength(0);
                expect(fixture.browser.micSession.getStream()).toBeNull();
                const dictation = fixture.captureAdmission.acquire('dictation');
                expect(dictation.status).toBe('acquired');
                if (dictation.status === 'acquired') dictation.lease.release();
            } finally { mint.resolve(new Response('{}')); await fixture.dispose(); await starting?.catch(() => undefined); }
        },
    );
});
