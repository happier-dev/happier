import { describe, expect, it } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { LocalServicePreviewSnapshotV1 } from '@happier-dev/protocol';
import {
    DaemonLocalServicePreviewOpenOrCreateResponseV1Schema,
    DaemonLocalServicePreviewRevokeResponseV1Schema,
    LocalServicePreviewResourceV1Schema,
} from '@happier-dev/protocol';
import type { RpcHandlerRegistrar } from '@/api/rpc/types';

import {
    isDaemonLocalServicePreviewLifecycleError,
    registerDaemonLocalServicePreviewSnapshotHandler,
} from './daemonLocalServicePreviewSnapshot';
import { createLocalServicePreviewRoutes } from '@/daemon/local/services/preview/routes';
import { createLocalServicePreviewRegistry } from '@/daemon/local/services/preview/registry';
import { createLocalServiceInventoryRegistry } from '@/daemon/local/services/inventory/registry';
import type { NormalizedLocalServiceInventoryEntry } from '@/daemon/local/services/inventory/scanner';
import { createManagedServicesOwner } from '@/plugins/runtime/invocation/services/managedServicesOwner';
import { createManagedServiceProcessSupervisorHost } from '@/plugins/runtime/invocation/services/managedProcessSupervisor';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { authorizeMachineRpcRequest } from '@/api/machine/machineRpcAuthorization';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { reloadConfiguration } from '@/configuration';
import { addServerProfile, adoptServerProfileHomeConnectionDescriptor } from '@/server/serverProfiles';

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
        accountId: 'account-lifecycle',
        registry: createLocalServicePreviewRegistry(),
        inventoryRegistry,
        now: () => 1_000,
        // Substitute only the HTTP boundary; registration, scope and RPC projection remain real.
        server: {
            token: 'daemon-token',
            serverBaseUrl: 'https://home.example.test',
            http: {
                async post(_url, body) {
                    const resource = LocalServicePreviewResourceV1Schema.parse(body);
                    return { data: { resource, accessUrl: 'https://private.preview.example.test/?previewToken=admission', expiresAt: 61_000 } };
                },
                async delete() { return { data: { ok: true } }; },
            },
        },
    });
}

