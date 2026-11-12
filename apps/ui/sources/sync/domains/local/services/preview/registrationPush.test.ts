import { afterEach, expect, it, vi } from 'vitest';
import { LocalServiceLauncherSnapshotV1Schema } from '@happier-dev/protocol/local/services/launcher/v1';
import { DaemonLocalServicePreviewSnapshotResponseV1Schema } from '@happier-dev/protocol/local/services/preview/v1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { flushHookEffects } from '@/dev/testkit';

const rpc = vi.hoisted(() => ({ machine: vi.fn() }));
// Only the daemon transport is substituted; the real shared watch, launcher,
// preview snapshot reader and reducers compose beneath it.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedMachineRpcBoundaryMock(rpc.machine);
});
import { getLocalServicePreviewState, resetLocalServicePreviewStoreForTests, subscribeLocalServicePreviewStore } from './sharedStore';
import { resetLocalServiceLauncherStoreForTests, subscribeLocalServiceLauncherStore } from '../launch/sharedStore';
import { resetLocalServiceInventoryStoreForTests } from '../inventory/sharedStore';

afterEach(() => {
    resetLocalServiceLauncherStoreForTests();
    resetLocalServiceInventoryStoreForTests();
    resetLocalServicePreviewStoreForTests();
});

it.each([
    { launcherHadBinding: true, delivery: 'push' },
    { launcherHadBinding: false, delivery: 'push' },
    { launcherHadBinding: false, delivery: 'resume' },
])('refreshes revoked previews (launcher binding: $launcherHadBinding, delivery: $delivery)', async ({ launcherHadBinding, delivery }) => {
    let generation = 1_000;
    let registered = true;
    const watches: Array<(value: unknown) => void> = [];
    const browserTarget = { kind: 'localServicePreview' as const, targetId: 'preview-a', machineId: 'machine-a', sessionId: 'session-a' };
    const launcherSnapshot = () => LocalServiceLauncherSnapshotV1Schema.parse({ v: 1, machineId: 'machine-a',
        sessionId: 'session-a', updatedAt: generation, targets: [{ id: 'managed:preview', source: 'managed_service',
            sourceClass: { kind: 'managed_service', managedServiceId: 'preview' }, machineId: 'machine-a', sessionId: 'session-a',
            title: 'Preview', confidence: 'medium', state: 'available', serviceState: 'running', actions: ['start'],
            ...(registered && launcherHadBinding ? { browserTarget } : {}) }] });
    let previewReads = 0;
    rpc.machine.mockImplementation(async (request: { method: string; payload?: { observationOnly?: true } }) => {
        // The mounted Machine subscription also holds one observation-only request (363303bc81).
        if (request.payload?.observationOnly) return new Promise(() => {});
        if (request.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH) return await new Promise(resolve => watches.push(resolve));
        // Automatic demand reads the daemon's current snapshot; only an explicit refresh forces a rescan.
        if (request.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_SNAPSHOT
            || request.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_REFRESH) return { protocolVersion: 1,
            snapshot: { v: 1, machineId: 'machine-a', generatedAt: generation, refreshState: 'idle', entries: [], diagnostics: [] } };
        if (request.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_PREVIEW_SNAPSHOT) {
            previewReads++;
            const resource = { previewId: 'preview-a', machineId: 'machine-a', sessionId: 'session-a',
                owner: { kind: 'session', id: 'session-a' }, target: { scheme: 'http', host: '127.0.0.1', port: 5173 },
                initialPath: { pathname: '/', search: '' }, display: { title: 'App', addressLabel: 'localhost:5173' }, originMode: 'host', browserTarget };
            return DaemonLocalServicePreviewSnapshotResponseV1Schema.parse({ protocolVersion: 1,
                snapshot: { v: 1, machineId: 'machine-a', generatedAt: generation, refreshState: 'idle', diagnostics: [],
                    resources: registered ? [resource] : [], previews: registered ? [{ previewId: resource.previewId,
                        resource, accessUrl: null, expiresAt: null, diagnostics: [] }] : [] } });
        }
        return { protocolVersion: 1, snapshot: launcherSnapshot() };
    });
    const key = { machineId: 'machine-a', serverId: 'server-a', sessionId: 'session-a' };
    let releaseA = subscribeLocalServiceLauncherStore(key, () => {});
    let releaseB = subscribeLocalServiceLauncherStore(key, () => {});
    await vi.waitFor(() => expect(watches).toHaveLength(1));
    const releasePreview = subscribeLocalServicePreviewStore(key, () => {});
    try {
        await vi.waitFor(() => expect(getLocalServicePreviewState(key).previewIds).toEqual(['preview-a']));
        await vi.waitFor(() => expect(watches).toHaveLength(1));
        await flushHookEffects();
        expect(previewReads).toBe(1);
        if (delivery === 'resume') { releaseA(); releaseB(); }
        registered = false;
        generation = 2_000;
        if (delivery === 'resume') {
            releaseA = subscribeLocalServiceLauncherStore(key, () => {});
            releaseB = subscribeLocalServiceLauncherStore(key, () => {});
        } else {
            watches[0]!({ protocolVersion: 1, changed: true, snapshot: launcherSnapshot() });
        }
        await vi.waitFor(() => expect(getLocalServicePreviewState(key).previewIds).toEqual([]));
        expect(previewReads).toBe(2);
    } finally { releaseA(); releaseB(); releasePreview(); }
});
