import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol';
import { EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1 } from '@happier-dev/protocol/actions';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import type { Server } from 'socket.io';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const machineFindFirstMock = vi.hoisted(() => vi.fn());

vi.mock('@/storage/db', () => ({
    db: {
        machine: { findFirst: machineFindFirstMock },
    },
}));

vi.mock('@/app/monitoring/metrics/index', () => ({
    observeRpcCall: vi.fn(),
    observeRpcTargetLookup: vi.fn(),
    recordRpcCallFailure: vi.fn(),
    recordRpcMethodNotAvailable: vi.fn(),
    recordRpcSelfCallRejection: vi.fn(),
    recordSocketClusterFetchSockets: vi.fn(),
}));


import { forwardRpcCall } from './forwardRpcCall';

describe('forwardRpcCall', () => {
    beforeEach(() => {
        machineFindFirstMock.mockReset().mockResolvedValue({
            revokedAt: null,
            replacedByMachineId: null,
        });
    });

    it('forwards machine-encrypted transcript refresh bytes without inspecting or rewriting them', async () => {
        const encryptedRequest = 'ZW5jcnlwdGVkLXRyYW5zY3JpcHQtcmVmcmVzaC1yZXF1ZXN0';
        const encryptedResponse = 'ZW5jcnlwdGVkLXRyYW5zY3JpcHQtcmVmcmVzaC1yZXNwb25zZQ==';
        const emitWithAck = vi.fn().mockResolvedValue(encryptedResponse);
        const target = {
            id: 'daemon-socket',
            data: {
                clientType: 'machine-scoped',
                machineId: 'machine-1',
            },
            timeout: vi.fn(() => ({ emitWithAck })),
        };
        const fetchSockets = vi.fn().mockResolvedValue([target]);
        const io = {
            in: vi.fn(() => ({
                timeout: vi.fn(() => ({ fetchSockets })),
                fetchSockets,
            })),
        } as unknown as Server;
        const method = `machine-1:${RPC_METHODS.DAEMON_EXTERNAL_SESSION_TRANSCRIPT_READ_AFTER}`;

        await expect(forwardRpcCall({
            io,
            targetUserId: 'user-1',
            method,
            callParams: encryptedRequest,
        })).resolves.toEqual({
            ok: true,
            result: encryptedResponse,
        });
        expect(emitWithAck).toHaveBeenCalledWith(
            SOCKET_RPC_EVENTS.REQUEST,
            expect.objectContaining({
                method,
                params: encryptedRequest,
            }),
        );
    });

    it.each([
        {
            name: 'legacy caller to current daemon',
            callerSupportsCurrentProtocol: false,
            targetSupportsCurrentProtocol: true,
        },
        {
            name: 'current caller to legacy daemon',
            callerSupportsCurrentProtocol: true,
            targetSupportsCurrentProtocol: false,
        },
    ])('refuses marked Machine RPC before daemon dispatch for $name', async ({
        callerSupportsCurrentProtocol,
        targetSupportsCurrentProtocol,
    }) => {
        machineFindFirstMock.mockResolvedValue({
            dataEncryptionKey: new Uint8Array(
                Buffer.from(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64'),
            ),
            revokedAt: null,
            replacedByMachineId: null,
        });
        const emitWithAck = vi.fn().mockResolvedValue('plain-response');
        const target = {
            id: 'daemon-socket',
            data: {
                clientType: 'machine-scoped',
                machineId: 'machine-1',
                accountStoredContentCompatibility: {
                    supportsCurrentProtocol: targetSupportsCurrentProtocol,
                    outcome: targetSupportsCurrentProtocol
                        ? 'accepted'
                        : 'observe-missing',
                },
            },
            timeout: vi.fn(() => ({ emitWithAck })),
        };
        const fetchSockets = vi.fn().mockResolvedValue([target]);
        const io = {
            in: vi.fn(() => ({
                timeout: vi.fn(() => ({ fetchSockets })),
                fetchSockets,
            })),
        } as unknown as Server;
        const callerSocket = {
            data: {
                accountStoredContentCompatibility: {
                    supportsCurrentProtocol:
                        callerSupportsCurrentProtocol,
                    outcome: callerSupportsCurrentProtocol
                        ? 'accepted'
                        : 'observe-missing',
                },
            },
        };

        await expect(forwardRpcCall({
            io,
            targetUserId: 'user-1',
            method: `machine-1:${RPC_METHODS.CAPABILITIES_INVOKE}`,
            callParams: 'opaque-request',
            callerSocket,
        })).resolves.toEqual({
            ok: false,
            error: 'client-upgrade-required',
            requirement: {
                v: 1,
                kind: 'account-stored-content',
                minimumProtocolVersion: 2,
            },
        });
        expect(emitWithAck).not.toHaveBeenCalled();
    });

    it('forwards marked Machine RPC when both caller and daemon are current', async () => {
        machineFindFirstMock.mockResolvedValue({
            dataEncryptionKey: new Uint8Array(
                Buffer.from(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64'),
            ),
            revokedAt: null,
            replacedByMachineId: null,
        });
        const currentCompatibility = {
            accepted: true,
            supportsCurrentProtocol: true,
            outcome: 'accepted',
        };
        const emitWithAck = vi.fn().mockResolvedValue('plain-response');
        const target = {
            id: 'daemon-socket',
            data: {
                clientType: 'machine-scoped',
                machineId: 'machine-1',
                accountStoredContentCompatibility: currentCompatibility,
            },
            timeout: vi.fn(() => ({ emitWithAck })),
        };
        const fetchSockets = vi.fn().mockResolvedValue([target]);
        const io = {
            in: vi.fn(() => ({
                timeout: vi.fn(() => ({ fetchSockets })),
                fetchSockets,
            })),
        } as unknown as Server;

        await expect(forwardRpcCall({
            io,
            targetUserId: 'user-1',
            method: `machine-1:${RPC_METHODS.CAPABILITIES_INVOKE}`,
            callParams: 'plain-request',
            callerSocket: {
                data: {
                    accountStoredContentCompatibility: currentCompatibility,
                },
            },
        })).resolves.toEqual({
            ok: true,
            result: 'plain-response',
        });
        expect(emitWithAck).toHaveBeenCalledTimes(1);
    });

    it('keeps retained E2EE Machine RPC available to legacy caller and daemon sockets', async () => {
        machineFindFirstMock.mockResolvedValue({
            dataEncryptionKey: new Uint8Array([0, 1, 2, 3]),
            revokedAt: null,
            replacedByMachineId: null,
        });
        const emitWithAck = vi.fn().mockResolvedValue('encrypted-response');
        const target = {
            id: 'legacy-daemon-socket',
            data: {
                clientType: 'machine-scoped',
                machineId: 'machine-1',
            },
            timeout: vi.fn(() => ({ emitWithAck })),
        };
        const fetchSockets = vi.fn().mockResolvedValue([target]);
        const io = {
            in: vi.fn(() => ({
                timeout: vi.fn(() => ({ fetchSockets })),
                fetchSockets,
            })),
        } as unknown as Server;

        await expect(forwardRpcCall({
            io,
            targetUserId: 'user-1',
            method: `machine-1:${RPC_METHODS.CAPABILITIES_INVOKE}`,
            callParams: 'encrypted-request',
            callerSocket: { data: {} },
        })).resolves.toEqual({
            ok: true,
            result: 'encrypted-response',
        });
        expect(emitWithAck).toHaveBeenCalledTimes(1);
    });

    it('unwraps a requested transport envelope while retaining the strict server acknowledgement', async () => {
        const emitWithAck = vi.fn().mockResolvedValue({
            v: 1,
            result: 'opaque-encrypted-stop-result',
            acknowledgement: {
                kind: 'session.stop',
                status: 'stopped',
            },
        });
        const target = {
            id: 'daemon-socket',
            data: {
                clientType: 'machine-scoped',
                machineId: 'machine-1',
            },
            timeout: vi.fn(() => ({ emitWithAck })),
        };
        const fetchSockets = vi.fn().mockResolvedValue([target]);
        const io = {
            in: vi.fn(() => ({
                timeout: vi.fn(() => ({ fetchSockets })),
                fetchSockets,
            })),
        } as unknown as Server;
        const method = `machine-1:${RPC_METHODS.STOP_SESSION}`;

        await expect(forwardRpcCall({
            io,
            targetUserId: 'user-1',
            method,
            callParams: 'opaque-encrypted-stop-request',
            transportResponseEnvelopeVersion: 1,
        })).resolves.toEqual({
            ok: true,
            result: 'opaque-encrypted-stop-result',
            transportAcknowledgement: {
                kind: 'session.stop',
                status: 'stopped',
            },
        });
        expect(emitWithAck).toHaveBeenCalledWith(
            SOCKET_RPC_EVENTS.REQUEST,
            expect.objectContaining({
                method,
                params: 'opaque-encrypted-stop-request',
                transportResponseEnvelopeVersion: 1,
            }),
        );
    });

    it('keeps an Agent realtime terminal watch pending beyond the generic RPC timeout and settles on terminal', async () => {
        vi.useFakeTimers();
        try {
            let resolveTerminal!: (value: unknown) => void;
            const terminalResponse = new Promise<unknown>((resolve) => {
                resolveTerminal = resolve;
            });
            const emitWithAck = vi.fn(() => terminalResponse);
            const timeout = vi.fn(() => ({
                emitWithAck,
            }));
            const target = {
                id: 'session-runner-socket',
                timeout,
            };
            const fetchSockets = vi.fn().mockResolvedValue([target]);
            const io = {
                in: vi.fn(() => ({
                    timeout: vi.fn(() => ({ fetchSockets })),
                    fetchSockets,
                })),
            } as unknown as Server;
            const method = `session-1:${SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_WATCH}`;

            let settled = false;
            const forwarded = forwardRpcCall({
                io,
                targetUserId: 'user-1',
                method,
                callParams: { applicationAttemptId: 'voice-attempt-1' },
            }).finally(() => {
                settled = true;
            });

            await vi.advanceTimersByTimeAsync(30_001);

            expect(settled).toBe(false);
            resolveTerminal({
                ok: true,
                status: 'terminal',
                event: { kind: 'terminal', reason: 'upstream_closed' },
            });
            await expect(forwarded).resolves.toEqual({
                ok: true,
                result: {
                    ok: true,
                    status: 'terminal',
                    event: { kind: 'terminal', reason: 'upstream_closed' },
                },
            });
            expect(timeout).toHaveBeenCalledWith(2_147_483_647);
            expect(emitWithAck).toHaveBeenCalledWith(
                SOCKET_RPC_EVENTS.REQUEST,
                {
                    method,
                    params: { applicationAttemptId: 'voice-attempt-1' },
                    timeoutMs: 2_147_483_647,
                },
            );
        } finally {
            vi.useRealTimers();
        }
    });

    it('keeps an external Action relay pending beyond the generic RPC timeout and returns the daemon response', async () => {
        vi.useFakeTimers();
        try {
            let resolveDaemonResponse!: (value: unknown) => void;
            const daemonResponse = {
                v: 1,
                actionId: 'session.wait.idle',
                requestId: 'external-request-1',
                execution: { ok: true, result: { status: 'idle' } },
            };
            const pendingDaemonResponse = new Promise<unknown>((resolve) => {
                resolveDaemonResponse = resolve;
            });
            const emitWithAck = vi.fn(() => pendingDaemonResponse);
            const timeout = vi.fn(() => ({ emitWithAck }));
            const target = {
                id: 'machine-daemon-socket',
                timeout,
            };
            const fetchSockets = vi.fn().mockResolvedValue([target]);
            const io = {
                in: vi.fn(() => ({
                    timeout: vi.fn(() => ({ fetchSockets })),
                    fetchSockets,
                })),
            } as unknown as Server;
            const method = `machine-1:${EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1}`;
            const callParams = {
                actionId: 'session.wait.idle',
                envelope: { v: 1, requestId: 'external-request-1', input: { opaque: true } },
            };

            let settled = false;
            const forwarded = forwardRpcCall({
                io,
                targetUserId: 'user-1',
                method,
                callParams,
            }).finally(() => {
                settled = true;
            });

            await vi.advanceTimersByTimeAsync(30_001);

            expect(settled).toBe(false);
            resolveDaemonResponse(daemonResponse);
            await expect(forwarded).resolves.toEqual({
                ok: true,
                result: daemonResponse,
            });
            expect(timeout).toHaveBeenCalledWith(2_147_483_647);
            expect(emitWithAck).toHaveBeenCalledWith(
                SOCKET_RPC_EVENTS.REQUEST,
                {
                    method,
                    params: callParams,
                    timeoutMs: 2_147_483_647,
                },
            );
        } finally {
            vi.useRealTimers();
        }
    });

    it('marks a timeout after target emission as a submitted-unknown settlement', async () => {
        const emitWithAck = vi.fn().mockRejectedValue(new Error('operation has timed out'));
        const onSubmittedUnknown = vi.fn();
        const target = {
            id: 'daemon-socket',
            timeout: vi.fn(() => ({ emitWithAck })),
        };
        const fetchSockets = vi.fn().mockResolvedValue([target]);
        const io = {
            in: vi.fn(() => ({
                timeout: vi.fn(() => ({ fetchSockets })),
                fetchSockets,
            })),
        } as unknown as Server;

        await expect(forwardRpcCall({
            io,
            targetUserId: 'user-1',
            method: 'agent.run',
            callParams: { request: 'opaque' },
            onSubmittedUnknown,
        })).resolves.toEqual({
            ok: false,
            error: 'operation has timed out',
        });
        expect(emitWithAck).toHaveBeenCalledTimes(1);
        expect(onSubmittedUnknown).toHaveBeenCalledTimes(1);
    });

    it('does not report submitted unknown when target setup fails before emission', async () => {
        const onSubmittedUnknown = vi.fn();
        const target = {
            id: 'daemon-socket',
            timeout: vi.fn(() => {
                throw new Error('target setup unavailable');
            }),
        };
        const fetchSockets = vi.fn().mockResolvedValue([target]);
        const io = {
            in: vi.fn(() => ({
                timeout: vi.fn(() => ({ fetchSockets })),
                fetchSockets,
            })),
        } as unknown as Server;

        await expect(forwardRpcCall({
            io,
            targetUserId: 'user-1',
            method: 'agent.run',
            callParams: { request: 'opaque' },
            onSubmittedUnknown,
        })).resolves.toEqual({
            ok: false,
            error: 'target setup unavailable',
        });
        expect(onSubmittedUnknown).not.toHaveBeenCalled();
    });

    it('marks a post-emission target revalidation loss as a submitted-unknown settlement', async () => {
        const emitWithAck = vi.fn().mockResolvedValue({ ok: true });
        const onSubmittedUnknown = vi.fn();
        const target = {
            id: 'daemon-socket',
            timeout: vi.fn(() => ({ emitWithAck })),
        };
        const fetchSockets = vi.fn().mockResolvedValue([target]);
        const io = {
            in: vi.fn(() => ({
                timeout: vi.fn(() => ({ fetchSockets })),
                fetchSockets,
            })),
        } as unknown as Server;

        await expect(forwardRpcCall({
            io,
            targetUserId: 'user-1',
            method: 'agent.run',
            callParams: { request: 'opaque' },
            onSubmittedUnknown,
            targetGuard: {
                filterTargets: async (targets) => targets,
                runOperation: async ({ operation }) => {
                    await operation();
                    return { status: 'unavailable' };
                },
            },
        })).resolves.toEqual({
            ok: false,
            error: 'RPC method not available',
            errorCode: 'RPC_METHOD_NOT_AVAILABLE',
        });
        expect(emitWithAck).toHaveBeenCalledTimes(1);
        expect(onSubmittedUnknown).toHaveBeenCalledTimes(1);
    });

});
