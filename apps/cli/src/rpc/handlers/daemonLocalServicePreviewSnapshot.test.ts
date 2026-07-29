import { describe, expect, it } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { LocalServicePreviewSnapshotV1 } from '@happier-dev/protocol';
import type { RpcHandlerRegistrar } from '@/api/rpc/types';

import {
    isDaemonLocalServicePreviewLifecycleError,
    registerDaemonLocalServicePreviewSnapshotHandler,
} from './daemonLocalServicePreviewSnapshot';
import { createLocalServicePreviewRoutes } from '@/daemon/local/services/preview/routes';
import { createLocalServicePreviewRegistry } from '@/daemon/local/services/preview/registry';
import { createLocalServiceInventoryRegistry } from '@/daemon/local/services/inventory/registry';
import type { NormalizedLocalServiceInventoryEntry } from '@/daemon/local/services/inventory/scanner';

function createRegistrar(): { handlers: Map<string, (payload: unknown) => Promise<unknown>>; registrar: RpcHandlerRegistrar } {
    const handlers = new Map<string, (payload: unknown) => Promise<unknown>>();
    return {
        handlers,
        registrar: {
            registerHandler(method, handler) {
                handlers.set(method, handler as (payload: unknown) => Promise<unknown>);
            },
        },
    };
}

const LIFECYCLE_MACHINE_ID = 'machine_lifecycle';

function lifecycleInventoryEntry(): NormalizedLocalServiceInventoryEntry {
    return {
        id: 'entry-vite',
        machineId: LIFECYCLE_MACHINE_ID,
        address: { kind: 'loopback', host: '127.0.0.1', family: 'ipv4' },
        endpoint: {
            scheme: 'http',
            host: '127.0.0.1',
            port: 5173,
            probeState: 'ready',
            probedAt: 2_000,
        },
        port: 5173,
        protocol: 'tcp',
        detectedAt: 1_000,
        lastSeenAt: 2_000,
        state: 'listening',
        source: 'detected',
        labels: [],
        confidence: 'high',
        processOwnershipConfidence: 'high',
        workspaceAssociationConfidence: 'high',
        diagnostics: [],
        presentation: { addressLabel: 'localhost:5173', displayName: 'Vite' },
    };
}

function createLifecycleRoutes() {
    const inventoryRegistry = createLocalServiceInventoryRegistry();
    inventoryRegistry.replaceSnapshot({
        v: 1,
        machineId: LIFECYCLE_MACHINE_ID,
        generatedAt: 1_000,
        refreshState: 'idle',
        entries: [lifecycleInventoryEntry()],
        diagnostics: [],
    });
    return createLocalServicePreviewRoutes({
        machineId: LIFECYCLE_MACHINE_ID,
        registry: createLocalServicePreviewRegistry(),
        inventoryRegistry,
        now: () => 1_000,
    });
}

