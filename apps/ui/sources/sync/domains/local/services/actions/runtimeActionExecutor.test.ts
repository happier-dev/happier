import { describe, expect, it, vi } from 'vitest';

import { REDACTED_LOCAL_SERVICE_PUBLIC_PREVIEW_URL } from '@happier-dev/protocol';
import type {
    DaemonLocalServicePreviewOpenOrCreateResponseV1,
    DaemonLocalServicePreviewRevokeResponseV1,
    DaemonLocalServicePublicPreviewCreateResponseV1,
    LocalServiceActionResultV1,
    LocalServiceInventorySnapshotV1,
    LocalServiceLauncherSnapshotV1,
    LocalServicePreviewResourceV1,
    LocalServicePreviewSnapshotV1,
    LocalServicePublicExposureV1,
    LocalServicePublicPreviewSnapshotV1,
    RuntimeActionExecuteArgs,
} from '@happier-dev/protocol';

function runtimeArgs(
    args: Omit<RuntimeActionExecuteArgs, 'context'> & Partial<Pick<RuntimeActionExecuteArgs, 'context'>>,
): RuntimeActionExecuteArgs {
    return {
        context: {},
        ...args,
    };
}

const launcherSnapshot: LocalServiceLauncherSnapshotV1 = {
    v: 1,
    machineId: 'machine_1',
    sessionId: 'session_1',
    updatedAt: 2_000,
    targets: [],
};

const inventorySnapshot: LocalServiceInventorySnapshotV1 = {
    v: 1,
    machineId: 'machine_1',
    generatedAt: 1_500,
    refreshState: 'idle',
    entries: [],
    diagnostics: [],
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
        recordedAt: 2_000,
    }],
};

const launcherStartResponse = {
    protocolVersion: 1 as const,
    machineId: 'machine_1',
    targetId: 'target_1',
    status: 'succeeded' as const,
    snapshot: launcherSnapshot,
};

const publicExposure = {
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
} satisfies LocalServicePublicExposureV1;

const publicPreviewSnapshot = {
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
} satisfies LocalServicePublicPreviewSnapshotV1;

const publicPreviewCreateResponse = {
    protocolVersion: 1,
    exposure: publicExposure,
    snapshot: publicPreviewSnapshot,
} satisfies DaemonLocalServicePublicPreviewCreateResponseV1;

const previewResource = {
    previewId: 'lsv-preview:inventory:entry-vite',
    sessionId: 'session_1',
    machineId: 'machine_1',
    owner: { kind: 'session', id: 'session_1' },
    target: { scheme: 'http', host: '127.0.0.1', port: 5173 },
    initialPath: { pathname: '/', search: '' },
    display: { title: 'Vite', addressLabel: 'localhost:5173' },
    originMode: 'host',
    browserTarget: {
        kind: 'localServicePreview',
        targetId: 'lsv-preview:inventory:entry-vite',
        sessionId: 'session_1',
        machineId: 'machine_1',
        display: { title: 'Vite', addressLabel: 'localhost:5173' },
    },
} satisfies LocalServicePreviewResourceV1;

const previewLifecycleSnapshot = {
    v: 1,
    machineId: 'machine_1',
    generatedAt: 4_000,
    refreshState: 'idle',
    resources: [previewResource],
    previews: [{
        previewId: previewResource.previewId,
        resource: previewResource,
        accessUrl: 'http://127.0.0.1:5173/',
        expiresAt: null,
        diagnostics: [],
    }],
    diagnostics: [],
} satisfies LocalServicePreviewSnapshotV1;

const previewOpenOrCreateResponse = {
    protocolVersion: 1,
    status: 'created',
    preview: previewLifecycleSnapshot.previews[0],
    snapshot: previewLifecycleSnapshot,
} satisfies DaemonLocalServicePreviewOpenOrCreateResponseV1;

