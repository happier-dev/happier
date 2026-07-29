import { describe, expect, it, vi } from 'vitest';
import type {
    ExternalSessionStatusDemandDaemonMessageV1,
} from '@happier-dev/protocol';
import type { ManagedConnectionState } from '@happier-dev/connection-supervisor';
import type { ApiMachineClient } from '@/api/apiMachine';

import { bindExternalSessionStatusDemand } from './externalSessionStatusDemandBinding';

function replaceDemandMessage(): ExternalSessionStatusDemandDaemonMessageV1 {
    return {
        v: 1,
        type: 'replace',
        clientConnectionId: 'ui-socket-1',
        revision: 1,
        entries: [{
            sessionId: 'session-1',
            linkGeneration: 'generation-current',
            demand: 'open',
        }],
    };
}

describe('bindExternalSessionStatusDemand', () => {
    it('retains provisional demand when canonical preflight load is transiently unavailable', async () => {
        vi.useFakeTimers();
        try {
            const messageListeners: Array<
                Parameters<ApiMachineClient['onExternalSessionStatusDemand']>[0]
            > = [];
            const loadCurrentLink = vi.fn(async () => {
                throw new Error('temporary canonical load failure');
            });
            const onDemandChanges = vi.fn()
                .mockRejectedValueOnce(new Error('retryable projection load failure'))
                .mockResolvedValue(undefined);
            const binding = bindExternalSessionStatusDemand({
                channel: {
                    onExternalSessionStatusDemand: (listener) => {
                        messageListeners.push(listener);
                        return () => {};
                    },
                    onConnectionStateChange: () => () => {},
                },
                machineId: 'machine-1',
                loadCurrentLink,
                subscribeRuntimeReload: () => () => {},
                onDemandChanges,
            });

            messageListeners[0]?.({
                v: 1,
                type: 'replace',
                clientConnectionId: 'ui-socket-1',
                revision: 1,
                entries: [{
                    sessionId: 'session-1',
                    linkGeneration: 'generation-current',
                    demand: 'open',
                }],
            });
            await binding.flush();

            expect(onDemandChanges).toHaveBeenCalledOnce();
            await vi.advanceTimersByTimeAsync(250);
            expect(onDemandChanges).toHaveBeenCalledTimes(2);
            expect(onDemandChanges).toHaveBeenLastCalledWith([{
                sessionId: 'session-1',
                linkGeneration: 'generation-current',
                demand: 'open',
            }]);
            await binding.dispose();
        } finally {
            vi.useRealTimers();
        }
    });

    it('refreshes retained demand on runtime reload and clears it on connection teardown', async () => {
        const messageListeners: Array<
            Parameters<ApiMachineClient['onExternalSessionStatusDemand']>[0]
        > = [];
        const connectionListeners: Array<
            Parameters<ApiMachineClient['onConnectionStateChange']>[0]
        > = [];
        const detachMessage = vi.fn();
        const detachConnection = vi.fn();
        const detachRuntimeReload = vi.fn();
        const runtimeReloadListeners: Array<() => void> = [];
        const onDemandChanges = vi.fn(async () => {});
        const binding = bindExternalSessionStatusDemand({
            channel: {
                onExternalSessionStatusDemand: (listener) => {
                    messageListeners.push(listener);
                    return detachMessage;
                },
                onConnectionStateChange: (listener) => {
                    connectionListeners.push(listener);
                    return detachConnection;
                },
            },
            isCurrentLink: async ({ linkGeneration }) => linkGeneration === 'generation-current',
            subscribeRuntimeReload: (listener) => {
                runtimeReloadListeners.push(listener);
                return detachRuntimeReload;
            },
            onDemandChanges,
        });

        messageListeners[0]?.({
            v: 1,
            type: 'replace',
            clientConnectionId: 'ui-socket-1',
            revision: 1,
            entries: [{
                sessionId: 'session-1',
                linkGeneration: 'generation-old',
                demand: 'visible',
            }],
        });
        messageListeners[0]?.({
            v: 1,
            type: 'replace',
            clientConnectionId: 'ui-socket-1',
            revision: 2,
            entries: [{
                sessionId: 'session-1',
                linkGeneration: 'generation-current',
                demand: 'open',
            }],
        });
        await binding.flush();

        expect(onDemandChanges).toHaveBeenCalledTimes(1);
        expect(onDemandChanges).toHaveBeenLastCalledWith([{
            sessionId: 'session-1',
            linkGeneration: 'generation-current',
            demand: 'open',
        }]);

        const state = (phase: ManagedConnectionState['phase']): ManagedConnectionState => ({
            phase,
            reason: null,
            attempt: 0,
            nextRetryAt: null,
            lastConnectedAt: null,
            lastDisconnectedAt: null,
            lastErrorMessage: null,
        });
        runtimeReloadListeners[0]?.();
        await binding.flush();
        expect(onDemandChanges).toHaveBeenLastCalledWith([{
            sessionId: 'session-1',
            linkGeneration: 'generation-current',
            demand: 'open',
        }]);

        connectionListeners[0]?.(state('online'));
        connectionListeners[0]?.(state('offline'));
        await binding.flush();
        expect(onDemandChanges).toHaveBeenLastCalledWith([{
            sessionId: 'session-1',
            linkGeneration: 'generation-current',
            demand: null,
        }]);

        await binding.dispose();
        expect(onDemandChanges).toHaveBeenLastCalledWith([{
            sessionId: 'session-1',
            linkGeneration: 'generation-current',
            demand: null,
        }]);
        expect(detachMessage).toHaveBeenCalledTimes(1);
        expect(detachConnection).toHaveBeenCalledTimes(1);
        expect(detachRuntimeReload).toHaveBeenCalledTimes(1);
    });

    it('completes a failed credential invalidation before runtime-reload reconciliation', async () => {
        vi.useFakeTimers();
        try {
            const messageListeners: Array<
                Parameters<ApiMachineClient['onExternalSessionStatusDemand']>[0]
            > = [];
            const runtimeReloadListeners: Array<() => void> = [];
            const onDemandChanges = vi.fn()
                .mockResolvedValueOnce(undefined)
                .mockRejectedValueOnce(new Error('credential release failed'))
                .mockResolvedValue(undefined);
            const binding = bindExternalSessionStatusDemand({
                channel: {
                    onExternalSessionStatusDemand: (listener) => {
                        messageListeners.push(listener);
                        return () => {};
                    },
                    onConnectionStateChange: () => () => {},
                },
                isCurrentLink: async () => true,
                subscribeRuntimeReload: (listener) => {
                    runtimeReloadListeners.push(listener);
                    return () => {};
                },
                onDemandChanges,
            });

            messageListeners[0]?.(replaceDemandMessage());
            await binding.flush();
            await expect(binding.reconcileCredentialInvalidation())
                .rejects.toThrow('credential release failed');

            runtimeReloadListeners[0]?.();
            await binding.flush();

            expect(onDemandChanges.mock.calls.map(([changes]) => changes)).toEqual([
                [{
                    sessionId: 'session-1',
                    linkGeneration: 'generation-current',
                    demand: 'open',
                }],
                [{
                    sessionId: 'session-1',
                    linkGeneration: 'generation-current',
                    demand: null,
                }],
                [{
                    sessionId: 'session-1',
                    linkGeneration: 'generation-current',
                    demand: null,
                }],
                [{
                    sessionId: 'session-1',
                    linkGeneration: 'generation-current',
                    demand: 'open',
                }],
            ]);

            await vi.advanceTimersByTimeAsync(30_000);
            expect(onDemandChanges).toHaveBeenCalledTimes(4);
            await binding.dispose();
        } finally {
            vi.useRealTimers();
        }
    });

    it('loads the canonical current link with this daemon machine scope', async () => {
        const messageListeners: Array<
            Parameters<ApiMachineClient['onExternalSessionStatusDemand']>[0]
        > = [];
        const loadCurrentLink = vi.fn(async () => ({
            machineId: 'machine-1',
            linkGeneration: 'generation-current',
        }));
        const onDemandChanges = vi.fn(async () => {});
        const binding = bindExternalSessionStatusDemand({
            channel: {
                onExternalSessionStatusDemand: (listener) => {
                    messageListeners.push(listener);
                    return () => {};
                },
                onConnectionStateChange: () => () => {},
            },
            machineId: 'machine-1',
            loadCurrentLink,
            subscribeRuntimeReload: () => () => {},
            onDemandChanges,
        });

        messageListeners[0]?.({
            v: 1,
            type: 'replace',
            clientConnectionId: 'ui-socket-1',
            revision: 1,
            entries: [{
                sessionId: 'session-1',
                linkGeneration: 'generation-current',
                demand: 'loaded',
            }],
        });
        await binding.flush();

        expect(loadCurrentLink).toHaveBeenCalledWith({
            sessionId: 'session-1',
            machineId: 'machine-1',
        });
        expect(onDemandChanges).toHaveBeenCalledTimes(1);
        await binding.dispose();
    });
});
