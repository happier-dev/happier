import { afterEach, describe, expect, it, vi } from 'vitest';
import { DirectRouteGrantRequestV2Schema, FeaturesResponseSchema, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';

import type { IModal } from '@/modal';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createSocketIoBoundaryStub } from '@/dev/testkit/mocks/socketIo';
import { primeServerFeaturesSnapshot, resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { storage } from '@/sync/domains/state/storage';
import { resetScopedMachineTransportCacheForTests } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool';
import { serverScopedRpcSocketPool } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';

type ModalShowInput = Parameters<IModal['show']>[0];
const modalShowBoundary = vi.hoisted(() => vi.fn<(input: ModalShowInput) => string>());
const ioBoundary = vi.hoisted(() => vi.fn());
const SERVER_URL = 'https://workspace-recovery.example.test';
const TOKEN = `hdr.${btoa(JSON.stringify({ sub: 'workspace-account' }))}.sig`;
const originalMachineState = {
    machines: storage.getState().machines,
    machineListByServerId: storage.getState().machineListByServerId,
};
let serverId: string;

function requireModalProps(input: ModalShowInput | undefined): NonNullable<ModalShowInput['props']> {
    if (!input?.props) {
        throw new Error('Expected workspace finalize recovery modal props');
    }
    return input.props;
}

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: { show: modalShowBoundary },
    }).module;
});

// Socket.IO is the network edge; guarded RPC policy and scope selection stay real.
vi.mock('socket.io-client', () => ({ io: (...args: unknown[]) => ioBoundary(...args) }));

afterEach(async () => {
    await serverScopedRpcSocketPool.stopAll();
    serverScopedRpcSocketPool.resetForTests();
    resetScopedMachineTransportCacheForTests();
    resetServerFeaturesClientForTests();
    await TokenStorage.removeCredentialsForServerUrl(SERVER_URL, { serverId });
    storage.setState(originalMachineState);
    delete process.env.EXPO_PUBLIC_HAPPIER_SESSION_FILE_INLINE_MAX_BYTES;
    modalShowBoundary.mockReset();
    ioBoundary.mockReset();
    resetRuntimeFetch();
    vi.unstubAllGlobals();
});

