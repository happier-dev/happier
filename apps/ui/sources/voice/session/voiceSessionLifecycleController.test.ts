import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';

import type { VoiceAdapterController, VoiceSessionSnapshot } from './types';

type VoiceAdapterRegistry = Readonly<{
    get: (id: string) => VoiceAdapterController | null;
    list: () => ReadonlyArray<VoiceAdapterController>;
}>;

const OPENAI_PROVIDER_ID = 'happier.voice.openai/realtime-openai';
const CODEX_PROVIDER_ID = 'happier.agent.codex/realtime-codex';

const logSpy = vi.hoisted(() => vi.fn());
vi.mock('@/log', () => ({ log: { log: logSpy } }));

afterEach(async () => {
    const { resetVoiceSessionRuntimeStateForTests } = await import('./voiceSessionStore');
    await resetVoiceSessionRuntimeStateForTests();
});

function createDeferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });

    return {
        promise,
        resolve,
        reject,
    };
}

function createAdapter(params: Readonly<{
    id: string;
    snapshot: VoiceSessionSnapshot;
    freshSnapshots?: boolean;
    start?: () => Promise<void>;
    stop?: () => Promise<void>;
}>): Readonly<{
    controller: VoiceAdapterController;
    setSnapshot: (snapshot: VoiceSessionSnapshot) => void;
    stop: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>;
    toggle: ReturnType<typeof vi.fn>;
    bargeIn: ReturnType<typeof vi.fn>;
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
    const toggle = vi.fn(async () => {});
    const bargeIn = vi.fn(async () => {});

    return {
        controller: {
            id: params.id,
            engineKind: 'realtime',
            start,
            stop,
            toggle,
            interrupt: vi.fn(async () => {}),
            bargeIn,
            setMuted: vi.fn(async () => {}),
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
        toggle,
        bargeIn,
    };
}

describe('createVoiceSessionLifecycleController', () => {
    it('reports the configured provider consumed by the lifecycle owner', async () => {
        const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
        const controller = createVoiceSessionLifecycleController({ getRegistry: () => ({
            get: () => null,
            list: () => [],
        }) });

        expect(controller.getConfiguredProviderId()).toBeNull();
        controller.setConfiguredProviderId('local_conversation');
        expect(controller.getConfiguredProviderId()).toBe('local_conversation');
    });

    it('names a Start refused because the selected provider has no registered adapter', async () => {
        const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
        const controller = createVoiceSessionLifecycleController({ getRegistry: () => ({
            get: () => null,
            list: () => [],
        }) });
        controller.setConfiguredProviderId(OPENAI_PROVIDER_ID);
        logSpy.mockClear();

        await controller.toggle('session-1');

        // Nothing else observes this refusal: no request, no microphone, no
        // state change, and the surface keeps its previous label.
        const record = logSpy.mock.calls
            .map((call) => String(call[0]))
            .find((line) => line.includes('[voiceRuntimeFailure]'));
        expect(record).toContain('voice_provider_adapter_not_registered');
        expect(record).toContain(OPENAI_PROVIDER_ID);
    });

    it('stays silent when Voice is switched off rather than misreporting a refusal', async () => {
        const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
        const controller = createVoiceSessionLifecycleController({ getRegistry: () => ({
            get: () => null,
            list: () => [],
        }) });
        controller.setConfiguredProviderId('off');
        logSpy.mockClear();

        await controller.toggle('session-1');

        expect(logSpy.mock.calls.map((call) => String(call[0])).filter(
            (line) => line.includes('[voiceRuntimeFailure]'),
        )).toEqual([]);
    });

    it('publishes the configured provider recoverable error after it disconnects', async () => {
        const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
        const deniedSnapshot: VoiceSessionSnapshot = {
            adapterId: 'local_conversation',
            sessionId: 'session-1',
            status: 'disconnected',
            mode: 'idle',
            canStop: false,
            errorCode: 'mic_permission_denied',
            errorMessage: 'mic_permission_denied',
            errorRecoveryAction: 'open_settings',
            errorPresentation: 'permission_required',
        };
        const configured = createAdapter({
            id: 'local_conversation',
            snapshot: deniedSnapshot,
        });
        const controller = createVoiceSessionLifecycleController({ getRegistry: () => ({
            get: (id: string) => id === configured.controller.id ? configured.controller : null,
            list: () => [configured.controller],
        }) });

        controller.setConfiguredProviderId('local_conversation');
        controller.rearmAfterCredentialAuthorityChange();

        expect(controller.getSnapshot()).toEqual(deniedSnapshot);
    });

    it('does not let a terminal error from the previous provider override the newly configured provider', async () => {
        const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
        const previous = createAdapter({
            id: OPENAI_PROVIDER_ID,
            snapshot: {
                adapterId: OPENAI_PROVIDER_ID,
                sessionId: 'session-1',
                status: 'error',
                mode: 'idle',
                canStop: false,
                errorCode: 'provider_auth_invalid',
                errorMessage: 'credential_unavailable',
                errorRecoveryAction: 'review_credentials',
                errorPresentation: 'error',
            },
        });
        const configured = createAdapter({
            id: CODEX_PROVIDER_ID,
            snapshot: {
                adapterId: CODEX_PROVIDER_ID,
                sessionId: null,
                status: 'disconnected',
                mode: 'idle',
                canStop: false,
            },
        });
        const controller = createVoiceSessionLifecycleController({ getRegistry: () => ({
            get: (id: string) => {
                if (id === previous.controller.id) return previous.controller;
                if (id === configured.controller.id) return configured.controller;
                return null;
            },
            list: () => [previous.controller, configured.controller],
        }) });

        controller.setConfiguredProviderId(OPENAI_PROVIDER_ID);
        expect(controller.getSnapshot()).toMatchObject({
            adapterId: OPENAI_PROVIDER_ID,
            status: 'error',
            errorCode: 'provider_auth_invalid',
        });

        controller.setConfiguredProviderId(CODEX_PROVIDER_ID);

        expect(controller.getSnapshot()).toEqual({
            adapterId: null,
            sessionId: null,
            status: 'disconnected',
            mode: 'idle',
            canStop: false,
        });
        expect(previous.start).not.toHaveBeenCalled();
        expect(previous.stop).not.toHaveBeenCalled();
        expect(configured.start).not.toHaveBeenCalled();
        expect(configured.stop).not.toHaveBeenCalled();
    });

    it('rearms only a terminal provider-auth failure and waits for the next explicit start', async () => {
        const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
        const authFailure: VoiceSessionSnapshot = {
            adapterId: OPENAI_PROVIDER_ID,
            sessionId: 'session-1',
            status: 'error',
            mode: 'idle',
            canStop: false,
            errorCode: 'provider_auth_invalid',
            errorMessage: 'credential_unavailable',
            errorRecoveryAction: 'review_credentials',
            errorPresentation: 'error',
        };
        const configured = createAdapter({
            id: OPENAI_PROVIDER_ID,
            snapshot: authFailure,
        });
        const controller = createVoiceSessionLifecycleController({ getRegistry: () => ({
            get: (id: string) => id === configured.controller.id ? configured.controller : null,
            list: () => [configured.controller],
        }) });

        controller.setConfiguredProviderId(OPENAI_PROVIDER_ID);
        controller.rearmAfterCredentialAuthorityChange();

        expect(controller.getSnapshot()).toEqual({
            adapterId: null,
            sessionId: null,
            status: 'disconnected',
            mode: 'idle',
            canStop: false,
        });
        expect(configured.start).not.toHaveBeenCalled();
        expect(configured.stop).not.toHaveBeenCalled();

        await controller.toggle('session-2');
        expect(configured.start).toHaveBeenCalledWith({ sessionId: 'session-2' });

        configured.setSnapshot(authFailure);
        expect(controller.getSnapshot()).toEqual(authFailure);
    });

    it('fences an active attachment when its credential authority changes', async () => {
        const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
        const active = createAdapter({
            id: CODEX_PROVIDER_ID,
            snapshot: {
                adapterId: CODEX_PROVIDER_ID,
                sessionId: 'global-voice-home',
                status: 'connected',
                mode: 'listening',
                canStop: true,
            },
        });
        const controller = createVoiceSessionLifecycleController({ getRegistry: () => ({
            get: (id: string) => id === active.controller.id ? active.controller : null,
            list: () => [active.controller],
        }) });

        controller.setConfiguredProviderId(CODEX_PROVIDER_ID);
        controller.rearmAfterCredentialAuthorityChange({ exactSessionAccountScopeChanged: true });

        expect(active.stop).toHaveBeenCalledOnce();
        expect(active.stop).toHaveBeenCalledWith({ sessionId: 'global-voice-home' });
        expect(active.start).not.toHaveBeenCalled();
    });

    it('keeps a connecting ordinary attachment when the change applies only to the next start', async () => {
        const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
        const connecting = createAdapter({
            id: OPENAI_PROVIDER_ID,
            snapshot: {
                adapterId: OPENAI_PROVIDER_ID,
                sessionId: 'voice-session',
                status: 'connecting',
                mode: 'idle',
                canStop: true,
            },
        });
        const controller = createVoiceSessionLifecycleController({ getRegistry: () => ({
            get: (id: string) => id === connecting.controller.id ? connecting.controller : null,
            list: () => [connecting.controller],
        }) });

        controller.setConfiguredProviderId(OPENAI_PROVIDER_ID);
        controller.rearmAfterCredentialAuthorityChange({
            exactSessionAccountScopeChanged: false,
            globalBindingAuthorityChanged: false,
        });

        expect(connecting.stop).not.toHaveBeenCalled();
    });

    it('keeps in-flight ordinary preparation when the change applies only to the next start', async () => {
        const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
        const startDeferred = createDeferred<void>();
        const preparing = createAdapter({
            id: OPENAI_PROVIDER_ID,
            snapshot: {
                adapterId: OPENAI_PROVIDER_ID,
                sessionId: null,
                status: 'disconnected',
                mode: 'idle',
                canStop: false,
            },
            start: async () => {
                await startDeferred.promise;
            },
        });
        const controller = createVoiceSessionLifecycleController({ getRegistry: () => ({
            get: (id: string) => id === preparing.controller.id ? preparing.controller : null,
            list: () => [preparing.controller],
        }) });

        controller.setConfiguredProviderId(OPENAI_PROVIDER_ID);
        const preparation = controller.toggle('voice-session');
        controller.rearmAfterCredentialAuthorityChange({
            exactSessionAccountScopeChanged: false,
            globalBindingAuthorityChanged: false,
        });

        expect(preparing.stop).not.toHaveBeenCalled();

        startDeferred.resolve();
        await preparation;
    });

    it('fences a connecting attachment when its exact credential authority changes', async () => {
        const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
        const connecting = createAdapter({
            id: CODEX_PROVIDER_ID,
            snapshot: {
                adapterId: CODEX_PROVIDER_ID,
                sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
                status: 'connecting',
                mode: 'idle',
                canStop: true,
            },
        });
        const controller = createVoiceSessionLifecycleController({ getRegistry: () => ({
            get: (id: string) => id === connecting.controller.id ? connecting.controller : null,
            list: () => [connecting.controller],
        }) });

        controller.setConfiguredProviderId(CODEX_PROVIDER_ID);
        controller.rearmAfterCredentialAuthorityChange({ globalBindingAuthorityChanged: true });

        expect(connecting.stop).toHaveBeenCalledOnce();
        expect(connecting.stop).toHaveBeenCalledWith({
            sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
        });
    });

    it('fences in-flight preparation when its exact credential authority changes', async () => {
        const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
        const startDeferred = createDeferred<void>();
        const preparing = createAdapter({
            id: CODEX_PROVIDER_ID,
            snapshot: {
                adapterId: CODEX_PROVIDER_ID,
                sessionId: null,
                status: 'disconnected',
                mode: 'idle',
                canStop: false,
            },
            start: async () => {
                await startDeferred.promise;
            },
        });
        const controller = createVoiceSessionLifecycleController({ getRegistry: () => ({
            get: (id: string) => id === preparing.controller.id ? preparing.controller : null,
            list: () => [preparing.controller],
        }) });

        controller.setConfiguredProviderId(CODEX_PROVIDER_ID);
        const preparation = controller.toggle(VOICE_AGENT_GLOBAL_SESSION_ID);
        await vi.waitFor(() => expect(preparing.start).toHaveBeenCalledOnce());
        controller.rearmAfterCredentialAuthorityChange({ exactSessionAccountScopeChanged: true });

        expect(preparing.stop).toHaveBeenCalledOnce();
        expect(preparing.stop).toHaveBeenCalledWith({
            sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
        });

        startDeferred.resolve();
        await preparation;
    });

    it('fences a pending Global Agent start when its selected global binding changes before publication', async () => {
        const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
        const startDeferred = createDeferred<void>();
        const preparing = createAdapter({
            id: CODEX_PROVIDER_ID,
            snapshot: {
                adapterId: CODEX_PROVIDER_ID,
                sessionId: null,
                status: 'disconnected',
                mode: 'idle',
                canStop: false,
            },
            start: async () => {
                await startDeferred.promise;
            },
        });
        const controller = createVoiceSessionLifecycleController({ getRegistry: () => ({
            get: (id: string) => id === preparing.controller.id ? preparing.controller : null,
            list: () => [preparing.controller],
        }) });

        controller.setConfiguredProviderId(CODEX_PROVIDER_ID);
        const preparation = controller.toggle(VOICE_AGENT_GLOBAL_SESSION_ID);
        await vi.waitFor(() => expect(preparing.start).toHaveBeenCalledOnce());
        expect(controller.getSnapshot()).toMatchObject({
            sessionId: null,
            status: 'disconnected',
        });

        controller.rearmAfterCredentialAuthorityChange({
            exactSessionAccountScopeChanged: false,
            globalBindingAuthorityChanged: true,
        });

        expect(preparing.stop).toHaveBeenCalledOnce();
        expect(preparing.stop).toHaveBeenCalledWith({
            sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
        });

        startDeferred.resolve();
        await preparation;
    });

    it('retains an established ordinary OpenAI attachment until terminal after a next-start-only change', async () => {
        const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
        const connected = createAdapter({
            id: OPENAI_PROVIDER_ID,
            snapshot: {
                adapterId: OPENAI_PROVIDER_ID,
                sessionId: 'voice-session',
                status: 'connected',
                mode: 'listening',
                canStop: true,
            },
        });
        const controller = createVoiceSessionLifecycleController({ getRegistry: () => ({
            get: (id: string) => id === connected.controller.id ? connected.controller : null,
            list: () => [connected.controller],
        }) });

        controller.setConfiguredProviderId(OPENAI_PROVIDER_ID);
        controller.rearmAfterCredentialAuthorityChange({
            exactSessionAccountScopeChanged: false,
            globalBindingAuthorityChanged: false,
        });

        expect(connected.stop).not.toHaveBeenCalled();
    });

    it('routes barge-in only through the active adapter capability', async () => {
        const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
        const active = createAdapter({
            id: 'active',
            snapshot: { adapterId: 'active', sessionId: 'session-1', status: 'connected', mode: 'speaking', canStop: true },
        });
        const controller = createVoiceSessionLifecycleController({ getRegistry: () => ({
            get: (id: string) => id === 'active' ? active.controller : null,
            list: () => [active.controller],
        }) });
        controller.setConfiguredProviderId('active');
        await controller.bargeIn('fallback');
        expect(active.bargeIn).toHaveBeenCalledWith({ sessionId: 'session-1' });
    });
    it('does not republish a pending switch after dispose', async () => {
        vi.resetModules();

        const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
        const { getVoiceSessionSnapshot, setVoiceSessionSnapshot } = await import('./voiceSessionStore');

        const stopDeferred = createDeferred<void>();
        const sourceSnapshot: VoiceSessionSnapshot = {
            adapterId: 'local_direct',
            sessionId: 'session-1',
            status: 'connected',
            mode: 'listening',
            canStop: true,
        };
        const targetSnapshot: VoiceSessionSnapshot = {
            adapterId: 'local_conversation',
            sessionId: null,
            status: 'disconnected',
            mode: 'idle',
            canStop: false,
        };
        const sourceAdapter = createAdapter({
            id: 'local_direct',
            snapshot: sourceSnapshot,
            stop: async () => {
                await stopDeferred.promise;
            },
        });
        const targetAdapter = createAdapter({
            id: 'local_conversation',
            snapshot: targetSnapshot,
        });
        const registry: VoiceAdapterRegistry = {
            get: (id) => {
                if (id === sourceAdapter.controller.id) return sourceAdapter.controller;
                if (id === targetAdapter.controller.id) return targetAdapter.controller;
                return null;
            },
            list: () => [sourceAdapter.controller, targetAdapter.controller],
        };

        // The published snapshot already reflects the active source adapter (the
        // realistic state once adapters derive from the owner-aware machine);
        // the controller no longer relies on a blind active-adapter fallback to
        // discover an owner, so it must start from the owner's snapshot.
        setVoiceSessionSnapshot(sourceSnapshot);

        const controller = createVoiceSessionLifecycleController({
            getRegistry: () => registry,
        });

        controller.setConfiguredProviderId('local_conversation');
        expect(controller.getSnapshot()).toEqual(sourceSnapshot);
        expect(sourceAdapter.stop).toHaveBeenCalledTimes(1);
        const stopCallPromise = sourceAdapter.stop.mock.results[0]?.value as Promise<void>;

        controller.dispose();
        setVoiceSessionSnapshot({
            adapterId: null,
            sessionId: null,
            status: 'disconnected',
            mode: 'idle',
            canStop: false,
        });

        stopDeferred.resolve();
        await stopCallPromise;

        expect(getVoiceSessionSnapshot()).toEqual({
            adapterId: null,
            sessionId: null,
            status: 'disconnected',
            mode: 'idle',
            canStop: false,
        });
    });

    it('keeps ownership disconnected while a provider switch is pending and ignores stale source reconnects', async () => {
        vi.resetModules();

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
        expect(targetAdapter.start).toHaveBeenCalledTimes(1);
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
        expect(targetAdapter.start).toHaveBeenCalledTimes(1);

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

        stopDeferred.resolve();
        await sourceAdapter.stop.mock.results[0]?.value;
        targetStartDeferred.resolve();
        await targetAdapter.start.mock.results[0]?.value;
    });

    it('stays disconnected after switching off even if the old source later reconnects', async () => {
        vi.resetModules();

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
                await stopDeferred.promise;
            },
        });
        const idlePeer = createAdapter({
            id: 'local_conversation',
            snapshot: {
                adapterId: 'local_conversation',
                sessionId: null,
                status: 'disconnected',
                mode: 'idle',
                canStop: false,
            },
        });
        const registry: VoiceAdapterRegistry = {
            get: (id) => {
                if (id === sourceAdapter.controller.id) return sourceAdapter.controller;
                if (id === idlePeer.controller.id) return idlePeer.controller;
                return null;
            },
            list: () => [sourceAdapter.controller, idlePeer.controller],
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

        controller.setConfiguredProviderId('off');
        expect(sourceAdapter.stop).toHaveBeenCalledTimes(1);
        expect(controller.getSnapshot()).toMatchObject({
            adapterId: 'local_direct',
            sessionId: 'session-1',
            status: 'connected',
            mode: 'listening',
            canStop: true,
        });

        await act(async () => {
            sourceAdapter.setSnapshot({
                adapterId: 'local_direct',
                sessionId: null,
                status: 'disconnected',
                mode: 'idle',
                canStop: false,
            });
        });

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

        stopDeferred.resolve();
        await sourceAdapter.stop.mock.results[0]?.value;
    });

    it('stops the owned adapter through the canonical lifecycle controller seam', async () => {
        vi.resetModules();

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
        const registry: VoiceAdapterRegistry = {
            get: (id) => {
                if (id === sourceAdapter.controller.id) return sourceAdapter.controller;
                return null;
            },
            list: () => [sourceAdapter.controller],
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

        controller.setConfiguredProviderId('local_direct');

        const stopPromise = controller.stop('stale-session');

        expect(sourceAdapter.stop).toHaveBeenCalledWith({ sessionId: 'session-1' });
        expect(controller.getSnapshot()).toEqual({
            adapterId: null,
            sessionId: null,
            status: 'disconnected',
            mode: 'idle',
            canStop: false,
        });

        stopDeferred.resolve();
        await stopPromise;

        expect(getVoiceSessionSnapshot()).toEqual({
            adapterId: 'local_direct',
            sessionId: 'session-1',
            status: 'connected',
            mode: 'listening',
            canStop: true,
        });
    });

    it('starts the configured adapter when toggled from a disconnected state', async () => {
        vi.resetModules();

        const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
        const { setVoiceSessionSnapshot } = await import('./voiceSessionStore');

        const targetAdapter = createAdapter({
            id: 'local_conversation',
            snapshot: {
                adapterId: 'local_conversation',
                sessionId: null,
                status: 'disconnected',
                mode: 'idle',
                canStop: false,
            },
        });
        const registry: VoiceAdapterRegistry = {
            get: (id) => (id === targetAdapter.controller.id ? targetAdapter.controller : null),
            list: () => [targetAdapter.controller],
        };

        setVoiceSessionSnapshot({
            adapterId: null,
            sessionId: null,
            status: 'disconnected',
            mode: 'idle',
            canStop: false,
        });

        const controller = createVoiceSessionLifecycleController({
            getRegistry: () => registry,
        });

        controller.setConfiguredProviderId('local_conversation');
        await controller.toggle('session-1');

        expect(targetAdapter.start).toHaveBeenCalledWith({ sessionId: 'session-1' });
        expect(targetAdapter.toggle).not.toHaveBeenCalled();
        expect(targetAdapter.stop).not.toHaveBeenCalled();
    });

    it('settles a current terminal retryable connection failure after the adapter publishes recovery', async () => {
        const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
        const connectionFailure = Object.assign(new Error('voice_connection_failed'), {
            code: 'voice_connection_failed',
        });
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
                    sessionId: 'session-1',
                    status: 'connecting',
                    mode: 'idle',
                    canStop: true,
                });
                adapter.setSnapshot({
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
                throw connectionFailure;
            },
        });
        const controller = createVoiceSessionLifecycleController({ getRegistry: () => ({
            get: (id: string) => id === adapter.controller.id ? adapter.controller : null,
            list: () => [adapter.controller],
        }) });
        controller.setConfiguredProviderId(OPENAI_PROVIDER_ID);

        await expect(controller.toggle('session-1')).resolves.toBeUndefined();
        expect(controller.getSnapshot()).toMatchObject({
            adapterId: OPENAI_PROVIDER_ID,
            sessionId: 'session-1',
            status: 'error',
            canStop: false,
            errorCode: 'voice_connection_failed',
            errorRecoveryAction: 'retry',
        });
    });

    it('settles a blank global Start only after the canonical global session enters and leaves the attempt', async () => {
        const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
        const connectionFailure = Object.assign(new Error('voice_connection_failed'), {
            code: 'voice_connection_failed',
        });
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
                    sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
                    status: 'connecting',
                    mode: 'idle',
                    canStop: true,
                });
                adapter.setSnapshot({
                    adapterId: OPENAI_PROVIDER_ID,
                    sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
                    status: 'error',
                    mode: 'idle',
                    canStop: false,
                    errorCode: 'voice_connection_failed',
                    errorMessage: 'voice_connection_failed',
                    errorRecoveryAction: 'retry',
                    errorPresentation: 'error',
                });
                throw connectionFailure;
            },
        });
        const controller = createVoiceSessionLifecycleController({ getRegistry: () => ({
            get: (id: string) => id === adapter.controller.id ? adapter.controller : null,
            list: () => [adapter.controller],
        }) });
        controller.setConfiguredProviderId(OPENAI_PROVIDER_ID);

        await expect(controller.toggle('')).resolves.toBeUndefined();
        expect(controller.getSnapshot()).toMatchObject({
            sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
            status: 'error',
            errorRecoveryAction: 'retry',
        });
    });

    it('rethrows an unannounced failure after an unrelated registry republish refreshes a prior retryable error', async () => {
        const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
        const programmerFailure = new Error('unexpected_start_bug');
        let republishRegistry = () => {};
        const adapter = createAdapter({
            id: OPENAI_PROVIDER_ID,
            freshSnapshots: true,
            snapshot: {
                adapterId: OPENAI_PROVIDER_ID,
                sessionId: 'session-1',
                status: 'error',
                mode: 'idle',
                canStop: false,
                errorCode: 'voice_connection_failed',
                errorMessage: 'voice_connection_failed',
                errorRecoveryAction: 'retry',
                errorPresentation: 'error',
            },
            start: async () => {
                republishRegistry();
                throw programmerFailure;
            },
        });
        const registry = {
            get: (id: string) => id === adapter.controller.id ? adapter.controller : null,
            list: () => [adapter.controller],
            subscribe: (listener: () => void) => {
                republishRegistry = listener;
                return () => {};
            },
        };
        const controller = createVoiceSessionLifecycleController({ getRegistry: () => registry });
        controller.setConfiguredProviderId(OPENAI_PROVIDER_ID);

        await expect(controller.toggle('session-1')).rejects.toBe(programmerFailure);
    });

    it('rethrows a blank global Start when a registry republish only carries a prior direct-session retryable error', async () => {
        const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
        const programmerFailure = new Error('unexpected_start_bug');
        let republishRegistry = () => {};
        const adapter = createAdapter({
            id: OPENAI_PROVIDER_ID,
            freshSnapshots: true,
            snapshot: {
                adapterId: OPENAI_PROVIDER_ID,
                sessionId: 'direct-session-1',
                status: 'error',
                mode: 'idle',
                canStop: false,
                errorCode: 'voice_connection_failed',
                errorMessage: 'voice_connection_failed',
                errorRecoveryAction: 'retry',
                errorPresentation: 'error',
            },
            start: async () => {
                republishRegistry();
                throw programmerFailure;
            },
        });
        const registry = {
            get: (id: string) => id === adapter.controller.id ? adapter.controller : null,
            list: () => [adapter.controller],
            subscribe: (listener: () => void) => {
                republishRegistry = listener;
                return () => {};
            },
        };
        const controller = createVoiceSessionLifecycleController({ getRegistry: () => registry });
        controller.setConfiguredProviderId(OPENAI_PROVIDER_ID);

        await expect(controller.toggle('')).rejects.toBe(programmerFailure);
        expect(adapter.start).toHaveBeenCalledWith({ sessionId: '' });
        expect(controller.getSnapshot().sessionId).not.toBe(VOICE_AGENT_GLOBAL_SESSION_ID);
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

        await expect(controller.toggle('session-1')).rejects.toBe(previousFailure);
    });

    it('rethrows a current terminal failure without retryable recovery', async () => {
        const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
        const credentialFailure = Object.assign(new Error('credential_unavailable'), {
            code: 'credential_unavailable',
        });
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
                    sessionId: 'session-1',
                    status: 'error',
                    mode: 'idle',
                    canStop: false,
                    errorCode: 'provider_auth_invalid',
                    errorMessage: 'credential_unavailable',
                    errorRecoveryAction: 'review_credentials',
                    errorPresentation: 'error',
                });
                throw credentialFailure;
            },
        });
        const controller = createVoiceSessionLifecycleController({ getRegistry: () => ({
            get: (id: string) => id === adapter.controller.id ? adapter.controller : null,
            list: () => [adapter.controller],
        }) });
        controller.setConfiguredProviderId(OPENAI_PROVIDER_ID);

        await expect(controller.toggle('session-1')).rejects.toBe(credentialFailure);
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

        await expect(controller.toggle('session-1')).rejects.toBe(cancelled);
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

        await expect(controller.toggle('session-1')).rejects.toBe(staleFailure);
    });

    it('rethrows a start rejection that published no terminal recovery', async () => {
        const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
        const programmerFailure = new Error('unexpected_start_bug');
        const adapter = createAdapter({
            id: OPENAI_PROVIDER_ID,
            snapshot: {
                adapterId: OPENAI_PROVIDER_ID,
                sessionId: null,
                status: 'disconnected',
                mode: 'idle',
                canStop: false,
            },
            start: async () => {
                throw programmerFailure;
            },
        });
        const controller = createVoiceSessionLifecycleController({ getRegistry: () => ({
            get: (id: string) => id === adapter.controller.id ? adapter.controller : null,
            list: () => [adapter.controller],
        }) });
        controller.setConfiguredProviderId(OPENAI_PROVIDER_ID);

        await expect(controller.toggle('session-1')).rejects.toBe(programmerFailure);
    });

    it('stops the owned adapter when toggled from an active state', async () => {
        vi.resetModules();

        const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
        const { setVoiceSessionSnapshot } = await import('./voiceSessionStore');

        const sourceAdapter = createAdapter({
            id: 'local_conversation',
            snapshot: {
                adapterId: 'local_conversation',
                sessionId: 'session-1',
                status: 'connected',
                mode: 'listening',
                canStop: true,
            },
        });
        const registry: VoiceAdapterRegistry = {
            get: (id) => (id === sourceAdapter.controller.id ? sourceAdapter.controller : null),
            list: () => [sourceAdapter.controller],
        };

        setVoiceSessionSnapshot({
            adapterId: 'local_conversation',
            sessionId: 'session-1',
            status: 'connected',
            mode: 'listening',
            canStop: true,
        });

        const controller = createVoiceSessionLifecycleController({
            getRegistry: () => registry,
        });

        controller.setConfiguredProviderId('local_conversation');
        await controller.toggle('session-1');

        expect(sourceAdapter.stop).toHaveBeenCalledWith({ sessionId: 'session-1' });
        expect(sourceAdapter.start).not.toHaveBeenCalled();
    });
});
