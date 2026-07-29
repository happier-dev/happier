import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { VoiceAdapterController, VoiceSessionSnapshot } from './types';

type VoiceAdapterRegistry = Readonly<{
    get: (id: string) => VoiceAdapterController | null;
    list: () => ReadonlyArray<VoiceAdapterController>;
}>;

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
            getSnapshot: () => snapshot,
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

    it('rearms only a terminal provider-auth failure and waits for the next explicit start', async () => {
        const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
        const authFailure: VoiceSessionSnapshot = {
            adapterId: 'realtime_openai',
            sessionId: 'session-1',
            status: 'disconnected',
            mode: 'idle',
            canStop: false,
            errorCode: 'provider_auth_invalid',
            errorMessage: 'credential_unavailable',
            errorRecoveryAction: 'review_credentials',
            errorPresentation: 'error',
        };
        const configured = createAdapter({
            id: 'realtime_openai',
            snapshot: authFailure,
        });
        const controller = createVoiceSessionLifecycleController({ getRegistry: () => ({
            get: (id: string) => id === configured.controller.id ? configured.controller : null,
            list: () => [configured.controller],
        }) });

        controller.setConfiguredProviderId('realtime_openai');
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
            id: 'realtime_codex',
            snapshot: {
                adapterId: 'realtime_codex',
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

        controller.setConfiguredProviderId('realtime_codex');
        controller.rearmAfterCredentialAuthorityChange({ fenceActive: true });

        expect(active.stop).toHaveBeenCalledOnce();
        expect(active.stop).toHaveBeenCalledWith({ sessionId: 'global-voice-home' });
        expect(active.start).not.toHaveBeenCalled();
    });

    it('aborts a connecting attachment even when the change is classified as next-start-only', async () => {
        const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
        const connecting = createAdapter({
            id: 'realtime_openai',
            snapshot: {
                adapterId: 'realtime_openai',
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

        controller.setConfiguredProviderId('realtime_openai');
        controller.rearmAfterCredentialAuthorityChange({ fenceActive: false });

        expect(connecting.stop).toHaveBeenCalledOnce();
        expect(connecting.stop).toHaveBeenCalledWith({ sessionId: 'voice-session' });
    });

    it('aborts in-flight preparation for a next-start-only change before connecting is published', async () => {
        const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
        const startDeferred = createDeferred<void>();
        const preparing = createAdapter({
            id: 'realtime_openai',
            snapshot: {
                adapterId: 'realtime_openai',
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

        controller.setConfiguredProviderId('realtime_openai');
        const preparation = controller.toggle('voice-session');
        controller.rearmAfterCredentialAuthorityChange({ fenceActive: false });

        expect(preparing.stop).toHaveBeenCalledOnce();
        expect(preparing.stop).toHaveBeenCalledWith({ sessionId: 'voice-session' });

        startDeferred.resolve();
        await preparation;
    });

    it('retains an established ordinary OpenAI attachment until terminal after a next-start-only change', async () => {
        const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
        const connected = createAdapter({
            id: 'realtime_openai',
            snapshot: {
                adapterId: 'realtime_openai',
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

        controller.setConfiguredProviderId('realtime_openai');
        controller.rearmAfterCredentialAuthorityChange({ fenceActive: false });

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
