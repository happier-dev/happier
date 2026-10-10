import { describe, expect, it, vi } from 'vitest';

import { REDACTED_LOCAL_SERVICE_PUBLIC_PREVIEW_URL } from '@happier-dev/protocol';
import type {
    DaemonLocalServiceLauncherHistoryClearResponseV1,
    DaemonLocalServiceLauncherOpenPreviewResponseV1,
    DaemonLocalServiceLauncherRegisterPreviewResponseV1,
    DaemonLocalServiceLauncherStartResponseV1,
    LocalServiceActionResultV1,
    LocalServiceLauncherSnapshotV1,
    LocalServicePublicExposureV1,
    LocalServicePublicPreviewSnapshotV1,
    RuntimeActionExecuteArgs,
} from '@happier-dev/protocol';

import type { LocalServiceActionRoutes } from './routes';
import { createLocalServiceActionRoutes } from './routes';
import type { LocalServiceLauncherLeafRoutes } from '../launch/leaves';
import type { LocalServicesDaemonFeatureGate, LocalServicesDaemonFeatureGateId } from '../featureGate';
import type { LocalServiceInventoryRoutes } from '../inventory/routes';
import type { NormalizedLocalServiceInventorySnapshot } from '../inventory/scanner';
import { createLocalServiceInventoryRegistry } from '../inventory/registry';
import { createLocalServicePreviewRegistry, registerLocalServicePreview } from '../preview/registry';
import { createLocalServicePreviewRoutes } from '../preview/routes';
import { createLocalServicePublicPreviewServerRoutes } from '../public/routes';
import { LocalServicePreviewResourceV1Schema } from '@happier-dev/protocol/local/services/preview/v1';

function runtimeArgs(
    args: Omit<RuntimeActionExecuteArgs, 'context'> & Partial<Pick<RuntimeActionExecuteArgs, 'context'>>,
): RuntimeActionExecuteArgs {
    return {
        context: {},
        ...args,
    };
}

// Route-behavior tests below are not exercising the server feature gate; they use an all-enabled
// gate so the (required, fail-closed) gate does not mask the route contract under test.
const allowAllFeatureGate: LocalServicesDaemonFeatureGate = {
    isEnabled: () => true,
    refresh: async () => {},
};

