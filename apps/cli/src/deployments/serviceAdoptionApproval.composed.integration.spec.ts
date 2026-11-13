import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActionIdSchema, DeploymentEnvironmentGetResultV1Schema,
    MachineServicesDiscoveryResultV1Schema, MachineServicesListResultV1Schema,
    type ActionExecuteResult, type MachineMetadataFieldReadV1, type MachineMetadataFieldPortV1 } from '@happier-dev/protocol';
import { ActionApprovalRequestCreatedResultSchema, ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ApprovalRequestPublicSettlementSchema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { MachineServiceAdoptResultV1Schema } from '@happier-dev/protocol/local/services/adoptionV1';
import { createMachineContentCodec } from '@/api/machine/machineStoredContent';
import { createMachineServicesRuntime } from '@/daemon/local/services/launch/machineServices';
import { createRequesterBoundDeploymentActionDeps } from '@/daemon/externalActions/deploymentActionDeps';
import { configuration } from '@/configuration';
import * as installationStore from '@/daemon/identity/store';
import { updateSettings } from '@/persistence';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createFilesystemEffectAdmission } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemEffectAdmission';
import { adoptServerProfileHomeConnectionDescriptor } from '@/server/serverProfiles';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { createDeploymentSocketHome } from '../../../server/sources/testkit/deploymentSocketHome.testkit.mjs';
import { db } from '../../../server/sources/storage/db';
import { createDaemonDeploymentActionDeps } from './createDaemonDeploymentActionDeps';
import { createS0DeploymentDaemonIngress, installationBoundary, readS0ControllerCredentials,
    readS0Installation } from './deploymentDaemonIngress.testkit';