describe('daemon local service preview snapshot rpc handler', () => {
    it('serves the daemon-owned local preview snapshot over machine rpc', async () => {
        const module = await import('./daemonLocalServicePreviewSnapshot').catch(() => null);

        expect(module?.registerDaemonLocalServicePreviewSnapshotHandler).toBeTypeOf('function');
        if (!module?.registerDaemonLocalServicePreviewSnapshotHandler) return;

        const snapshot: LocalServicePreviewSnapshotV1 = {
            v: 1,
            machineId: 'machine_1',
            generatedAt: 1_000,
            refreshState: 'idle',
            resources: [],
            diagnostics: [],
        };
        const { handlers, registrar } = createRegistrar();
        module.registerDaemonLocalServicePreviewSnapshotHandler(registrar, {
            localServicesPreview: {
                getSnapshot: async () => snapshot,
            },
        });

        const method = (RPC_METHODS as Record<string, string>).DAEMON_LOCAL_SERVICES_PREVIEW_SNAPSHOT;
        expect(method).toBe('daemon.localServices.preview.snapshot');
        await expect(handlers.get(method)?.({ machineId: 'machine_1' })).resolves.toEqual({
            protocolVersion: 1,
            snapshot,
        });
    });

    it('registers openOrCreate + revoke lifecycle handlers when the route owner exposes them', () => {
        const { handlers, registrar } = createRegistrar();
        registerDaemonLocalServicePreviewSnapshotHandler(registrar, {
            localServicesPreview: createLifecycleRoutes(),
        });

        expect(handlers.has(RPC_METHODS.DAEMON_LOCAL_SERVICES_PREVIEW_OPEN_OR_CREATE)).toBe(true);
        expect(handlers.has(RPC_METHODS.DAEMON_LOCAL_SERVICES_PREVIEW_REVOKE)).toBe(true);
    });

    it('does not register lifecycle handlers for a read-only (snapshot-only) route owner', () => {
        const { handlers, registrar } = createRegistrar();
        registerDaemonLocalServicePreviewSnapshotHandler(registrar, {
            localServicesPreview: {
                getSnapshot: async () => ({
                    v: 1,
                    machineId: 'machine_1',
                    generatedAt: 1_000,
                    refreshState: 'idle',
                    resources: [],
                    diagnostics: [],
                }),
            },
        });

        expect(handlers.has(RPC_METHODS.DAEMON_LOCAL_SERVICES_PREVIEW_OPEN_OR_CREATE)).toBe(false);
        expect(handlers.has(RPC_METHODS.DAEMON_LOCAL_SERVICES_PREVIEW_REVOKE)).toBe(false);
    });

    it('openOrCreate dispatches to the daemon route and returns the BrowserViewTarget-bearing snapshot row', async () => {
        const { handlers, registrar } = createRegistrar();
        registerDaemonLocalServicePreviewSnapshotHandler(registrar, {
            localServicesPreview: createLifecycleRoutes(),
        });

        const response = await handlers.get(RPC_METHODS.DAEMON_LOCAL_SERVICES_PREVIEW_OPEN_OR_CREATE)?.({
            machineId: LIFECYCLE_MACHINE_ID,
            sessionId: 'session-1',
            inventoryEntryId: 'entry-vite',
        }) as Record<string, unknown>;

        expect(response.status).toBe('created');
        expect(response.protocolVersion).toBe(1);
        const preview = response.preview as Record<string, unknown>;
        expect(preview.accessUrl).toBe('http://127.0.0.1:5173/');
    });

    it('revoke dispatches to the daemon route and reports the refreshed snapshot', async () => {
        const { handlers, registrar } = createRegistrar();
        const routes = createLifecycleRoutes();
        registerDaemonLocalServicePreviewSnapshotHandler(registrar, {
            localServicesPreview: routes,
        });
        const created = await routes.openOrCreate({
            machineId: LIFECYCLE_MACHINE_ID,
            inventoryEntryId: 'entry-vite',
        });
        expect(created.ok).toBe(true);
        if (!created.ok) return;

        const response = await handlers.get(RPC_METHODS.DAEMON_LOCAL_SERVICES_PREVIEW_REVOKE)?.({
            machineId: LIFECYCLE_MACHINE_ID,
            previewId: created.response.preview.previewId,
        }) as Record<string, unknown>;

        expect(response.revoked).toBe(true);
        expect((response.snapshot as Record<string, unknown>).previews).toHaveLength(0);
    });

    it('maps a daemon route refusal to a lifecycle error carrying the reason code', async () => {
        const { handlers, registrar } = createRegistrar();
        registerDaemonLocalServicePreviewSnapshotHandler(registrar, {
            localServicesPreview: createLifecycleRoutes(),
        });

        const dispatch = handlers.get(RPC_METHODS.DAEMON_LOCAL_SERVICES_PREVIEW_OPEN_OR_CREATE);
        await expect(dispatch?.({
            machineId: 'a-different-machine',
            inventoryEntryId: 'entry-vite',
        })).rejects.toSatisfy((error: unknown) => (
            isDaemonLocalServicePreviewLifecycleError(error)
            && error.reasonCode === 'wrong_machine'
        ));
    });
});