describe('workspaceWriteFile finalize recovery composition', () => {
    it('waits for explicit same-session retries and re-presents an indeterminate finalize until terminal success', async () => {
        process.env.EXPO_PUBLIC_HAPPIER_SESSION_FILE_INLINE_MAX_BYTES = '4';
        modalShowBoundary.mockReturnValue('recovery-modal');
        const expiresAt = Date.now() + 60_000;
        const secureValues = new Map<string, string>();
        // The desktop command bridge is the native boundary. Its real lifecycle
        // adapter still validates and owns every acquired/released carrier.
        vi.stubGlobal('__TAURI_INTERNALS__', {
            invoke: async (command: string, args?: Record<string, unknown>) => {
                if (command === 'desktop_secure_storage_read') return secureValues.get(String(args?.key)) ?? null;
                if (command === 'desktop_secure_storage_write') { secureValues.set(String(args?.key), String(args?.value)); return null; }
                if (command === 'desktop_secure_storage_remove') { secureValues.delete(String(args?.key)); return null; }
                if (command === 'iroh_get_availability') return { available: true };
                if (command === 'iroh_get_application_endpoint') return { endpointId: 'b'.repeat(64) };
                if (command === 'iroh_start_machine_tunnel') return { leaseId: 'workspace-carrier', localPort: 46001 };
                if (command === 'iroh_stop_machine_tunnel') return null;
                throw new Error(`Unexpected native command: ${command}`);
            },
        });
        serverId = (await upsertServerProfile({ serverUrl: SERVER_URL })).id;
        expect(await TokenStorage.setCredentialsForServerUrl(SERVER_URL, { serverId }, { token: TOKEN })).toBe(true);
        const machine = createMachineFixture({
            operationProtocolCapabilities: {
                irohMachineEndpoint: {
                    protocolVersions: [1], endpointId: 'a'.repeat(64),
                    relayUrls: ['https://relay.example.test'], directAddresses: ['127.0.0.1:48123'],
                },
            },
            operationProtocolCapabilitiesRevision: 1,
            daemonState: {
                transfer: {
                    supported: { import: true, export: true },
                    listenerClasses: {
                        loopback_http: { enabled: false, configured: false, active: false },
                        tailscale_serve_https: { enabled: false, configured: false, active: false },
                    },
                    lifecycle: { mode: 'lazy_idle_shutdown', version: 1 },
                },
            },
        });
        storage.setState((state) => ({
            machines: { ...state.machines, [machine.id]: machine },
            machineListByServerId: { ...state.machineListByServerId, [serverId]: [machine] },
        }));
        primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features: FeaturesResponseSchema.parse({
            features: { machines: { enabled: true, transfer: { enabled: true, directPeer: { enabled: true } }, peerMediation: { enabled: true } } },
            capabilities: {},
        }) } });
        const socket = createSocketIoBoundaryStub();
        const defaultAck = socket.socket.emitWithAck.getMockImplementation()!;
        const prepareRequests: unknown[] = [];
        socket.socket.emitWithAck.mockImplementation(async (event, payload) => {
            if (event !== SOCKET_RPC_EVENTS.CALL) return await defaultAck(event, payload);
            if (!payload || typeof payload !== 'object' || !('method' in payload) || payload.method !== `machine-1:${RPC_METHODS.DAEMON_DIRECT_TRANSFER_IMPORT_PREPARE}`) {
                throw new Error('Unexpected machine RPC request');
            }
            prepareRequests.push(payload);
            return { ok: true, result: {
                success: true,
                uploadId: 'upload-composed-recovery',
                destDisplayPath: '/repo/large.txt',
                expectedSizeBytes: 5,
                chunkSizeBytes: 5,
                recipientPublicKeyBase64: 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=',
                expiresAt,
                endpointCandidates: [{
                    kind: 'http',
                    url: 'http://127.0.0.1:46001/machine-transfers/direct/imports/upload-composed-recovery',
                    expiresAt,
                }],
            } };
        });
        ioBoundary.mockReturnValue(socket.socket);

        const requests: Array<Readonly<{ method: string; url: string }>> = [];
        let finalizeRequestCount = 0;
        setRuntimeFetch(async (input, init) => {
            const url = input instanceof URL ? input.toString() : String(input);
            const method = String(init?.method ?? 'GET');
            const parsed = new URL(url);
            if (parsed.pathname === '/v1/auth/ping') return new Response('{"ok":true}', { status: 200 });
            if (parsed.pathname === '/v1/machines/machine-1') return new Response(JSON.stringify({
                machine: { id: 'machine-1', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER },
            }), { status: 200, headers: { 'Content-Type': 'application/json' } });
            if (parsed.pathname === '/v1/machines/peer/mediation/route-grants') {
                const request = DirectRouteGrantRequestV2Schema.parse(JSON.parse(String(init?.body)));
                return new Response(JSON.stringify({ ok: true, grant: {
                    payload: {
                        v: 2, grantId: 'workspace-grant', accountId: 'workspace-account', machineId: request.machineId,
                        flowKind: request.flowKind, routeKind: request.routeKind, scope: request.scope,
                        iat: Date.now(), exp: expiresAt, aud: 'happier-daemon-route-grant',
                        endpointFingerprint: request.endpointFingerprint, proofKind: 'ephemeral_ed25519',
                        ephemeralPublicKeyBase64Url: request.ephemeralPublicKeyBase64Url, iroh: request.iroh,
                    },
                    signature: { keyId: 'key-1', alg: 'Ed25519', valueBase64Url: Buffer.from(new Uint8Array(64).fill(4)).toString('base64url') },
                } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
            }
            requests.push({ method, url });

            if (method === 'PUT' && url.endsWith('/chunks/0')) {
                return new Response(JSON.stringify({ success: true }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                });
            }
            if (method !== 'POST' || !url.endsWith('/finalize')) {
                throw new Error(`unexpected HTTP request: ${method} ${url}`);
            }

            finalizeRequestCount += 1;
            if (finalizeRequestCount === 1) {
                return new Response(JSON.stringify({
                    success: false,
                    error: 'Destination rollback is still incomplete',
                    errorCode: 'TRANSFER_FINALIZE_RECOVERY_REQUIRED',
                    keepSession: true,
                }), {
                    status: 500,
                    headers: {
                        'content-type': 'application/json',
                        'x-happier-transfer-session-expires-at': String(expiresAt),
                    },
                });
            }
            if (finalizeRequestCount === 2) {
                return new Response(null, { status: 502 });
            }
            if (finalizeRequestCount === 3) {
                return new Response(JSON.stringify({
                    success: true,
                    finalized: {
                        success: true,
                        path: '/repo/large.txt',
                        sizeBytes: 5,
                    },
                    sha256: 'sha256:recovered',
                }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                });
            }
            throw new Error('unexpected automatic finalize retry');
        });

        const { workspaceWriteFile } = await import('./fileReadWrite');
        const result = workspaceWriteFile(
            { machineId: 'machine-1', rootPath: '/repo', serverId },
            'large.txt',
            'hello',
        );

        await vi.waitFor(() => expect(modalShowBoundary).toHaveBeenCalledTimes(1));
        expect(finalizeRequestCount).toBe(1);
        expect(prepareRequests).toHaveLength(1);
        expect(requests.filter(({ method }) => method === 'PUT')).toHaveLength(1);

        const firstModal = modalShowBoundary.mock.calls[0]?.[0];
        requireModalProps(firstModal).onResolve('retry_finalize');
        await vi.waitFor(() => expect(modalShowBoundary).toHaveBeenCalledTimes(2));

        expect(finalizeRequestCount).toBe(2);
        expect(prepareRequests).toHaveLength(1);
        expect(requests.filter(({ method }) => method === 'PUT')).toHaveLength(1);

        await Promise.resolve();
        expect(finalizeRequestCount).toBe(2);

        const secondModal = modalShowBoundary.mock.calls[1]?.[0];
        requireModalProps(secondModal).onResolve('retry_finalize');

        await expect(result).resolves.toEqual({ success: true, hash: 'sha256:recovered' });
        expect(finalizeRequestCount).toBe(3);
        expect(modalShowBoundary).toHaveBeenCalledTimes(2);
        expect(prepareRequests).toHaveLength(1);
        expect(requests).toEqual([
            {
                method: 'PUT',
                url: 'http://127.0.0.1:46001/machine-transfers/direct/imports/upload-composed-recovery/chunks/0',
            },
            {
                method: 'POST',
                url: 'http://127.0.0.1:46001/machine-transfers/direct/imports/upload-composed-recovery/finalize',
            },
            {
                method: 'POST',
                url: 'http://127.0.0.1:46001/machine-transfers/direct/imports/upload-composed-recovery/finalize',
            },
            {
                method: 'POST',
                url: 'http://127.0.0.1:46001/machine-transfers/direct/imports/upload-composed-recovery/finalize',
            },
        ]);

        requireModalProps(secondModal).onResolve('retry_finalize');
        await Promise.resolve();
        expect(finalizeRequestCount).toBe(3);
        expect(modalShowBoundary).toHaveBeenCalledTimes(2);
    });
});