import { createOwnServerDeploymentRuntimeForHost } from './targets/ownServer/ownServerDeploymentHostRuntime';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe.skipIf(process.platform !== 'linux')('approved native Compose adoption', () => {
    // Both fixtures share the server process's canonical Home identity cache.
    const serverId = `srv_${randomUUID().replaceAll('-', '')}`;
    it.each(['manual', 'presenter'] as const)('settles approval into a new Project and readable E2EE Environment (%s)', async delivery => {
        const encryptionMode = 'e2ee' as const;
        const home = await createDeploymentSocketHome({ encryptionMode, serverId,
            ...(encryptionMode === 'e2ee' ? { prepareMachineContent: (key: Uint8Array, metadata: Readonly<Record<string, unknown>>) =>
                createMachineContentCodec({ encryptionMode: 'e2ee', encryptionKey: key,
                    encryptionVariant: 'dataKey' }).encodeStored(metadata) } : {}) });
        const cleanup: Array<() => Promise<void>> = [() => home.close()];
        try {
            // Installation lookup, Machine metadata persistence and the external Docker
            // process are boundaries. Approval/replay, signed HTTP, admission and Project storage stay real.
            vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockImplementation(
                () => installationBoundary.getStore() ?? readS0Installation(home));
            const credentials = readS0ControllerCredentials(home);
            await adoptServerProfileHomeConnectionDescriptor({ descriptor: { v: 1, homeServerIdentityId: home.serverId,
                canonicalServerUrl: home.baseUrl, revision: 1, endpoints: [{ kind: 'https', url: home.baseUrl }] },
                expectedProfileId: configuration.activeServerId, createIfMissing: true, observation: 'exact' });
            cleanup.push(async () => { await updateSettings(settings => {
                const servers = { ...settings.servers };
                if (servers[configuration.activeServerId]?.homeConnectionDescriptor?.homeServerIdentityId === home.serverId)
                    delete servers[configuration.activeServerId];
                return { ...settings, servers };
            }); });
            await updateSettings(settings => ({ ...settings,
                machineIdByServerIdByAccountId: { ...settings.machineIdByServerIdByAccountId,
                    [configuration.activeServerId]: { ...settings.machineIdByServerIdByAccountId?.[configuration.activeServerId],
                        [home.accountId]: home.machineId } },
                lastTokenSubByServerId: { ...settings.lastTokenSubByServerId, [configuration.activeServerId]: home.accountId } }));
            const mounted = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
                runtimeOptions: { pluginIds: ['happier.machine.services'],
                    scopedActionRuntime: { credentials, actionsSettingsProvider: createActionSettingsProvider() } } });
            cleanup.push(() => mounted.dispose());
            const lifetime = new AbortController();
            cleanup.push(async () => { lifetime.abort(); });
            const directory = join(home.baseDir, 'unmanaged-compose');
            await mkdir(directory);
            vi.stubEnv('PATH', `${directory}${delimiter}${process.env.PATH ?? ''}`);
            vi.stubEnv('NODE_OPTIONS', '');
            const composePath = join(directory, 'compose.yaml');
            const model = { name: 'approved-adoption', services: { worker: { image: 'ubuntu:24.04', command: ['sleep', 'infinity'], environment: {} } } };
            await writeFile(composePath, JSON.stringify(model));
            const containerId = 'a'.repeat(64);
            const container = { Id: containerId, Image: 'sha256:' + 'b'.repeat(64),
                Config: { Labels: { 'com.docker.compose.project': model.name, 'com.docker.compose.service': 'worker',
                    'com.docker.compose.oneoff': 'False', 'com.docker.compose.project.working_dir': directory,
                    'com.docker.compose.project.config_files': composePath } }, State: { Status: 'running' }, Mounts: [], NetworkSettings: { Ports: {} } };
            await writeFile(join(directory, 'docker'), `#!${process.execPath}
const args = process.argv.slice(2);
if (args.includes('info')) process.stdout.write(args.includes('{{.ID}}') ? 'engine-a' : JSON.stringify({ID:'engine-a',OSType:'linux',Architecture:'x86_64'}));
else if (args[0] === 'ps') process.stdout.write(${JSON.stringify(containerId)});
else if (args[0] === 'inspect') process.stdout.write(JSON.stringify(${JSON.stringify([container])}));
else if (args.includes('config')) process.stdout.write(JSON.stringify(args.includes('--variables') ? {} : ${JSON.stringify(model)}));
else process.exit(23);
`, { mode: 0o700 });
            const authority = createFilesystemEffectAdmission({ resolveHomeServerIdentityId: async () => home.serverId,
                resolveHostIdentity: async () => ({ custodianAccountId: home.accountId,
                    machineId: home.machineId, installationId: home.installationId }) });
            const resolveRequesterIdentity: NonNullable<Parameters<typeof createDaemonDeploymentActionDeps>[0]['resolveRequesterIdentity']> = async context => {
                const requester = await authority.resolveActionRequester!(context);
                try { return requester.identity; } finally { await requester.dispose(); }
            };
            const runtime = createOwnServerDeploymentRuntimeForHost({ credentials, resolveRequesterIdentity,
                serverId: home.serverId, serverHttpBaseUrl: home.baseUrl, machineId: home.machineId,
                acquirePluginRuntimeRegistryLease: () => mounted.controller.acquireRuntimeRegistry({ resolveRuntimeRegistry: async () => mounted.registry }),
                signal: lifetime.signal });
            let metadata: MachineMetadataFieldReadV1 = { status: 'ready', metadataVersion: 1, metadata: {} };
            const port: MachineMetadataFieldPortV1 = { read: async () => metadata, compareAndSwap: async mutation => {
                if (metadata.status !== 'ready') return metadata;
                if (mutation.expectedMetadataVersion !== metadata.metadataVersion) return { ...metadata, status: 'conflict' };
                metadata = { status: 'ready', metadataVersion: metadata.metadataVersion + 1, metadata: mutation.metadata };
                return { ...metadata, status: 'applied' };
            } };
            const services = createMachineServicesRuntime({ target: { serverId: home.serverId, machineId: home.machineId },
                readMetadata: () => metadata, captureMetadataPort: () => port });
            const daemon = await createS0DeploymentDaemonIngress({ home,
                machineServiceAction: request => services.execute(request),
                projectManagedServices: mounted.registry.projectManagedServices,
                createDeploymentActionDeps: (requester, operations) => createRequesterBoundDeploymentActionDeps({ credentials: requester?.credentials ?? credentials,
                    runActionOperation: operations.runActionOperation,
                    resolveRequesterIdentity, serverId: home.serverId, serverHttpBaseUrl: requester?.serverHttpBaseUrl ?? home.baseUrl,
                    machineId: home.machineId, runtime,
                    ...(requester ? { savedSecretOperationContext: requester.savedSecretOperationContext } : {}) }) });
            cleanup.push(() => daemon.close());
            const approvalArtifacts: string[] = [];
            const executor = createCliActionExecutorFromCredentials({ credentials, readCredentials: async () => credentials,
                externalActionClient: true,
                machineId: home.machineId, serverId: home.serverId, serverIdentityId: home.serverId, serverApiUrl: home.baseUrl });
            const invoke = (name: string, input: unknown) => {
                const actionId = ActionIdSchema.parse(name);
                return executor.execute(actionId, input, { surface: 'cli', serverId: home.serverId,
                    serverIdentityId: home.serverId, actionRequestId: randomUUID() });
            };
            const approved = async (name: string, input: unknown): Promise<ActionExecuteResult> => {
                const result = await invoke(name, input);
                const approval = result.ok ? ActionApprovalRequestCreatedResultSchema.safeParse(result.result) : null;
                if (!approval?.success) return result;
                approvalArtifacts.push(approval.data.artifactId);
                const decision = await invoke('approval.request.decide', { artifactId: approval.data.artifactId, decision: 'approve' });
                expect(decision.ok, JSON.stringify(decision)).toBe(true);
                const opened = await invoke('approval.request.get', { artifactId: approval.data.artifactId });
                if (!opened.ok) throw new Error(opened.errorCode);
                const detail = getActionSpec('approval.request.get').outputSchema.parse(opened.result);
                if (!detail || typeof detail !== 'object' || !('request' in detail)) throw new Error('Missing approval');
                const { execution } = ApprovalRequestPublicSettlementSchema.parse(detail.request);
                if (execution.ok) return { ok: true, result: execution.result };
                const { executedAtMs: _executedAtMs, ...failure } = execution;
                return ActionExecuteFailureSchema.parse(failure);
            };
            const address = { serverId: home.serverId, machineId: home.machineId };
            const discovery = await invoke('machines.services.discovery', { ...address,
                adapter: { pluginId: 'happier.machine.services', localId: 'compose' } });
            expect(discovery.ok, JSON.stringify(discovery)).toBe(true);
            if (!discovery.ok) throw new Error(discovery.errorCode);
            const discovered = MachineServicesDiscoveryResultV1Schema.parse(discovery.result);
            const candidate = discovered.kind === 'snapshot' ? discovered.candidates.find(row => row.name === 'approved-adoption') : null;
            if (!candidate) throw new Error(`Missing unmanaged Compose project: ${JSON.stringify(discovered)}`);
            expect((await approved('machines.services.watch', { ...address, candidateId: candidate.candidateId,
                expectedRevision: candidate.revision, lifecyclePurpose: 'deployment' })).ok).toBe(true);
            const list = await invoke('machines.services.list', address);
            if (!list.ok) throw new Error(list.errorCode);
            const watched = MachineServicesListResultV1Schema.parse(list.result);
            const service = watched.kind === 'snapshot' ? watched.services.find(row => row.nativeInstance?.nativeResourceId === candidate.nativeResourceId) : null;
            if (!service?.generation) throw new Error('Missing watched generation');
            const base = { ...address, serviceId: service.serviceId, expectedGeneration: service.generation,
                profiles: [], requestKey: randomUUID() };
            const reviewResult = await approved('machines.services.adopt', { ...base, mode: 'review' });
            if (!reviewResult.ok) throw new Error(reviewResult.errorCode);
            const review = MachineServiceAdoptResultV1Schema.parse(reviewResult.result);
            if (review.kind !== 'review') throw new Error('Missing adoption review');
            const apply = { ...base, mode: 'apply', reviewedDigest: review.reviewedDigest, bindingsConfirmed: true, bindings: [],
                destination: { name: 'Approved adoption', newProject: { name: 'Approved adoption', requestKey: randomUUID(),
                    owner: { kind: 'account', accountId: home.accountId } }, protection: 'nonProduction', purpose: 'standard',
                    deployerMode: 'managers', controllerMachineId: home.machineId } };
            const approvalsBeforeApply = approvalArtifacts.length;
            const presentedApprovals: string[] = [];
            const presentingExecutor = createCliActionExecutorFromCredentials({ credentials, readCredentials: async () => credentials,
                externalActionClient: true,
                machineId: home.machineId, serverId: home.serverId, serverIdentityId: home.serverId, serverApiUrl: home.baseUrl,
                onApprovalRequested: async (artifactId, _signal, decide) => {
                    presentedApprovals.push(artifactId);
                    return await decide('approve');
                } });
            const result = delivery === 'manual' ? await approved('machines.services.adopt', apply)
                : await presentingExecutor.execute('machines.services.adopt', apply, { surface: 'cli', serverId: home.serverId,
                    serverIdentityId: home.serverId, actionRequestId: randomUUID() });
            expect(presentedApprovals).toHaveLength(delivery === 'presenter' ? 1 : 0);
            expect(approvalArtifacts.length).toBe(approvalsBeforeApply + (delivery === 'manual' ? 1 : 0));
            const projects = await db.projectSource.findMany({ where: { name: 'Approved adoption' }, select: { id: true } });
            const environments = await db.deploymentEnvironment.count({ where: { projectSourceId: { in: projects.map(row => row.id) } } });
            expect(result, JSON.stringify({ result, projects, environments })).toMatchObject({ ok: true, result: { kind: 'adopted' } });
            if (!result.ok) throw new Error(result.errorCode);
            const adopted = MachineServiceAdoptResultV1Schema.parse(result.result);
            if (adopted.kind !== 'adopted') throw new Error(`Incomplete adoption: ${adopted.kind}`);
            const read = await invoke('deployments.environments.get', { serverId: home.serverId, environmentId: adopted.environmentId });
            if (!read.ok) throw new Error(read.errorCode);
            expect(DeploymentEnvironmentGetResultV1Schema.parse(read.result)).toMatchObject({ ok: true,
                environment: { id: adopted.environmentId, revision: adopted.revision } });
            expect(await db.projectSource.count({ where: { name: 'Approved adoption' } })).toBe(1);
        } finally { for (const close of cleanup.reverse()) await close(); }
    });
});
