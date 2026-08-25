import { describe, expect, it, vi } from 'vitest';

import type {
    DaemonLocalServiceLauncherStartResponseV1,
    LocalServiceActionResultV1,
    LocalServiceLauncherSnapshotV1,
    LocalServicePublicExposureV1,
    LocalServicePublicPreviewSnapshotV1,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import type { NormalizedLocalServiceInventorySnapshot } from '@/daemon/local/services/inventory/scanner';

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

const inventorySnapshot: NormalizedLocalServiceInventorySnapshot = {
    v: 1,
    machineId: 'machine_1',
    generatedAt: 1_000,
    refreshState: 'idle',
    entries: [],
    diagnostics: [],
};

const launcherSnapshot: LocalServiceLauncherSnapshotV1 = {
    v: 1,
    machineId: 'machine_1',
    sessionId: 'session_1',
    updatedAt: 2_000,
    targets: [],
};

const actionResult: LocalServiceActionResultV1 = {
    v: 1,
    requestId: 'request_1',
    action: 'copy_url',
    status: 'succeeded',
    auditEvents: [{
        v: 1,
        eventId: 'request_1:0:succeeded',
        requestId: 'request_1',
        machineId: 'machine_1',
        action: 'copy_url',
        result: 'succeeded',
        recordedAt: 3_000,
    }],
};

const launcherStartResponse: DaemonLocalServiceLauncherStartResponseV1 = {
    protocolVersion: 1,
    machineId: 'machine_1',
    targetId: 'preview:web',
    status: 'denied',
    reasonCode: 'launcher_start_unsupported',
    snapshot: launcherSnapshot,
};

const publicExposure: LocalServicePublicExposureV1 = {
    exposureId: 'public_preview_1',
    previewId: 'preview_1',
    sessionId: 'session_1',
    machineId: 'machine_1',
    mode: 'secret_link',
    state: 'active',
    publicUrl: 'https://preview.example.test/s/public_preview_1',
    issuedAt: 1_000,
    expiresAt: 601_000,
    auditEventIds: ['audit_1'],
    rateLimitProfileId: 'default',
};

const publicPreviewSnapshot: LocalServicePublicPreviewSnapshotV1 = {
    v: 1,
    machineId: 'machine_1',
    sessionId: 'session_1',
    previewId: 'preview_1',
    generatedAt: 3_000,
    refreshState: 'idle',
    policy: {
        enabled: true,
        allowedModes: ['secret_link'],
        maxTtlMs: 600_000,
        maxConcurrentExposures: 1,
        dnsTlsRequired: true,
        auditRequired: true,
        rateLimitProfileIds: ['default'],
    },
    exposures: [publicExposure],
    diagnostics: [],
};

describe('daemon local services machine rpc handlers', () => {
    it('serves inventory, launcher, and action routes through one daemon-owned registration point', async () => {
        const module = await import('./daemonLocalServices').catch(() => null);

        expect(module?.registerDaemonLocalServicesMachineRpcHandlers).toBeTypeOf('function');
        if (!module?.registerDaemonLocalServicesMachineRpcHandlers) return;

        const inventoryRoutes = {
            getSnapshot: vi.fn(async () => inventorySnapshot),
            refreshSnapshot: vi.fn(async () => ({ ...inventorySnapshot, generatedAt: 1_500 })),
        };
        const launcherRoutes = {
            getSnapshot: vi.fn(async () => launcherSnapshot),
            startTarget: vi.fn(async () => launcherStartResponse),
        };
        const actionRoutes = {
            execute: vi.fn(async () => actionResult),
        };
        const { handlers, registrar } = createRegistrar();

        module.registerDaemonLocalServicesMachineRpcHandlers(registrar, {
            localServicesInventory: inventoryRoutes,
            localServicesLauncher: launcherRoutes,
            localServicesActions: actionRoutes,
        });

        expect([...handlers.keys()].sort()).toEqual([
            RPC_METHODS.DAEMON_LOCAL_SERVICES_ACTIONS_EXECUTE,
            RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_REFRESH,
            RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_SNAPSHOT,
            RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_SNAPSHOT,
            RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_START,
        ].sort());
        await expect(handlers.get(RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_SNAPSHOT)?.({
            machineId: 'machine_1',
        })).resolves.toEqual({
            protocolVersion: 1,
            snapshot: inventorySnapshot,
        });
        expect(inventoryRoutes.getSnapshot).toHaveBeenCalledOnce();

        await expect(handlers.get(RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_REFRESH)?.({
            machineId: 'machine_1',
        })).resolves.toEqual({
            protocolVersion: 1,
            snapshot: { ...inventorySnapshot, generatedAt: 1_500 },
        });
        expect(inventoryRoutes.refreshSnapshot).toHaveBeenCalledOnce();

        await expect(handlers.get(RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_SNAPSHOT)?.({
            machineId: 'machine_1',
            sessionId: 'session_1',
            scope: 'machine',
            workspaceRoot: '/repo/web',
        })).resolves.toEqual({
            protocolVersion: 1,
            snapshot: launcherSnapshot,
        });
        expect(launcherRoutes.getSnapshot).toHaveBeenCalledOnce();
        expect(launcherRoutes.getSnapshot).toHaveBeenCalledWith({
            sessionId: 'session_1',
            scope: 'machine',
            workspaceRoot: '/repo/web',
        });

        const startRequest = {
            machineId: 'machine_1',
            targetId: 'preview:web',
            sessionId: 'session_1',
        };
        await expect(handlers.get(RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_START)?.(startRequest)).resolves.toEqual(
            launcherStartResponse,
        );
        expect(launcherRoutes.startTarget).toHaveBeenCalledWith(startRequest);

        const request = {
            requestId: 'request_1',
            target: { kind: 'inventory_entry' as const, inventoryEntryId: 'entry_1', machineId: 'machine_1' },
            action: 'copy_url' as const,
            force: false,
        };
        await expect(handlers.get(RPC_METHODS.DAEMON_LOCAL_SERVICES_ACTIONS_EXECUTE)?.(request)).resolves.toEqual({
            protocolVersion: 1,
            result: actionResult,
        });
        expect(actionRoutes.execute).toHaveBeenCalledWith(request);
    });

    it('serves the LSV-1 launcher leaf routes (openPreview/registerPreview/history.clear) when leaf routes are available', async () => {
        const module = await import('./daemonLocalServices').catch(() => null);

        expect(module?.registerDaemonLocalServicesMachineRpcHandlers).toBeTypeOf('function');
        if (!module?.registerDaemonLocalServicesMachineRpcHandlers) return;

        const openPreviewResponse = {
            protocolVersion: 1 as const,
            status: 'opened' as const,
            targetId: 'preview:web',
        };
        const registerPreviewResponse = {
            protocolVersion: 1 as const,
            status: 'registered' as const,
            targetId: 'inventory:entry_1',
            previewId: 'preview_1',
        };
        const historyClearResponse = {
            protocolVersion: 1 as const,
            cleared: 3,
            snapshot: launcherSnapshot,
        };
        const leaves = {
            openPreview: vi.fn(async () => openPreviewResponse),
            registerPreview: vi.fn(async () => registerPreviewResponse),
            clearHistory: vi.fn(async () => historyClearResponse),
        };
        const launcherRoutes = {
            getSnapshot: vi.fn(async () => launcherSnapshot),
            startTarget: vi.fn(async () => launcherStartResponse),
            leaves,
        };
        const { handlers, registrar } = createRegistrar();

        module.registerDaemonLocalServicesMachineRpcHandlers(registrar, {
            localServicesLauncher: launcherRoutes,
        });

        expect(handlers.has(RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_OPEN_PREVIEW)).toBe(true);
        expect(handlers.has(RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_REGISTER_PREVIEW)).toBe(true);
        expect(handlers.has(RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_HISTORY_CLEAR)).toBe(true);

        const openPreviewRequest = { machineId: 'machine_1', targetId: 'preview:web', sessionId: 'session_1' };
        await expect(
            handlers.get(RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_OPEN_PREVIEW)?.(openPreviewRequest),
        ).resolves.toEqual(openPreviewResponse);
        expect(leaves.openPreview).toHaveBeenCalledWith(openPreviewRequest);

        const registerPreviewRequest = { machineId: 'machine_1', targetId: 'inventory:entry_1' };
        await expect(
            handlers.get(RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_REGISTER_PREVIEW)?.(registerPreviewRequest),
        ).resolves.toEqual(registerPreviewResponse);
        expect(leaves.registerPreview).toHaveBeenCalledWith(registerPreviewRequest);

        const historyClearRequest = { machineId: 'machine_1' };
        await expect(
            handlers.get(RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_HISTORY_CLEAR)?.(historyClearRequest),
        ).resolves.toEqual(historyClearResponse);
        expect(leaves.clearHistory).toHaveBeenCalledWith(historyClearRequest);
    });

    it('omits the LSV-1 launcher leaf routes when no leaf routes are wired', async () => {
        const module = await import('./daemonLocalServices').catch(() => null);

        expect(module?.registerDaemonLocalServicesMachineRpcHandlers).toBeTypeOf('function');
        if (!module?.registerDaemonLocalServicesMachineRpcHandlers) return;

        const launcherRoutes = {
            getSnapshot: vi.fn(async () => launcherSnapshot),
            startTarget: vi.fn(async () => launcherStartResponse),
        };
        const { handlers, registrar } = createRegistrar();

        module.registerDaemonLocalServicesMachineRpcHandlers(registrar, {
            localServicesLauncher: launcherRoutes,
        });

        expect(handlers.has(RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_OPEN_PREVIEW)).toBe(false);
        expect(handlers.has(RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_REGISTER_PREVIEW)).toBe(false);
        expect(handlers.has(RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_HISTORY_CLEAR)).toBe(false);
    });

    it('serves public-preview status/create/revoke routes through the daemon-owned registration point', async () => {
        const module = await import('./daemonLocalServices').catch(() => null);

        expect(module?.registerDaemonLocalServicesMachineRpcHandlers).toBeTypeOf('function');
        if (!module?.registerDaemonLocalServicesMachineRpcHandlers) return;

        const publicPreviewRoutes = {
            getStatus: vi.fn(async () => publicPreviewSnapshot),
            createExposure: vi.fn(async () => ({
                protocolVersion: 1 as const,
                exposure: publicExposure,
                snapshot: publicPreviewSnapshot,
            })),
            revokeExposure: vi.fn(async () => ({
                protocolVersion: 1 as const,
                exposureId: 'public_preview_1',
                revokedAt: 3_100,
                snapshot: {
                    ...publicPreviewSnapshot,
                    exposures: [{ ...publicExposure, state: 'revoked' as const, revokedAt: 3_100 }],
                },
            })),
            copyUrl: vi.fn(async () => ({
                protocolVersion: 1 as const,
                machineId: 'machine_1',
                sessionId: 'session_1',
                previewId: 'preview_1',
                exposureId: 'public_preview_1',
                publicUrl: 'https://preview.example.test/s/public_preview_1',
            })),
        };
        const { handlers, registrar } = createRegistrar();

        module.registerDaemonLocalServicesMachineRpcHandlers(registrar, {
            localServicesPublicPreview: publicPreviewRoutes,
        } as never);

        expect([...handlers.keys()].sort()).toEqual([
            RPC_METHODS.DAEMON_LOCAL_SERVICES_PUBLIC_PREVIEW_COPY_URL,
            RPC_METHODS.DAEMON_LOCAL_SERVICES_PUBLIC_PREVIEW_CREATE,
            RPC_METHODS.DAEMON_LOCAL_SERVICES_PUBLIC_PREVIEW_REVOKE,
            RPC_METHODS.DAEMON_LOCAL_SERVICES_PUBLIC_PREVIEW_STATUS,
        ].sort());

        await expect(handlers.get(RPC_METHODS.DAEMON_LOCAL_SERVICES_PUBLIC_PREVIEW_STATUS)?.({
            machineId: 'machine_1',
            sessionId: 'session_1',
            previewId: 'preview_1',
        })).resolves.toEqual({
            protocolVersion: 1,
            snapshot: publicPreviewSnapshot,
        });
        expect(publicPreviewRoutes.getStatus).toHaveBeenCalledWith({
            machineId: 'machine_1',
            sessionId: 'session_1',
            previewId: 'preview_1',
        });

        // UX-5: a create request WITHOUT the acknowledged confirmation token must be rejected at this
        // direct RPC chokepoint (no UI-only bypass) and must NOT reach createExposure.
        const unconfirmedCreateRequest = {
            machineId: 'machine_1',
            sessionId: 'session_1',
            previewId: 'preview_1',
            mode: 'secret_link' as const,
            ttlMs: 600_000,
        };
        await expect(
            handlers.get(RPC_METHODS.DAEMON_LOCAL_SERVICES_PUBLIC_PREVIEW_CREATE)?.(unconfirmedCreateRequest),
        ).rejects.toThrow('local_services_public_preview_confirmation_required');
        expect(publicPreviewRoutes.createExposure).not.toHaveBeenCalled();

        const createRequest = {
            ...unconfirmedCreateRequest,
            confirmation: { acknowledged: true as const },
        };
        await expect(handlers.get(RPC_METHODS.DAEMON_LOCAL_SERVICES_PUBLIC_PREVIEW_CREATE)?.(createRequest)).resolves.toEqual({
            protocolVersion: 1,
            exposure: publicExposure,
            snapshot: publicPreviewSnapshot,
        });
        expect(publicPreviewRoutes.createExposure).toHaveBeenCalledWith(createRequest);

        const revokeRequest = {
            machineId: 'machine_1',
            sessionId: 'session_1',
            previewId: 'preview_1',
            exposureId: 'public_preview_1',
        };
        await expect(handlers.get(RPC_METHODS.DAEMON_LOCAL_SERVICES_PUBLIC_PREVIEW_REVOKE)?.(revokeRequest)).resolves.toMatchObject({
            protocolVersion: 1,
            exposureId: 'public_preview_1',
            revokedAt: 3_100,
        });
        expect(publicPreviewRoutes.revokeExposure).toHaveBeenCalledWith(revokeRequest);

        await expect(handlers.get(RPC_METHODS.DAEMON_LOCAL_SERVICES_PUBLIC_PREVIEW_COPY_URL)?.(revokeRequest)).resolves.toEqual({
            protocolVersion: 1,
            machineId: 'machine_1',
            sessionId: 'session_1',
            previewId: 'preview_1',
            exposureId: 'public_preview_1',
            publicUrl: 'https://preview.example.test/s/public_preview_1',
        });
        expect(publicPreviewRoutes.copyUrl).toHaveBeenCalledWith(revokeRequest);
    });
});