const inventorySnapshot: NormalizedLocalServiceInventorySnapshot = {
    v: 1,
    machineId: 'machine_1',
    generatedAt: 2_000,
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

function createObservedActionRoutes() {
    const registry = createLocalServiceInventoryRegistry();
    registry.replaceSnapshot({ ...inventorySnapshot, entries: [{ id: 'entry_1', machineId: 'machine_1',
        address: { kind: 'loopback', host: '127.0.0.1', family: 'ipv4' }, port: 5173, protocol: 'tcp',
        detectedAt: 1_000, lastSeenAt: 2_000, state: 'listening', source: 'detected', labels: [],
        confidence: 'high', processOwnershipConfidence: 'high', workspaceAssociationConfidence: 'high', diagnostics: [] }] });
    return { registry, routes: createLocalServiceActionRoutes({ machineId: 'machine_1', inventoryRegistry: registry, now: () => 2_000 }) };
}

const launcherSnapshot: LocalServiceLauncherSnapshotV1 = {
    v: 1,
    machineId: 'machine_1',
    sessionId: 'session_1',
    updatedAt: 4_000,
    targets: [],
};

const launcherStartResponse: DaemonLocalServiceLauncherStartResponseV1 = {
    protocolVersion: 1,
    machineId: 'machine_1',
    targetId: 'managed:web',
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

describe('daemon local-services runtime action executor', () => {
    it('opens and revokes the actual source-qualified preview through Actions without retargeting an inventory entry', async () => {
        const { createLocalServicesDaemonRuntimeActionExecutor } = await import('./runtimeActionExecutor');
        const registry = createLocalServicePreviewRegistry();
        const serviceTarget = { kind: 'managed_service' as const, machineId: 'machine_1', managedServiceId: 'actual-instance', cwd: '/workspace/app',
            declaration: { workspaceRefId: 'workspace_1', selection: { kind: 'manifest' as const, name: 'web' } } };
        const registered = registerLocalServicePreview(registry, {
            previewId: 'actual-preview', machineId: 'machine_1', owner: { kind: 'user', id: 'starter' }, serviceTarget,
            target: { scheme: 'http', host: '127.0.0.1', port: 5173 }, initialPath: { pathname: '/', search: '' },
            display: { title: 'Web', addressLabel: 'localhost:5173' }, originMode: 'host',
        });
        if (!registered.ok) throw new Error(registered.reasonCode);
        const previewRoutes = createLocalServicePreviewRoutes({ machineId: 'machine_1', registry, server: {
            token: 'custodian-token', serverBaseUrl: 'https://home.example.test',
            // Only Home HTTP is replaced; Action normalization, registry and lifecycle run together.
            http: { async post(_url, body) {
                const resource = LocalServicePreviewResourceV1Schema.parse(body);
                expect(resource.serviceTarget).toEqual(serviceTarget);
                return { data: { resource, accessUrl: 'https://actual-preview.example.test/?previewToken=current', expiresAt: 61_000 } };
            }, async delete() { return { data: { ok: true } }; } },
        } });
        const execute = createLocalServicesDaemonRuntimeActionExecutor({ routes: { previewRoutes }, featureGate: allowAllFeatureGate });
        const opened = await execute(runtimeArgs({ actionId: 'localServices.preview.openOrCreate', input: {
            machineId: 'machine_1', targetId: 'managed:web', serviceTarget } }));
        expect(opened).toMatchObject({ status: 'existing', preview: { previewId: 'actual-preview',
            accessUrl: 'https://actual-preview.example.test/?previewToken=current', resource: { serviceTarget } } });
        const wrong = await execute(runtimeArgs({ actionId: 'localServices.preview.revoke', input: {
            machineId: 'machine_1', previewId: 'actual-preview', serviceTarget: { ...serviceTarget, managedServiceId: 'another-instance' } } }));
        expect(wrong).toMatchObject({ ok: false });
        expect(registry.previewsById.has('actual-preview')).toBe(true);
        const revoked = await execute(runtimeArgs({ actionId: 'localServices.preview.revoke', input: {
            machineId: 'machine_1', previewId: 'actual-preview', serviceTarget } }));
        expect(revoked).toMatchObject({ revoked: true, previewId: 'actual-preview' });
        expect(registry.previewsById.has('actual-preview')).toBe(false);
    });
    it('maps localServices.inventory.list to the daemon inventory snapshot route', async () => {
        const mod = await import('./runtimeActionExecutor').catch(() => null);

        expect(mod?.createLocalServicesDaemonRuntimeActionExecutor).toBeTypeOf('function');
        if (!mod?.createLocalServicesDaemonRuntimeActionExecutor) return;

        const inventoryRoutes: Pick<LocalServiceInventoryRoutes, 'getSnapshot' | 'refreshSnapshot'> = {
            getSnapshot: vi.fn(async () => inventorySnapshot),
            refreshSnapshot: vi.fn(async () => ({ ...inventorySnapshot, generatedAt: 3_000 })),
        };
        const execute = mod.createLocalServicesDaemonRuntimeActionExecutor({
            featureGate: allowAllFeatureGate,
            routes: { inventoryRoutes },
        });

        await expect(execute(runtimeArgs({
            actionId: 'localServices.inventory.list',
            input: { machineId: 'machine_1' },
        }))).resolves.toEqual(inventorySnapshot);
        expect(inventoryRoutes.getSnapshot).toHaveBeenCalledOnce();
        expect(inventoryRoutes.refreshSnapshot).not.toHaveBeenCalled();
    });

    it('dispatches each launcher leaf through the assembled executor (never *_unbacked)', async () => {
        const mod = await import('./runtimeActionExecutor').catch(() => null);
        if (!mod?.createLocalServicesDaemonRuntimeActionExecutor) return;

        const launcherSnapshotLocal: LocalServiceLauncherSnapshotV1 = {
            v: 1,
            machineId: 'machine_1',
            updatedAt: 1_000,
            targets: [],
        };
        const openResponse: DaemonLocalServiceLauncherOpenPreviewResponseV1 = {
            protocolVersion: 1,
            status: 'opened',
            targetId: 'inventory:entry_1',
            browserTarget: { kind: 'externalUrl', targetId: 'inventory:entry_1', url: 'http://127.0.0.1:5173/' },
        };
        const registerResponse: DaemonLocalServiceLauncherRegisterPreviewResponseV1 = {
            protocolVersion: 1,
            status: 'registered',
            targetId: 'inventory:entry_1',
            previewId: 'lsv-preview:inventory:entry_1',
        };
        const clearResponse: DaemonLocalServiceLauncherHistoryClearResponseV1 = {
            protocolVersion: 1,
            cleared: 2,
            snapshot: launcherSnapshotLocal,
        };
        const leaves: LocalServiceLauncherLeafRoutes = {
            openPreview: vi.fn(async () => openResponse),
            registerPreview: vi.fn(async () => registerResponse),
            clearHistory: vi.fn(async () => clearResponse),
        };
        const execute = mod.createLocalServicesDaemonRuntimeActionExecutor({
            featureGate: allowAllFeatureGate,
            routes: { launcherRoutes: { getSnapshot: vi.fn(async () => launcherSnapshotLocal), leaves } },
        });

        const open = await execute(runtimeArgs({
            actionId: 'localServices.launcher.openPreview',
            input: { machineId: 'machine_1', targetId: 'inventory:entry_1' },
        }));
        expect((open as { status?: string }).status).toBe('opened');

        const register = await execute(runtimeArgs({
            actionId: 'localServices.launcher.registerPreview',
            input: { machineId: 'machine_1', targetId: 'inventory:entry_1' },
        }));
        expect((register as { status?: string }).status).toBe('registered');

        const cleared = await execute(runtimeArgs({
            actionId: 'localServices.launcher.history.clear',
            input: { machineId: 'machine_1' },
        }));
        expect((cleared as { cleared?: number }).cleared).toBe(2);

        expect(leaves.openPreview).toHaveBeenCalledOnce();
        expect(leaves.registerPreview).toHaveBeenCalledOnce();
        expect(leaves.clearHistory).toHaveBeenCalledOnce();
    });

    it('opens the requested inventory listener and Session through real private-preview registration', async () => {
        const { createLocalServicesDaemonRuntimeActionExecutor } = await import('./runtimeActionExecutor');
        const inventoryRegistry = createLocalServiceInventoryRegistry();
        inventoryRegistry.replaceSnapshot({
            v: 1, machineId: 'machine_1', generatedAt: 1_000, refreshState: 'idle', diagnostics: [],
            entries: [{
                id: 'entry_1', machineId: 'machine_1',
                address: { kind: 'loopback', host: '127.0.0.1', family: 'ipv4' },
                endpoint: { scheme: 'http', host: '127.0.0.1', port: 5173, probeState: 'ready', probedAt: 1_000 },
                port: 5173, protocol: 'tcp', detectedAt: 1_000, lastSeenAt: 1_000,
                state: 'listening', source: 'detected', labels: [], diagnostics: [],
                confidence: 'high', processOwnershipConfidence: 'high', workspaceAssociationConfidence: 'high',
            }],
        });
        const previewRoutes = createLocalServicePreviewRoutes({
            machineId: 'machine_1', accountId: 'account_1', inventoryRegistry, registry: createLocalServicePreviewRegistry(),
            server: {
                token: 'daemon-token', serverBaseUrl: 'https://home.example.test',
                // The server transport is the genuine boundary; request mapping and lifecycle are real.
                http: {
                    async post(_url, body) {
                        const resource = LocalServicePreviewResourceV1Schema.parse(body);
                        return { data: { resource, accessUrl: 'https://private.example.test/?previewToken=admission', expiresAt: 61_000 } };
                    },
                    async delete() { return { data: { ok: true } }; },
                },
            },
        });
        const execute = createLocalServicesDaemonRuntimeActionExecutor({
            featureGate: allowAllFeatureGate,
            routes: { previewRoutes },
        });

        const result = await execute(runtimeArgs({
            actionId: 'localServices.preview.openOrCreate',
            input: { machineId: 'machine_1', sessionId: 'session_1', targetId: 'entry_1' },
        }));

        const snapshot = await previewRoutes.getSnapshot();
        expect(snapshot.resources).toHaveLength(1);
        expect(snapshot.resources[0]).toMatchObject({
            machineId: 'machine_1', sessionId: 'session_1', owner: { kind: 'session', id: 'session_1' },
            target: { scheme: 'http', host: '127.0.0.1', port: 5173 },
        });
        expect(result).toMatchObject({
            status: 'created', preview: { resource: snapshot.resources[0], accessUrl: 'https://private.example.test/?previewToken=admission' },
        });
    });

    it('surfaces a preview lifecycle refusal reasonCode instead of a generic disable', async () => {
        const mod = await import('./runtimeActionExecutor').catch(() => null);
        if (!mod?.createLocalServicesDaemonRuntimeActionExecutor) return;

        const execute = mod.createLocalServicesDaemonRuntimeActionExecutor({
            featureGate: allowAllFeatureGate,
            routes: {
                previewRoutes: {
                    getSnapshot: vi.fn(),
                    openOrCreate: vi.fn(async () => ({ ok: false as const, reasonCode: 'unknown_inventory_entry' })),
                    revoke: vi.fn(),
                },
            },
        });

        await expect(execute(runtimeArgs({
            actionId: 'localServices.preview.openOrCreate',
            input: { machineId: 'machine_1', targetId: 'nope' },
        }))).resolves.toEqual({
            ok: false,
            errorCode: 'runtime_action_disabled',
            error: 'runtime_action_disabled:localServices:preview_unknown_inventory_entry',
        });
    });

    it('forgets the actual inventory entry through the canonical daemon Action owner', async () => {
        const mod = await import('./runtimeActionExecutor').catch(() => null);

        expect(mod?.createLocalServicesDaemonRuntimeActionExecutor).toBeTypeOf('function');
        if (!mod?.createLocalServicesDaemonRuntimeActionExecutor) return;

        const { routes: actionRoutes, registry } = createObservedActionRoutes();
        const execute = mod.createLocalServicesDaemonRuntimeActionExecutor({
            featureGate: allowAllFeatureGate,
            routes: { actionRoutes },
        });
        const request = {
            requestId: 'request_1',
            target: { kind: 'inventory_entry' as const, inventoryEntryId: 'entry_1', machineId: 'machine_1' },
            action: 'forget' as const,
            force: false,
        };

        await expect(execute(runtimeArgs({
            actionId: 'localServices.actions.forget',
            input: request,
        }))).resolves.toMatchObject({ requestId: request.requestId, action: 'forget', status: 'succeeded', undoKey: expect.any(String) });
        expect(registry.getSnapshot().entries).toEqual([]);
    });

    it('rejects a local-service request whose action does not match its Action id', async () => {
        const mod = await import('./runtimeActionExecutor').catch(() => null);

        expect(mod?.createLocalServicesDaemonRuntimeActionExecutor).toBeTypeOf('function');
        if (!mod?.createLocalServicesDaemonRuntimeActionExecutor) return;

        const actionRoutes: Pick<LocalServiceActionRoutes, 'execute'> = {
            execute: vi.fn(async () => actionResult),
        };
        const execute = mod.createLocalServicesDaemonRuntimeActionExecutor({
            featureGate: allowAllFeatureGate,
            routes: { actionRoutes },
        });

        await expect(execute(runtimeArgs({
            actionId: 'localServices.actions.copyUrl',
            input: {
                requestId: 'request_stop',
                target: {
                    kind: 'managed_service',
                    managedServiceId: 'managed_1',
                    machineId: 'machine_1',
                },
                action: 'stop_managed',
                confirmationNonce: 'confirmation_1',
                force: false,
            },
        }))).resolves.toEqual({
            ok: false,
            errorCode: 'invalid_parameters',
            error: 'invalid_parameters',
        });
        expect(actionRoutes.execute).not.toHaveBeenCalled();
    });

    it('routes localServices.launcher.start through the daemon launcher start route', async () => {
        const mod = await import('./runtimeActionExecutor').catch(() => null);

        expect(mod?.createLocalServicesDaemonRuntimeActionExecutor).toBeTypeOf('function');
        if (!mod?.createLocalServicesDaemonRuntimeActionExecutor) return;

        const launcherRoutes = {
            getSnapshot: vi.fn(async () => launcherSnapshot),
            startTarget: vi.fn(async () => launcherStartResponse),
        };
        const execute = mod.createLocalServicesDaemonRuntimeActionExecutor({
            featureGate: allowAllFeatureGate,
            routes: { launcherRoutes },
        });
        const request = {
            machineId: 'machine_1',
            targetId: 'managed:web',
            sessionId: 'session_1',
        };

        await expect(execute(runtimeArgs({
            actionId: 'localServices.launcher.start',
            input: request,
        }))).resolves.toEqual(launcherStartResponse);
        expect(launcherRoutes.getSnapshot).not.toHaveBeenCalled();
    });

    it('fails localServices.launcher.start closed when the daemon start route is unavailable', async () => {
        const mod = await import('./runtimeActionExecutor').catch(() => null);

        expect(mod?.createLocalServicesDaemonRuntimeActionExecutor).toBeTypeOf('function');
        if (!mod?.createLocalServicesDaemonRuntimeActionExecutor) return;

        const execute = mod.createLocalServicesDaemonRuntimeActionExecutor({
            featureGate: allowAllFeatureGate,
            routes: { launcherRoutes: { getSnapshot: vi.fn(async () => launcherSnapshot) } },
        });

        await expect(execute(runtimeArgs({
            actionId: 'localServices.launcher.start',
            input: {
                machineId: 'machine_1',
                targetId: 'managed:web',
            },
        }))).resolves.toEqual({
            ok: false,
            errorCode: 'runtime_action_disabled',
            error: 'runtime_action_disabled:localServices:local_services_launcher_start_route_unavailable',
        });
    });

    it('rejects invalid localServices.launcher.start input before route dispatch', async () => {
        const mod = await import('./runtimeActionExecutor').catch(() => null);

        expect(mod?.createLocalServicesDaemonRuntimeActionExecutor).toBeTypeOf('function');
        if (!mod?.createLocalServicesDaemonRuntimeActionExecutor) return;

        const launcherRoutes = {
            getSnapshot: vi.fn(async () => launcherSnapshot),
            startTarget: vi.fn(async () => launcherStartResponse),
        };
        const execute = mod.createLocalServicesDaemonRuntimeActionExecutor({
            featureGate: allowAllFeatureGate,
            routes: { launcherRoutes },
        });

        await expect(execute(runtimeArgs({
            actionId: 'localServices.launcher.start',
            input: { machineId: 'machine_1' },
        }))).resolves.toEqual({
            ok: false,
            errorCode: 'invalid_parameters',
            error: 'invalid_parameters',
        });
        expect(launcherRoutes.startTarget).not.toHaveBeenCalled();
    });

    it('refuses a managed Stop whose actual owner has no such service', async () => {
        const mod = await import('./runtimeActionExecutor').catch(() => null);

        expect(mod?.createLocalServicesDaemonRuntimeActionExecutor).toBeTypeOf('function');
        if (!mod?.createLocalServicesDaemonRuntimeActionExecutor) return;

        const { routes: actionRoutes, registry } = createObservedActionRoutes();
        const execute = mod.createLocalServicesDaemonRuntimeActionExecutor({
            featureGate: allowAllFeatureGate,
            routes: { actionRoutes },
        });
        const request = {
            requestId: 'request_stop',
            target: { kind: 'managed_service' as const, managedServiceId: 'managed_1', machineId: 'machine_1' },
            action: 'stop_managed' as const,
            confirmationNonce: 'confirm_stop',
            force: false,
        };

        await expect(execute(runtimeArgs({
            actionId: 'localServices.actions.stopManaged',
            input: request,
        }))).resolves.toMatchObject({ requestId: request.requestId, action: 'stop_managed', status: 'denied', reasonCode: 'unknown_managed_service' });
        expect(registry.getSnapshot().entries[0]?.state).toBe('listening');
    });

    it('fails localServices.actions closed when the daemon action route is unavailable', async () => {
        const mod = await import('./runtimeActionExecutor').catch(() => null);

        expect(mod?.createLocalServicesDaemonRuntimeActionExecutor).toBeTypeOf('function');
        if (!mod?.createLocalServicesDaemonRuntimeActionExecutor) return;

        const execute = mod.createLocalServicesDaemonRuntimeActionExecutor({ routes: {}, featureGate: allowAllFeatureGate });

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
            error: 'runtime_action_disabled:localServices:local_services_action_routes_unavailable',
        });
    });

    // Route-contract test: it asserts the RAW public URL, so it must state the surface it really
    // models (a user driving the services pane). An unattributed caller is now treated as
    // agent-reachable and redacted (INV-1 / DEC-2), which is a different contract, covered below.
    it('routes localServices.publicPreview controls through daemon public-preview routes', async () => {
        const mod = await import('./runtimeActionExecutor').catch(() => null);

        expect(mod?.createLocalServicesDaemonRuntimeActionExecutor).toBeTypeOf('function');
        if (!mod?.createLocalServicesDaemonRuntimeActionExecutor) return;

        let currentExposure = publicExposure;
        const publicPreviewRoutes = createLocalServicePublicPreviewServerRoutes({ token: 'daemon-token',
            serverBaseUrl: 'https://home.example.test', http: {
                async post(url) {
                    return { data: url.endsWith('/status')
                        ? { protocolVersion: 1, snapshot: { ...publicPreviewSnapshot, exposures: [currentExposure] } }
                        : { exposure: currentExposure } };
                },
                async delete() {
                    currentExposure = { ...currentExposure, state: 'revoked', revokedAt: 3_100 };
                    return { data: { ok: true } };
                },
            } });
        const execute = mod.createLocalServicesDaemonRuntimeActionExecutor({
            featureGate: allowAllFeatureGate,
            routes: { publicPreviewRoutes },
        });

        await expect(execute(runtimeArgs({
            actionId: 'localServices.publicPreview.status',
            input: {
                machineId: 'machine_1',
                sessionId: 'session_1',
                previewId: 'preview_1',
            },
            context: { surface: 'ui' },
        }))).resolves.toEqual(publicPreviewSnapshot);

        const createRequest = {
            machineId: 'machine_1',
            sessionId: 'session_1',
            previewId: 'preview_1',
            mode: 'secret_link' as const,
            ttlMs: 600_000,
            // UX-5: the daemon requires an explicit acknowledged confirmation to expose a service.
            confirmation: { acknowledged: true as const },
        };
        await expect(execute(runtimeArgs({
            actionId: 'localServices.publicPreview.create',
            input: createRequest,
            context: { surface: 'ui' },
        }))).resolves.toMatchObject({
            protocolVersion: 1,
            exposure: publicExposure,
        });

        const revokeRequest = {
            machineId: 'machine_1',
            sessionId: 'session_1',
            previewId: 'preview_1',
            exposureId: 'public_preview_1',
        };
        await expect(execute(runtimeArgs({
            actionId: 'localServices.publicPreview.copyUrl', input: revokeRequest, context: { surface: 'ui' },
        }))).resolves.toMatchObject({ protocolVersion: 1, publicUrl: publicExposure.publicUrl });
        await expect(execute(runtimeArgs({
            actionId: 'localServices.publicPreview.revoke',
            input: revokeRequest,
            context: { surface: 'ui' },
        }))).resolves.toMatchObject({
            protocolVersion: 1,
            exposureId: 'public_preview_1',
        });
        expect(currentExposure.state).toBe('revoked');

        await expect(execute(runtimeArgs({
            actionId: 'localServices.publicPreview.copyUrl',
            input: revokeRequest,
        }))).rejects.toThrow('local_services_public_preview_exposure_unavailable');
    });

    it('redacts public-preview status URLs for agent-surface egress', async () => {
        const mod = await import('./runtimeActionExecutor').catch(() => null);

        expect(mod?.createLocalServicesDaemonRuntimeActionExecutor).toBeTypeOf('function');
        if (!mod?.createLocalServicesDaemonRuntimeActionExecutor) return;

        const publicPreviewRoutes = {
            getStatus: vi.fn(async () => publicPreviewSnapshot),
            createExposure: vi.fn(),
            revokeExposure: vi.fn(),
            copyUrl: vi.fn(),
        };
        const execute = mod.createLocalServicesDaemonRuntimeActionExecutor({
            featureGate: allowAllFeatureGate,
            routes: { publicPreviewRoutes } as never,
        });

        const result = await execute(runtimeArgs({
            actionId: 'localServices.publicPreview.status',
            input: {
                machineId: 'machine_1',
                sessionId: 'session_1',
                previewId: 'preview_1',
            },
            context: { surface: 'agent' },
        })) as LocalServicePublicPreviewSnapshotV1;

        expect(result.exposures[0]?.publicUrl).toBe(REDACTED_LOCAL_SERVICE_PUBLIC_PREVIEW_URL);
        expect(publicPreviewRoutes.getStatus).toHaveBeenCalledOnce();
    });

    // INV-1 / DEC-2: the egress predicate resolves the SAME way as the consent layer — an
    // unknown or missing surface is treated as agent-reachable, so the secret public URL is
    // redacted rather than egressed raw. Previously this branch tested `surface === 'agent'`
    // and handed the raw URL to every other value, including `undefined`.
    it('redacts public-preview status URLs when the caller stamps no surface (fail closed)', async () => {
        const mod = await import('./runtimeActionExecutor');

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
                snapshot: publicPreviewSnapshot,
            })),
            copyUrl: vi.fn(),
        };
        const execute = mod.createLocalServicesDaemonRuntimeActionExecutor({
            featureGate: allowAllFeatureGate,
            routes: { publicPreviewRoutes } as never,
        });

        const unattributed = await execute(runtimeArgs({
            actionId: 'localServices.publicPreview.status',
            input: { machineId: 'machine_1', sessionId: 'session_1', previewId: 'preview_1' },
        })) as LocalServicePublicPreviewSnapshotV1;
        expect(unattributed.exposures[0]?.publicUrl).toBe(REDACTED_LOCAL_SERVICE_PUBLIC_PREVIEW_URL);

        const unknownSurface = await execute(runtimeArgs({
            actionId: 'localServices.publicPreview.status',
            input: { machineId: 'machine_1', sessionId: 'session_1', previewId: 'preview_1' },
            context: { surface: 'not_a_surface' as never },
        })) as LocalServicePublicPreviewSnapshotV1;
        expect(unknownSurface.exposures[0]?.publicUrl).toBe(REDACTED_LOCAL_SERVICE_PUBLIC_PREVIEW_URL);

        const createResult = await execute(runtimeArgs({
            actionId: 'localServices.publicPreview.create',
            input: {
                machineId: 'machine_1',
                sessionId: 'session_1',
                previewId: 'preview_1',
                mode: 'secret_link',
                ttlMs: 600_000,
                confirmation: { acknowledged: true },
            },
        })) as { exposure: LocalServicePublicExposureV1 };
        expect(createResult.exposure.publicUrl).toBe(REDACTED_LOCAL_SERVICE_PUBLIC_PREVIEW_URL);

        const revokeResult = await execute(runtimeArgs({
            actionId: 'localServices.publicPreview.revoke',
            input: {
                machineId: 'machine_1',
                sessionId: 'session_1',
                previewId: 'preview_1',
                exposureId: 'public_preview_1',
            },
        })) as { snapshot: LocalServicePublicPreviewSnapshotV1 };
        expect(revokeResult.snapshot.exposures[0]?.publicUrl).toBe(REDACTED_LOCAL_SERVICE_PUBLIC_PREVIEW_URL);

        // A known non-agent surface still receives the real URL — the fix must not redact
        // everything unconditionally.
        const uiResult = await execute(runtimeArgs({
            actionId: 'localServices.publicPreview.status',
            input: { machineId: 'machine_1', sessionId: 'session_1', previewId: 'preview_1' },
            context: { surface: 'ui' },
        })) as LocalServicePublicPreviewSnapshotV1;
        expect(uiResult.exposures[0]?.publicUrl).toBe('https://preview.example.test/s/public_preview_1');
    });

    it('redacts public-preview create and revoke response URLs for agent-surface egress', async () => {
        const mod = await import('./runtimeActionExecutor').catch(() => null);

        expect(mod?.createLocalServicesDaemonRuntimeActionExecutor).toBeTypeOf('function');
        if (!mod?.createLocalServicesDaemonRuntimeActionExecutor) return;

        const revokedSnapshot: LocalServicePublicPreviewSnapshotV1 = {
            ...publicPreviewSnapshot,
            exposures: [{ ...publicExposure, state: 'revoked', revokedAt: 3_100 }],
        };
        const publicPreviewRoutes = {
            getStatus: vi.fn(),
            createExposure: vi.fn(async () => ({
                protocolVersion: 1 as const,
                exposure: publicExposure,
                snapshot: publicPreviewSnapshot,
            })),
            revokeExposure: vi.fn(async () => ({
                protocolVersion: 1 as const,
                exposureId: 'public_preview_1',
                revokedAt: 3_100,
                snapshot: revokedSnapshot,
            })),
            copyUrl: vi.fn(),
        };
        const execute = mod.createLocalServicesDaemonRuntimeActionExecutor({
            featureGate: allowAllFeatureGate,
            routes: { publicPreviewRoutes } as never,
        });

        const createResult = await execute(runtimeArgs({
            actionId: 'localServices.publicPreview.create',
            input: {
                machineId: 'machine_1',
                sessionId: 'session_1',
                previewId: 'preview_1',
                mode: 'secret_link',
                ttlMs: 600_000,
                confirmation: { acknowledged: true },
            },
            context: { surface: 'agent' },
        })) as { exposure: LocalServicePublicExposureV1; snapshot?: LocalServicePublicPreviewSnapshotV1 };
        const revokeResult = await execute(runtimeArgs({
            actionId: 'localServices.publicPreview.revoke',
            input: {
                machineId: 'machine_1',
                sessionId: 'session_1',
                previewId: 'preview_1',
                exposureId: 'public_preview_1',
            },
            context: { surface: 'agent' },
        })) as { snapshot: LocalServicePublicPreviewSnapshotV1 };

        expect(createResult.exposure.publicUrl).toBe(REDACTED_LOCAL_SERVICE_PUBLIC_PREVIEW_URL);
        expect(createResult.snapshot?.exposures[0]?.publicUrl).toBe(REDACTED_LOCAL_SERVICE_PUBLIC_PREVIEW_URL);
        expect(revokeResult.snapshot.exposures[0]?.publicUrl).toBe(REDACTED_LOCAL_SERVICE_PUBLIC_PREVIEW_URL);
        expect(publicPreviewRoutes.createExposure).toHaveBeenCalledOnce();
        expect(publicPreviewRoutes.revokeExposure).toHaveBeenCalledOnce();
    });

    // UX-5: a non-UI/agent caller must NOT be able to expose a service without consent. The daemon
    // rejects a create request that lacks the acknowledged confirmation, even when routes are present.
    it('rejects publicPreview.create without an acknowledged confirmation token', async () => {
        const mod = await import('./runtimeActionExecutor');
        const publicPreviewRoutes = {
            getStatus: vi.fn(async () => publicPreviewSnapshot),
            createExposure: vi.fn(async () => ({
                protocolVersion: 1 as const,
                exposure: publicExposure,
                snapshot: publicPreviewSnapshot,
            })),
            revokeExposure: vi.fn(),
            copyUrl: vi.fn(),
        };
        const execute = mod.createLocalServicesDaemonRuntimeActionExecutor({
            featureGate: allowAllFeatureGate,
            routes: { publicPreviewRoutes } as never,
        });

        await expect(execute(runtimeArgs({
            actionId: 'localServices.publicPreview.create',
            input: {
                machineId: 'machine_1',
                sessionId: 'session_1',
                previewId: 'preview_1',
                mode: 'secret_link' as const,
                ttlMs: 600_000,
            },
        }))).resolves.toMatchObject({
            ok: false,
            error: 'runtime_action_disabled:localServices:local_services_public_preview_confirmation_required',
        });
        expect(publicPreviewRoutes.createExposure).not.toHaveBeenCalled();
    });

    // Execution-boundary fail-closed gate. A server that disables a local-service feature must
    // refuse the action at the daemon, even when the backing route owner is present.
    const gateWith = (
        enabled: Partial<Record<LocalServicesDaemonFeatureGateId, boolean>>,
    ): LocalServicesDaemonFeatureGate => ({
        isEnabled: (id) => enabled[id] === true,
        refresh: async () => {},
    });

    // OWNER-GATE closure (mirrors the browser daemon executor): the gate is required, and a
    // JavaScript / stale compiled caller that omits it must still fail closed for EVERY
    // local-services family before any route dispatch — never silently disable all gating.
    it.each([
        {
            name: 'inventory',
            actionId: 'localServices.inventory.list' as const,
            input: { machineId: 'machine_1' },
            refusedFeatureId: 'localServices.inventory',
        },
        {
            name: 'launcher',
            actionId: 'localServices.launcher.snapshot' as const,
            input: { machineId: 'machine_1' },
            refusedFeatureId: 'localServices.launcher',
        },
        {
            name: 'preview',
            actionId: 'localServices.preview.status' as const,
            input: { machineId: 'machine_1' },
            refusedFeatureId: 'localServices.preview',
        },
        {
            name: 'publicPreview',
            actionId: 'localServices.publicPreview.status' as const,
            input: { machineId: 'machine_1', sessionId: 'session_1' },
            refusedFeatureId: 'localServices.publicPreview',
        },
        {
            name: 'actions',
            actionId: 'localServices.actions.terminateDetected' as const,
            input: { machineId: 'machine_1', inventoryId: 'svc_1', port: 3_000, confirm: true },
            refusedFeatureId: 'localServices.actions',
        },
    ])('fails closed for the $name family when an untyped caller omits the feature gate', async ({ actionId, input, refusedFeatureId }) => {
        const mod = await import('./runtimeActionExecutor');
        const inventoryRoutes = {
            getSnapshot: vi.fn(async () => inventorySnapshot),
            refreshSnapshot: vi.fn(async () => inventorySnapshot),
        };
        const launcherRoutes = {
            getSnapshot: vi.fn(async () => launcherSnapshot),
        };
        const unsafeInput = {
            routes: { inventoryRoutes, launcherRoutes },
        };
        // Boundary fixture: deliberately simulates a JavaScript/stale compiled caller omitting the
        // required gate, which TypeScript (correctly) forbids for typed callers.
        const execute = mod.createLocalServicesDaemonRuntimeActionExecutor(
            unsafeInput as unknown as Parameters<typeof mod.createLocalServicesDaemonRuntimeActionExecutor>[0],
        );

        await expect(execute(runtimeArgs({ actionId, input }))).resolves.toMatchObject({
            ok: false,
            errorCode: 'runtime_action_disabled',
            error: `runtime_action_disabled:localServices:feature_disabled:${refusedFeatureId}`,
        });
        expect(inventoryRoutes.getSnapshot).not.toHaveBeenCalled();
        expect(launcherRoutes.getSnapshot).not.toHaveBeenCalled();
    });

    it('refuses launcher.start at the execution boundary when localServices.launcher is disabled', async () => {
        const mod = await import('./runtimeActionExecutor');
        const launcherRoutes = {
            getSnapshot: vi.fn(async () => launcherSnapshot),
            startTarget: vi.fn(async () => launcherStartResponse),
        };
        const execute = mod.createLocalServicesDaemonRuntimeActionExecutor({
            routes: { launcherRoutes },
            featureGate: gateWith({ 'localServices.launcher': false }),
        });

        await expect(execute(runtimeArgs({
            actionId: 'localServices.launcher.start',
            input: { machineId: 'machine_1', targetId: 'managed:web', sessionId: 'session_1' },
        }))).resolves.toEqual({
            ok: false,
            errorCode: 'runtime_action_disabled',
            error: 'runtime_action_disabled:localServices:feature_disabled:localServices.launcher',
        });
        expect(launcherRoutes.startTarget).not.toHaveBeenCalled();
    });

    it('refuses managed actions when localServices.managed is disabled even with actions enabled', async () => {
        const mod = await import('./runtimeActionExecutor');
        const actionRoutes: Pick<LocalServiceActionRoutes, 'execute'> = {
            execute: vi.fn(async () => actionResult),
        };
        const execute = mod.createLocalServicesDaemonRuntimeActionExecutor({
            routes: { actionRoutes },
            featureGate: gateWith({ 'localServices.actions': true, 'localServices.managed': false }),
        });

        await expect(execute(runtimeArgs({
            actionId: 'localServices.actions.stopManaged',
            input: {
                requestId: 'request_stop',
                target: { kind: 'managed_service', managedServiceId: 'managed_1', machineId: 'machine_1' },
                action: 'stop_managed',
                confirmationNonce: 'confirm_stop',
                force: false,
            },
        }))).resolves.toEqual({
            ok: false,
            errorCode: 'runtime_action_disabled',
            error: 'runtime_action_disabled:localServices:feature_disabled:localServices.managed',
        });
        expect(actionRoutes.execute).not.toHaveBeenCalled();
    });

    it('refuses terminateDetected when localServices.actions.terminate is disabled', async () => {
        const mod = await import('./runtimeActionExecutor');
        const actionRoutes: Pick<LocalServiceActionRoutes, 'execute'> = {
            execute: vi.fn(async () => actionResult),
        };
        const execute = mod.createLocalServicesDaemonRuntimeActionExecutor({
            routes: { actionRoutes },
            featureGate: gateWith({ 'localServices.actions': true, 'localServices.actions.terminate': false }),
        });

        await expect(execute(runtimeArgs({
            actionId: 'localServices.actions.terminateDetected',
            input: {
                requestId: 'request_terminate',
                target: { kind: 'inventory_entry', inventoryEntryId: 'entry_1', machineId: 'machine_1' },
                action: 'terminate_detected',
                confirmationNonce: 'confirm_terminate',
                force: false,
            },
        }))).resolves.toEqual({
            ok: false,
            errorCode: 'runtime_action_disabled',
            error: 'runtime_action_disabled:localServices:feature_disabled:localServices.actions.terminate',
        });
        expect(actionRoutes.execute).not.toHaveBeenCalled();
    });

    it('refuses preview.status when localServices.preview is disabled', async () => {
        const mod = await import('./runtimeActionExecutor');
        const previewRoutes = { getSnapshot: vi.fn(async () => publicPreviewSnapshot) };
        const execute = mod.createLocalServicesDaemonRuntimeActionExecutor({
            routes: { previewRoutes } as never,
            featureGate: gateWith({ 'localServices.preview': false }),
        });

        await expect(execute(runtimeArgs({
            actionId: 'localServices.preview.status',
            input: { machineId: 'machine_1', sessionId: 'session_1' },
        }))).resolves.toEqual({
            ok: false,
            errorCode: 'runtime_action_disabled',
            error: 'runtime_action_disabled:localServices:feature_disabled:localServices.preview',
        });
        expect(previewRoutes.getSnapshot).not.toHaveBeenCalled();
    });

    it('refuses publicPreview.create when localServices.publicPreview is disabled', async () => {
        const mod = await import('./runtimeActionExecutor');
        const publicPreviewRoutes = {
            getStatus: vi.fn(async () => publicPreviewSnapshot),
            createExposure: vi.fn(async () => ({
                protocolVersion: 1 as const,
                exposure: publicExposure,
                snapshot: publicPreviewSnapshot,
            })),
            revokeExposure: vi.fn(),
            copyUrl: vi.fn(),
        };
        const execute = mod.createLocalServicesDaemonRuntimeActionExecutor({
            routes: { publicPreviewRoutes } as never,
            featureGate: gateWith({ 'localServices.publicPreview': false }),
        });

        await expect(execute(runtimeArgs({
            actionId: 'localServices.publicPreview.create',
            input: {
                machineId: 'machine_1',
                sessionId: 'session_1',
                previewId: 'preview_1',
                mode: 'secret_link',
                ttlMs: 600_000,
            },
        }))).resolves.toEqual({
            ok: false,
            errorCode: 'runtime_action_disabled',
            error: 'runtime_action_disabled:localServices:feature_disabled:localServices.publicPreview',
        });
        expect(publicPreviewRoutes.createExposure).not.toHaveBeenCalled();
    });

    it('still executes a governed action when the gate enables its feature', async () => {
        const mod = await import('./runtimeActionExecutor');
        const { routes: actionRoutes, registry } = createObservedActionRoutes();
        const execute = mod.createLocalServicesDaemonRuntimeActionExecutor({
            routes: { actionRoutes },
            featureGate: gateWith({ 'localServices.actions': true }),
        });
        const request = {
            requestId: 'request_1',
            target: { kind: 'inventory_entry' as const, inventoryEntryId: 'entry_1', machineId: 'machine_1' },
            action: 'copy_url' as const,
            force: false,
        };

        await expect(execute(runtimeArgs({
            actionId: 'localServices.actions.copyUrl',
            input: request,
        }))).resolves.toMatchObject({ requestId: request.requestId, action: 'copy_url', status: 'succeeded' });
        expect(registry.getSnapshot().entries[0]?.state).toBe('listening');
    });
});
