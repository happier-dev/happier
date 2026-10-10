import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DaemonLocalServicePreviewSnapshotResponseV1, LocalServicePreviewResourceV1 } from '@happier-dev/protocol';

import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';

import { selectLocalServicePreviewRows } from './store';
import {
    invalidateLocalServicePreviewStore,
    resetLocalServicePreviewStoreForTests,
} from './sharedStore';
import type { LocalServicePreviewSnapshotClient } from './useLocalServicePreviewState';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { createAccountTokenForTests, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol';

const daemonBoundary = vi.hoisted(() => ({ requests: [] as Array<{
    serverUrl: string; token: string | undefined; method: string; params: unknown;
}>, response: undefined as unknown }));

// Socket.IO is the external daemon boundary; the scoped RPC owner and codec remain real.
vi.mock('socket.io-client', async (importOriginal) => {
    const actual = await importOriginal<typeof import('socket.io-client')>();
    const { createSocketIoBoundaryStub } = await import('@/dev/testkit/mocks/socketIo');
    const { SOCKET_RPC_EVENTS } = await import('@happier-dev/protocol/socketRpc');
    return { ...actual, io: (serverUrl: string, options: { auth?: { token?: string } }) => {
        const { socket } = createSocketIoBoundaryStub();
        socket.emitWithAck.mockImplementation(async (event, payload) => {
            if (event !== SOCKET_RPC_EVENTS.CALL) return { v: 1, ok: true, admittedSessionIds: [] };
            if (!payload || typeof payload !== 'object' || !('method' in payload)
                || typeof payload.method !== 'string' || !('params' in payload)) {
                throw new Error('Malformed daemon RPC request');
            }
            daemonBoundary.requests.push({ serverUrl, token: options.auth?.token,
                method: payload.method, params: payload.params });
            return { ok: true, result: daemonBoundary.response };
        });
        return socket;
    } };
});

function createPreviewResource(overrides: Partial<LocalServicePreviewResourceV1> = {}): LocalServicePreviewResourceV1 {
    return {
        previewId: 'preview_1',
        sessionId: 'session_1',
        machineId: 'machine_1',
        owner: { kind: 'session', id: 'session_1' },
        target: { scheme: 'http', host: '127.0.0.1', port: 5173 },
        initialPath: { pathname: '/dashboard', search: '?tab=preview' },
        display: {
            title: 'Dashboard',
            addressLabel: 'localhost:5173',
        },
        originMode: 'host',
        browserTarget: {
            kind: 'localServicePreview',
            targetId: 'preview_1',
            sessionId: 'session_1',
            machineId: 'machine_1',
            display: {
                title: 'Dashboard',
                addressLabel: 'localhost:5173',
            },
        },
        ...overrides,
    };
}

describe('useLocalServicePreviewState', () => {
    afterEach(async () => {
        vi.useRealTimers();
        resetLocalServicePreviewStoreForTests();
        resetRuntimeFetch();
        daemonBoundary.requests.length = 0;
        vi.restoreAllMocks();
        standardCleanup();
        const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
        const { resetScopedMachineTransportCacheForTests } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool');
        serverScopedRpcSocketPool.resetForTests();
        resetScopedMachineTransportCacheForTests();
    });

    it('loads preview snapshots from the canonical snapshot client', async () => {
        const snapshotClient: LocalServicePreviewSnapshotClient = vi.fn(async () => ({
            ok: true as const,
            snapshot: {
                generatedAt: 1_000,
                refreshState: 'idle' as const,
                previews: [{
                    previewId: 'preview_1',
                    resource: createPreviewResource(),
                    accessUrl: 'https://preview.happier.test/v1/local-services/preview/preview_1/',
                    expiresAt: 2_000,
                    diagnostics: [],
                }],
                diagnostics: [],
            },
        }));
        const { useLocalServicePreviewState } = await import('./useLocalServicePreviewState');

        const hook = await renderHook(() => useLocalServicePreviewState({
            machineId: 'machine_1',
            snapshotClient,
            nowMs: () => 900,
        }));

        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(snapshotClient).toHaveBeenCalledWith(expect.objectContaining({ machineId: 'machine_1' }));
        expect(selectLocalServicePreviewRows(hook.getCurrent())).toEqual([
            expect.objectContaining({
                previewId: 'preview_1',
                accessUrl: 'https://preview.happier.test/v1/local-services/preview/preview_1/',
                expiresAt: 2_000,
            }),
        ]);
        expect(hook.getCurrent().refreshState).toBe('idle');
    });

    it('routes the default snapshot request through daemon machine rpc', async () => {
        await loadSyncSingletonForTests();
        const home = await upsertServerProfile({ serverUrl: 'https://preview-background.example.test' });
        const token = createAccountTokenForTests('preview-account');
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockImplementation(async (serverUrl) => (
            serverUrl === home.serverUrl ? { token } : null
        ));
        setRuntimeFetch(async (input) => {
            const url = new URL(String(input));
            if (url.origin !== home.serverUrl) throw new Error(`Unexpected preview Home: ${url.origin}`);
            if (url.pathname === '/v1/auth/ping') return Response.json({});
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            if (url.pathname === '/v1/machines/machine_1') return Response.json({ machine: {
                id: 'machine_1', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
            } });
            return Response.json({}, { status: 404 });
        });
        daemonBoundary.response = {
            protocolVersion: 1,
            snapshot: {
                v: 1,
                machineId: 'machine_1',
                generatedAt: 1_000,
                refreshState: 'idle',
                resources: [],
                previews: [],
                diagnostics: [],
            },
        } satisfies DaemonLocalServicePreviewSnapshotResponseV1;
        const { useLocalServicePreviewState } = await import('./useLocalServicePreviewState');

        const hook = await renderHook(() => useLocalServicePreviewState({
            machineId: 'machine_1',
            serverId: home.id,
            nowMs: () => 900,
        }));

        await flushHookEffects({ cycles: 2, turns: 2 });

        await act(async () => {
            await waitForHomeGovernance(() => expect(daemonBoundary.requests).not.toEqual([]));
        });
        expect(daemonBoundary.requests).toEqual([{ serverUrl: home.serverUrl, token,
            method: 'machine_1:daemon.localServices.preview.snapshot', params: { machineId: 'machine_1' } }]);
        expect(hook.getCurrent().refreshState).toBe('idle');
    });

    it('fails closed when the snapshot route is unavailable', async () => {
        const snapshotClient: LocalServicePreviewSnapshotClient = vi.fn(async () => ({
            ok: false as const,
            reason: 'unavailable' as const,
        }));
        const { useLocalServicePreviewState } = await import('./useLocalServicePreviewState');

        const hook = await renderHook(() => useLocalServicePreviewState({
            machineId: 'machine_1',
            snapshotClient,
            nowMs: () => 1_000,
        }));

        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(selectLocalServicePreviewRows(hook.getCurrent())).toEqual([]);
        expect(hook.getCurrent().refreshState).toBe('error');
    });

    it('preserves the last-known-good previews when an invalidation refresh fails', async () => {
        // PRV-4: refreshes are invalidation-driven, not on a 15s wall-clock interval. A failed
        // re-fetch keeps the already-hydrated previews (UX continuity) and reports `error`.
        const snapshotClient: LocalServicePreviewSnapshotClient = vi.fn()
            .mockResolvedValueOnce({
                ok: true as const,
                snapshot: {
                    generatedAt: 1_000,
                    refreshState: 'idle' as const,
                    previews: [{
                        previewId: 'preview_1',
                        resource: createPreviewResource(),
                        accessUrl: 'https://preview.happier.test/v1/local-services/preview/preview_1/',
                        expiresAt: 2_000,
                        diagnostics: [],
                    }],
                    diagnostics: [],
                },
            })
            .mockResolvedValueOnce({
                ok: false as const,
                reason: 'unavailable' as const,
            });
        const { useLocalServicePreviewState } = await import('./useLocalServicePreviewState');

        const hook = await renderHook(() => useLocalServicePreviewState({
            machineId: 'machine_1',
            snapshotClient,
            nowMs: () => 1_500,
        }));

        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(snapshotClient).toHaveBeenCalledTimes(1);
        expect(selectLocalServicePreviewRows(hook.getCurrent())).toHaveLength(1);

        await act(async () => {
            invalidateLocalServicePreviewStore({ machineId: 'machine_1' });
        });
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(snapshotClient).toHaveBeenCalledTimes(2);
        expect(selectLocalServicePreviewRows(hook.getCurrent())).toEqual([
            expect.objectContaining({ previewId: 'preview_1' }),
        ]);
        expect(hook.getCurrent().refreshState).toBe('error');
    });
});
