import axios from 'axios';
import nacl from 'tweetnacl';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { admitRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { projectExternalActionRequesterHttpAuthorization } from '@/api/externalActionExecutionAuthorization';
import { chmod, copyFile, cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorkspaceExecutionConfigClientV1 } from '@happier-dev/protocol/workspaces/workspaceExecutionConfigClientV1';
import { ProjectManifestV1Schema } from '@happier-dev/protocol/workspaces/projectSetup/projectManifestV1';
import type { RpcHandlerContext } from '@/api/rpc/types';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { createDaemonAdmissionDrain } from '@/daemon/lifecycle/admissionDrain';
import { createProjectWorkerAdmission } from '@/workspaces/execution/projectWorkerAdmission';
import { createTerminalPtySessionManager } from '@/terminal/pty/sessions';
import type { PtyExitEvent, PtyProcess, PtySpawnParams } from '@/terminal/pty/provider';
import { createManagedServicesOwner } from '@/plugins/runtime/invocation/services/managedServicesOwner';
import { createProjectNativeEnvironmentIoForHost } from '@/plugins/runtime/invocation/services/exec';
import { createManagedServiceProcessSupervisorHost } from '@/plugins/runtime/invocation/services/managedProcessSupervisor';
import type { ProjectFiniteActionRuntime } from '@/workspaces/projectSetup/projectFiniteAction';
import { discoverLocalServiceRunTargets } from './runTargets';
import { createProjectServiceDeclarationStarter } from './projectDeclarations';
import { createLocalServiceLauncherFeed } from './feed';
import { createLocalServiceLauncherRoutes } from './routes';
import { createLocalServiceInventoryRegistry } from '../inventory/registry';
import { createLocalServicePreviewRegistry } from '../preview/registry';
import { createLocalServiceLauncherHistoryStore } from './leaves';
import { createLocalServiceActionRoutes } from '../actions/routes';
import { createLocalServicesDaemonRuntimeActionExecutor } from '../actions/runtimeActionExecutor';
import { createLocalServicesDaemonFeatureGate } from '../featureGate';
import { createLocalServiceActionConfirmationNonceV1, createProjectServiceDeclarationTargetIdV1 } from '@happier-dev/protocol/local/services/actions/v1';
import { computeWorkspaceSyncPolicyDigest, type WorkspaceSyncRelationshipV1 } from '@happier-dev/protocol';
import type { ProjectAccountRowV1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { ApiClient } from '@/api/api';
import * as machineTransport from '@/session/transport/rpc/machineRpc';
import { createProjectDefinitionAction, registerProjectDefinitionHandlers } from '@/rpc/handlers/projectDefinitions';
import { createProjectFiniteSourceManifestInspector } from '@/daemon/startup/createDaemonMachineBootstrapRuntime';
import { createWorkspaceSyncWorkerPreparation, prepareWorkspaceSyncBetween } from '@/workspaces/sync/workspaceSyncPreparation';
import { withdrawActiveProjectAccountRowsSnapshot } from '@/workspaces/projectAccountRows';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { isApprovalRequiredByActionsSettings } from '@happier-dev/protocol/actions/actionApprovalPolicy';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { registerDaemonLocalServicesMachineRpcHandlers } from '@/rpc/handlers/daemonLocalServices';
import { authorizeMachineRpcRequest } from '@/api/machine/machineRpcAuthorization';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { DaemonLocalServiceLauncherSnapshotResponseV1Schema } from '@happier-dev/protocol/local/services/launcher/v1';
import { createDefaultWorkspaceExecutionSettingsV1 } from '@happier-dev/protocol/workspaces/projectWorkerPreferencesV1';
import type { ProjectServicePlacementV1 } from '@happier-dev/protocol/workspaces/projectServicePlacementV1';
import type { MachinePoolViewV1 } from '@happier-dev/protocol/machines/pools/v1';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import type { PluginApi, PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { ManagedServiceNativeInstanceV1 } from '@happier-dev/plugin-sdk/managed-services';
import { createDaemonSpawnToolResolutionContext } from '@/daemon/spawnHooks';
import { readSupervisedPluginProcessIdForHost } from '@/plugins/runtime/exec/processSupervisor';
import { ingestCanonicalPluginManifest } from '@/plugins/manifest/ingest';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/resolvePluginContributions';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { activatePluginRuntimeRegistry } from '@/plugins/runtime/lifecycle/manager';
import { resolveProjectNativeAdapter } from '@/plugins/runtime/lifecycle/contributions/targetProjectNativeAdapters';
import { createPluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';
import { createPluginInvocationLifetime } from '@/plugins/runtime/invocation/lifetime';
import { createProductionPluginInvocationServiceOwners } from '@/plugins/runtime/invocation/services/production';
import { resolveManifestHostAccessRequestsForQualifiedContribution } from '@/plugins/runtime/hostAccess/manifestRequests';
import { pixiPlugin, pixiRuntime, pixiAdapter, importedPixiEnvironment } from '../../../../../../../packages/plugin-sdk/fixtures/external-targeted-packages/project-native-source';
import * as processTreeBoundary from '@/agent/runtime/process/killProcessTree';

class ObservedSetupPty implements PtyProcess {
    readonly pid = 3456;
    readonly ownedProcessGroupId = 3456;
    private readonly exits = new Set<(event: PtyExitEvent) => void>();
    write() {}
    resize() {}
    kill() {}
    onData() { return { dispose() {} }; }
    onExit(listener: (event: PtyExitEvent) => void) { this.exits.add(listener); return { dispose: () => this.exits.delete(listener) }; }
    exit(exitCode: number) { for (const listener of this.exits) listener({ exitCode, signal: 0 }); }
}

describe('accepted Project Service declaration starter', () => {
    const cleanups: Array<() => Promise<void>> = [];
    afterEach(async () => { vi.restoreAllMocks(); withdrawActiveProjectAccountRowsSnapshot(); await Promise.all(cleanups.splice(0).map(cleanup => cleanup())); });

    async function fixture(setup = false, source?: unknown, finiteAccepting = true, workerExecution?: 'portable' | 'primary') {
        const root = await mkdtemp(join(tmpdir(), 'happier-project-service-'));
        await mkdir(join(root, '.happier'));
        const command = `${JSON.stringify(process.execPath)} -e "setInterval(() => {}, 1000)"`;
        const manifest = ProjectManifestV1Schema.parse({ version: 1, services: { worker: { source: source ?? { kind: 'command', command },
            ...(workerExecution ? { execution: workerExecution } : {}) } },
            ...(setup ? { workspace: { setup: [{ kind: 'command', command: 'echo setup' }] } } : {}) });
        await writeFile(join(root, '.happier/project.json'), JSON.stringify(manifest));
        const workspace = { id: 'accepted', serverId: 'home', machineId: 'machine', rootPath: root, createdAtMs: 1, projectKey: 'project' };
        const targetRoot = workerExecution ? await mkdtemp(join(tmpdir(), 'happier-project-service-target-')) : root;
        const targetWorkspace = workerExecution ? { ...workspace, id: 'worker-ref', machineId: 'worker-machine', rootPath: targetRoot } : workspace;
        const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`, encryption: null,
            credentialProvenance: 'stored_session' as const };
        const basePolicy = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
        const relationship: WorkspaceSyncRelationshipV1 = { v: 1, relationshipId: 'source-worker', controllerMachineId: workspace.machineId,
            alphaWorkspaceRefId: workspace.id, betaWorkspaceRefId: targetWorkspace.id, mode: 'keep_synced', enabled: true,
            ...(workerExecution ? { provenance: { kind: 'worker_clean_copy' as const, sourceWorkspaceRefId: workspace.id, targetWorkspaceRefId: targetWorkspace.id } } : {}),
            contentPolicy: { ...basePolicy, policyDigest: computeWorkspaceSyncPolicyDigest(basePolicy) }, createdAtMs: 1, updatedAtMs: 1 };
        let relationshipCurrent = true;
        let copyManifestOverride: unknown;
        let afterCopy: (() => void) | undefined;
        let copies = 0;
        // HTTP is the only replaced boundary: A2 opening, trust and placement codecs remain real.
        vi.spyOn(axios, 'get').mockImplementation(async url => {
            const path = new URL(String(url)).pathname;
            if (path === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: {} }, version: 0 } };
            if (path.startsWith('/v1/machines/')) {
                const publishedMachine = [workspace, targetWorkspace].find(value => path === `/v1/machines/${encodeURIComponent(value.machineId)}`);
                if (!publishedMachine) throw new Error(`Unknown fixture Machine path: ${path}`);
                return { status: 200, data: { machine: {
                    id: publishedMachine.machineId, metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0, storageMode: 'plain',
                    access: { custodian: { accountId: 'owner', displayName: 'Owner' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' },
                } } };
            }
            return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
        });
        let trustedSetupDigest: string | null = null;
        const post = vi.spyOn(axios, 'post').mockImplementation(async url => {
            if (String(url).endsWith('/project-trust/read')) return { status: 200, data: trustedSetupDigest === null ? { status: 'absent' }
                : { status: 'present', revision: 1, content: { t: 'plain', v: { project: { serverId: 'home', projectId: 'project' },
                    reviewedEffectDigest: trustedSetupDigest, approvedAtMs: 1 } } } };
            const refs = workerExecution ? [workspace, targetWorkspace] : [workspace];
            const rows: ProjectAccountRowV1[] = refs.map(value => { const key = { kind: 'workspace-ref' as const, serverId: 'home', id: value.id };
                return { key, revision: 1, content: { t: 'plain', v: { key, value } } }; });
            if (workerExecution) {
                const key = { kind: 'relationship-graph' as const };
                rows.push({ key, revision: relationshipCurrent ? 1 : 2, content: { t: 'plain', v: { key, value: { relationships: relationshipCurrent ? [relationship] : [] } } } });
            }
            return { status: 200, data: { status: 'listed', coverage: 'complete', rows } };
        });
        let savedPlacement: ProjectServicePlacementV1 | undefined;
        const config = createWorkspaceExecutionConfigClientV1({ mode: 'plain', material: null, isCurrent: () => true,
            randomBytes: length => new Uint8Array(length), transport: { read: async () => savedPlacement
                ? { status: 'present', revision: 1, content: { t: 'plain', v: { ...createDefaultWorkspaceExecutionSettingsV1(), services: { worker: savedPlacement } } } }
                : { status: 'absent' },
                mutate: async () => { throw new Error('read only'); } } });
        const setupProcesses: Array<{ params: PtySpawnParams; pty: ObservedSetupPty }> = [];
        const terminalSessions = createTerminalPtySessionManager({ ptyProvider: { spawn(params) {
            const pty = new ObservedSetupPty(); setupProcesses.push({ params, pty }); return pty;
        // This fake OS process has no descendants after its supplied exit.
        } }, stopProcessTree: async () => {}, probeProcessGroup: () => 'absent',
            config: { maxSessions: 10, idleTimeoutMs: 60_000, bufferMaxBytes: 1_000_000, bufferMaxEvents: 1000,
                bufferRetentionMs: 600_000, urlParseBufferLimit: 32_768, maxWriteChunkBytes: 16_384, defaultCols: 80, defaultRows: 24 }, env: {}, platform: 'linux' });
        const operationRuntime = createHostActionOperationRuntime({ machineId: targetWorkspace.machineId,
            custodyBinding: { serverId: 'home', installationId: 'installation' }, resolveAccountId: async () => 'owner',
            ...(workerExecution ? { generateOperationId: () => 'setup-operation' } : {}) });
        const owner = createManagedServicesOwner({ processSupervisorHost: createManagedServiceProcessSupervisorHost({ custodyOwner: 'daemon' }),
            // Plugin dependency installation is unreachable for literal Project commands.
            dependencies: Object.freeze({}) as never, resolveScope: scope => scope });
        cleanups.push(async () => { terminalSessions.dispose(); await owner.dispose(); await rm(root, { recursive: true, force: true });
            if (targetRoot !== root) await rm(targetRoot, { recursive: true, force: true }); });
        const ingress: RpcHandlerContext = { signal: new AbortController().signal, transportRequestId: 'service-request',
            machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: targetWorkspace.machineId, installationId: 'installation', role: 'manage', encryptionMode: 'plain' },
            verifyMachineAdmissionCurrent: async () => true };
        let nativeTool: Readonly<{ executablePath: string; args?: readonly string[] }> | null = null;
        const admissionDrain = createDaemonAdmissionDrain();
        const runtime: ProjectFiniteActionRuntime = { serverId: 'home', machineId: targetWorkspace.machineId, accountId: 'owner', credentials,
            serverHttpBaseUrl: 'https://home.example', isCurrent: async () => true, operationRuntime, terminalSessions,
            workerAdmission: createProjectWorkerAdmission({ machineId: targetWorkspace.machineId, admissionDrain, readPolicy: async () => ({ status: 'ready', policy: { accepting: finiteAccepting, runAtMost: null }, source: 'stored', metadataVersion: 1 }) }),
            resolveWorkspaceExecutionConfig: async () => config, nativeIo: { resolveTool: async () => nativeTool },
            environmentIo: createProjectNativeEnvironmentIoForHost({ resolveTool: async () => null }),
            platform: 'linux', arch: 'x64', hostEnvironment: {}, successHomeDir: join(targetRoot, 'success'),
            ...(workerExecution ? createWorkspaceSyncWorkerPreparation({ serverId: 'home', serverHttpBaseUrl: 'https://home.example',
                targetMachineId: targetWorkspace.machineId, credentials, isCurrent: async () => true,
                // The controller's file-transfer/flush transport is the replaced boundary. Route/currentness and clean facts stay real.
                prepareBetween: (request, signal) => prepareWorkspaceSyncBetween({ ...request, serverId: 'home', signal,
                    readCurrent: async () => ({ workspaceRefs: [workspace, targetWorkspace], relationships: relationshipCurrent ? [relationship] : [] }),
                    flush: async () => {
                        copies++;
                        await cp(join(root, '.happier'), join(targetRoot, '.happier'), { recursive: true });
                        if (copyManifestOverride !== undefined) await writeFile(join(targetRoot, '.happier/project.json'), JSON.stringify(copyManifestOverride));
                        afterCopy?.();
                        return { relationshipId: relationship.relationshipId, controllerMachineId: workspace.machineId,
                            state: 'watching', alphaPath: root, betaPath: targetRoot, mode: relationship.mode,
                            endpointStates: { alpha: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 },
                                beta: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 } },
                            conflictCount: 0, lastCycleObservedAtMs: null };
                    } }) }) : {}) };
        if (workerExecution) {
            const handlers = new Map<string, (input: unknown, context?: RpcHandlerContext) => Promise<unknown>>();
            registerProjectDefinitionHandlers({ machineId: workspace.machineId,
                rpcHandlerManager: { registerHandler: (method, handler) => { handlers.set(method, handler); } },
                actionExecutor: createActionExecutor(createCliActionDeps({ token: credentials.token, credentials,
                    serverId: 'home', serverHttpBaseUrl: 'https://home.example', sessionId: 'cli-global', mode: 'plain', ctx: null,
                    projectDefinitionAction: createProjectDefinitionAction({ serverId: 'home',
                        machineId: workspace.machineId, workingDirectory: root, accessPolicy: { kind: 'restrictedRoots', roots: [root] } }) })) });
            vi.spyOn(machineTransport, 'callExactMachineRpc').mockImplementation(async request => {
                expect(request.machineId).toBe(workspace.machineId);
                const handler = handlers.get(request.method);
                if (!handler) throw new Error('Unknown SOURCE Action');
                return await handler(request.request, { signal: request.signal ?? ingress.signal });
            });
            const inspectSourceProjectManifest = createProjectFiniteSourceManifestInspector({ api: await ApiClient.create(credentials),
                credentials, serverId: 'home', serverHttpBaseUrl: 'https://home.example', accountId: 'owner', ingress, isCurrent: async () => true });
            Object.assign(runtime, { inspectSourceProjectManifest });
        }
        const projectionLifetime = new AbortController();
        const starter = createProjectServiceDeclarationStarter({ resolveRuntime: async () => runtime,
            acquirePluginRuntime: async () => ({ registry: { projectManagedServices: owner, retirementSignal: projectionLifetime.signal }, release: async () => {} }) });
        const targets = await discoverLocalServiceRunTargets({ roots: [], acceptedWorkspaceRefs: [workspace] });
        const target = targets.find(target => 'declaration' in target && target.declaration.selection.kind === 'manifest');
        if (!target || !('declaration' in target)) throw new Error('Fixture manifest did not produce a Service declaration');
        const request = { machineId: targetWorkspace.machineId, targetId: target.id, workspace: { serverId: 'home', machineId: 'machine', workspaceId: workspace.id, rootPath: root }, declaration: target.declaration,
            ...(workerExecution ? { choice: { kind: 'workers' as const, destination: { kind: 'machine' as const, machineId: targetWorkspace.machineId } } } : {}) };
        const context = { authority: 'account_automation' as const, serverId: 'home', actionRequestId: 'service-request' };
        const history = createLocalServiceLauncherHistoryStore();
        const feed = createLocalServiceLauncherFeed({ machineId: targetWorkspace.machineId, history,
            inventoryRegistry: createLocalServiceInventoryRegistry(), previewRegistry: createLocalServicePreviewRegistry(),
            projectManagedServices: owner,
            runTargets: () => discoverLocalServiceRunTargets({ roots: [], acceptedWorkspaceRefs: [targetWorkspace] }) });
        const routes = createLocalServiceLauncherRoutes({ feed, history, ...starter });
        return { root, workspace, targetRoot, targetWorkspace, manifest, starter, routes, history, request, ingress, context, owner, post, setupProcesses, operationRuntime, runtime, admissionDrain,
            copies: () => copies, withdrawRelationship() { relationshipCurrent = false; },
            changeCopiedManifest(value: unknown) { copyManifestOverride = value; },
            afterCopy(callback: () => void) { afterCopy = callback; },
            savePlacement(value: ProjectServicePlacementV1) { savedPlacement = value; },
            setNativeTool(value: NonNullable<typeof nativeTool>) { nativeTool = value; },
            trustSetupDigest(value: string) { trustedSetupDigest = value; },
            retireRegistryProjection() { projectionLifetime.abort(); } };
    }

    it('starts a reviewed Service for an admitted restricted requester without owner credentials', async () => {
        const h = await fixture();
        const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-proof', binding: {
            accountId: 'bob', principalId: 'bob', credentialId: 'pat', custodianAccountId: 'owner', accountEncryptionMode: 'plain',
            serverIdentityId: 'stable-home', machineId: 'machine', installationId: 'installation', actionId: 'localServices.launcher.start',
            requestId: 'service-request', requestEnvelopeDigest: 'a'.repeat(43), target: { kind: 'machine', machineId: 'machine' },
            grant: { v: 1, actions: { families: [], ids: ['localServices.launcher.start'] }, targets: { sessions: [], machines: ['machine'] },
                approve: false, origins: [], models: null, permissionModes: null, create: null },
        } });
        vi.mocked(axios.get).mockImplementation(async url => {
            if (String(url).endsWith('/v1/account/profile')) return { status: 200, data: { id: 'bob' } };
            if (String(url).endsWith('/v2/account/settings')) return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
            return { status: 200, data: { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
        });
        const admitted = await admitRequesterAccountActionContext({ authorization, credentials: { token: 'bob', encryption: null },
            serverId: 'home', serverIdentityId: 'stable-home', serverHttpBaseUrl: 'https://home.example', isCurrent: async () => true });
        if (!admitted) throw new Error('Requester custody not admitted');
        const rowPost = h.post.getMockImplementation()!;
        h.post.mockImplementation(async (url, body, options) => String(url).endsWith('/verify')
            ? { status: 200, data: { ok: true } } : rowPost(url, body, options));
        const carrier = await projectExternalActionRequesterHttpAuthorization({ authorization: admitted.authorization,
            serverId: 'home', serverIdentityId: 'stable-home', serverHttpBaseUrl: 'https://home.example', target: authorization.binding.target,
            installationId: 'installation', privateKey: nacl.sign.keyPair().secretKey, isCurrent: admitted.isCurrent });
        if (!carrier) throw new Error('Requester HTTP custody not admitted');
        // This replaces constructor state, not admission or native review logic.
        Reflect.deleteProperty(h.runtime, 'credentials');
        Object.assign(h.runtime, { accountId: 'bob', accountAuthorization: carrier, isCurrent: admitted.isCurrent });
        const ingress = { ...h.ingress, callerInputAuthorization: carrier, callerInputConstraints: { models: null, permissionModes: null },
            machineAdmission: { ...h.ingress.machineAdmission!, actorAccountId: 'bob' } };
        const review = await h.routes.startTarget!(h.request, ingress, h.context);
        expect(review).toMatchObject({ status: 'denied', reasonCode: 'project_service_effect_review_required' });
        expect(await h.routes.startTarget!({ ...h.request, expectedEffectDigest: review.reviewedEffectDigest }, ingress, h.context))
            .toMatchObject({ status: 'succeeded' });
        const handle = h.owner.listProjectServices()[0]!;
        expect(handle.requester.accountId).toBe('bob');
        await admitted.dispose();
        // Installed requester invocation retirement does not revoke custody of its already-running Service.
        expect(handle.isCurrent()).toBe(true);
        await handle.stop();
    });

    it('reviews fresh accepted bytes, starts a URL-less owned process through final Exec, and retains exact requester custody', async () => {
        const h = await fixture();
        const review = await h.routes.startTarget!(h.request, h.ingress, h.context);
        expect(review).toMatchObject({ status: 'denied', reasonCode: 'project_service_effect_review_required', reviewedEffectDigest: expect.any(String) });
        if (!review.reviewedEffectDigest) throw new Error('Expected reviewed effect');
        const request = { ...h.request, expectedEffectDigest: review.reviewedEffectDigest };
        h.history.dismiss(request.targetId);
        expect((await h.routes.getSnapshot()).targets).toEqual([]);
        const result = await h.routes.startTarget!(request, h.ingress, h.context);
        expect(result).toMatchObject({ status: 'succeeded', snapshot: { machineId: 'machine', targets: [expect.objectContaining({ serviceState: 'running' })] } });
        expect(h.history.isDismissed(request.targetId)).toBe(false);
        const handle = h.owner.listProjectServices()[0];
        expect(result).toMatchObject({ currentTarget: { kind: 'managed_service', managedServiceId: handle?.instanceId,
            machineId: 'machine', workspaceId: h.workspace.id, cwd: h.root, declaration: h.request.declaration } });
        expect(handle).toMatchObject({ workspace: { id: 'accepted', serverId: 'home' }, declaration: h.request.declaration,
            requester: { serverId: 'home', accountId: 'owner', machineId: 'machine', installationId: 'installation' } });
        expect(handle?.instanceId).toEqual(expect.any(String));
        expect(handle?.snapshot()).toMatchObject({ state: 'running', baseUrl: null });
        expect(result.snapshot?.targets[0]).toMatchObject({
            startedAtMs: handle?.snapshot().startedAtMs,
            startedByAccountId: 'owner',
            endpointKind: 'none',
        });
        h.retireRegistryProjection();
        expect(handle?.isCurrent()).toBe(true);
        expect(h.owner.listProjectServices()).toEqual([handle]);
        await handle?.stop();
        expect(h.owner.listProjectServices()).toEqual([]);
    });

    it('publishes a portless declaration HTTP endpoint only after owned-tree observation', async () => {
        const h = await fixture();
        // The real listener and OS census prove ancestry; no PID, port or lineage is invented.
        const portPath = join(h.root, 'observed-port');
        const serverPath = join(h.root, 'server.cjs');
        await writeFile(serverPath, `const http = require('node:http'); const fs = require('node:fs');
const server = http.createServer((request, response) => response.end('observed'));
server.listen(0, '127.0.0.1', () => fs.writeFileSync(${JSON.stringify(portPath)}, String(server.address().port)));`);
        await writeFile(join(h.root, '.happier/project.json'), JSON.stringify({ ...h.manifest,
            services: { worker: { source: { kind: 'command', command: `${JSON.stringify(process.execPath)} ${JSON.stringify(serverPath)}` } } } }));
        const review = await h.routes.startTarget!(h.request, h.ingress, h.context);
        const started = await h.routes.startTarget!({ ...h.request, expectedEffectDigest: review.reviewedEffectDigest }, h.ingress, h.context);
        expect(started.status).toBe('succeeded');
        await expect.poll(() => readFile(portPath, 'utf8').then(Number).catch(() => null), { timeout: 10_000 }).toEqual(expect.any(Number));
        const port = Number(await readFile(portPath, 'utf8'));
        await expect.poll(async () => (await h.routes.getSnapshot()).targets.find(target => target.source === 'managed_service')?.endpointUrl,
            { timeout: 10_000 }).toBe(`http://127.0.0.1:${port}`);
        const target = (await h.routes.getSnapshot()).targets.find(target => target.source === 'managed_service');
        expect(target).toMatchObject({ serviceState: 'running', endpointKind: 'http', startedByAccountId: 'owner' });
        await h.owner.listProjectServices()[0]?.stop();
    });

    it('reads complete current managed bindings independently of launcher Hide and distinguishes owned empty', async () => {
        const h = await fixture();
        const read = { workspaceRoot: h.root, projection: 'managed_bindings' as const };
        const rpc = new RpcHandlerManager({ scopePrefix: 'machine', localMachineId: 'machine', encryptionMode: 'plain' });
        registerDaemonLocalServicesMachineRpcHandlers(rpc, { machineId: 'machine', serverId: 'home', localServicesLauncher: h.routes });
        const getBindings = async () => DaemonLocalServiceLauncherSnapshotResponseV1Schema.parse(await rpc.invokeLocal(
            RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_SNAPSHOT, { machineId: 'machine', ...read }, { signal: h.ingress.signal, localActionContext: h.context })).snapshot;
        expect((await getBindings()).targets).toEqual([]);
        const review = await h.routes.startTarget!(h.request, h.ingress, h.context);
        if (!review.reviewedEffectDigest) throw new Error('Expected Service review');
        expect(await h.routes.startTarget!({ ...h.request, expectedEffectDigest: review.reviewedEffectDigest }, h.ingress, h.context))
            .toMatchObject({ status: 'succeeded' });
        const handle = h.owner.listProjectServices()[0]!;
        h.history.dismiss(handle.serviceId);
        expect((await h.routes.getSnapshot()).targets).toEqual([]);
        expect((await getBindings()).targets).toEqual([expect.objectContaining({
            source: 'managed_service', sourceClass: { kind: 'managed_service', managedServiceId: handle.instanceId },
            workspace: h.request.workspace, declaration: h.request.declaration, serviceState: 'running',
        })]);
        await handle.stop();
        expect((await getBindings()).targets).toEqual([]);
    });

    it.skipIf(!process.env.FX16_DOCKER_PATH)('qualifies installed detached Compose through declaration admission, observation and exact Stop', async () => {
        const h = await fixture(false, { kind: 'native', tool: 'compose', file: 'compose.yaml', target: 'worker' });
        await writeFile(join(h.root, 'compose.yaml'), 'services:\n  worker:\n    image: alpine:3.22\n    command: [sh, -c, "echo fx16-service-output; echo fx16-service-error >&2; exec sleep 3600"]\n');
        h.setNativeTool({ executablePath: process.env.FX16_DOCKER_PATH!, args: JSON.parse(process.env.FX16_DOCKER_ARGS ?? '[]') });
        const review = await h.routes.startTarget!(h.request, h.ingress, h.context);
        expect(review).toMatchObject({ status: 'denied', reasonCode: 'project_service_effect_review_required' });
        const effect = review.reviewedEffect;
        if (!effect || typeof effect !== 'object' || Array.isArray(effect) || !effect.command || typeof effect.command !== 'object' || Array.isArray(effect.command)
            || !Array.isArray(effect.command.args) || !effect.command.args.every(arg => typeof arg === 'string')) throw new Error('Expected reviewed native argv');
        const nativeArgs = effect.command.args;
        // The reviewed resolved tuple already includes the installed tool's prefix.
        const cleanupArgs = [...nativeArgs.slice(0, nativeArgs.indexOf('up')), 'down'];
        try {
            const started = await h.routes.startTarget!({ ...h.request, expectedEffectDigest: review.reviewedEffectDigest }, h.ingress, h.context);
            expect(started).toMatchObject({ status: 'succeeded' });
            const handle = h.owner.listProjectServices()[0]!;
            expect(handle.snapshot()).toMatchObject({ state: 'running', mode: 'native', baseUrl: null });
            expect(handle.snapshot().diagnostics).toContainEqual(expect.objectContaining({ code: 'native_service_output', message: expect.stringContaining('fx16-service-error') }));
            expect(h.setupProcesses).toEqual([]);
            const feed = await h.routes.getSnapshot();
            expect(feed.targets).toContainEqual(expect.objectContaining({ source: 'managed_service', serviceState: 'running' }));
            expect(feed.targets.find(target => target.sourceClass?.kind === 'managed_service')?.endpointUrl).toBeUndefined();
            try { await handle.stop(); }
            catch (error) { throw new Error(`Native Stop failed: ${JSON.stringify(handle.snapshot())}`, { cause: error }); }
            expect(handle.snapshot()).toMatchObject({ state: 'stopped' });
            // A fresh owner binding adopts an already-detached survivor without
            // another starter. This is the daemon-crash recovery boundary, not
            // graceful owner disposal (which intentionally stops owned services).
            expect((await h.runtime.environmentIo.run({ command: process.env.FX16_DOCKER_PATH!,
                args: nativeArgs, cwd: h.root, env: {} })).exitCode).toBe(0);
            const recovered = await h.routes.startTarget!({ ...h.request, expectedEffectDigest: review.reviewedEffectDigest }, h.ingress, h.context);
            expect(recovered).toMatchObject({ status: 'succeeded' });
            const recoveredHandle = h.owner.listProjectServices()[0]!;
            expect(recoveredHandle.snapshot()).toMatchObject({ state: 'running', mode: 'native', pid: null, baseUrl: null });
            expect(recoveredHandle.instanceId).not.toBe(handle.instanceId);
            expect(await recoveredHandle.stop()).toEqual({ status: 'stopped' });
        } finally {
            // The fixture's exact reviewed native project owns containers/networks.
            // Down preserves volumes and cannot address another lane's project.
            const cleanup = await h.runtime.environmentIo.run({ command: process.env.FX16_DOCKER_PATH!, args: cleanupArgs, cwd: h.root, env: {} });
            expect(cleanup.exitCode).toBe(0);
            const project = nativeArgs[nativeArgs.indexOf('--project-name') + 1];
            for (const args of [['ps', '--all'], ['network', 'ls']]) {
                const inventory = await h.runtime.environmentIo.run({ command: process.env.FX16_DOCKER_PATH!,
                    args: [...JSON.parse(process.env.FX16_DOCKER_ARGS ?? '[]'), ...args, '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.ID}}'], cwd: h.root, env: {} });
                expect(inventory.exitCode).toBe(0);
                expect(inventory.stdout.trim()).toBe('');
            }
            await h.owner.listProjectServices()[0]?.stop();
        }
    }, 120_000);

    it.each(['foreground_native_service', 'no_setup_live_root', 'setup_live_root', 'setup_exited_root_with_live_descendant', 'no_setup_with_native_helper', 'pre_final_native_helper', 'detached_native_resource', 'detached_native_resource_accepted_stop'] as const)('retains the actual selected plugin environment through Service Start and unconfirmed Stop until owned tree settlement (%s)', async fixtureKind => {
        const detachedNative = fixtureKind.startsWith('detached_native_resource');
        const foregroundNative = fixtureKind === 'foreground_native_service';
        let acceptedNativeStop = fixtureKind === 'detached_native_resource_accepted_stop';
        const withSetup = fixtureKind.startsWith('setup_');
        const preFinalHelper = fixtureKind === 'pre_final_native_helper';
        const withNativeHelper = fixtureKind === 'no_setup_with_native_helper' || preFinalHelper;
        const exitedRoot = fixtureKind === 'setup_exited_root_with_live_descendant';
        if (exitedRoot && process.platform === 'win32') return;
        const h = await fixture(withSetup);
        const configContent = '[tasks]\ncheck = "echo checked"';
        await writeFile(join(h.root, 'pixi.toml'), configContent);
        const pidPath = join(h.root, 'native-tree.json');
        const treeScript = [
            'const { spawn } = require("node:child_process"); const fs = require("node:fs");',
            'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); child.unref();',
            `fs.writeFileSync(${JSON.stringify(pidPath)}, JSON.stringify({ parentPid: process.pid, childPid: child.pid }));`,
            'setInterval(() => {}, 1000);',
        ].join(' ');
        const manifest = detachedNative || foregroundNative ? { ...h.manifest, services: { worker: {
            source: { kind: 'pluginNative', adapter: pixiAdapter, file: 'pixi.toml', target: 'check' },
        } } } : !exitedRoot ? h.manifest : { ...h.manifest, services: { worker: {
            source: { kind: 'command', command: `exec ${JSON.stringify(process.execPath)} -e ${JSON.stringify(treeScript)}` },
        } } };
        await writeFile(join(h.root, '.happier/project.json'), JSON.stringify({ ...manifest, environment: importedPixiEnvironment }));
        const pluginManifest = detachedNative ? { ...pixiPlugin.manifest, contributes: { ...pixiPlugin.manifest.contributes,
            projectNativeAdapters: pixiPlugin.manifest.contributes?.projectNativeAdapters?.map(adapter => ({ ...adapter,
                roles: [...adapter.roles, 'nativeServiceLifecycle'] })),
        } } : pixiPlugin.manifest;
        const ingested = ingestCanonicalPluginManifest(pluginManifest, { sourceProvenance: 'registryCustodied' });
        if (!ingested.ok) throw new Error('Expected admitted public native fixture');
        const environmentObservation: { signal?: AbortSignal } = {};
        let nativeHelper: Awaited<ReturnType<PluginInvocationContext['services']['exec']['spawn']>> | undefined;
        const nativeInstance: ManagedServiceNativeInstanceV1 = { adapter: pixiAdapter, nativeResourceId: 'observed-external-service-instance' };
        let nativeStopped = false;
        let nativeObservation: 'known' | 'unknown' | 'failed' = 'known';
        const stoppedResources: ManagedServiceNativeInstanceV1[] = [];
        const installedToolPath = join(h.root, process.platform === 'win32' ? 'pixi.exe' : 'pixi');
        if (withNativeHelper || detachedNative || foregroundNative) {
            await copyFile(process.execPath, installedToolPath);
            if (process.platform !== 'win32') await chmod(installedToolPath, 0o755);
        }
        const targets = [{ provenance: 'first_party' as const, source: { kind: 'bundled' as const }, pluginId: pixiAdapter.pluginId,
            manifestPath: '/virtual/pixi/plugin.json', daemonEntryPath: '/virtual/pixi/daemon.mjs',
            sourceSpec: { kind: 'package' as const, locator: '@acme/pixi', trustPolicy: 'local_trusted' as const, installPolicy: 'copy' as const },
            activationEvents: [], manifest: ingested.manifest }];
        const inputs = projectLoadedPluginContributes({ provenance: 'first_party', loadResult: { loadedPlugins: [{
            pluginId: pixiAdapter.pluginId, pluginRootPath: h.root, manifestPath: targets[0]!.manifestPath,
            daemonEntryPath: targets[0]!.daemonEntryPath, devDaemonEntryPath: null, sourceSpec: targets[0]!.sourceSpec, manifest: ingested.manifest,
        }], diagnosticsByPluginId: {} } });
        const contributes = createResolvedContributionRegistry({ ...inputs, activationTargets: targets });
        // The plugin module loader is a boundary; registration, native admission,
        // invocation services and managed process custody remain their real owners.
        const activateRegistry = () => {
            const occurrenceId = createPluginRuntimeOccurrenceId(pixiAdapter.pluginId);
            return activatePluginRuntimeRegistry({ contributes, occurrenceIdsByPluginId: new Map([[pixiAdapter.pluginId, occurrenceId]]),
            // Each fixture supplies distinct closure-backed module bytes, not
            // another load of the same globally cached bundled module.
            generation: 1, resolveActivationSource: () => ({ kind: 'bundled', moduleId: `@acme/pixi/service-native-lifetime/${occurrenceId}`, load: async () => ({
                activate(api: PluginApi) {
                    api.projectNativeAdapters.register(pixiAdapter.localId, {
                        ...pixiRuntime,
                        ...(detachedNative || foregroundNative ? {
                            async resolveCommand(request: Parameters<NonNullable<typeof pixiRuntime.resolveCommand>>[0]) {
                                return { kind: 'resolved' as const, executable: { kind: 'systemTool' as const, id: 'pixi' },
                                    args: ['-e', foregroundNative ? treeScript : `require('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); process.exit(0)`],
                                    cwd: request.root, reviewInputs: request.files, ...(detachedNative ? { nativeInstance } : {}) };
                            },
                            ...(detachedNative ? { nativeServiceLifecycle: {
                                async inspect(instance: typeof nativeInstance, _options, context) {
                                    expect(instance).toEqual(nativeInstance);
                                    if (!context) throw new Error('Native lifecycle lost admitted invocation services');
                                    const bytes = await context.services.fs.readFile({ root: 'workspace', relativePath: 'pixi.toml' });
                                    expect(new TextDecoder().decode(bytes)).toBe(configContent);
                                    if (nativeObservation === 'failed') throw new Error('Native resource inspection is unavailable');
                                    return { phase: nativeObservation === 'unknown' ? 'unknown' as const
                                        : nativeStopped ? 'stopped' as const : 'running' as const, readiness: 'not_reported' as const, endpoint: null };
                                },
                                async stop(instance: typeof nativeInstance, _options, context) {
                                    if (!context) throw new Error('Native Stop lost admitted invocation services');
                                    stoppedResources.push(instance);
                                    return { status: nativeStopped && !acceptedNativeStop ? 'stopped' as const : 'accepted' as const };
                                },
                            } } : {}),
                        } : {}),
                        async produceEnvironment(request, context) {
                            environmentObservation.signal = context.signal;
                            const bytes = await context.services.fs.readFile({ root: 'workspace', relativePath: 'pixi.toml' });
                            if (new TextDecoder().decode(bytes) !== configContent) throw new Error('Selected environment lost actual reviewed root');
                            if (withNativeHelper && request.launch) {
                                nativeHelper = await context.services.exec.spawn({ executable: { kind: 'systemTool', id: 'pixi' },
                                    args: ['-e', 'setInterval(() => {}, 1000)'], cwd: { root: 'workspace', relativePath: '' } });
                                if (preFinalHelper) await nativeHelper.dispose();
                            }
                            // Preparation can request only environment evaluation;
                            // this fixture's native environment has no extra variables.
                            return { kind: 'ready', env: request.launch?.env ?? {}, reviewInputs: request.files };
                        },
                    });
                },
            }) }) });
        };
        let registry = await activateRegistry();
        const toolResolution = createDaemonSpawnToolResolutionContext({ processEnv: { PATH: h.root, PATHEXT: '.EXE' } });
        const owners = createProductionPluginInvocationServiceOwners({ loggerSink: { write() {} }, exec: {
            resolvePath: async () => h.root,
            resolveExecutable: async reference => {
                if ((!withNativeHelper && !detachedNative && !foregroundNative) || reference.kind !== 'systemTool' || reference.id !== 'pixi') throw new Error('This environment does not launch a native wrapper');
                const resolved = await toolResolution.resolveSystemTool({ toolId: 'pixi', lookupNames: ['pixi'], reason: 'Resolve actual installed native helper fixture' });
                if (!resolved.ok) throw new Error(resolved.reasonCode);
                return { command: resolved.command, args: resolved.args };
            },
        } });
        cleanups.push(async () => { await nativeHelper?.dispose(); });
        cleanups.push(async () => { await registry.dispose(); await owners.dispose(); });
        const plugins: NonNullable<ProjectFiniteActionRuntime['plugins']> = { resolveProjectNativeAdapter(reference, role) {
            return resolveProjectNativeAdapter({ reference, role, targets, registry, createInvocationContext(input) {
                const lifetime = createPluginInvocationLifetime(input.signal);
                const seed = { plugin: { id: pixiAdapter.pluginId, version: ingested.manifest.version },
                    contribution: { id: pixiAdapter.localId, qualifiedId: `${pixiAdapter.pluginId}/projectNativeAdapters/${pixiAdapter.localId}` },
                    occurrenceId: input.occurrenceId, correlationId: 'service-native-environment', surface: 'cli' as const,
                    signal: lifetime.signal, redactionLifetimeSignal: lifetime.redactionLifetimeSignal,
                    isOccurrenceCurrent: () => !lifetime.signal.aborted && input.isCurrent() };
                const hostAccessRequests = resolveManifestHostAccessRequestsForQualifiedContribution({ manifest: ingested.manifest,
                    pluginId: pixiAdapter.pluginId, contribution: seed.contribution });
                if (!hostAccessRequests) { lifetime.complete(); throw new Error('Selected environment lost declared HostAccess'); }
                try {
                    return { context: { ...seed, invokedAtMs: lifetime.invokedAtMs, services: owners.createOperationServices(seed, {
                        filesystemRoots: { pluginData: h.root, workspace: input.root, projects: new Map<string, string>() },
                        environment: input.environment ?? {}, hostAccessRequests,
                    }) }, complete: lifetime.complete };
                } catch (error) { lifetime.complete(); throw error; }
            } });
        } };
        Object.assign(h.runtime, { plugins });
        const setupReview = await h.routes.startTarget!(h.request, h.ingress, h.context);
        expect(setupReview).toMatchObject({ status: 'denied', reasonCode: 'project_setup_consent_required', reviewedEffectDigest: expect.any(String) });
        if (!setupReview.reviewedEffectDigest) throw new Error('Expected actual setup environment review');
        // The genuine Home boundary now returns the existing approving-Account
        // Trust row, not a Service waiver or fabricated human authority.
        h.trustSetupDigest(setupReview.reviewedEffectDigest);
        const review = await h.routes.startTarget!(h.request, h.ingress, h.context);
        expect(review).toMatchObject({ status: 'denied', reasonCode: 'project_service_effect_review_required' });
        expect(environmentObservation.signal).toBeUndefined();
        if (!review.reviewedEffectDigest) throw new Error('Expected actual Service environment review');
        let preFinalTerminationAttempts = 0;
        const originalTerminate = processTreeBoundary.killProcessTree;
        const preFinalTermination = preFinalHelper ? vi.spyOn(processTreeBoundary, 'killProcessTree').mockImplementation(async (...args) => {
            preFinalTerminationAttempts++;
            if (preFinalTerminationAttempts === 1) throw new Error('OS could not prove pre-final native helper settlement');
            await originalTerminate(...args);
        }) : undefined;
        const completion = h.routes.startTarget!({ ...h.request, expectedEffectDigest: review.reviewedEffectDigest }, h.ingress, h.context);
        if (preFinalHelper) {
            let startFinished = false;
            void completion.then(() => { startFinished = true; }, () => { startFinished = true; });
            let retirement: Promise<void> | undefined;
            try {
                await expect.poll(() => preFinalTerminationAttempts).toBe(1);
                const pid = nativeHelper && readSupervisedPluginProcessIdForHost(nativeHelper);
                if (!pid) throw new Error('Expected actual pre-final selected native helper');
                expect(process.kill(pid, 0)).toBe(true);
                expect(startFinished).toBe(false);
                expect(environmentObservation.signal?.aborted).toBe(false);
                expect(h.owner.listProjectServices()).toEqual([]);
                expect(h.owner.readRetainedSemanticCustodyCount()).toBeGreaterThan(0);
                // Before a Project handle is published, final retirement is
                // the existing semantic-entry Stop ingress, not a new API.
                retirement = h.owner.retireProjectServices();
                await expect.poll(() => preFinalTerminationAttempts).toBeGreaterThan(1);
                await retirement;
                await completion;
                expect(() => process.kill(pid, 0)).toThrow();
                expect(environmentObservation.signal?.aborted).toBe(true);
                expect(h.owner.readRetainedSemanticCustodyCount()).toBe(0);
            } finally {
                preFinalTermination?.mockRestore();
                // Genuine Exec cleanup settles the boundary even on RED.
                await nativeHelper?.dispose();
                await completion.catch(() => undefined);
                await retirement?.catch(() => undefined);
            }
            return;
        }
        if (withSetup) {
            const completed: { result?: Awaited<typeof completion> } = {};
            void completion.then(result => { completed.result = result; });
            await expect.poll(() => h.setupProcesses.length === 1 || completed.result !== undefined).toBe(true);
            if (completed.result) expect(completed.result.reasonCode).toBeUndefined();
            expect(h.setupProcesses.length).toBe(1);
            expect(h.owner.listProjectServices()).toEqual([]);
            h.setupProcesses[0]!.pty.exit(0);
        }
        const started = await completion;
        expect(started.reasonCode).toBeUndefined();
        expect(started).toMatchObject({ status: 'succeeded' });
        const handle = h.owner.listProjectServices()[0];
        expect(handle?.snapshot()).toMatchObject({ state: 'running' });
        expect(environmentObservation.signal?.aborted).toBe(false);
        if (!handle) throw new Error('Expected actual owned Service');
        if (foregroundNative) expect(handle.snapshot().mode).toBe('spawn');
        if (detachedNative) {
            try {
                await expect.poll(async () => {
                    try { const pid = Number(await readFile(pidPath, 'utf8')); process.kill(pid, 0); return false; }
                    catch (error) { return error instanceof Error && 'code' in error && error.code === 'ESRCH'; }
                }).toBe(true);
                expect(handle.snapshot()).toMatchObject({ mode: 'native', state: 'running', baseUrl: null });
                await expect(handle.stop()).rejects.toMatchObject({ code: 'plugin_managed_server_termination_incomplete' });
                expect(handle.snapshot().state).not.toBe('stopped');
                expect(environmentObservation.signal?.aborted).toBe(false);
                await registry.dispose();
                nativeStopped = true;
                if (acceptedNativeStop) {
                    await expect(handle.stop()).rejects.toMatchObject({ code: 'plugin_managed_server_termination_incomplete' });
                    expect(handle.snapshot().state).not.toBe('stopped');
                    expect(h.owner.listProjectServices()).toEqual([handle]);
                    expect(h.owner.readRetainedSemanticCustodyCount()).toBeGreaterThan(0);
                    expect(environmentObservation.signal?.aborted).toBe(false);
                    registry = await activateRegistry();
                    for (const uncertainty of ['failed', 'unknown'] as const) {
                        nativeObservation = uncertainty;
                        await expect(handle.stop()).rejects.toMatchObject({ code: 'plugin_managed_server_termination_incomplete' });
                        expect(h.owner.listProjectServices()).toEqual([handle]);
                        expect(stoppedResources).toEqual([nativeInstance, nativeInstance]);
                        expect(environmentObservation.signal?.aborted).toBe(false);
                    }
                    nativeObservation = 'known';
                    nativeStopped = false;
                    await expect(handle.stop()).rejects.toMatchObject({ code: 'plugin_managed_server_termination_incomplete' });
                    expect(handle.snapshot().state).not.toBe('stopped');
                    expect(h.owner.readRetainedSemanticCustodyCount()).toBeGreaterThan(0);
                    expect(environmentObservation.signal?.aborted).toBe(false);
                    nativeStopped = true;
                }
                await expect(handle.stop()).resolves.toEqual({ status: 'stopped' });
                expect(stoppedResources).toEqual(acceptedNativeStop
                    ? [nativeInstance, nativeInstance, nativeInstance] : [nativeInstance, nativeInstance]);
                expect(handle.snapshot()).toMatchObject({ state: 'stopped', nativePhase: 'stopped' });
                expect(h.owner.listProjectServices()).toEqual([]);
                expect(environmentObservation.signal?.aborted).toBe(true);
                return;
            } finally {
                // Supply a definitive native stop for cleanup even if recovery is RED.
                nativeStopped = true;
                nativeObservation = 'known';
                acceptedNativeStop = false;
                await handle.stop();
            }
        }
        if (withNativeHelper) {
            const helperPid = nativeHelper && readSupervisedPluginProcessIdForHost(nativeHelper);
            if (!helperPid) throw new Error('Expected actual selected environment helper');
            let releaseHelper!: () => void;
            let rejectHelper!: (error: Error) => void;
            let helperStopStarted = false;
            let stopFinished = false;
            const originalTerminate = processTreeBoundary.killProcessTree;
            const heldTermination = new Promise<void>((resolve, reject) => { releaseHelper = resolve; rejectHelper = reject; });
            const terminate = vi.spyOn(processTreeBoundary, 'killProcessTree').mockImplementation(async (...args) => {
                if (args[0].pid === helperPid && !helperStopStarted) {
                    helperStopStarted = true;
                    await heldTermination;
                }
                await originalTerminate(...args);
            });
            const stop = handle.stop();
            void stop.then(() => { stopFinished = true; }, () => { stopFinished = true; });
            try {
                await expect.poll(() => helperStopStarted).toBe(true);
                expect(stopFinished).toBe(false);
                expect(environmentObservation.signal?.aborted).toBe(false);
                expect(process.kill(helperPid, 0)).toBe(true);
                rejectHelper(new Error('OS could not prove selected native helper tree absent'));
                await expect(stop).rejects.toBeInstanceOf(Error);
                expect(environmentObservation.signal?.aborted).toBe(false);
                expect(process.kill(helperPid, 0)).toBe(true);
            } finally {
                releaseHelper();
                terminate.mockRestore();
                await nativeHelper?.dispose();
                await stop.catch(() => undefined);
            }
            await handle.stop();
            expect(h.owner.listProjectServices()).toEqual([]);
            expect(environmentObservation.signal?.aborted).toBe(true);
            return;
        }
        const terminate = vi.spyOn(processTreeBoundary, 'killProcessTree').mockRejectedValue(new Error('OS tree termination could not be observed'));
        try {
            if (exitedRoot) {
                await expect.poll(async () => {
                    try { await readFile(pidPath, 'utf8'); return true; } catch { return false; }
                }).toBe(true);
                const pids: unknown = JSON.parse(await readFile(pidPath, 'utf8'));
                if (!pids || typeof pids !== 'object' || !('parentPid' in pids) || typeof pids.parentPid !== 'number'
                    || !('childPid' in pids) || typeof pids.childPid !== 'number') throw new Error('Expected actual OS tree identities');
                const parentPid = pids.parentPid;
                const childPid = pids.childPid;
                process.kill(parentPid, 'SIGKILL');
                await expect.poll(() => {
                    try { process.kill(parentPid, 0); return true; } catch { return false; }
                }).toBe(false);
                expect(() => process.kill(childPid, 0)).not.toThrow();
                expect(environmentObservation.signal?.aborted).toBe(false);
            }
            await expect(handle.stop()).rejects.toMatchObject({ code: 'plugin_managed_server_termination_incomplete' });
            expect(h.owner.listProjectServices()).toEqual([handle]);
            expect(environmentObservation.signal?.aborted).toBe(false);
        } finally { terminate.mockRestore(); }
        await handle?.stop();
        expect(h.owner.listProjectServices()).toEqual([]);
        expect(environmentObservation.signal?.aborted).toBe(true);
    });

    it('revalidates the selected Service after review and never runs changed bytes', async () => {
        const h = await fixture();
        const review = await h.starter.resolveStartTarget(h.request, h.ingress, h.context);
        if (review.ok || !review.reviewedEffectDigest) throw new Error('Expected reviewed effect');
        const request = { ...h.request, expectedEffectDigest: review.reviewedEffectDigest };
        const resolved = await h.starter.resolveStartTarget(request, h.ingress, h.context);
        if (!resolved.ok) throw new Error(resolved.reasonCode);
        await writeFile(join(h.root, '.happier/project.json'), JSON.stringify({ ...h.manifest, services: { worker: { source: { kind: 'command', command: 'echo changed' } } } }));
        expect(await h.starter.startManagedDeclaration(resolved.declaration, request, h.ingress, h.context)).toMatchObject({ status: 'denied', reasonCode: 'project_service_effect_changed' });
        expect(h.owner.listProjectServices()).toEqual([]);
    });

    it('receives an immutable portable SOURCE, copies only during Start, and publishes actual worker custody without a finite slot', async () => {
        const h = await fixture(false, undefined, false, 'portable');
        const review = await h.routes.startTarget!(h.request, h.ingress, h.context);
        expect(review).toMatchObject({ status: 'denied', reasonCode: 'project_service_effect_review_required', reviewedEffectDigest: expect.any(String) });
        expect(h.copies()).toBe(0);
        expect(h.owner.listProjectServices()).toEqual([]);
        if (!review.reviewedEffectDigest) throw new Error('Expected SOURCE effect review');
        const result = await h.routes.startTarget!({ ...h.request, expectedEffectDigest: review.reviewedEffectDigest }, h.ingress, h.context);
        expect(result).toMatchObject({ status: 'succeeded', machineId: 'worker-machine', snapshot: {
            machineId: 'worker-machine', targets: [expect.objectContaining({ serviceState: 'running', workspaceId: h.targetWorkspace.id })] } });
        expect(h.copies()).toBe(1);
        expect(h.request.workspace).toMatchObject({ machineId: 'machine', workspaceId: h.workspace.id, rootPath: h.root });
        const handle = h.owner.listProjectServices()[0]!;
        const declaration = { workspaceRefId: h.targetWorkspace.id, selection: h.request.declaration.selection };
        expect(result.currentTarget).toEqual({ kind: 'managed_service', managedServiceId: handle.instanceId,
            machineId: h.targetWorkspace.machineId, workspaceId: h.targetWorkspace.id, cwd: h.targetRoot, declaration });
        expect(handle).toMatchObject({ workspace: h.targetWorkspace, declaration, cwd: h.targetRoot,
            serviceId: createProjectServiceDeclarationTargetIdV1(h.targetWorkspace, declaration.selection) });
        expect(handle.snapshot()).toMatchObject({ state: 'running', baseUrl: null });
        expect(h.setupProcesses).toEqual([]);
        await handle.stop();
    });

    it('refuses a receiving primary-only SOURCE before copy or setup consent', async () => {
        const h = await fixture(true, undefined, false, 'primary');
        expect(await h.routes.startTarget!(h.request, h.ingress, h.context)).toMatchObject({ status: 'denied', reasonCode: 'primary_only' });
        expect(h.copies()).toBe(0);
        expect(h.setupProcesses).toEqual([]);
        expect(h.owner.listProjectServices()).toEqual([]);
    });

    it('holds real worker setup review in the same operation, resumes after Remember, and releases its slot before service custody', async () => {
        const h = await fixture(true, undefined, true, 'portable');
        const reviewed = await h.routes.startTarget!(h.request, h.ingress, h.context);
        if (!reviewed.reviewedEffectDigest) throw new Error('Expected SOURCE service review');
        const request = { ...h.request, expectedEffectDigest: reviewed.reviewedEffectDigest };
        const completion = h.routes.startTarget!(request, h.ingress, h.context);
        const scope = { accountId: 'owner', machineId: h.targetWorkspace.machineId };
        await expect.poll(() => h.operationRuntime.store.get(scope, 'setup-operation')?.setupReview?.code).toBe('project_setup_consent_required');
        const pending = h.operationRuntime.store.get(scope, 'setup-operation')!;
        expect(h.copies()).toBe(1);
        expect(h.setupProcesses).toEqual([]);
        expect(h.owner.listProjectServices()).toEqual([]);
        expect(h.runtime.workerAdmission.dependencies()).toMatchObject([{ operationId: 'setup-operation', state: 'setup' }]);
        h.trustSetupDigest(pending.setupReview!.reviewedEffectDigest);
        // Exact original-request replay wakes the incumbent review owner; no new Start or reservation is submitted.
        await h.operationRuntime.observeExecution({ actionId: 'projects.prepare',
            input: { workspace: h.request.workspace, phase: 'setup' }, rpcContext: h.ingress,
            actionRequestId: h.context.actionRequestId, execute: async () => { throw new Error('Replay must keep the original setup closure'); } });
        await expect.poll(() => h.setupProcesses.length).toBe(1);
        expect(h.setupProcesses[0]?.params).toMatchObject({ options: { cwd: h.targetRoot } });
        h.setupProcesses[0]!.pty.exit(0);
        expect(await completion).toMatchObject({ status: 'succeeded' });
        expect(h.runtime.workerAdmission.dependencies()).toEqual([]);
        expect(h.operationRuntime.store.list(scope).items).toHaveLength(1);
        await h.owner.listProjectServices()[0]?.stop();
    });

    it('refuses copied declaration drift and a withdrawn exact route without native launch', async () => {
        const h = await fixture(false, undefined, false, 'portable');
        const review = await h.routes.startTarget!(h.request, h.ingress, h.context);
        if (!review.reviewedEffectDigest) throw new Error('Expected SOURCE effect review');
        h.changeCopiedManifest({ ...h.manifest, services: { worker: { ...h.manifest.services!.worker,
            source: { kind: 'command', command: 'echo changed' } } } });
        const request = { ...h.request, expectedEffectDigest: review.reviewedEffectDigest };
        expect(await h.routes.startTarget!(request, h.ingress, h.context)).toMatchObject({ status: 'denied', reasonCode: 'project_service_effect_changed' });
        expect(h.copies()).toBe(1);
        expect(h.owner.listProjectServices()).toEqual([]);
        h.withdrawRelationship();
        expect(await h.routes.startTarget!(request, h.ingress, h.context)).toMatchObject({ status: 'denied' });
        expect(h.copies()).toBe(1);
        expect(h.owner.listProjectServices()).toEqual([]);
    });

    it.each(['platform', 'configEnvironment'] as const)('binds the receiving %s to SOURCE review and refuses its change after copy', async fact => {
        const h = await fixture(false, undefined, false, 'portable');
        const review = await h.routes.startTarget!(h.request, h.ingress, h.context);
        expect(review).toMatchObject({ reviewedEffect: { serviceEffect: {
            command: { kind: 'literal', cwd: h.targetRoot }, environment: { kind: 'host' }, platform: { os: 'linux', arch: 'x64' },
        } } });
        if (!review.reviewedEffectDigest) throw new Error('Expected SOURCE effect review');
        h.afterCopy(() => Object.assign(h.runtime, fact === 'platform' ? { platform: 'darwin' } : { configEnvironment: { PORT: 'changed' } }));
        expect(await h.routes.startTarget!({ ...h.request, expectedEffectDigest: review.reviewedEffectDigest }, h.ingress, h.context))
            .toMatchObject({ status: 'denied', reasonCode: 'project_service_effect_changed' });
        expect(h.copies()).toBe(1);
        expect(h.owner.listProjectServices()).toEqual([]);
        expect(h.setupProcesses).toEqual([]);
    });

    it('refuses a new no-finite-prerequisite worker Service when the actual daemon drains before or during copy', async () => {
        const h = await fixture(false, undefined, false, 'portable');
        const review = await h.routes.startTarget!(h.request, h.ingress, h.context);
        if (!review.reviewedEffectDigest) throw new Error('Expected SOURCE effect review');
        const request = { ...h.request, expectedEffectDigest: review.reviewedEffectDigest };
        h.admissionDrain.beginTemporaryDrain();
        expect(await h.routes.startTarget!(request, h.ingress, h.context)).toMatchObject({ status: 'denied', reasonCode: 'draining' });
        expect(h.copies()).toBe(0);
        expect(h.owner.listProjectServices()).toEqual([]);
        h.admissionDrain.resume();
        h.afterCopy(() => h.admissionDrain.beginTemporaryDrain());
        expect(await h.routes.startTarget!(request, h.ingress, h.context)).toMatchObject({ status: 'denied', reasonCode: 'draining' });
        expect(h.copies()).toBe(1);
        expect(h.owner.listProjectServices()).toEqual([]);
        expect(h.setupProcesses).toEqual([]);
        expect(h.runtime.workerAdmission.dependencies()).toEqual([]);
    });

    it.each(['explicit', 'saved', 'withdrawn_after_copy'] as const)('uses current canonical pool membership at the receiving worker without reranking (%s)', async scenario => {
        const h = await fixture(false, undefined, false, 'portable');
        const poolId = '99d55938-f860-4af8-8023-01fecec86f35';
        let members: MachinePoolViewV1['pool']['members'] = [
            { machineId: 'higher-priority-machine', priorityTier: 0, enabled: true, state: 'connected' },
            { machineId: h.targetWorkspace.machineId, priorityTier: 1, enabled: true, state: 'connected' },
        ];
        // Only authenticated Home HTTP is replaced: canonical pool Action/codec and native Action execution remain real.
        vi.spyOn(axios, 'request').mockImplementation(async config => {
            expect(config.headers).toMatchObject({ Authorization: `Bearer ${h.runtime.credentials.token}` });
            if (config.url === 'https://home.example/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
            expect(config.url).toBe('https://home.example/v1/machines/pools/get');
            expect(config.method).toBe('POST');
            expect(config.data).toEqual({ poolId });
            const view: MachinePoolViewV1 = { pool: { id: poolId, name: 'Workers', description: null, revision: 1, createdAt: 1, updatedAt: 1, members },
                availability: { state: 'known', connectedCount: members.length, enabledCount: members.length } };
            return { status: 200, data: view };
        });
        const gate = createLocalServicesDaemonFeatureGate({ env: {}, resolveServerFeaturesSnapshot: () => ({ status: 'ready',
            features: FeaturesResponseSchema.parse({ features: { localServices: { enabled: true, inventory: { enabled: true }, launcher: { enabled: true },
                managed: { enabled: true }, actions: { enabled: true } }, browser: { enabled: true, viewTargets: { enabled: true } } }, capabilities: {} }) }) });
        await gate.refresh();
        expect(gate.isEnabled('localServices.launcher')).toBe(true);
        const executor = createCliActionExecutorFromCredentials({ credentials: h.runtime.credentials, serverId: 'home',
            serverApiUrl: 'https://home.example', machineId: h.targetWorkspace.machineId, pluginActionExecutionOwner: 'current_process',
            readCredentials: async () => h.runtime.credentials,
            runtimeActionExecute: createLocalServicesDaemonRuntimeActionExecutor({ featureGate: gate, ingress: h.ingress,
                routes: { launcherRoutes: h.routes } }) });
        const choice = { kind: 'workers' as const, destination: { kind: 'pool' as const, poolId, selection: 'automatic' as const } };
        h.savePlacement({ runsOn: choice, unavailable: 'fail' });
        const { choice: exactChoice, ...sourceRequest } = h.request;
        expect(exactChoice).toMatchObject({ destination: { machineId: h.targetWorkspace.machineId } });
        const request = { ...sourceRequest, ...(scenario === 'saved' ? {} : { choice }) };
        const context = { surface: 'cli' as const, authority: 'present_user' as const,
            presentUserConfirmation: { actionId: 'localServices.launcher.start' as const }, actionRequestId: 'pool-native-start' };
        const review = await executor.execute('localServices.launcher.start', request, context);
        expect(review, JSON.stringify(review, null, 2)).toMatchObject({ ok: true, result: { status: 'denied', reasonCode: 'project_service_effect_review_required' } });
        if (!review.ok || !review.result || typeof review.result !== 'object' || !('reviewedEffectDigest' in review.result)
            || typeof review.result.reviewedEffectDigest !== 'string') throw new Error('Expected current pool SOURCE effect review');
        expect(h.copies()).toBe(0);
        if (scenario === 'withdrawn_after_copy') h.afterCopy(() => { members = members.filter(member => member.machineId !== h.targetWorkspace.machineId); });
        const started = await executor.execute('localServices.launcher.start', { ...request, expectedEffectDigest: review.result.reviewedEffectDigest }, context);
        expect(started).toMatchObject({ ok: true, result: scenario === 'withdrawn_after_copy'
            ? { status: 'denied', reasonCode: 'target_not_local' }
            : { status: 'succeeded', currentTarget: { machineId: h.targetWorkspace.machineId, workspaceId: h.targetWorkspace.id } } });
        expect(h.copies()).toBe(1);
        expect(request.workspace).toEqual(h.request.workspace);
        expect(request.declaration.workspaceRefId).toBe(h.workspace.id);
        expect(request.choice).toEqual(scenario === 'saved' ? undefined : choice);
        expect(h.setupProcesses).toEqual([]);
        if (scenario === 'withdrawn_after_copy') expect(h.owner.listProjectServices()).toEqual([]);
        else await h.owner.listProjectServices()[0]?.stop();
    });

    it('refuses a primary-only worker choice before requesting setup consent or starting a service', async () => {
        const h = await fixture(true);
        const request = { ...h.request, choice: { kind: 'workers' as const,
            destination: { kind: 'machine' as const, machineId: 'worker-machine' } } };
        expect(await h.starter.resolveStartTarget(request, h.ingress, h.context))
            .toMatchObject({ ok: false, reasonCode: 'primary_only' });
        expect(h.owner.listProjectServices()).toEqual([]);
        expect(h.setupProcesses).toEqual([]);
    });

    it('starts a service with no finite prerequisite when finite admission is off', async () => {
        const h = await fixture(false, undefined, false);
        const review = await h.starter.resolveStartTarget(h.request, h.ingress, h.context);
        if (review.ok || !review.reviewedEffectDigest) throw new Error('Expected Service effect review');
        const request = { ...h.request, expectedEffectDigest: review.reviewedEffectDigest };
        const selected = await h.starter.resolveStartTarget(request, h.ingress, h.context);
        if (!selected.ok) throw new Error(selected.reasonCode);
        expect(await h.starter.startManagedDeclaration(selected.declaration, request, h.ingress, h.context))
            .toMatchObject({ status: 'succeeded' });
        expect(h.setupProcesses).toEqual([]);
        expect(h.owner.listProjectServices()[0]?.snapshot()).toMatchObject({ state: 'running', baseUrl: null });
        await h.owner.listProjectServices()[0]?.stop();
    });

    it('starts an accepted native package declaration with the actual resolved executable and argv', async () => {
        const h = await fixture(false, { kind: 'native', tool: 'package_script', file: 'package.json', target: 'dev' });
        await writeFile(join(h.root, 'package.json'), JSON.stringify({ name: 'package', scripts: { dev: 'package-authored server command' } }));
        // A system-tool wrapper is a genuine OS resolution boundary. The native codec must retain its argv prefix.
        h.setNativeTool({ executablePath: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)', '--'] });
        const directTargets = await discoverLocalServiceRunTargets({ roots: [], acceptedWorkspaceRefs: [h.workspace] });
        const target = directTargets.find(target => 'declaration' in target && target.declaration.selection.kind === 'native'
            && target.declaration.selection.source.kind === 'native' && target.declaration.selection.source.tool === 'package_script');
        if (!target || !('declaration' in target)) throw new Error('Expected direct accepted package declaration');
        const selectedRequest = { ...h.request, targetId: target.id, declaration: target.declaration };
        const review = await h.routes.startTarget!(selectedRequest, h.ingress, h.context);
        expect(review).toMatchObject({ status: 'denied', reasonCode: 'project_service_effect_review_required', reviewedEffect: {
            command: { args: ['-e', 'setInterval(() => {}, 1000)', '--', 'run', 'dev'] },
        } });
        if (!review.reviewedEffectDigest) throw new Error('Expected native effect review');
        const request = { ...selectedRequest, expectedEffectDigest: review.reviewedEffectDigest };
        expect(await h.routes.startTarget!(request, h.ingress, h.context)).toMatchObject({ status: 'succeeded' });
        expect(h.owner.listProjectServices()[0]?.snapshot()).toMatchObject({ state: 'running', baseUrl: null });
        await h.owner.listProjectServices()[0]?.stop();
    });

    it.each([
        [{ kind: 'native', tool: 'flox', file: '.flox/env/manifest.toml', target: 'web' }, 'native_service_lifecycle_unsupported'],
        [{ kind: 'pluginNative', adapter: { pluginId: 'acme.native', localId: 'service' }, file: 'service.json', target: 'web' }, 'native_service_instance_unavailable'],
    ])('refuses a detached source lacking an actual native instance/lifecycle witness', async (source, reasonCode) => {
        const h = await fixture(false, source);
        expect(await h.starter.resolveStartTarget(h.request, h.ingress, h.context)).toMatchObject({ ok: false, reasonCode });
        expect(h.owner.listProjectServices()).toEqual([]);
    });

    it('keeps setup consent separate and refuses foreign requester credentials before reading Home', async () => {
        const h = await fixture(true);
        expect(await h.starter.resolveStartTarget(h.request, { ...h.ingress, machineAdmission: { ...h.ingress.machineAdmission!, actorAccountId: 'teammate' } }, h.context))
            .toMatchObject({ ok: false, reasonCode: 'project_requester_credentials_unavailable' });
        expect(h.post).not.toHaveBeenCalled();
        expect(await h.starter.resolveStartTarget(h.request, h.ingress, h.context)).toMatchObject({ ok: false, reasonCode: 'project_setup_consent_required' });
        expect(h.owner.listProjectServices()).toEqual([]);
        expect(h.setupProcesses).toEqual([]);
    });

    it('waits for the actual admitted setup PTY exit before establishing the Service', async () => {
        const h = await fixture(true);
        const setupReview = await h.starter.resolveStartTarget(h.request, h.ingress, h.context);
        if (setupReview.ok || setupReview.reasonCode !== 'project_setup_consent_required' || !setupReview.reviewedEffectDigest) throw new Error('Expected setup review');
        // The Home boundary now reports the pre-existing approved D18 setup row, not a Service trust grant.
        h.trustSetupDigest(setupReview.reviewedEffectDigest);
        const serviceReview = await h.starter.resolveStartTarget(h.request, h.ingress, h.context);
        if (serviceReview.ok || !serviceReview.reviewedEffectDigest) throw new Error('Expected Service review');
        const request = { ...h.request, expectedEffectDigest: serviceReview.reviewedEffectDigest };
        const resolved = await h.starter.resolveStartTarget(request, h.ingress, h.context);
        if (!resolved.ok) throw new Error(resolved.reasonCode);
        let finished = false;
        const completion = h.starter.startManagedDeclaration(resolved.declaration, request, h.ingress, h.context).then(result => { finished = true; return result; });
        await expect.poll(() => h.setupProcesses.length).toBe(1);
        expect(h.owner.listProjectServices()).toEqual([]);
        expect(finished).toBe(false);
        expect(h.setupProcesses[0]?.params).toMatchObject({ args: ['-c', 'echo setup'], options: { cwd: h.root } });
        h.setupProcesses[0]!.pty.exit(0);
        expect(await completion).toMatchObject({ status: 'succeeded', currentTarget: { kind: 'managed_service', machineId: 'machine' } });
        expect(h.owner.listProjectServices()[0]?.snapshot()).toMatchObject({ state: 'running', baseUrl: null });
        await h.owner.listProjectServices()[0]?.stop();
    });
    it.each(['rpc', 'agent'] as const)('restarts the exact occurrence through fresh Start admission on %s, retaining independent Start approval', async surface => {
        const h = await fixture();
        const review = await h.routes.startTarget!(h.request, h.ingress, h.context);
        if (!review.reviewedEffectDigest) throw new Error('Expected current Service review');
        const start = { ...h.request, expectedEffectDigest: review.reviewedEffectDigest };
        expect(await h.routes.startTarget!(start, h.ingress, h.context)).toMatchObject({ status: 'succeeded' });
        const original = h.owner.listProjectServices()[0]!;
        const actionRoutes = createLocalServiceActionRoutes({ machineId: 'machine', projectManagedServices: h.owner,
            inventoryRegistry: createLocalServiceInventoryRegistry(), restartManagedService: h.starter.restartManagedService,
            verifyConfirmationNonce: request => request.confirmationNonce === createLocalServiceActionConfirmationNonceV1(request) });
        const gate = createLocalServicesDaemonFeatureGate({ env: {}, resolveServerFeaturesSnapshot: () => ({ status: 'ready',
            features: FeaturesResponseSchema.parse({ features: { localServices: { enabled: true, inventory: { enabled: true },
                managed: { enabled: true }, actions: { enabled: true }, launcher: { enabled: true } },
                browser: { enabled: true, viewTargets: { enabled: true } } }, capabilities: {} }) }) });
        await gate.refresh();
        const approvals: string[] = [];
        const execute: ReturnType<typeof createLocalServicesDaemonRuntimeActionExecutor> = createLocalServicesDaemonRuntimeActionExecutor({ featureGate: gate, ingress: h.ingress,
            routes: { launcherRoutes: h.routes, actionRoutes },
            prepareStartAction: (request, context) => executor.prepare('localServices.launcher.start', request, context) });
        const executor: ReturnType<typeof createActionExecutor> = createActionExecutor({
            ...createCliActionDeps({ token: h.runtime.credentials.token, credentials: h.runtime.credentials,
                serverId: 'home', serverHttpBaseUrl: 'https://home.example', sessionId: 'cli-global', mode: 'plain', ctx: null }),
            runtimeActionExecute: execute,
            isActionApprovalRequired: (actionId, context) => isApprovalRequiredByActionsSettings(actionId,
                normalizeActionsSettingsV1(null), context),
            // Artifact persistence and the human decision are genuine external boundaries.
            approvalsCreate: async ({ request }) => { approvals.push(request.actionId); return { artifactId: 'restart-start-review' }; },
            approvalsUpdate: async () => ({ ok: true }),
            approvalsWaitForDecision: async ({ request }) => {
                expect(original.snapshot().state).toBe('running');
                return { decision: 'reject' as const, request, decisionAuthority: 'present_user' as const };
            } });
        const request = { requestId: 'restart-service', action: 'restart_managed' as const, force: false,
            expectedEffectDigest: review.reviewedEffectDigest,
            target: { kind: 'managed_service' as const, machineId: 'machine', managedServiceId: original.instanceId,
                workspaceId: h.workspace.id, declaration: h.request.declaration, cwd: h.root } };
        await writeFile(join(h.root, '.happier/project.json'), JSON.stringify({ ...h.manifest,
            services: { ...h.manifest.services, worker: { source: { kind: 'command', command: 'different reviewed effect' } } } }));
        expect(await execute({ actionId: 'localServices.actions.restartManaged',
            input: { ...request, confirmationNonce: createLocalServiceActionConfirmationNonceV1(request) },
            context: { ...h.context, actionRequestId: request.requestId, surface } })).toMatchObject({ status: 'denied', reasonCode: 'project_service_effect_changed' });
        expect(original.snapshot().state).toBe('running');
        expect(approvals).toEqual([]);
        await writeFile(join(h.root, '.happier/project.json'), JSON.stringify(h.manifest));
        const result = await execute({ actionId: 'localServices.actions.restartManaged',
            input: { ...request, confirmationNonce: createLocalServiceActionConfirmationNonceV1(request) },
            context: { ...h.context, actionRequestId: request.requestId, surface } });
        if (surface === 'agent') {
            expect(original.snapshot().state).toBe('running');
            expect(result).toMatchObject({ status: 'denied', reasonCode: 'approval_rejected' });
            expect(approvals).toEqual(['localServices.launcher.start']);
            expect(h.owner.listProjectServices()).toEqual([original]);
        } else {
            expect(original.snapshot().state).toBe('stopped');
            expect(result).toMatchObject({ status: 'succeeded' });
            expect(approvals).toEqual([]);
            expect(h.owner.listProjectServices()[0]?.instanceId).not.toBe(original.instanceId);
            expect(h.owner.listProjectServices()[0]?.snapshot().state).toBe('running');
        }
    });
    it('keeps the legacy Machine control transport behind the same current Agent approval policy', async () => {
        const h = await fixture();
        const review = await h.routes.startTarget!(h.request, h.ingress, h.context);
        if (!review.reviewedEffectDigest) throw new Error('Expected current Service effect');
        expect(await h.routes.startTarget!({ ...h.request, expectedEffectDigest: review.reviewedEffectDigest }, h.ingress, h.context))
            .toMatchObject({ status: 'succeeded' });
        const handle = h.owner.listProjectServices()[0]!;
        const actionRoutes = createLocalServiceActionRoutes({ machineId: 'machine', projectManagedServices: h.owner,
            inventoryRegistry: createLocalServiceInventoryRegistry(),
            verifyConfirmationNonce: request => request.confirmationNonce === createLocalServiceActionConfirmationNonceV1(request) });
        const gate = createLocalServicesDaemonFeatureGate({ env: {}, resolveServerFeaturesSnapshot: () => ({ status: 'ready',
            features: FeaturesResponseSchema.parse({ features: { localServices: { enabled: true, inventory: { enabled: true },
                actions: { enabled: true }, managed: { enabled: true } } }, capabilities: {} }) }) });
        await gate.refresh();
        const rpc = new RpcHandlerManager({ scopePrefix: 'machine', localMachineId: 'machine', encryptionMode: 'plain' });
        const approvals: string[] = [];
        registerDaemonLocalServicesMachineRpcHandlers(rpc, { machineId: 'machine', serverId: 'home', localServicesActions: actionRoutes,
            resolveLauncherActionExecutor: ({ ingress }) => {
                const executor = createActionExecutor({
                    ...createCliActionDeps({ token: h.runtime.credentials.token, credentials: h.runtime.credentials,
                        serverId: 'home', serverHttpBaseUrl: 'https://home.example', sessionId: 'cli-global', mode: 'plain', ctx: null }),
                    runtimeActionExecute: createLocalServicesDaemonRuntimeActionExecutor({
                        featureGate: gate, ingress, routes: { actionRoutes } }),
                    isActionApprovalRequired: (actionId, context) => isApprovalRequiredByActionsSettings(actionId,
                        normalizeActionsSettingsV1(null), context),
                    approvalsCreate: async ({ request }) => { approvals.push(request.actionId); return { artifactId: 'stop-review' }; },
                    approvalsUpdate: async () => ({ ok: true }),
                    approvalsWaitForDecision: async ({ request }) => ({ decision: 'reject' as const, request, decisionAuthority: 'present_user' as const }) });
                return { execute: (actionId, input, context) => executor.execute(actionId, input, { serverId: 'home', ...context }) };
            } });
        const request = { requestId: 'legacy-stop', action: 'stop_managed' as const, force: false,
            target: { kind: 'managed_service' as const, machineId: 'machine', managedServiceId: handle.instanceId,
                workspaceId: h.workspace.id, declaration: h.request.declaration, cwd: h.root } };
        expect(await rpc.invokeLocal(RPC_METHODS.DAEMON_LOCAL_SERVICES_ACTIONS_EXECUTE,
            { ...request, confirmationNonce: createLocalServiceActionConfirmationNonceV1(request) },
            { localActionContext: { surface: 'agent', authority: 'account_automation', actionRequestId: request.requestId } }))
            .toMatchObject({ ok: false, errorCode: 'approval_rejected' });
        expect(approvals).toEqual(['localServices.actions.stopManaged']);
        expect(handle.snapshot().state).toBe('running');
    });
    it('reaches fresh replacement through the actual receiving Machine Restart Action handler', async () => {
        const h = await fixture();
        const review = await h.routes.startTarget!(h.request, h.ingress, h.context);
        if (!review.reviewedEffectDigest) throw new Error('Expected Service effect review');
        expect(await h.routes.startTarget!({ ...h.request, expectedEffectDigest: review.reviewedEffectDigest }, h.ingress, h.context))
            .toMatchObject({ status: 'succeeded' });
        const old = h.owner.listProjectServices()[0]!;
        const actionRoutes = createLocalServiceActionRoutes({ machineId: 'machine', projectManagedServices: h.owner,
            inventoryRegistry: createLocalServiceInventoryRegistry(), restartManagedService: h.starter.restartManagedService,
            verifyConfirmationNonce: request => request.confirmationNonce === createLocalServiceActionConfirmationNonceV1(request) });
        const featureGate = createLocalServicesDaemonFeatureGate({ env: {}, resolveServerFeaturesSnapshot: () => ({ status: 'ready',
            features: FeaturesResponseSchema.parse({ features: { localServices: { enabled: true, inventory: { enabled: true },
                managed: { enabled: true }, actions: { enabled: true }, launcher: { enabled: true } },
                browser: { enabled: true, viewTargets: { enabled: true } } }, capabilities: {} }) }) });
        await featureGate.refresh();
        const rpc = new RpcHandlerManager({ scopePrefix: 'machine', localMachineId: 'machine', encryptionMode: 'plain',
            authorizeRequest: request => authorizeMachineRpcRequest(request, { machineId: 'machine',
                resolveCustodianAccountId: async () => 'owner', resolveInstallationId: () => 'installation',
                verifyMachineAdmission: async () => true }) });
        registerDaemonLocalServicesMachineRpcHandlers(rpc, { machineId: 'machine', serverId: 'home', localServicesActions: actionRoutes,
            resolveLauncherActionExecutor: ({ ingress }) => {
                const executor: ReturnType<typeof createActionExecutor> = createActionExecutor({
                    ...createCliActionDeps({ token: h.runtime.credentials.token, credentials: h.runtime.credentials,
                        serverId: 'home', serverHttpBaseUrl: 'https://home.example', sessionId: 'cli-global', mode: 'plain', ctx: null }),
                    runtimeActionExecute: createLocalServicesDaemonRuntimeActionExecutor({ featureGate, ingress,
                        routes: { launcherRoutes: h.routes, actionRoutes },
                        prepareStartAction: (request, context) => executor.prepare('localServices.launcher.start', request, context) }) });
                return { execute: (actionId, input, context) => executor.execute(actionId, input, { serverId: 'home', ...context }) };
            } });
        const request = { requestId: 'received-restart', action: 'restart_managed' as const, force: false,
            expectedEffectDigest: review.reviewedEffectDigest,
            target: { kind: 'managed_service' as const, machineId: 'machine', managedServiceId: old.instanceId,
                workspaceId: h.workspace.id, declaration: h.request.declaration, cwd: h.root } };
        expect(await rpc.handleRequest({ method: 'machine:daemon.localServices.actions.restartManaged',
            params: { ...request, confirmationNonce: createLocalServiceActionConfirmationNonceV1(request) },
            requestId: request.requestId, machineAdmission: h.ingress.machineAdmission })).toMatchObject({ status: 'succeeded' });
        expect(old.snapshot().state).toBe('stopped');
        expect(h.owner.listProjectServices()[0]?.instanceId).not.toBe(old.instanceId);
        expect(h.owner.listProjectServices()[0]?.snapshot().state).toBe('running');
    });
});