const previewRevokeResponse = {
    protocolVersion: 1,
    previewId: previewResource.previewId,
    revoked: true,
    snapshot: {
        v: 1,
        machineId: 'machine_1',
        generatedAt: 5_000,
        refreshState: 'idle',
        resources: [],
        previews: [],
        diagnostics: [],
    },
} satisfies DaemonLocalServicePreviewRevokeResponseV1;

describe('UI local-services runtime action executor', () => {
    it('maps localServices.launcher.snapshot to the local-services launcher snapshot client', async () => {
        const mod = await import('./runtimeActionExecutor').catch(() => null);

        expect(mod?.createLocalServicesRuntimeActionExecutor).toBeTypeOf('function');
        if (!mod?.createLocalServicesRuntimeActionExecutor) return;

        const fetchLauncherSnapshot = vi.fn(async () => ({ ok: true as const, snapshot: launcherSnapshot }));
        const onLauncherSnapshot = vi.fn();
        const execute = mod.createLocalServicesRuntimeActionExecutor({
            resolveMachineId: () => 'machine_1',
            fetchLauncherSnapshot,
            onLauncherSnapshot,
        });

        await expect(execute(runtimeArgs({
            actionId: 'localServices.launcher.snapshot',
            input: { sessionId: 'session_1' },
            context: { serverId: 'server_1' },
        }))).resolves.toEqual(launcherSnapshot);
        expect(fetchLauncherSnapshot).toHaveBeenCalledWith({
            machineId: 'machine_1',
            serverId: 'server_1',
            sessionId: 'session_1',
            request: undefined,
        });
        expect(onLauncherSnapshot).toHaveBeenCalledWith({
            machineId: 'machine_1',
            serverId: 'server_1',
            sessionId: 'session_1',
            snapshot: launcherSnapshot,
        });
    });

    it('publishes inventory action snapshots into the shared inventory store sink', async () => {
        const mod = await import('./runtimeActionExecutor').catch(() => null);

        expect(mod?.createLocalServicesRuntimeActionExecutor).toBeTypeOf('function');
        if (!mod?.createLocalServicesRuntimeActionExecutor) return;

        const fetchInventorySnapshot = vi.fn(async () => ({ ok: true as const, snapshot: inventorySnapshot }));
        const onInventorySnapshot = vi.fn();
        const execute = mod.createLocalServicesRuntimeActionExecutor({
            resolveMachineId: () => 'machine_1',
            fetchInventorySnapshot,
            onInventorySnapshot,
        });

        await expect(execute(runtimeArgs({
            actionId: 'localServices.inventory.list',
            input: { sessionId: 'session_1' },
            context: { serverId: 'server_1' },
        }))).resolves.toEqual(inventorySnapshot);
        expect(onInventorySnapshot).toHaveBeenCalledWith({
            machineId: 'machine_1',
            serverId: 'server_1',
            sessionId: 'session_1',
            snapshot: inventorySnapshot,
        });
    });

    it('fails snapshot actions closed when no machine context can be resolved', async () => {
        const mod = await import('./runtimeActionExecutor').catch(() => null);

        expect(mod?.createLocalServicesRuntimeActionExecutor).toBeTypeOf('function');
        if (!mod?.createLocalServicesRuntimeActionExecutor) return;

        const fetchLauncherSnapshot = vi.fn(async () => ({ ok: true as const, snapshot: launcherSnapshot }));
        const execute = mod.createLocalServicesRuntimeActionExecutor({
            fetchLauncherSnapshot,
        });

        await expect(execute(runtimeArgs({
            actionId: 'localServices.launcher.snapshot',
            input: { sessionId: 'session_1' },
        }))).resolves.toEqual({
            ok: false,
            errorCode: 'runtime_action_disabled',
            error: 'runtime_action_disabled:localServices:local_services_machine_unavailable',
        });
        expect(fetchLauncherSnapshot).not.toHaveBeenCalled();
    });

    it('fails action execution closed when the local action route is unavailable', async () => {
        const mod = await import('./runtimeActionExecutor').catch(() => null);

        expect(mod?.createLocalServicesRuntimeActionExecutor).toBeTypeOf('function');
        if (!mod?.createLocalServicesRuntimeActionExecutor) return;

        const executeLocalServiceAction = vi.fn(async () => ({ ok: false as const, reason: 'unavailable' as const }));
        const execute = mod.createLocalServicesRuntimeActionExecutor({
            executeLocalServiceAction,
        });

        await expect(execute(runtimeArgs({
            actionId: 'localServices.actions.copyUrl',
            input: {
                requestId: 'request_1',
                target: { kind: 'inventory_entry', inventoryEntryId: 'entry_1', machineId: 'machine_1' },
                action: 'copy_url',
                force: false,
            },
        }))).resolves.toEqual({
            ok: false,
            errorCode: 'runtime_action_disabled',
            error: 'runtime_action_disabled:localServices:local_services_action_unavailable',
        });
        expect(executeLocalServiceAction).toHaveBeenCalledOnce();
    });

    it('returns local service action results from the injected action client', async () => {
        const mod = await import('./runtimeActionExecutor').catch(() => null);

        expect(mod?.createLocalServicesRuntimeActionExecutor).toBeTypeOf('function');
        if (!mod?.createLocalServicesRuntimeActionExecutor) return;

        const executeLocalServiceAction = vi.fn(async () => ({ ok: true as const, result: actionResult }));
        const execute = mod.createLocalServicesRuntimeActionExecutor({
            executeLocalServiceAction,
        });

        await expect(execute(runtimeArgs({
            actionId: 'localServices.actions.copyUrl',
            input: {
                requestId: 'request_1',
                target: { kind: 'inventory_entry', inventoryEntryId: 'entry_1', machineId: 'machine_1' },
                action: 'copy_url',
                force: false,
            },
        }))).resolves.toEqual(actionResult);
    });

    it('maps localServices.launcher.start to the injected launcher start route', async () => {
        const mod = await import('./runtimeActionExecutor').catch(() => null);

        expect(mod?.createLocalServicesRuntimeActionExecutor).toBeTypeOf('function');
        if (!mod?.createLocalServicesRuntimeActionExecutor) return;

        const startLauncherTarget = vi.fn(async () => ({ ok: true as const, response: launcherStartResponse }));
        const onLauncherSnapshot = vi.fn();
        const execute = mod.createLocalServicesRuntimeActionExecutor({
            startLauncherTarget,
            onLauncherSnapshot,
        });

        await expect(execute(runtimeArgs({
            actionId: 'localServices.launcher.start',
            input: {
                machineId: 'machine_1',
                targetId: 'target_1',
                sessionId: 'session_1',
                workspaceId: 'workspace_1',
            },
            context: { serverId: 'server_1' },
        }))).resolves.toEqual(launcherStartResponse);
        expect(startLauncherTarget).toHaveBeenCalledWith({
            machineId: 'machine_1',
            targetId: 'target_1',
            serverId: 'server_1',
            sessionId: 'session_1',
            workspaceId: 'workspace_1',
        });
        expect(onLauncherSnapshot).toHaveBeenCalledWith({
            machineId: 'machine_1',
            serverId: 'server_1',
            sessionId: 'session_1',
            snapshot: launcherSnapshot,
        });
    });

    it('fails launcher start closed when route is missing or input is invalid', async () => {
        const mod = await import('./runtimeActionExecutor').catch(() => null);

        expect(mod?.createLocalServicesRuntimeActionExecutor).toBeTypeOf('function');
        if (!mod?.createLocalServicesRuntimeActionExecutor) return;

        const execute = mod.createLocalServicesRuntimeActionExecutor();

        await expect(execute(runtimeArgs({
            actionId: 'localServices.launcher.start',
            input: {
                machineId: 'machine_1',
                targetId: 'target_1',
            },
        }))).resolves.toEqual({
            ok: false,
            errorCode: 'runtime_action_disabled',
            error: 'runtime_action_disabled:localServices:local_services_launcher_unavailable',
        });
        await expect(execute(runtimeArgs({
            actionId: 'localServices.launcher.start',
            input: { machineId: 'machine_1' },
        }))).resolves.toEqual({
            ok: false,
            errorCode: 'invalid_parameters',
            error: 'invalid_parameters',
        });
    });

    it('maps localServices.launcher.openPreview to the injected launcher leaf route (executor-backed, not unbacked)', async () => {
        const mod = await import('./runtimeActionExecutor').catch(() => null);

        expect(mod?.createLocalServicesRuntimeActionExecutor).toBeTypeOf('function');
        if (!mod?.createLocalServicesRuntimeActionExecutor) return;

        const openPreviewResponse = {
            protocolVersion: 1 as const,
            status: 'opened' as const,
            targetId: 'target_1',
        };
        const openLauncherPreview = vi.fn(async () => ({ ok: true as const, response: openPreviewResponse }));
        const execute = mod.createLocalServicesRuntimeActionExecutor({ openLauncherPreview });

        await expect(execute(runtimeArgs({
            actionId: 'localServices.launcher.openPreview',
            input: { machineId: 'machine_1', targetId: 'target_1', sessionId: 'session_1' },
            context: { serverId: 'server_1' },
        }))).resolves.toEqual(openPreviewResponse);
        expect(openLauncherPreview).toHaveBeenCalledWith({
            machineId: 'machine_1',
            targetId: 'target_1',
            serverId: 'server_1',
            sessionId: 'session_1',
        });
    });

    it('maps localServices.launcher.registerPreview to the injected launcher leaf route (executor-backed, not unbacked)', async () => {
        const mod = await import('./runtimeActionExecutor').catch(() => null);

        expect(mod?.createLocalServicesRuntimeActionExecutor).toBeTypeOf('function');
        if (!mod?.createLocalServicesRuntimeActionExecutor) return;

        const registerPreviewResponse = {
            protocolVersion: 1 as const,
            status: 'registered' as const,
            targetId: 'inventory:entry_1',
            previewId: 'preview_1',
        };
        const registerLauncherPreview = vi.fn(async () => ({ ok: true as const, response: registerPreviewResponse }));
        const execute = mod.createLocalServicesRuntimeActionExecutor({ registerLauncherPreview });

        await expect(execute(runtimeArgs({
            actionId: 'localServices.launcher.registerPreview',
            input: { machineId: 'machine_1', targetId: 'inventory:entry_1' },
            context: { serverId: 'server_1' },
        }))).resolves.toEqual(registerPreviewResponse);
        expect(registerLauncherPreview).toHaveBeenCalledWith({
            machineId: 'machine_1',
            targetId: 'inventory:entry_1',
            serverId: 'server_1',
            sessionId: undefined,
        });
    });

    it('maps localServices.launcher.history.clear to the injected launcher leaf route (executor-backed, not unbacked)', async () => {
        const mod = await import('./runtimeActionExecutor').catch(() => null);

        expect(mod?.createLocalServicesRuntimeActionExecutor).toBeTypeOf('function');
        if (!mod?.createLocalServicesRuntimeActionExecutor) return;

        const historyClearResponse = {
            protocolVersion: 1 as const,
            cleared: 2,
            snapshot: launcherSnapshot,
        };
        const clearLauncherHistory = vi.fn(async () => ({ ok: true as const, response: historyClearResponse }));
        const execute = mod.createLocalServicesRuntimeActionExecutor({ clearLauncherHistory });

        await expect(execute(runtimeArgs({
            actionId: 'localServices.launcher.history.clear',
            input: { machineId: 'machine_1', sessionId: 'session_1' },
            context: { serverId: 'server_1' },
        }))).resolves.toEqual(historyClearResponse);
        expect(clearLauncherHistory).toHaveBeenCalledWith({
            machineId: 'machine_1',
            serverId: 'server_1',
            sessionId: 'session_1',
        });
    });

    it('fails launcher leaves closed (not unbacked) when machine context or target is missing', async () => {
        const mod = await import('./runtimeActionExecutor').catch(() => null);

        expect(mod?.createLocalServicesRuntimeActionExecutor).toBeTypeOf('function');
        if (!mod?.createLocalServicesRuntimeActionExecutor) return;

        const openLauncherPreview = vi.fn();
        const registerLauncherPreview = vi.fn();
        const execute = mod.createLocalServicesRuntimeActionExecutor({
            openLauncherPreview,
            registerLauncherPreview,
        });

        // No machine context resolvable → machine-unavailable, never the unbacked fallthrough.
        await expect(execute(runtimeArgs({
            actionId: 'localServices.launcher.openPreview',
            input: { targetId: 'target_1' },
        }))).resolves.toEqual({
            ok: false,
            errorCode: 'runtime_action_disabled',
            error: 'runtime_action_disabled:localServices:local_services_machine_unavailable',
        });
        // Missing targetId → invalid parameters, never the unbacked fallthrough.
        await expect(execute(runtimeArgs({
            actionId: 'localServices.launcher.registerPreview',
            input: { machineId: 'machine_1' },
        }))).resolves.toEqual({
            ok: false,
            errorCode: 'invalid_parameters',
            error: 'invalid_parameters',
        });
        expect(openLauncherPreview).not.toHaveBeenCalled();
        expect(registerLauncherPreview).not.toHaveBeenCalled();
    });

    it('maps localServices.publicPreview actions to the injected public-preview routes', async () => {
        const mod = await import('./runtimeActionExecutor').catch(() => null);

        expect(mod?.createLocalServicesRuntimeActionExecutor).toBeTypeOf('function');
        if (!mod?.createLocalServicesRuntimeActionExecutor) return;

        const fetchPublicPreviewStatus = vi.fn(async () => ({ ok: true as const, snapshot: publicPreviewSnapshot }));
        const createPublicPreviewExposure = vi.fn(async () => ({ ok: true as const, response: publicPreviewCreateResponse }));
        const revokePublicPreviewExposure = vi.fn(async () => ({
            ok: true as const,
            response: {
                protocolVersion: 1 as const,
                exposureId: 'public_preview_1',
                revokedAt: 4_000,
                snapshot: {
                    ...publicPreviewSnapshot,
                    exposures: [{ ...publicExposure, state: 'revoked' as const, revokedAt: 4_000 }],
                },
            },
        }));
        const copyPublicPreviewUrl = vi.fn(async () => ({
            ok: true as const,
            response: {
                protocolVersion: 1 as const,
                machineId: 'machine_1',
                sessionId: 'session_1',
                previewId: 'preview_1',
                exposureId: 'public_preview_1',
                publicUrl: publicExposure.publicUrl,
            },
        }));
        const onPublicPreviewSnapshot = vi.fn();
        const execute = mod.createLocalServicesRuntimeActionExecutor({
            resolveMachineId: () => 'machine_1',
            fetchPublicPreviewStatus,
            createPublicPreviewExposure,
            revokePublicPreviewExposure,
            copyPublicPreviewUrl,
            onPublicPreviewSnapshot,
        });

        await expect(execute(runtimeArgs({
            actionId: 'localServices.publicPreview.status',
            input: { previewId: 'preview_1' },
            context: { defaultSessionId: 'session_1', serverId: 'server_1' },
        }))).resolves.toEqual(publicPreviewSnapshot);
        await expect(execute(runtimeArgs({
            actionId: 'localServices.publicPreview.create',
            input: {
                sessionId: 'session_1',
                previewId: 'preview_1',
                mode: 'secret_link',
                ttlMs: 600_000,
                rateLimitProfileId: 'default',
            },
            context: { serverId: 'server_1' },
        }))).resolves.toEqual(publicPreviewCreateResponse);
        await expect(execute(runtimeArgs({
            actionId: 'localServices.publicPreview.revoke',
            input: {
                sessionId: 'session_1',
                previewId: 'preview_1',
                exposureId: 'public_preview_1',
            },
            context: { serverId: 'server_1' },
        }))).resolves.toEqual({
            protocolVersion: 1,
            exposureId: 'public_preview_1',
            revokedAt: 4_000,
            snapshot: {
                ...publicPreviewSnapshot,
                exposures: [{ ...publicExposure, state: 'revoked', revokedAt: 4_000 }],
            },
        });
        await expect(execute(runtimeArgs({
            actionId: 'localServices.publicPreview.copyUrl',
            input: {
                sessionId: 'session_1',
                previewId: 'preview_1',
                exposureId: 'public_preview_1',
            },
            context: { serverId: 'server_1' },
        }))).resolves.toEqual({
            protocolVersion: 1,
            machineId: 'machine_1',
            sessionId: 'session_1',
            previewId: 'preview_1',
            exposureId: 'public_preview_1',
            publicUrl: publicExposure.publicUrl,
        });

        expect(fetchPublicPreviewStatus).toHaveBeenCalledWith({
            request: {
                machineId: 'machine_1',
                sessionId: 'session_1',
                previewId: 'preview_1',
            },
            serverId: 'server_1',
        });
        expect(onPublicPreviewSnapshot).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine_1',
            serverId: 'server_1',
            sessionId: 'session_1',
            previewId: 'preview_1',
            snapshot: publicPreviewSnapshot,
        }));
        expect(createPublicPreviewExposure).toHaveBeenCalledWith({
            request: {
                machineId: 'machine_1',
                sessionId: 'session_1',
                previewId: 'preview_1',
                mode: 'secret_link',
                ttlMs: 600_000,
                rateLimitProfileId: 'default',
            },
            serverId: 'server_1',
        });
        expect(onPublicPreviewSnapshot).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine_1',
            serverId: 'server_1',
            sessionId: 'session_1',
            previewId: 'preview_1',
            snapshot: publicPreviewCreateResponse.snapshot,
        }));
        expect(revokePublicPreviewExposure).toHaveBeenCalledWith({
            request: {
                machineId: 'machine_1',
                sessionId: 'session_1',
                previewId: 'preview_1',
                exposureId: 'public_preview_1',
            },
            serverId: 'server_1',
        });
        expect(onPublicPreviewSnapshot).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine_1',
            serverId: 'server_1',
            sessionId: 'session_1',
            previewId: 'preview_1',
            exposureId: 'public_preview_1',
            snapshot: expect.objectContaining({
                exposures: [expect.objectContaining({ state: 'revoked' })],
            }),
        }));
        expect(copyPublicPreviewUrl).toHaveBeenCalledWith({
            request: {
                machineId: 'machine_1',
                sessionId: 'session_1',
                previewId: 'preview_1',
                exposureId: 'public_preview_1',
            },
            serverId: 'server_1',
        });
    });

    it('fails public-preview actions closed when routing is missing or input is invalid', async () => {
        const mod = await import('./runtimeActionExecutor').catch(() => null);

        expect(mod?.createLocalServicesRuntimeActionExecutor).toBeTypeOf('function');
        if (!mod?.createLocalServicesRuntimeActionExecutor) return;

        const execute = mod.createLocalServicesRuntimeActionExecutor({
            resolveMachineId: () => 'machine_1',
        });

        await expect(execute(runtimeArgs({
            actionId: 'localServices.publicPreview.status',
            input: { sessionId: 'session_1' },
        }))).resolves.toEqual({
            ok: false,
            errorCode: 'runtime_action_disabled',
            error: 'runtime_action_disabled:localServices:local_services_public_preview_unavailable',
        });
        await expect(execute(runtimeArgs({
            actionId: 'localServices.publicPreview.create',
            input: {
                sessionId: 'session_1',
                previewId: 'preview_1',
                mode: 'secret_link',
            },
        }))).resolves.toEqual({
            ok: false,
            errorCode: 'invalid_parameters',
            error: 'invalid_parameters',
        });
    });

    it('redacts public-preview status URLs for agent-surface egress while publishing the raw store snapshot', async () => {
        const mod = await import('./runtimeActionExecutor').catch(() => null);
        expect(mod?.createLocalServicesRuntimeActionExecutor).toBeTypeOf('function');
        if (!mod?.createLocalServicesRuntimeActionExecutor) return;

        const fetchPublicPreviewStatus = vi.fn(async () => ({ ok: true as const, snapshot: publicPreviewSnapshot }));
        const onPublicPreviewSnapshot = vi.fn();
        const execute = mod.createLocalServicesRuntimeActionExecutor({
            resolveMachineId: () => 'machine_1',
            fetchPublicPreviewStatus,
            onPublicPreviewSnapshot,
        });

        const result = await execute(runtimeArgs({
            actionId: 'localServices.publicPreview.status',
            input: { previewId: 'preview_1' },
            context: { surface: 'agent', defaultSessionId: 'session_1', serverId: 'server_1' },
        })) as LocalServicePublicPreviewSnapshotV1;

        expect(result.exposures[0]?.publicUrl).toBe(REDACTED_LOCAL_SERVICE_PUBLIC_PREVIEW_URL);
        expect(onPublicPreviewSnapshot).toHaveBeenCalledWith(expect.objectContaining({
            snapshot: publicPreviewSnapshot,
        }));
    });

    it('redacts public-preview create and revoke response URLs for agent-surface egress while publishing raw store snapshots', async () => {
        const mod = await import('./runtimeActionExecutor').catch(() => null);
        expect(mod?.createLocalServicesRuntimeActionExecutor).toBeTypeOf('function');
        if (!mod?.createLocalServicesRuntimeActionExecutor) return;

        const revokedSnapshot = {
            ...publicPreviewSnapshot,
            exposures: [{ ...publicExposure, state: 'revoked' as const, revokedAt: 4_000 }],
        };
        const createPublicPreviewExposure = vi.fn(async () => ({
            ok: true as const,
            response: publicPreviewCreateResponse,
        }));
        const revokePublicPreviewExposure = vi.fn(async () => ({
            ok: true as const,
            response: {
                protocolVersion: 1 as const,
                exposureId: 'public_preview_1',
                revokedAt: 4_000,
                snapshot: revokedSnapshot,
            },
        }));
        const onPublicPreviewSnapshot = vi.fn();
        const execute = mod.createLocalServicesRuntimeActionExecutor({
            resolveMachineId: () => 'machine_1',
            createPublicPreviewExposure,
            revokePublicPreviewExposure,
            onPublicPreviewSnapshot,
        });

        const createResult = await execute(runtimeArgs({
            actionId: 'localServices.publicPreview.create',
            input: {
                sessionId: 'session_1',
                previewId: 'preview_1',
                mode: 'secret_link',
                ttlMs: 600_000,
                rateLimitProfileId: 'default',
                confirmation: { acknowledged: true },
            },
            context: { surface: 'agent', serverId: 'server_1' },
        })) as DaemonLocalServicePublicPreviewCreateResponseV1;
        const revokeResult = await execute(runtimeArgs({
            actionId: 'localServices.publicPreview.revoke',
            input: {
                sessionId: 'session_1',
                previewId: 'preview_1',
                exposureId: 'public_preview_1',
            },
            context: { surface: 'agent', serverId: 'server_1' },
        })) as { snapshot: LocalServicePublicPreviewSnapshotV1 };

        expect(createResult.exposure.publicUrl).toBe(REDACTED_LOCAL_SERVICE_PUBLIC_PREVIEW_URL);
        expect(createResult.snapshot?.exposures[0]?.publicUrl).toBe(REDACTED_LOCAL_SERVICE_PUBLIC_PREVIEW_URL);
        expect(revokeResult.snapshot.exposures[0]?.publicUrl).toBe(REDACTED_LOCAL_SERVICE_PUBLIC_PREVIEW_URL);
        expect(onPublicPreviewSnapshot).toHaveBeenCalledWith(expect.objectContaining({
            snapshot: publicPreviewCreateResponse.snapshot,
        }));
        expect(onPublicPreviewSnapshot).toHaveBeenCalledWith(expect.objectContaining({
            snapshot: revokedSnapshot,
        }));
    });

    it('dispatches localServices.preview.openOrCreate to the daemon route and publishes the snapshot', async () => {
        const mod = await import('./runtimeActionExecutor');

        const openOrCreatePreview = vi.fn(async () => ({ ok: true as const, response: previewOpenOrCreateResponse }));
        const onPreviewSnapshot = vi.fn();
        const execute = mod.createLocalServicesRuntimeActionExecutor({
            resolveMachineId: () => 'machine_1',
            openOrCreatePreview,
            onPreviewSnapshot,
        });

        await expect(execute(runtimeArgs({
            actionId: 'localServices.preview.openOrCreate',
            input: { sessionId: 'session_1', inventoryEntryId: 'entry-vite' },
            context: { serverId: 'server_1' },
        }))).resolves.toEqual(previewOpenOrCreateResponse);

        expect(openOrCreatePreview).toHaveBeenCalledWith({
            request: {
                machineId: 'machine_1',
                sessionId: 'session_1',
                inventoryEntryId: 'entry-vite',
            },
            serverId: 'server_1',
        });
        // Action-driven invalidation: the returned snapshot is published into the shared store.
        expect(onPreviewSnapshot).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine_1',
            serverId: 'server_1',
            snapshot: expect.objectContaining({ generatedAt: 4_000, refreshState: 'idle' }),
        }));
    });

    it('dispatches localServices.preview.revoke to the daemon route and publishes the refreshed snapshot', async () => {
        const mod = await import('./runtimeActionExecutor');

        const revokePreview = vi.fn(async () => ({ ok: true as const, response: previewRevokeResponse }));
        const onPreviewSnapshot = vi.fn();
        const execute = mod.createLocalServicesRuntimeActionExecutor({
            resolveMachineId: () => 'machine_1',
            revokePreview,
            onPreviewSnapshot,
        });

        await expect(execute(runtimeArgs({
            actionId: 'localServices.preview.revoke',
            input: { previewId: previewResource.previewId },
        }))).resolves.toEqual(previewRevokeResponse);

        expect(revokePreview).toHaveBeenCalledWith({
            request: { machineId: 'machine_1', previewId: previewResource.previewId },
            serverId: undefined,
        });
        expect(onPreviewSnapshot).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine_1',
            snapshot: expect.objectContaining({ generatedAt: 5_000 }),
        }));
    });

    it('maps a daemon preview-lifecycle refusal to a stable preview_<reason> disabled code', async () => {
        const mod = await import('./runtimeActionExecutor');

        const openOrCreatePreview = vi.fn(async () => ({ ok: false as const, reason: 'refused:wrong_machine' as const }));
        const onPreviewSnapshot = vi.fn();
        const execute = mod.createLocalServicesRuntimeActionExecutor({
            resolveMachineId: () => 'machine_1',
            openOrCreatePreview,
            onPreviewSnapshot,
        });

        await expect(execute(runtimeArgs({
            actionId: 'localServices.preview.openOrCreate',
            input: { inventoryEntryId: 'entry-vite' },
        }))).resolves.toEqual({
            ok: false,
            errorCode: 'runtime_action_disabled',
            error: 'runtime_action_disabled:localServices:local_services_preview_refused:wrong_machine',
        });
        expect(onPreviewSnapshot).not.toHaveBeenCalled();
    });

    it('fails localServices.preview.revoke closed when previewId is missing', async () => {
        const mod = await import('./runtimeActionExecutor');

        const revokePreview = vi.fn();
        const execute = mod.createLocalServicesRuntimeActionExecutor({
            resolveMachineId: () => 'machine_1',
            revokePreview,
        });

        await expect(execute(runtimeArgs({
            actionId: 'localServices.preview.revoke',
            input: {},
        }))).resolves.toEqual({
            ok: false,
            errorCode: 'invalid_parameters',
            error: 'invalid_parameters',
        });
        expect(revokePreview).not.toHaveBeenCalled();
    });
});
