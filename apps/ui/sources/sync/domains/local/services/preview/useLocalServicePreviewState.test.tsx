import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LocalServicePreviewResourceV1 } from '@happier-dev/protocol';

import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';

import { selectLocalServicePreviewRows } from './store';
import {
    invalidateLocalServicePreviewStore,
    resetLocalServicePreviewStoreForTests,
} from './sharedStore';
import type { LocalServicePreviewSnapshotClient } from './useLocalServicePreviewState';

const testState = vi.hoisted(() => ({
    apiSocketRequest: vi.fn(),
    createSessionRequestWithServerScope: vi.fn(),
    machineRpcWithServerScope: vi.fn(),
    scopedRequest: vi.fn(),
}));

vi.mock('@/sync/api/session/apiSocket', () => ({
    apiSocket: {
        request: (...args: readonly unknown[]) => testState.apiSocketRequest(...args),
    },
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/createSessionRequestWithServerScope', () => ({
    createSessionRequestWithServerScope: (...args: readonly unknown[]) =>
        testState.createSessionRequestWithServerScope(...args),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: (...args: readonly unknown[]) => testState.machineRpcWithServerScope(...args),
}));

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
    afterEach(() => {
        vi.useRealTimers();
        resetLocalServicePreviewStoreForTests();
        testState.apiSocketRequest.mockReset();
        testState.createSessionRequestWithServerScope.mockReset();
        testState.machineRpcWithServerScope.mockReset();
        testState.scopedRequest.mockReset();
        standardCleanup();
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
        testState.machineRpcWithServerScope.mockResolvedValue({
            protocolVersion: 1,
            snapshot: {
                v: 1,
                machineId: 'machine_1',
                generatedAt: 1_000,
                refreshState: 'idle',
                resources: [],
                diagnostics: [],
            },
        });
        const { useLocalServicePreviewState } = await import('./useLocalServicePreviewState');

        const hook = await renderHook(() => useLocalServicePreviewState({
            machineId: 'machine_1',
            serverId: 'server_2',
            nowMs: () => 900,
        }));

        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(testState.machineRpcWithServerScope).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine_1',
            serverId: 'server_2',
            method: 'daemon.localServices.preview.snapshot',
            payload: { machineId: 'machine_1' },
        }));
        expect(testState.createSessionRequestWithServerScope).not.toHaveBeenCalled();
        expect(testState.scopedRequest).not.toHaveBeenCalled();
        expect(testState.apiSocketRequest).not.toHaveBeenCalled();
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
