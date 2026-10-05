import { afterEach, describe, expect, it, vi } from 'vitest';

import { createVoiceCaptureAdmissionController } from '@/voice/runtime/input/VoiceCaptureAdmissionController';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';

import { createVoiceSessionLifecycleController } from './voiceSessionLifecycleController';
import type { VoiceAdapterController, VoiceSessionSnapshot } from './types';

const OPENAI_PROVIDER_ID = 'happier.voice.openai/realtime-openai';

const sessionAddress = (sessionId: string) => ({ serverId: 'server-1', sessionId });

vi.mock('@/log', () => ({ log: { log: vi.fn() } }));
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

afterEach(async () => {
    const { resetVoiceSessionRuntimeStateForTests } = await import('./voiceSessionStore');
    await resetVoiceSessionRuntimeStateForTests();
});

function createSnapshotPublisher(initial: VoiceSessionSnapshot): Readonly<{
    getSnapshot: () => VoiceSessionSnapshot;
    publish: (next: VoiceSessionSnapshot) => void;
    subscribe: (listener: () => void) => () => void;
}> {
    let snapshot = initial;
    const listeners = new Set<() => void>();
    return {
        getSnapshot: () => snapshot,
        publish: (next) => {
            snapshot = next;
            for (const listener of listeners) listener();
        },
        subscribe: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
}

describe('voice session lifecycle edge contracts', () => {
    it.each([
        { status: 'error', rejectCleanup: false, replaceDuringCleanup: false },
        { status: 'disconnected', rejectCleanup: false, replaceDuringCleanup: false },
        { status: 'error', rejectCleanup: true, replaceDuringCleanup: false },
        { status: 'disconnected', rejectCleanup: false, replaceDuringCleanup: true },
    ] as const)('dismisses terminal $status (cleanup rejected: $rejectCleanup, replaced: $replaceDuringCleanup) without losing recovery', async ({ status, rejectCleanup, replaceDuringCleanup }) => {
        const { getVoiceSessionEndedAttempt, setVoiceSessionSnapshot } = await import('./voiceSessionStore');
        const snapshots = createSnapshotPublisher({
            adapterId: OPENAI_PROVIDER_ID, sessionId: null, status: 'disconnected', mode: 'idle', canStop: false,
        });
        let mediaHeld = false;
        let cleanupRejected = rejectCleanup;
        let releaseCleanup!: () => void;
        const cleanup = replaceDuringCleanup ? new Promise<void>((resolve) => { releaseCleanup = resolve; }) : Promise.resolve();
        const start = vi.fn(async ({ sessionId }: Readonly<{ sessionId: string }>) => {
            mediaHeld = true;
            snapshots.publish({ adapterId: OPENAI_PROVIDER_ID, sessionId, status: 'connected', mode: 'listening', canStop: true });
        });
        // The provider boundary may retain media and its terminal error until Stop; lifecycle owns cleanup.
        const adapter: VoiceAdapterController = {
            id: OPENAI_PROVIDER_ID, engineKind: 'realtime', start,
            stop: async () => {
                if (cleanupRejected) {
                    cleanupRejected = false;
                    throw new Error('media_cleanup_failed');
                }
                await cleanup;
                mediaHeld = false;
            },
            toggle: async () => {}, interrupt: async () => {}, setMuted: async () => {}, sendContextUpdate: () => {},
            getSnapshot: snapshots.getSnapshot, subscribe: snapshots.subscribe,
        };
        const captureAdmission = createVoiceCaptureAdmissionController();
        const releaseConnectivity = vi.fn();
        const controller = createVoiceSessionLifecycleController({
            captureAdmission, acquireConnectivityLease: () => releaseConnectivity,
            getRegistry: () => ({ get: () => adapter, list: () => [adapter] }),
        });
        const unsubscribe = controller.subscribe(() => setVoiceSessionSnapshot(controller.getSnapshot()));
        try {
            controller.setConfiguredProviderId(adapter.id);
            await controller.toggle({ serverId: 'home-a', sessionId: 'voice-session' });
            const failure: VoiceSessionSnapshot = {
                adapterId: adapter.id, sessionId: 'voice-session', status, mode: 'idle', canStop: false,
                errorCode: 'network_error', errorRecoveryAction: 'retry', errorPresentation: 'error',
            };
            snapshots.publish(failure);
            expect(getVoiceSessionEndedAttempt()).toBeNull();
            await controller.dismissFailedAttempt('another-session');
            expect(controller.getSnapshot()).toMatchObject(failure);
            if (rejectCleanup) {
                await expect(controller.dismissFailedAttempt('voice-session')).rejects.toThrow('media_cleanup_failed');
                expect(mediaHeld).toBe(true);
                expect(controller.getSnapshot()).toMatchObject(failure);
                await controller.retry('another-session');
                expect(start).toHaveBeenCalledTimes(2);
                expect(controller.getSnapshot().status).toBe('connected');
                return;
            }
            const dismissal = controller.dismissFailedAttempt('voice-session');
            if (replaceDuringCleanup) {
                const target = { serverId: 'home-b', sessionId: 'new-session' };
                await controller.toggle(target);
                snapshots.publish({ ...failure, sessionId: target.sessionId });
                releaseCleanup();
                await dismissal;
                expect(controller.getSnapshot()).toMatchObject({ ...failure, sessionId: target.sessionId });
                await controller.retry('voice-session');
                expect(start).toHaveBeenLastCalledWith({ sessionId: target.sessionId, requestedTargetSessionAddress: target });
                expect(controller.getSnapshot().status).toBe('connected');
                return;
            }
            await dismissal;
            expect(mediaHeld).toBe(false);
            expect(releaseConnectivity).toHaveBeenCalled();
            expect(controller.getSnapshot()).toEqual({ adapterId: null, sessionId: null, status: 'disconnected', mode: 'idle', canStop: false });
            expect(getVoiceSessionEndedAttempt()).toBeNull();
            snapshots.publish({ ...failure });
            expect(controller.getSnapshot().status).toBe('disconnected');
            expect(controller.getSnapshot().errorCode).toBeUndefined();
            await controller.retry('voice-session');
            expect(start).toHaveBeenCalledTimes(1);
            const capture = captureAdmission.acquire('dictation');
            expect(capture.status).toBe('acquired');
            if (capture.status === 'acquired') capture.lease.release();
            await controller.toggle({ serverId: 'home-b', sessionId: 'new-session' });
            expect(controller.getSnapshot().status).toBe('connected');
        } finally {
            unsubscribe();
            await controller.dispose();
        }
    });

    it.each(['connecting', 'connected', 'error'] as const)('refuses to dismiss a live %s attempt', async (status) => {
        const snapshots = createSnapshotPublisher({
            adapterId: OPENAI_PROVIDER_ID, sessionId: 'voice-session', status, mode: 'listening', canStop: true,
            ...(status === 'error' ? { errorCode: 'network_error', errorPresentation: 'error' as const } : {}),
        });
        let mediaHeld = true;
        const adapter: VoiceAdapterController = {
            id: OPENAI_PROVIDER_ID, engineKind: 'realtime', start: async () => {},
            stop: async () => { mediaHeld = false; },
            toggle: async () => {}, interrupt: async () => {}, setMuted: async () => {}, sendContextUpdate: () => {},
            getSnapshot: snapshots.getSnapshot, subscribe: snapshots.subscribe,
        };
        const controller = createVoiceSessionLifecycleController({ getRegistry: () => ({ get: () => adapter, list: () => [adapter] }) });
        try {
            controller.setConfiguredProviderId(adapter.id);
            await controller.dismissFailedAttempt('voice-session');
            expect(controller.getSnapshot()).toEqual(snapshots.getSnapshot());
            expect(mediaHeld).toBe(true);
        } finally {
            await controller.dispose();
        }
    });

    it('retries the exact failed Home binding and honors a later explicit global start', async () => {
        const snapshots = createSnapshotPublisher({
            adapterId: OPENAI_PROVIDER_ID, sessionId: null, status: 'disconnected', mode: 'idle', canStop: false,
        });
        const start = vi.fn(async ({ sessionId }: Readonly<{ sessionId: string }>) => snapshots.publish({
            adapterId: OPENAI_PROVIDER_ID, sessionId: sessionId || VOICE_AGENT_GLOBAL_SESSION_ID,
            status: 'connected', mode: 'listening', canStop: true,
        }));
        const adapter: VoiceAdapterController = {
            id: OPENAI_PROVIDER_ID, engineKind: 'realtime', start,
            stop: async () => snapshots.publish({
                adapterId: OPENAI_PROVIDER_ID, sessionId: null, status: 'disconnected', mode: 'idle', canStop: false,
            }),
            toggle: async () => {}, interrupt: async () => {}, setMuted: async () => {},
            sendContextUpdate: () => {}, getSnapshot: snapshots.getSnapshot, subscribe: snapshots.subscribe,
        };
        const releaseConnectivity = vi.fn();
        const controller = createVoiceSessionLifecycleController({
            captureAdmission: createVoiceCaptureAdmissionController(),
            acquireConnectivityLease: () => releaseConnectivity,
            getRegistry: () => ({ get: () => adapter, list: () => [adapter] }),
        });
        const fail = () => snapshots.publish({
            adapterId: OPENAI_PROVIDER_ID, sessionId: snapshots.getSnapshot().sessionId,
            status: 'disconnected', mode: 'idle', canStop: false,
            errorCode: 'network_error', errorRecoveryAction: 'retry',
        });
        try {
            controller.setConfiguredProviderId(adapter.id);
            for (const serverId of ['home-a', 'home-b']) {
                const target = { serverId, sessionId: 'same-session' };
                await controller.toggle(target);
                fail();
                expect(releaseConnectivity).toHaveBeenCalled();
                await controller.retry('another-visible-session');
                expect(start).toHaveBeenLastCalledWith({ sessionId: 'same-session', requestedTargetSessionAddress: target });
                await controller.stop('same-session');
            }
            await controller.toggle({ serverId: 'home-a', sessionId: 'same-session' });
            fail();
            await controller.toggle(null);
            expect(start).toHaveBeenLastCalledWith({ sessionId: '', requestedTargetSessionAddress: null });
            fail();
            await controller.retry(VOICE_AGENT_GLOBAL_SESSION_ID);
            expect(start).toHaveBeenLastCalledWith({ sessionId: '', requestedTargetSessionAddress: null });
        } finally {
            await controller.dispose();
        }
    });

    it.each(['end', 'account', 'provider', 'global_binding'] as const)('retires the failed binding after %s without starting a targetless retry', async (retirement) => {
        const snapshots = createSnapshotPublisher({
            adapterId: OPENAI_PROVIDER_ID, sessionId: null, status: 'disconnected', mode: 'idle', canStop: false,
        });
        const start = vi.fn(async ({ sessionId }: Readonly<{ sessionId: string }>) => snapshots.publish({
            adapterId: OPENAI_PROVIDER_ID, sessionId: sessionId || VOICE_AGENT_GLOBAL_SESSION_ID,
            status: 'connected', mode: 'listening', canStop: true,
        }));
        const adapter: VoiceAdapterController = {
            id: OPENAI_PROVIDER_ID, engineKind: 'realtime', start,
            stop: async () => {}, toggle: async () => {}, interrupt: async () => {}, setMuted: async () => {},
            sendContextUpdate: () => {}, getSnapshot: snapshots.getSnapshot, subscribe: snapshots.subscribe,
        };
        const controller = createVoiceSessionLifecycleController({
            captureAdmission: createVoiceCaptureAdmissionController(),
            getRegistry: () => ({ get: (id) => id === adapter.id ? adapter : null, list: () => [adapter] }),
        });
        try {
            controller.setConfiguredProviderId(adapter.id);
            await controller.toggle(retirement === 'global_binding' ? null : { serverId: 'home-a', sessionId: 'same-session' });
            snapshots.publish({
                adapterId: OPENAI_PROVIDER_ID, sessionId: snapshots.getSnapshot().sessionId,
                status: 'disconnected', mode: 'idle', canStop: false,
                errorCode: 'network_error', errorRecoveryAction: 'retry',
            });
            if (retirement === 'end') await controller.stop('same-session');
            if (retirement === 'account') controller.rearmAfterCredentialAuthorityChange({ exactSessionAccountScopeChanged: true });
            if (retirement === 'global_binding') controller.rearmAfterCredentialAuthorityChange({ globalBindingAuthorityChanged: true });
            if (retirement === 'provider') {
                controller.setConfiguredProviderId('off');
                controller.setConfiguredProviderId(adapter.id);
            }
            await controller.retry('same-session');
            expect(start).toHaveBeenCalledTimes(1);
        } finally {
            await controller.dispose();
        }
    });

    it('holds routine connectivity through the exact active Voice attempt', async () => {
        const snapshots = createSnapshotPublisher({
            adapterId: 'local_direct',
            sessionId: null,
            status: 'disconnected',
            mode: 'idle',
            canStop: false,
        });
        const releaseConnectivity = vi.fn();
        const acquireConnectivityLease = vi.fn(() => releaseConnectivity);
        const adapter: VoiceAdapterController = {
            id: 'local_direct',
            engineKind: 'local',
            start: vi.fn(async ({ sessionId }) => snapshots.publish({
                adapterId: 'local_direct',
                sessionId,
                status: 'connected',
                mode: 'listening',
                canStop: true,
            })),
            stop: vi.fn(async ({ sessionId }) => snapshots.publish({
                adapterId: 'local_direct',
                sessionId,
                status: 'disconnected',
                mode: 'idle',
                canStop: false,
            })),
            toggle: vi.fn(async () => {}),
            interrupt: vi.fn(async () => {}),
            setMuted: vi.fn(async () => {}),
            sendContextUpdate: vi.fn(),
            getSnapshot: snapshots.getSnapshot,
            subscribe: snapshots.subscribe,
        };
        const controller = createVoiceSessionLifecycleController({
            acquireConnectivityLease,
            getRegistry: () => ({
                get: (id) => id === adapter.id ? adapter : null,
                list: () => [adapter],
            }),
        });

        try {
            controller.setConfiguredProviderId(adapter.id);
            await controller.toggle(sessionAddress('session-1'));

            expect(acquireConnectivityLease).toHaveBeenCalledTimes(1);
            expect(releaseConnectivity).not.toHaveBeenCalled();

            await controller.stop('session-1');
            expect(releaseConnectivity).toHaveBeenCalledTimes(1);
        } finally {
            await controller.dispose();
        }
    });

    it('does not release connectivity for an initial disconnected snapshot while Start is still pending', async () => {
        const snapshots = createSnapshotPublisher({
            adapterId: 'local_direct',
            sessionId: null,
            status: 'disconnected',
            mode: 'idle',
            canStop: false,
        });
        let rejectStart: (error: Error) => void = () => {};
        const startSettlement = new Promise<void>((_resolve, reject) => {
            rejectStart = reject;
        });
        const releaseConnectivity = vi.fn();
        const adapter: VoiceAdapterController = {
            id: 'local_direct',
            engineKind: 'local',
            start: vi.fn(async ({ sessionId }) => {
                snapshots.publish({
                    adapterId: 'local_direct',
                    sessionId,
                    status: 'disconnected',
                    mode: 'idle',
                    canStop: false,
                });
                await startSettlement;
            }),
            stop: vi.fn(async () => {}),
            toggle: vi.fn(async () => {}),
            interrupt: vi.fn(async () => {}),
            setMuted: vi.fn(async () => {}),
            sendContextUpdate: vi.fn(),
            getSnapshot: snapshots.getSnapshot,
            subscribe: snapshots.subscribe,
        };
        const controller = createVoiceSessionLifecycleController({
            acquireConnectivityLease: () => releaseConnectivity,
            getRegistry: () => ({
                get: (id) => id === adapter.id ? adapter : null,
                list: () => [adapter],
            }),
        });

        try {
            controller.setConfiguredProviderId(adapter.id);
            const start = controller.toggle(sessionAddress('session-1'));
            await Promise.resolve();
            expect(releaseConnectivity).not.toHaveBeenCalled();

            rejectStart(new Error('start_failed'));
            await expect(start).rejects.toThrow('start_failed');
            expect(releaseConnectivity).toHaveBeenCalledTimes(1);
        } finally {
            await controller.dispose();
        }
    });

    it('publishes a retryable provider-unavailable snapshot before admitting microphone capture', async () => {
        const captureAdmission = createVoiceCaptureAdmissionController();
        const published = vi.fn();
        const controller = createVoiceSessionLifecycleController({
            captureAdmission,
            getRegistry: () => ({
                get: () => null,
                list: () => [],
            }),
        });
        controller.setConfiguredProviderId(OPENAI_PROVIDER_ID);
        const unsubscribe = controller.subscribe(published);

        try {
            await controller.toggle(sessionAddress('session-1'));

            expect(controller.getSnapshot()).toEqual({
                adapterId: OPENAI_PROVIDER_ID,
                sessionId: 'session-1',
                status: 'error',
                mode: 'idle',
                canStop: false,
                errorCode: 'service_temporarily_unavailable',
                errorMessage: 'voice_provider_adapter_not_registered',
                errorRecoveryAction: 'retry',
                errorPresentation: 'error',
            });
            expect(published).toHaveBeenCalledTimes(1);

            // Repeated Start on the same unavailable selection retains the
            // current refusal instead of publishing/erroring again.
            await controller.toggle(sessionAddress('session-1'));
            expect(published).toHaveBeenCalledTimes(1);

            const dictationAdmission = captureAdmission.acquire('dictation');
            expect(dictationAdmission).toMatchObject({ status: 'acquired' });
            if (dictationAdmission.status === 'acquired') dictationAdmission.lease.release();

            // The refusal belongs only to the selected provider/session. A
            // later selection must not inherit that stale error.
            controller.setConfiguredProviderId('local_conversation');
            expect(controller.getSnapshot()).toEqual({
                adapterId: null,
                sessionId: null,
                status: 'disconnected',
                mode: 'idle',
                canStop: false,
            });
        } finally {
            unsubscribe();
            await controller.dispose();
        }
    });

    it('retains the exact Home address when an unavailable same-id target is replaced before Retry', async () => {
        const snapshots = createSnapshotPublisher({
            adapterId: OPENAI_PROVIDER_ID,
            sessionId: null,
            status: 'disconnected',
            mode: 'idle',
            canStop: false,
        });
        const start = vi.fn(async () => undefined);
        const adapter: VoiceAdapterController = {
            id: OPENAI_PROVIDER_ID,
            engineKind: 'realtime',
            start,
            stop: vi.fn(async () => undefined),
            toggle: vi.fn(async () => undefined),
            interrupt: vi.fn(async () => undefined),
            setMuted: vi.fn(async () => undefined),
            sendContextUpdate: vi.fn(),
            getSnapshot: snapshots.getSnapshot,
            subscribe: snapshots.subscribe,
        };
        let registered: VoiceAdapterController | null = null;
        const controller = createVoiceSessionLifecycleController({
            getRegistry: () => ({
                get: (id) => id === OPENAI_PROVIDER_ID ? registered : null,
                list: () => registered ? [registered] : [],
            }),
        });
        controller.setConfiguredProviderId(OPENAI_PROVIDER_ID);

        try {
            await controller.toggle({ serverId: 'home-a', sessionId: 'same-session' });
            await controller.toggle({ serverId: 'home-b', sessionId: 'same-session' });
            registered = adapter;

            await controller.retry('same-session');

            expect(start).toHaveBeenCalledWith({
                sessionId: 'same-session',
                requestedTargetSessionAddress: {
                    serverId: 'home-b',
                    sessionId: 'same-session',
                },
            });
        } finally {
            await controller.dispose();
        }
    });

    it.each(['on_demand', 'automatic'] as const)(
        'reseeds the active Local Agent model session when disclosure returns from off to %s',
        async () => {
            const snapshots = createSnapshotPublisher({
                adapterId: 'local_conversation',
                sessionId: null,
                status: 'disconnected',
                mode: 'idle',
                canStop: false,
            });
            const starts = vi.fn(async ({ sessionId }: Readonly<{ sessionId: string }>) => {
                snapshots.publish({
                    adapterId: 'local_conversation',
                    sessionId,
                    status: 'connected',
                    mode: 'listening',
                    canStop: true,
                });
            });
            const adapter: VoiceAdapterController = {
                id: 'local_conversation',
                engineKind: 'local',
                start: starts,
                stop: vi.fn(async ({ sessionId }) => {
                    snapshots.publish({
                        adapterId: 'local_conversation',
                        sessionId,
                        status: 'disconnected',
                        mode: 'idle',
                        canStop: false,
                    });
                }),
                toggle: vi.fn(async () => {}),
                interrupt: vi.fn(async () => {}),
                setMuted: vi.fn(async () => {}),
                sendContextUpdate: vi.fn(),
                sendTextTurn: vi.fn(async () => {}),
                getSnapshot: snapshots.getSnapshot,
                subscribe: snapshots.subscribe,
            };
            const controller = createVoiceSessionLifecycleController({
                getRegistry: () => ({
                    get: (id) => id === adapter.id ? adapter : null,
                    list: () => [adapter],
                }),
            });

            try {
                controller.setConfiguredProviderId(adapter.id);
                controller.setCurrentUiContextToolSetEnabled(true);
                await controller.toggle(sessionAddress('local-session'));
                controller.setCurrentUiContextToolSetEnabled(false);
                await vi.waitFor(() => expect(starts).toHaveBeenCalledTimes(2));

                controller.setCurrentUiContextToolSetEnabled(true);
                await vi.waitFor(() => expect(starts).toHaveBeenCalledTimes(3));

                expect(adapter.stop).toHaveBeenCalledTimes(2);
                expect(controller.getSnapshot()).toMatchObject({
                    adapterId: adapter.id,
                    sessionId: 'local-session',
                    status: 'connected',
                    canStop: true,
                });
            } finally {
                await controller.dispose();
            }
        },
    );

    it('does not replace an active Local Direct attempt when disclosure returns from off', async () => {
        const snapshots = createSnapshotPublisher({
            adapterId: 'local_direct',
            sessionId: 'local-session',
            status: 'connected',
            mode: 'listening',
            canStop: true,
        });
        const adapter: VoiceAdapterController = {
            id: 'local_direct',
            engineKind: 'local',
            start: vi.fn(async () => {}),
            stop: vi.fn(async () => {}),
            toggle: vi.fn(async () => {}),
            interrupt: vi.fn(async () => {}),
            setMuted: vi.fn(async () => {}),
            sendContextUpdate: vi.fn(),
            getSnapshot: snapshots.getSnapshot,
            subscribe: snapshots.subscribe,
        };
        const controller = createVoiceSessionLifecycleController({
            getRegistry: () => ({
                get: (id) => id === adapter.id ? adapter : null,
                list: () => [adapter],
            }),
        });

        try {
            controller.setConfiguredProviderId(adapter.id);
            controller.setCurrentUiContextToolSetEnabled(true);
            controller.setCurrentUiContextToolSetEnabled(false);
            controller.setCurrentUiContextToolSetEnabled(true);

            expect(adapter.stop).not.toHaveBeenCalled();
            expect(adapter.start).not.toHaveBeenCalled();
            expect(controller.getSnapshot()).toMatchObject({
                adapterId: adapter.id,
                sessionId: 'local-session',
                status: 'connected',
                canStop: true,
            });
        } finally {
            await controller.dispose();
        }
    });
});