describe('daemon local service preview snapshot rpc handler', () => {
    it('admits and retires a declared Service addressed by the exact Home identity of its daemon profile', async () => {
        const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_ACTIVE_SERVER_ID', 'HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL']);
        await withTempDir('happier-preview-home-', async homeDir => {
            env.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_ACTIVE_SERVER_ID: undefined,
                HAPPIER_SERVER_URL: undefined, HAPPIER_WEBAPP_URL: undefined });
            reloadConfiguration();
            const owner = createManagedServicesOwner({
                processSupervisorHost: createManagedServiceProcessSupervisorHost({ custodyOwner: 'daemon' }),
                dependencies: Object.freeze({}) as never, resolveScope: scope => scope,
            });
            try {
                const profile = await addServerProfile({ name: 'preview-daemon', serverUrl: 'https://home.example.test', webappUrl: 'https://home.example.test' });
                const homeId = 'srv_preview_home';
                const workspace = { id: 'workspace-preview', serverId: homeId, machineId: LIFECYCLE_MACHINE_ID,
                    rootPath: homeDir, createdAtMs: 1 };
                const declaration = { workspaceRefId: workspace.id, selection: { kind: 'manifest' as const, name: 'web' } };
                let stopped = false;
                const handle = await owner.superviseProject({ kind: 'workspace', workspace, declaration, cwd: homeDir,
                    serviceId: 'declared-web', specIdentity: 'declared-web', isCurrent: () => true,
                    requester: { serverId: homeId, accountId: 'starter', machineId: workspace.machineId, installationId: 'installation' },
                    // Only the external native process lifecycle is substituted.
                    processSpec: { mode: { kind: 'native',
                        instance: { adapter: { pluginId: 'fixture.plugin', localId: 'web' }, nativeResourceId: 'preview-web' },
                        lifecycle: { inspect: async () => ({ phase: stopped ? 'stopped' : 'running', readiness: 'ready', endpoint: 'http://127.0.0.1:4312' }),
                            stop: async () => { stopped = true; return { status: 'stopped' }; } } } },
                    authorizeLaunch: async () => ({ command: process.execPath, args: ['-e', ''], env: {}, release: async () => undefined }),
                });
                let verifications = 0;
                const rpc = new RpcHandlerManager({ scopePrefix: workspace.machineId, localMachineId: workspace.machineId,
                    encryptionMode: 'plain', logger() {}, authorizeRequest: request => authorizeMachineRpcRequest(request, {
                        machineId: workspace.machineId, resolveCustodianAccountId: async () => 'starter',
                        resolveInstallationId: () => 'installation', verifyMachineAdmission: async () => { verifications++; return true; },
                    }) });
                registerDaemonLocalServicePreviewSnapshotHandler(rpc, { projectManagedServices: owner,
                    machineId: workspace.machineId, serverId: profile.id });
                const target = { kind: 'managed_service', machineId: workspace.machineId, managedServiceId: handle.instanceId,
                    workspaceId: workspace.id, cwd: homeDir, declaration };
                const read = () => rpc.handleRequest({ method: `${workspace.machineId}:${RPC_METHODS.DAEMON_LOCAL_SERVICES_PREVIEW_ADMISSION}`,
                    params: { v: 1, kind: 'read', target }, authorization: { kind: 'localServices.preview.admission.serverOrigin' },
                    machineAdmission: { actorAccountId: 'starter', custodianAccountId: 'starter', machineId: workspace.machineId,
                        installationId: 'installation', role: 'manage', encryptionMode: 'plain' } });
                expect(await read()).toMatchObject({ kind: 'refused', reasonCode: 'service_unavailable' });
                await adoptServerProfileHomeConnectionDescriptor({ expectedProfileId: profile.id, observation: 'exact',
                    descriptor: { v: 1, homeServerIdentityId: homeId, canonicalServerUrl: profile.serverUrl,
                        revision: 1, endpoints: [{ kind: 'https', url: profile.serverUrl }] } });
                const beforeRead = verifications;
                expect(await read()).toMatchObject({ v: 1, kind: 'admitted', instanceId: handle.instanceId,
                    serviceTarget: target, starterAccountId: 'starter', endpoint: { scheme: 'http', host: '127.0.0.1', port: 4312 } });
                expect(verifications - beforeRead).toBe(1);
                await handle.stop();
                expect(stopped).toBe(true);
                expect(await read()).toMatchObject({ kind: 'refused', reasonCode: 'service_unavailable' });
            } finally {
                await owner.dispose();
                env.restore();
                reloadConfiguration();
            }
        });
    });

    it('preserves the installed preview snapshot when another registration has no preview owner', async () => {
        const { handlers, registrar } = createRegistrar();
        const routes = createLifecycleRoutes();
        registerDaemonLocalServicePreviewSnapshotHandler(registrar, { localServicesPreview: routes });

        // Project admission can be registered separately from the preview owner.
        // A registration without that owner must not replace its snapshot reader.
        registerDaemonLocalServicePreviewSnapshotHandler(registrar, {});

        await expect(handlers.get(RPC_METHODS.DAEMON_LOCAL_SERVICES_PREVIEW_SNAPSHOT)?.({
            machineId: LIFECYCLE_MACHINE_ID,
        })).resolves.toEqual({ protocolVersion: 1, snapshot: await routes.getSnapshot() });
    });

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

        const response = DaemonLocalServicePreviewOpenOrCreateResponseV1Schema.parse(await handlers.get(RPC_METHODS.DAEMON_LOCAL_SERVICES_PREVIEW_OPEN_OR_CREATE)?.({
            machineId: LIFECYCLE_MACHINE_ID,
            sessionId: 'session-1',
            inventoryEntryId: 'entry-vite',
        }));

        expect(response.status).toBe('created');
        expect(response.protocolVersion).toBe(1);
        expect(response.preview.accessUrl).toBe('https://private.preview.example.test/?previewToken=admission');
        expect(response.preview.resource.browserTarget).toMatchObject({
            kind: 'localServicePreview', machineId: LIFECYCLE_MACHINE_ID, sessionId: 'session-1',
        });
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

        const response = DaemonLocalServicePreviewRevokeResponseV1Schema.parse(await handlers.get(RPC_METHODS.DAEMON_LOCAL_SERVICES_PREVIEW_REVOKE)?.({
            machineId: LIFECYCLE_MACHINE_ID,
            previewId: created.response.preview.previewId,
        }));

        expect(response.revoked).toBe(true);
        expect(response.snapshot.previews).toHaveLength(0);
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
