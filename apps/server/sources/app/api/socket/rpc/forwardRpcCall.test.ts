import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import type { Server } from 'socket.io';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

function setRequiredDaemonFloor(version: string): void {
    vi.stubEnv('HAPPIER_SESSION_SYNC_COMPATIBILITY__ENFORCEMENT', 'required');
    vi.stubEnv('HAPPIER_SESSION_SYNC_COMPATIBILITY__MINIMUM_PROTOCOL_VERSION', '2');
    vi.stubEnv('HAPPIER_SESSION_SYNC_COMPATIBILITY__MINIMUM_VERSIONS_JSON', JSON.stringify({
        daemon: version,
        'session-runner': version,
    }));
}

describe('forwardRpcCall provider-host compatibility', () => {
    beforeEach(() => {
        machineFindFirstMock.mockReset().mockResolvedValue({
            revokedAt: null,
            replacedByMachineId: null,
        });
        setRequiredDaemonFloor('0.2.10');
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it.each([
        RPC_METHODS.SPAWN_HAPPY_SESSION,
        RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_CONSUME_RESET_CREDIT,
    ])('revalidates daemon compatibility immediately before forwarding provider-starting RPC %s', async (providerStartingMethod) => {
        const emitWithAck = vi.fn().mockResolvedValue({ type: 'success', sessionId: 'session-1' });
        const targetTimeout = vi.fn(() => ({ emitWithAck }));
        const target = {
            id: 'daemon-socket',
            data: {
                clientType: 'machine-scoped',
                machineId: 'machine-1',
                sessionSyncCompatibility: {
                    parseResult: {
                        status: 'valid',
                        declaration: {
                            v: 1,
                            clientKind: 'daemon',
                            appVersion: '0.2.10',
                            sessionSyncProtocolVersion: 2,
                        },
                    },
                },
            },
            timeout: targetTimeout,
        };
        const fetchSockets = vi.fn().mockResolvedValue([target]);
        const io = {
            in: vi.fn(() => ({
                timeout: vi.fn(() => ({ fetchSockets })),
                fetchSockets,
            })),
        } as unknown as Server;
        const method = `machine-1:${providerStartingMethod}`;

        await expect(forwardRpcCall({
            io,
            targetUserId: 'user-1',
            method,
            callParams: { directory: '/workspace' },
        })).resolves.toEqual({
            ok: true,
            result: { type: 'success', sessionId: 'session-1' },
        });
        expect(targetTimeout).toHaveBeenCalledTimes(1);

        targetTimeout.mockClear();
        emitWithAck.mockClear();
        setRequiredDaemonFloor('0.2.11');

        await expect(forwardRpcCall({
            io,
            targetUserId: 'user-1',
            method,
            callParams: { directory: '/workspace' },
        })).resolves.toEqual({
            ok: false,
            error: 'client-upgrade-required',
            requirement: expect.objectContaining({
                v: 1,
                clientKind: 'daemon',
                minimumAppVersion: '0.2.11',
                minimumSessionSyncProtocolVersion: 2,
            }),
        });
        expect(targetTimeout).not.toHaveBeenCalled();
        expect(emitWithAck).not.toHaveBeenCalled();
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

});
