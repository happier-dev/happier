import { afterEach, describe, expect, it, vi } from 'vitest';

import { createVoiceCaptureAdmissionController } from '@/voice/runtime/input/VoiceCaptureAdmissionController';

import type { VoiceAdapterController, VoiceSessionSnapshot } from './types';

const OPENAI_PROVIDER_ID = 'happier.voice.openai/realtime-openai';

vi.mock('@/log', () => ({ log: { log: vi.fn() } }));

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
    it('holds routine connectivity through the exact active Voice attempt', async () => {
        const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
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
            await controller.toggle('session-1');

            expect(acquireConnectivityLease).toHaveBeenCalledTimes(1);
            expect(releaseConnectivity).not.toHaveBeenCalled();

            await controller.stop('session-1');
            expect(releaseConnectivity).toHaveBeenCalledTimes(1);
        } finally {
            await controller.dispose();
        }
    });

    it('does not release connectivity for an initial disconnected snapshot while Start is still pending', async () => {
        const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
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
            const start = controller.toggle('session-1');
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
        const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
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
            await controller.toggle('session-1');

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
            await controller.toggle('session-1');
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

    it.each(['on_demand', 'automatic'] as const)(
        'reseeds the active Local Agent model session when disclosure returns from off to %s',
        async () => {
            const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
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
                await controller.toggle('local-session');
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
        const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
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
