import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createLocalServiceActionConfirmationNonceV1, isLocalServiceActionConfirmationNonceV1 } from '@happier-dev/protocol/local/services/actions/v1';
import { LocalServiceLauncherSnapshotV1Schema } from '@happier-dev/protocol/local/services/launcher/v1';
import { createManagedServicesOwner, type WorkspaceProjectManagedServiceSupervisionInput } from '@/plugins/runtime/invocation/services/managedServicesOwner';
import { createManagedServiceProcessSupervisorHost } from '@/plugins/runtime/invocation/services/managedProcessSupervisor';
import { MANAGED_SERVICE_NUMERIC_CONTRACT } from '@/plugins/runtime/invocation/services/managedServiceSpecNormalization';
import { authorizeResolvedProjectExecLaunchForHost, createProjectNativeToolchainIoForHost } from '@/plugins/runtime/invocation/services/exec';
import { createLocalServiceInventoryRegistry } from '../inventory/registry';
import { createLocalServicePreviewRegistry } from '../preview/registry';
import { createLocalServiceActionRoutes } from '../actions/routes';
import { createLocalServiceLauncherFeed } from './feed';

describe('Project Service daemon restart reconciliation', () => {
    it.each(['alive', 'gone'] as const)('reconciles a %s process after owner retirement, preserving identity and idempotent Stop', async condition => {
        const directory = await mkdtemp(join(tmpdir(), 'project-service-restart-'));
        const createOwner = () => createManagedServicesOwner({
            projectServiceStateDirectory: directory,
            processSupervisorHost: createManagedServiceProcessSupervisorHost({ custodyOwner: 'daemon' }),
            dependencies() { throw new Error('Project services do not acquire plugin dependencies'); },
            resolveScope() { return null; },
        });
        const before = createOwner();
        const workspace = { id: 'workspace-one', serverId: 'home', machineId: 'machine-one', rootPath: process.cwd(), createdAtMs: 1 };
        const declaration = { workspaceRefId: workspace.id, selection: { kind: 'manifest' as const, name: 'web' } };
        const feed = (owner: ReturnType<typeof createOwner>) => createLocalServiceLauncherFeed({
            machineId: workspace.machineId, projectManagedServices: owner,
            inventoryRegistry: createLocalServiceInventoryRegistry(), previewRegistry: createLocalServicePreviewRegistry(),
        });
        let after: ReturnType<typeof createOwner> | undefined;
        let handle: Awaited<ReturnType<typeof before.superviseProject>> | undefined;
        try {
            const start = {
                kind: 'workspace', workspace, declaration, cwd: workspace.rootPath,
                requester: { serverId: workspace.serverId, machineId: workspace.machineId, accountId: 'account-one', installationId: 'install-one' },
                serviceId: 'project:web', specIdentity: 'reviewed-web', isCurrent: () => true,
                authorizeLaunch: ({ signal, endpoint }) => authorizeResolvedProjectExecLaunchForHost({
                    signal, assertCurrent() {},
                    projectLaunch: { status: 'ready', reviewedEffectDigest: 'reviewed-web', toolchain: {
                        selection: { kind: 'host' }, root: workspace.rootPath, platform: process.platform,
                        io: createProjectNativeToolchainIoForHost({ resolveTool: async () => null }),
                    } },
                    launch: { command: process.execPath,
                        args: ['-e', `require('node:http').createServer((req,res)=>res.end('ready')).listen(${endpoint!.port},'127.0.0.1')`],
                        cwd: workspace.rootPath, env: {}, release() {} },
                }),
                processSpec: { mode: { kind: 'managedSpawn', host: '127.0.0.1' },
                    healthCheck: { kind: 'http', target: { kind: 'serverPath', path: '/' },
                        timeoutMs: MANAGED_SERVICE_NUMERIC_CONTRACT.healthTimeoutMs.defaultValue } },
            } satisfies WorkspaceProjectManagedServiceSupervisionInput;
            handle = await before.superviseProject(start);
            await handle.waitUntilHealthy();
            const request = { projection: 'managed_bindings' as const, workspaceRoot: workspace.rootPath };
            const running = LocalServiceLauncherSnapshotV1Schema.parse(await feed(before).getSnapshot(request));
            const original = running.targets[0]!;
            expect(original).toMatchObject({ serviceState: 'healthy', sourceClass: { managedServiceId: handle.instanceId } });
            await before.dispose({ preserveProjectServices: true });
            // This is the same owner-retirement boundary used by registry reload.
            // A real process survives; no ready flag or recovered handle is supplied.
            if (condition === 'gone') await handle.stop();
            after = createOwner();
            const settled = LocalServiceLauncherSnapshotV1Schema.parse(await feed(after).getSnapshot(request));
            expect(settled.targets).toEqual([expect.objectContaining({
                id: handle.serviceId, serviceState: condition === 'alive' ? 'running' : 'stopped',
                sourceClass: { kind: 'managed_service', managedServiceId: handle.instanceId },
            })]);
            expect(settled.targets[0]).not.toHaveProperty('unavailableReason');
            if (condition === 'alive') {
                expect(settled.targets[0]!.endpointUrl).toBe(original.endpointUrl);
                expect(settled.targets[0]!.actions).toEqual(['manage', 'register_preview']);
                expect(await (await fetch(original.endpointUrl!)).text()).toBe('ready');
            } else {
                expect(settled.targets[0]).not.toHaveProperty('endpointUrl');
                expect(settled.targets[0]!.actions).toEqual([]);
            }
            const routes = createLocalServiceActionRoutes({ machineId: workspace.machineId,
                projectManagedServices: after, inventoryRegistry: createLocalServiceInventoryRegistry(),
                verifyConfirmationNonce: isLocalServiceActionConfirmationNonceV1 });
            const stopRequest = { requestId: 'stop-after-restart', action: 'stop_managed' as const, force: false,
                target: { kind: 'managed_service' as const, machineId: workspace.machineId, managedServiceId: handle.instanceId } };
            const stop = { ...stopRequest, confirmationNonce: createLocalServiceActionConfirmationNonceV1(stopRequest) };
            const foreignExecution = { actionContext: { surface: 'cli' as const, serverId: workspace.serverId },
                ingress: { signal: new AbortController().signal, machineAdmission: {
                    actorAccountId: 'another-account', custodianAccountId: 'custodian', machineId: workspace.machineId,
                    installationId: 'install-one', role: 'use' as const, encryptionMode: 'plain' as const,
                } } };
            expect(await routes.execute(stop, foreignExecution)).toMatchObject({ status: 'denied' });
            expect((await feed(after).getSnapshot({ ...request,
                requesterManagedServices: { serverId: workspace.serverId, accountId: 'another-account' } })).targets).toEqual([]);
            expect(await routes.execute(stop)).toMatchObject({ status: 'succeeded' });
            expect((await feed(after).getSnapshot(request)).targets).toEqual([expect.objectContaining({ serviceState: 'stopped' })]);
            expect(await routes.execute(stop)).toMatchObject({ status: 'succeeded' });
            const replacement = await after.superviseProject(start);
            await replacement.waitUntilHealthy();
            expect(replacement.instanceId).not.toBe(handle.instanceId);
            expect((await feed(after).getSnapshot(request)).targets).toEqual([expect.objectContaining({
                serviceState: 'healthy', sourceClass: { kind: 'managed_service', managedServiceId: replacement.instanceId },
            })]);
        } finally {
            await after?.dispose();
            await handle?.stop();
            await before.dispose();
            await rm(directory, { recursive: true, force: true });
        }
    });

    it('returns a typed visible refusal for a truly unknown instance', async () => {
        const owner = createManagedServicesOwner({ processSupervisorHost: createManagedServiceProcessSupervisorHost({ custodyOwner: 'daemon' }),
            dependencies() { throw new Error('No dependencies'); }, resolveScope() { return null; } });
        try {
            const routes = createLocalServiceActionRoutes({ machineId: 'machine-one', projectManagedServices: owner,
                inventoryRegistry: createLocalServiceInventoryRegistry() });
            expect(await routes.execute({ requestId: 'stop-unknown', action: 'stop_managed', force: false,
                target: { kind: 'managed_service', machineId: 'machine-one', managedServiceId: 'unknown-instance' } }))
                .toMatchObject({ status: 'denied', reasonCode: 'unknown_managed_service' });
        } finally { await owner.dispose(); }
    });
});
