import axios from 'axios';
import { mkdtemp, mkdir, rm, writeFile, readFile, access, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorkspaceExecutionConfigClientV1 } from '@happier-dev/protocol/workspaces/workspaceExecutionConfigClientV1';
import type { WorkerDestinationV1 } from '@happier-dev/protocol/workspaces/projectWorkerPreferencesV1';
import type { MachinePoolViewV1 } from '@happier-dev/protocol/machines/pools/v1';
import { createAccountServerActionDeps } from '@/api/accountServerActionDeps';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';
import * as machineRpcTransport from '@/session/transport/rpc/machineRpc';
import { createProjectWorkerAction } from '@/workspaces/execution/projectWorkerAction';
import { WORKSPACE_EXECUTION_CONFIG_ROUTE_V1 } from '@happier-dev/protocol/workspaces/workspaceExecutionConfigRowV1';
import type { RpcHandlerContext } from '@/api/rpc/types';
import { PROJECT_FINITE_ACTION_RPC_METHODS_V1, ProjectSetupConsentFailureDetailsV1Schema } from '@happier-dev/protocol/actions/projectActionFamily';
import { ProjectDefinitionInspectOutputSchema } from '@happier-dev/protocol/actions/projectDefinitionActionFamily';
import { createProjectDefinitionAction } from '@/rpc/handlers/projectDefinitions';
import { ProjectTrustMutationRequestV1Schema, type ProjectTrustContentV1 } from '@happier-dev/protocol/workspaces/projectSetup/projectTrustRowV1';
import { createProjectSetupTrustClient } from './projectSetupTrust';
import { readProjectManifest } from './projectManifestFile';
import type { RpcHandler, RpcHandlerRegistrar } from '@/api/rpc/types';
import { registerProjectFiniteRpcHandlers } from '@/rpc/handlers/projects/registerProjectFiniteRpcHandlers';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { bindExternalActionExecutionAuthorizationHttpPathV1, ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionExecutionAuthorizationV1Schema, ExternalActionMachineBootstrapV1Schema, ExternalActionRequestEnvelopeV1Schema, ExternalActionResponseEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { ProjectWorkerStatusInputV1Schema } from '@happier-dev/protocol/actions/specs/projectWorkers';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { computeWorkspaceSyncPolicyDigest, type WorkspaceSyncRelationshipV1, type WorkspaceRefV1 } from '@happier-dev/protocol';
import { createWorkspaceSyncWorkerPreparation, resolveWorkspaceSyncWorkerTarget, prepareWorkspaceSyncBetween } from '@/workspaces/sync/workspaceSyncPreparation';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { createDaemonAdmissionDrain } from '@/daemon/lifecycle/admissionDrain';
import { createProjectWorkerAdmission } from '@/workspaces/execution/projectWorkerAdmission';
import { createTerminalPtySessionManager } from '@/terminal/pty/sessions';
import type { PtyExitEvent, PtyProcess, PtySpawnParams } from '@/terminal/pty/provider';
import { createProjectFiniteAction, type ProjectFiniteActionRuntime } from './projectFiniteAction';
import { createProjectNativeEnvironmentIoForHost } from '@/plugins/runtime/invocation/services/exec';
import * as processTreeBoundary from '@/agent/runtime/process/killProcessTree';

const turn = () => new Promise<void>(resolve => setImmediate(resolve));
// The Home HTTP boundary publishes this fixture Account identity; it is not caller-supplied Action authority.
const ownerToken = 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJvd25lciJ9.signature';
const portableNativeManifest = { version: 1, scripts: { checked: { execution: 'portable',
    source: { kind: 'native', tool: 'make', file: 'Makefile', target: 'check' } } } } as const;
class BoundaryPty implements PtyProcess {
    readonly pid = 3456;
    readonly ownedProcessGroupId = 3456;
    private readonly exits = new Set<(event: PtyExitEvent) => void>();
    write() {}
    resize() {}
    kill() {}
    onData() { return { dispose() {} }; }
    onExit(listener: (event: PtyExitEvent) => void) { this.exits.add(listener); return { dispose: () => this.exits.delete(listener) }; }
    exit(exitCode: number) { for (const listener of this.exits) listener({ exitCode }); }
}

describe('authenticated finite Project Action owner', () => {
    const roots: string[] = [];
    const managers: Array<ReturnType<typeof createTerminalPtySessionManager>> = [];
    afterEach(async () => { managers.splice(0).forEach(manager => manager.dispose()); vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
    async function harness(manifest?: unknown, runAtMost: number | null = null, sourceMachineId = 'machine', credentialToken = 'requester') {
        const root = await mkdtemp(join(tmpdir(), 'happier-project-finite-'));
        roots.push(root);
        if (manifest) { await mkdir(join(root, '.happier')); await writeFile(join(root, '.happier/project.json'), JSON.stringify(manifest)); }
        await writeFile(join(root, 'Makefile'), 'check:\n\techo checked\n');
        const workspace = { id: 'accepted', serverId: 'home', machineId: sourceMachineId, rootPath: root, createdAtMs: 1, projectKey: 'project' };
        const address = { serverId: 'home', machineId: sourceMachineId, rootPath: root, workspaceId: 'accepted' };
        const workspaceRefs: WorkspaceRefV1[] = [workspace];
        const relationships: WorkspaceSyncRelationshipV1[] = [];
        let trustContent: ProjectTrustContentV1 | null = null;
        const get = vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { mode: 'plain', updatedAt: 1 } });
        const post = vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
            if (String(url).endsWith('/project-trust/read')) return { status: 200, data: trustContent
                ? { status: 'present', revision: 1, content: trustContent } : { status: 'absent' } };
            if (String(url).endsWith('/project-trust/mutate')) {
                const mutation = ProjectTrustMutationRequestV1Schema.parse(body);
                trustContent = mutation.content;
                return { status: 200, data: { status: 'updated', revision: 1, cursor: 1 } };
            }
            return { status: 200, data: { status: 'listed', coverage: 'complete', rows: [...workspaceRefs.map(value => {
                const key = { kind: 'workspace-ref', serverId: 'home', id: value.id };
                return { key, revision: 1, content: { t: 'plain', v: { key, value } } };
            }), { key: { kind: 'relationship-graph' }, revision: 1,
                content: { t: 'plain', v: { key: { kind: 'relationship-graph' }, value: { relationships } } } }] } };
        });
        const spawned: Array<{ params: PtySpawnParams; pty: BoundaryPty }> = [];
        const terminalSessions = createTerminalPtySessionManager({
            ptyProvider: { spawn(params) { const pty = new BoundaryPty(); spawned.push({ params, pty }); return pty; } },
            config: { maxSessions: 10, idleTimeoutMs: 60_000, bufferMaxBytes: 1_000_000, bufferMaxEvents: 1000,
                bufferRetentionMs: 600_000, urlParseBufferLimit: 32_768, maxWriteChunkBytes: 16_384, defaultCols: 80, defaultRows: 24 },
            // The fake OS process has no descendants after its exit event.
            env: {}, platform: 'linux', stopProcessTree: async () => {}, probeProcessGroup: () => 'absent',
        });
        managers.push(terminalSessions);
        let sequence = 0;
        const operationRuntime = createHostActionOperationRuntime({ machineId: 'machine', resolveAccountId: async () => 'owner',
            generateOperationId: () => ++sequence === 1 ? 'operation' : `operation-${sequence}` });
        let allowAdHoc = false;
        let workersEnabled = false;
        let unavailable: 'ask' | 'primary' | 'fail' = 'ask';
        let workerDestination: WorkerDestinationV1 = { kind: 'machine', machineId: 'machine' };
        const workspaceExecutionConfig = createWorkspaceExecutionConfigClientV1({ mode: 'plain', material: null, isCurrent: () => true,
            randomBytes: length => new Uint8Array(length), transport: {
                read: async () => ({ status: 'present', revision: 1, content: { t: 'plain', v: {
                    enabled: workersEnabled, unavailable, allowAdHoc, scriptOverrides: {}, services: {},
                    ...(workersEnabled ? { destination: workerDestination } : {}),
                } } }), mutate: async () => { throw new Error('read only'); },
            } });
        let accepting = true;
        const workerAdmission = createProjectWorkerAdmission({ machineId: 'machine', admissionDrain: createDaemonAdmissionDrain(),
            readPolicy: async () => ({ status: 'ready', policy: { accepting, runAtMost }, source: 'stored', metadataVersion: 1 }) });
        const context: RpcHandlerContext = { signal: new AbortController().signal, transportRequestId: 'transport',
            machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: 'machine', installationId: 'installation', role: 'manage', encryptionMode: 'plain' },
            verifyMachineAdmissionCurrent: async () => true };
        let nativeExecutablePath: string | undefined;
        let nativeExecutableRelativePath: string | undefined;
        const configEnvironment: Record<string, string> = { MODE: 'original' };
        let credentialCurrent = true;
        let continueCopy = () => {};
        let copyAllowed = Promise.resolve();
        const holdCopy = () => { copyAllowed = new Promise<void>(resolve => { continueCopy = resolve; }); };
        holdCopy();
        const runtime: ProjectFiniteActionRuntime = {
            accountId: 'owner', serverId: 'home', machineId: 'machine', credentials: { token: credentialToken, encryption: null }, serverHttpBaseUrl: 'https://home.example',
            isCurrent: async () => credentialCurrent,
            terminalSessions, operationRuntime, workerAdmission, resolveWorkspaceExecutionConfig: async () => workspaceExecutionConfig,
            nativeIo: { resolveTool: async (tool, request) => ({ executablePath: nativeExecutableRelativePath
                ? join(request.cwd, nativeExecutableRelativePath) : nativeExecutablePath ?? `/managed/${tool}`, version: '1' }) },
            environmentIo: createProjectNativeEnvironmentIoForHost({ resolveTool: async () => null }),
            platform: 'linux', arch: 'x64', hostEnvironment: {}, successHomeDir: join(root, 'success'),
            configEnvironment,
            // The system transport boundary invokes the real passive definition owner on the SOURCE host.
            inspectSourceProjectManifest: async ({ source, signal }) => {
                const inspect = createProjectDefinitionAction({ serverId: source.serverId, machineId: source.machineId,
                    workingDirectory: source.rootPath, accessPolicy: { kind: 'restrictedRoots', roots: [source.rootPath] }, nativeIo: runtime.nativeIo });
                const result = await inspect({ actionId: 'projects.inspect', input: { workspace: { serverId: source.serverId,
                    machineId: source.machineId, workspaceId: source.id, rootPath: source.rootPath } }, context: { signal, serverId: source.serverId } });
                const inspection = ProjectDefinitionInspectOutputSchema.parse(result);
                return { ...inspection.definition, commands: inspection.commands, environmentExecutionInputs: inspection.environmentExecutionInputs };
            },
            resolveWorkerTarget: async ({ source }) => {
                const resolved = resolveWorkspaceSyncWorkerTarget({ serverId: 'home', sourceWorkspaceRefId: source.id, targetMachineId: 'machine', workspaceRefs, relationships });
                if (!resolved.ok) throw Object.assign(new Error(resolved.errorCode), { code: resolved.errorCode });
                return resolved;
            },
            prepareDequeue: async ({ basis, signal }) => {
                if (!basis) return;
                const prepared = await prepareWorkspaceSyncBetween({ serverId: 'home', sourceWorkspaceRefId: basis.source.id,
                    targetWorkspaceRefId: basis.target.id, readCurrent: async () => ({ workspaceRefs, relationships }), signal,
                    // This boundary stands for the external Sync controller's actual file-copy and clean-status response.
                    flush: async relationshipId => {
                        await copyAllowed;
                        await cp(basis.source.rootPath, basis.target.rootPath, { recursive: true });
                        return { relationshipId, controllerMachineId: sourceMachineId, state: 'watching', alphaPath: basis.source.rootPath, betaPath: basis.target.rootPath,
                            mode: 'keep_synced', endpointStates: {
                                alpha: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 },
                                beta: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 },
                            }, conflictCount: 0, lastCycleObservedAtMs: null };
                    },
                });
                if (!prepared.ok) throw Object.assign(new Error(prepared.errorCode), { code: prepared.errorCode });
            },
        };
        const invoke = (actionId: 'projects.prepare' | 'projects.script.run' | 'projects.compute.exec', input: unknown, ingress = context) =>
            createProjectFiniteAction(runtime, ingress)({ actionId, input, context: { authority: 'account_automation', actionRequestId: ingress.transportRequestId ?? 'request', serverId: 'home' } });
        const handlers = new Map<string, RpcHandler<unknown, unknown>>();
        const registrar: RpcHandlerRegistrar = { registerHandler<TRequest, TResponse>(method: string, handler: RpcHandler<TRequest, TResponse>) {
            // RPC ingress is untyped; registered production handlers validate the request beneath this boundary.
            handlers.set(method, (request, ingress) => handler(request as TRequest, ingress));
        } };
        let invocationApprovalRequired = false;
        registerProjectFiniteRpcHandlers(registrar, { serverId: 'home', machineId: 'machine', runtime,
            createActionExecutor: async (current, ingress) => {
                const { createCliActionExecutorHarness } = await import('@/session/actions/createCliActionExecutorHarness');
                return createCliActionExecutorHarness({ token: current.credentials.token,
                credentials: current.credentials, mode: 'plain', ctx: null, sessionId: 'fixture-session', serverId: current.serverId, serverHttpBaseUrl: current.serverHttpBaseUrl,
                actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1({ v: 1,
                    actions: invocationApprovalRequired ? { 'projects.script.run': { approvalRequiredSurfaces: ['rpc', 'api'] } } : {},
                    ...(invocationApprovalRequired ? {} : { approvalWaivedSurfaces: { 'projects.prepare': ['rpc', 'api', 'agent'], 'projects.script.run': ['rpc', 'api', 'agent'], 'projects.compute.exec': ['rpc', 'api', 'agent'] } }),
                }) },
                }, { machinePoolAction: createAccountServerActionDeps({ token: current.credentials.token, credentials: current.credentials,
                    serverId: current.serverId, serverHttpBaseUrl: current.serverHttpBaseUrl }).machinePoolAction,
                    projectAction: createProjectFiniteAction(current, ingress) }).executor;
            },
        });
        const rpcInvoke = (actionId: 'projects.prepare' | 'projects.script.run' | 'projects.compute.exec', input: unknown, ingress = context) =>
            handlers.get(PROJECT_FINITE_ACTION_RPC_METHODS_V1[actionId])!(input, ingress);
        const addWorkerTarget = async () => {
            const targetRoot = await mkdtemp(join(tmpdir(), 'happier-project-worker-'));
            roots.push(targetRoot);
            await mkdir(join(targetRoot, '.happier'));
            await writeFile(join(targetRoot, '.happier/project.json'), 'invalid before clean copy');
            const target = { ...workspace, id: 'worker-target', machineId: 'machine', rootPath: targetRoot };
            workspaceRefs.push(target);
            const policy = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
            relationships.push({ v: 1, relationshipId: 'source-worker', controllerMachineId: sourceMachineId,
                alphaWorkspaceRefId: workspace.id, betaWorkspaceRefId: target.id, mode: 'keep_synced', enabled: true,
                contentPolicy: { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) }, createdAtMs: 1, updatedAtMs: 1 });
            workersEnabled = true;
            return target;
        };
        const installPreferenceReadHttpBoundary = () => vi.spyOn(axios, 'request').mockImplementation(async config => {
            expect(config.headers).toMatchObject({ Authorization: `Bearer ${credentialToken}` });
            if (config.url === 'https://home.example/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
            expect(config.url).toBe(`https://home.example${WORKSPACE_EXECUTION_CONFIG_ROUTE_V1}/read`);
            expect(config.data).toEqual({ address: { serverId: 'home', refId: address.workspaceId } });
            const preference = await workspaceExecutionConfig.get({ workspace: { serverId: 'home', refId: address.workspaceId } });
            if (preference.status !== 'ready') throw new Error('Fixture workspace preference unavailable');
            return { status: 200, data: { status: 'present', revision: 1, content: { t: 'plain', v: { ...preference.preference, services: {} } } } };
        });
        return { root, runtime, context, address, workspaceRefs, relationships, invoke, rpcInvoke, spawned, operationRuntime, workspaceExecutionConfig, get, post, allowAdHoc: () => { allowAdHoc = true; },
            setToolExecutable: (path: string) => { nativeExecutablePath = path; }, refuseAdmission: () => { accepting = false; },
            setToolRelativeExecutable: (path: string) => { nativeExecutableRelativePath = path; },
            setConfigEnvironment: (name: string, value: string) => { configEnvironment[name] = value; },
            retireCredentials: () => { credentialCurrent = false; }, requireInvocationApproval: () => { invocationApprovalRequired = true; },
            addWorkerTarget, continueCopy: () => continueCopy(), holdCopy,
            setWorkerDestination: (machineId: string) => { workerDestination = { kind: 'machine', machineId }; },
            setWorkerUnavailable: (value: 'ask' | 'primary' | 'fail') => { unavailable = value; },
            setWorkerPool: (poolId: string) => { workersEnabled = true; workerDestination = { kind: 'pool', poolId, selection: 'automatic' }; },
            isFiniteExecutionLive: () => handlers.has(PROJECT_FINITE_ACTION_RPC_METHODS_V1['projects.script.run'])
                && handlers.has(PROJECT_FINITE_ACTION_RPC_METHODS_V1['projects.compute.exec']),
            installPreferenceReadHttpBoundary,
            rememberSetup: (reviewedEffectDigest: string) => createProjectSetupTrustClient({ credentials: runtime.credentials,
                serverHttpBaseUrl: runtime.serverHttpBaseUrl }).approveReviewedEffect({ project: { serverId: 'home', projectId: 'project' },
                reviewedEffectDigest, currentEffectDigest: reviewedEffectDigest, approvedAtMs: 1, expectedRevision: 'absent', authority: 'present_user' }),
        };
    }

    it.each([{ commands: [] }, { commands: ['echo must-not-run'] }])('retries the original built-in native environment through public Stop while retaining the same FIFO reservation, setup $commands', async ({ commands }) => {
        const h = await harness({ version: 1, environment: { kind: 'toolchain', tool: 'mise', configPath: 'mise.toml' },
            workspace: { setup: commands.map(command => ({ kind: 'command', command })) } }, 1);
        await writeFile(join(h.root, 'mise.toml'), '[env]\nMODE = "native"\n');
        const pidFile = join(h.root, 'builtin-helper.pid');
        const io = createProjectNativeEnvironmentIoForHost({
            // Replace only the external installed Mise tool boundary with a
            // process implementing its admitted Linux argv/version contract.
            // Actual evaluation, Exec supervision, operation and FIFO are real.
            resolveTool: async () => ({ executablePath: process.execPath, version: '2026.10.4', args: ['-e',
                `require("node:fs").writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);`] }),
        });
        Object.assign(h.runtime, { environmentIo: io });
        const scope = { accountId: 'owner', machineId: 'machine' };
        const input = { workspace: h.address, selection: { kind: 'native', source: { kind: 'native', tool: 'make', file: 'Makefile', target: 'check' } } };
        let helperPid: number | undefined;
        let allowTermination = false;
        let terminationAttempts = 0;
        const terminate = processTreeBoundary.killProcessTree;
        const boundary = vi.spyOn(processTreeBoundary, 'killProcessTree').mockImplementation(async (...args) => {
            terminationAttempts++;
            if (!allowTermination) throw new Error('OS cannot yet prove native environment tree absent');
            await terminate(...args);
        });
        try {
            expect(await h.rpcInvoke('projects.script.run', input)).toMatchObject({ operation: { operationId: 'operation' } });
            await expect.poll(() => h.operationRuntime.store.get(scope, 'operation')?.setupReview?.code).toBe('project_setup_consent_required');
            await h.rememberSetup(h.operationRuntime.store.get(scope, 'operation')!.setupReview!.reviewedEffectDigest);
            expect(await h.rpcInvoke('projects.script.run', input)).toMatchObject({ operation: { operationId: 'operation' } });
            await expect.poll(async () => {
                try { helperPid = Number(await readFile(pidFile, 'utf8')); return Number.isSafeInteger(helperPid) && helperPid > 0; }
                catch { return false; }
            }).toBe(true);
            expect(process.kill(helperPid!, 0)).toBe(true);
            expect(h.spawned).toEqual([]);
            expect(await h.rpcInvoke('projects.script.run', input, { ...h.context, transportRequestId: 'builtin-next' }))
                .toMatchObject({ operation: { operationId: 'operation-2' } });
            expect(await h.runtime.workerAdmission.load()).toMatchObject({ kind: 'known', running: 1, queued: 1 });
            expect(await h.operationRuntime.handlers.cancel({ operationId: 'operation' })).toEqual({ kind: 'requested' });
            await expect.poll(() => h.operationRuntime.store.get(scope, 'operation')?.observation?.kind).toBe('outcome_uncertain');
            expect(terminationAttempts).toBeGreaterThan(0);
            expect(process.kill(helperPid!, 0)).toBe(true);
            expect(h.spawned).toEqual([]);
            allowTermination = true;
            expect(await h.operationRuntime.handlers.cancel({ operationId: 'operation' })).toEqual({ kind: 'requested' });
            await expect.poll(() => { try { process.kill(helperPid!, 0); return false; } catch { return true; } }).toBe(true);
            await expect.poll(() => h.operationRuntime.store.get(scope, 'operation')?.state).toBe('cancelled');
            // The next entry may enter native preparation only after the first
            // operation's actual tree proof, never while it remains unknown.
            await expect.poll(() => h.runtime.workerAdmission.dependencies()[0]?.operationId).toBe('operation-2');
            const firstPid = helperPid;
            await expect.poll(async () => Number(await readFile(pidFile, 'utf8')) !== firstPid).toBe(true);
            helperPid = Number(await readFile(pidFile, 'utf8'));
            expect(await h.operationRuntime.handlers.cancel({ operationId: 'operation-2' })).toEqual({ kind: 'requested' });
            await expect.poll(() => h.operationRuntime.store.get(scope, 'operation-2')?.state).toBe('cancelled');
        } finally {
            allowTermination = true;
            boundary.mockRestore();
            h.operationRuntime.runner.cancel(scope, 'operation');
            h.operationRuntime.runner.cancel(scope, 'operation-2');
            if (helperPid) {
                try { process.kill(helperPid, 'SIGKILL'); } catch { /* Already proven absent on success. */ }
            }
        }
    });

    it('runs a detected native source without importing a manifest and observes the real nonzero process outcome', async () => {
        const h = await harness();
        const selection = { kind: 'native', source: { kind: 'native', tool: 'make', file: 'Makefile', target: 'check' } } as const;
        const script = { source: selection.source };
        const result = await h.rpcInvoke('projects.script.run', { workspace: h.address, selection });
        expect.soft(result).toMatchObject({ operation: { operationId: 'operation', state: 'accepted', domainRef: { purpose: 'script', workspaceRefId: 'accepted', sourceWorkspace: h.address, script } } });
        await expect.poll(() => h.spawned.length).toBe(1);
        expect(h.spawned).toHaveLength(1);
        expect.soft(h.operationRuntime.store.get({ accountId: 'owner', machineId: 'machine' }, 'operation')).toMatchObject({
            state: 'running', progress: { kind: 'phase', phase: 'script', label: expect.any(String) },
            domainRef: { purpose: 'script', sourceWorkspace: h.address, script, terminalId: expect.any(String) },
        });
        const running = h.operationRuntime.store.get({ accountId: 'owner', machineId: 'machine' }, 'operation');
        expect(running?.domainRef).not.toHaveProperty('exitCode');
        expect(running?.domainRef).not.toHaveProperty('script.name');
        expect(h.spawned[0]!.params).toMatchObject({ file: '/managed/make', args: ['-f', join(h.root, 'Makefile'), 'check'], options: { cwd: h.root } });
        h.spawned[0]!.pty.exit(7);
        await expect.poll(() => h.operationRuntime.store.get({ accountId: 'owner', machineId: 'machine' }, 'operation')?.state).toBe('failed');
        const failed = h.operationRuntime.store.get({ accountId: 'owner', machineId: 'machine' }, 'operation');
        expect(failed).toMatchObject({ state: 'failed', error: { errorCode: 'project_command_step_failed' }, domainRef: { purpose: 'script', sourceWorkspace: h.address, script, exitCode: 7, terminalId: expect.any(String) }, startedAt: running?.startedAt, settledAt: expect.any(Number) });
        await expect(access(join(h.root, '.happier/project.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('refuses raw caller authority, missing/stale transport admission, and foreign requester credentials before network or process effects', async () => {
        const h = await harness();
        const input = { workspace: h.address, phase: 'setup' };
        expect(await h.invoke('projects.prepare', { ...input, actorAccountId: 'owner' })).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
        expect(await h.invoke('projects.prepare', input, { signal: h.context.signal })).toMatchObject({ ok: false, errorCode: 'machine_admission_required' });
        expect(await h.invoke('projects.prepare', input, { ...h.context, verifyMachineAdmissionCurrent: async () => false })).toMatchObject({ ok: false, errorCode: 'machine_admission_changed' });
        expect(await h.invoke('projects.prepare', input, { ...h.context, machineAdmission: { ...h.context.machineAdmission!, actorAccountId: 'teammate' } })).toMatchObject({ ok: false, errorCode: 'project_requester_credentials_unavailable' });
        expect(h.get).not.toHaveBeenCalled(); expect(h.post).not.toHaveBeenCalled(); expect(h.spawned).toEqual([]);
    });

    it('does not borrow the owner credentials for a same-actor constrained caller without a finite proof producer', async () => {
        const h = await harness();
        const result = await h.invoke('projects.prepare', { workspace: h.address, phase: 'setup' }, { ...h.context,
            callerInputConstraints: { models: null, permissionModes: null } });
        expect(result).toMatchObject({ ok: false, errorCode: 'project_requester_authorization_unavailable' });
        expect(h.get).not.toHaveBeenCalled(); expect(h.post).not.toHaveBeenCalled(); expect(h.spawned).toEqual([]);
    });

    it('keeps setup-effect consent distinct from an already-approved invocation and returns only reviewed data', async () => {
        const h = await harness({ version: 1, workspace: { setup: [{ kind: 'command', command: 'echo setup' }] } });
        const result = await h.invoke('projects.script.run', { workspace: h.address, selection: { kind: 'native', source: { kind: 'native', tool: 'make', file: 'Makefile', target: 'check' } } });
        expect(result).toMatchObject({ operation: { operationId: 'operation' } });
        const scope = { accountId: 'owner', machineId: 'machine' };
        await expect.poll(() => h.operationRuntime.store.get(scope, 'operation')?.setupReview?.code).toBe('project_setup_consent_required');
        const reviewed = ProjectSetupConsentFailureDetailsV1Schema.parse(h.operationRuntime.store.get(scope, 'operation')!.setupReview);
        // This contract compares consent intent, not concurrent operation-id
        // allocation. Admit each original request before asserting its receipt.
        for (const [index, consentScope] of (['thisTime', 'untilChanged'] as const).entries()) {
            const pending = await h.rpcInvoke('projects.prepare', {
                workspace: h.address, phase: 'setup', expectedEffectDigest: reviewed.reviewedEffectDigest, consentScope,
            }, { ...h.context, transportRequestId: `prepare-${consentScope}` });
            const operationId = `operation-${index + 2}`;
            expect(pending).toMatchObject({ operation: { operationId } });
            await expect.poll(() => h.operationRuntime.store.get(scope, operationId)?.setupReview?.code).toBe('project_setup_consent_required');
            expect(h.operationRuntime.store.get(scope, operationId)).toMatchObject({ state: 'accepted', setupReview: {
                kind: 'pendingApproval', reviewedEffectDigest: reviewed.reviewedEffectDigest,
                consentScope,
            } });
        }
        expect(await h.rpcInvoke('projects.prepare', { workspace: h.address, phase: 'setup', consentScope: 'thisTime' }))
            .toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
        expect(await h.rpcInvoke('projects.prepare', { workspace: h.address, phase: 'setup', expectedEffectDigest: reviewed.reviewedEffectDigest,
            consentScope: 'forever' })).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
        expect(await h.rpcInvoke('projects.prepare', { workspace: h.address, phase: 'setup', expectedEffectDigest: reviewed.reviewedEffectDigest,
            consentScope: 'thisTime', authority: 'present_user' })).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
        expect(JSON.stringify(result)).not.toContain('requester'); expect(JSON.stringify(result)).not.toContain('successBasis');
        expect(h.spawned).toEqual([]);
        expect(h.post.mock.calls.filter(([url]) => String(url).endsWith('/project-trust/mutate'))).toEqual([]);
    });

    it('uses the canonical opt-in policy for exact ad-hoc argv/cwd', async () => {
        const h = await harness();
        const input = { workspace: h.address, executable: '/managed/echo', argv: ['one argument', 'two'], cwd: h.root };
        expect(await h.invoke('projects.compute.exec', input)).toMatchObject({ ok: false, errorCode: 'ad_hoc_disabled' });
        h.allowAdHoc();
        expect(await h.invoke('projects.compute.exec', input)).toMatchObject({ operation: { domainRef: { purpose: 'exec' } } });
        await expect.poll(() => h.spawned.length).toBe(1);
        expect(h.spawned[0]!.params).toMatchObject({ file: '/managed/echo', args: ['one argument', 'two'], options: { cwd: h.root } });
        h.spawned[0]!.pty.exit(0); await turn(); await turn();
    });

    it('revalidates the exact script after queued admission and refuses changed native bytes without a second launch', async () => {
        const h = await harness(undefined, 1);
        const input = { workspace: h.address, selection: { kind: 'native', source: { kind: 'native', tool: 'make', file: 'Makefile', target: 'check' } } };
        await h.invoke('projects.script.run', input);
        await expect.poll(() => h.spawned.length).toBe(1);
        expect(await h.invoke('projects.script.run', input, { ...h.context, transportRequestId: 'second' })).toMatchObject({ operation: { operationId: 'operation-2', state: 'accepted' } });
        expect(h.runtime.workerAdmission.dependencies({ workspaceRefId: 'accepted' })).toMatchObject([
            { operationId: 'operation', state: 'running' }, { operationId: 'operation-2', state: 'queued' },
        ]);
        await writeFile(join(h.root, 'Makefile'), 'check:\n\techo changed after approval\n');
        h.spawned[0]!.pty.exit(0);
        await expect.poll(() => h.operationRuntime.store.get({ accountId: 'owner', machineId: 'machine' }, 'operation-2')?.state).toBe('failed');
        expect(h.operationRuntime.store.get({ accountId: 'owner', machineId: 'machine' }, 'operation-2')).toMatchObject({ error: { errorCode: 'project_script_effect_changed' } });
        expect(h.spawned).toHaveLength(1);
        expect(h.runtime.workerAdmission.dependencies()).toEqual([]);
    });

    it('refuses detected native worker execution before accepting an operation, copying or spawning', async () => {
        const h = await harness(undefined, 1, 'source-machine');
        const target = await h.addWorkerTarget();
        try {
            const result = await h.rpcInvoke('projects.script.run', { workspace: h.address,
                selection: { kind: 'native', source: { kind: 'native', tool: 'make', file: 'Makefile', target: 'check' } },
                choice: { kind: 'workers', destination: { kind: 'machine', machineId: 'machine' } },
            });
            expect.soft(result, JSON.stringify(result)).toMatchObject({ ok: false, errorCode: 'primary_only' });
            expect.soft(h.operationRuntime.store.get({ accountId: 'owner', machineId: 'machine' }, 'operation')).toBeNull();
            expect.soft(h.runtime.workerAdmission.dependencies()).toEqual([]);
            expect.soft(await readFile(join(target.rootPath, '.happier/project.json'), 'utf8')).toBe('invalid before clean copy');
            expect.soft(h.spawned).toEqual([]);
        } finally {
            h.operationRuntime.runner.cancel({ accountId: 'owner', machineId: 'machine' }, 'operation');
            h.continueCopy();
            await turn();
            await turn();
        }
    });

    it.each(['command', 'native config', 'native executable', 'ordinary data', 'native ordinary data'] as const)('retains the accepted portable Script effect through worker copy while allowing fresh %s', async changed => {
        const native = changed === 'native config' || changed === 'native executable' || changed === 'native ordinary data';
        const localExecutable = changed === 'native executable' ? 'project-make' : changed === 'native ordinary data' ? 'a-project-make' : undefined;
        const manifest = { version: 1, scripts: { checked: { execution: 'portable',
            source: native
                ? { kind: 'native', tool: 'make', file: changed === 'native ordinary data' ? './Makefile' : 'Makefile', target: 'check' }
                : { kind: 'command', command: 'echo original' } } } };
        const h = await harness(manifest, 1, 'source-machine');
        const target = await h.addWorkerTarget();
        if (localExecutable) {
            await writeFile(join(h.root, localExecutable), 'original executable bytes');
            h.setToolRelativeExecutable(localExecutable);
        }
        await writeFile(join(h.root, 'input.txt'), 'original ordinary data');
        const input = { workspace: h.address, selection: { kind: 'named', name: 'checked' },
            choice: { kind: 'workers', destination: { kind: 'machine', machineId: 'machine' } } };
        const scope = { accountId: 'owner', machineId: 'machine' };
        try {
            expect(await h.rpcInvoke('projects.script.run', input)).toEqual(expect.objectContaining({
                operation: expect.objectContaining({ operationId: 'operation' }),
            }));
            h.continueCopy();
            await expect.poll(() => h.spawned.length).toBe(1);
            expect(h.spawned[0]!.params.args).toEqual(native
                ? ['-f', join(target.rootPath, 'Makefile'), 'check'] : ['-c', 'echo original']);
            if (localExecutable) expect(h.spawned[0]!.params.file).toBe(join(target.rootPath, localExecutable));
            h.holdCopy();
            expect(await h.rpcInvoke('projects.script.run', input, { ...h.context, transportRequestId: `accepted-worker-${changed}` }))
                .toMatchObject({ operation: { operationId: 'operation-2' } });
            await expect.poll(() => h.runtime.workerAdmission.dependencies().find(entry => entry.operationId === 'operation-2')?.state).toBe('queued');
            if (changed === 'command') {
                await writeFile(join(h.root, '.happier/project.json'), JSON.stringify({ ...manifest, scripts: { checked: {
                    ...manifest.scripts.checked, source: { kind: 'command', command: 'echo changed-after-acceptance' },
                } } }));
            } else if (changed === 'native config') await writeFile(join(h.root, 'Makefile'), 'check:\n\techo changed-after-acceptance\n');
            else if (changed === 'native executable') await writeFile(join(h.root, 'project-make'), 'changed executable bytes');
            else await writeFile(join(h.root, 'input.txt'), 'fresh ordinary data');
            h.spawned[0]!.pty.exit(0);
            h.continueCopy();
            await expect.poll(() => h.spawned.length === 2 || h.operationRuntime.store.get(scope, 'operation-2')?.state === 'failed').toBe(true);
            if (changed !== 'ordinary data' && changed !== 'native ordinary data') {
                expect(h.spawned).toHaveLength(1);
                expect(h.operationRuntime.store.get(scope, 'operation-2')).toMatchObject({ state: 'failed', error: {
                    errorCode: 'project_script_effect_changed', details: { kind: 'pendingApproval', code: 'project_script_effect_changed',
                        reviewedEffectDigest: expect.any(String), reviewedEffect: expect.anything() },
                } });
                expect(h.runtime.workerAdmission.dependencies()).toEqual([]);
            } else {
                expect(h.spawned).toHaveLength(2);
                expect(h.spawned[1]!.params.args).toEqual(native ? ['-f', join(target.rootPath, 'Makefile'), 'check'] : ['-c', 'echo original']);
                if (localExecutable) expect(h.spawned[1]!.params.file).toBe(join(target.rootPath, localExecutable));
                expect(await readFile(join(target.rootPath, 'input.txt'), 'utf8')).toBe('fresh ordinary data');
                h.spawned[1]!.pty.exit(0);
                await expect.poll(() => h.operationRuntime.store.get(scope, 'operation-2')?.state).toBe('succeeded');
                expect(h.runtime.workerAdmission.dependencies()).toEqual([]);
            }
        } finally {
            // The OS boundary must settle even when the unsafe extra launch is
            // the deciding RED, so the original reservation cannot leak.
            h.spawned[1]?.pty.exit(0);
            h.continueCopy();
        }
    });

    it('publishes reserved preparation after leaving the queue without claiming a process has launched', async () => {
        const h = await harness(portableNativeManifest, 1, 'source-machine');
        await h.addWorkerTarget();
        const input = { workspace: h.address,
            selection: { kind: 'named', name: 'checked' },
            choice: { kind: 'workers', destination: { kind: 'machine', machineId: 'machine' } } };
        expect(await h.rpcInvoke('projects.script.run', input)).toMatchObject({ operation: { operationId: 'operation' } });
        h.continueCopy();
        await expect.poll(() => h.spawned.length).toBe(1);
        h.holdCopy();
        expect(await h.rpcInvoke('projects.script.run', input, { ...h.context, transportRequestId: 'queued-preparation' }))
            .toMatchObject({ operation: { operationId: 'operation-2' } });
        const scope = { accountId: 'owner', machineId: 'machine' };
        await expect.poll(() => h.runtime.workerAdmission.dependencies().find(entry => entry.operationId === 'operation-2')?.state).toBe('queued');
        const queued = h.operationRuntime.store.get(scope, 'operation-2');
        expect(await h.operationRuntime.handlers.getV2({ operationId: 'operation-2' }, h.context)).toMatchObject({ kind: 'found', operation: {
            state: 'accepted', progress: { kind: 'phase', phase: 'queued', queueAhead: 0, label: expect.any(String) },
        } });
        h.spawned[0]!.pty.exit(0);
        await expect.poll(() => h.runtime.workerAdmission.dependencies().find(entry => entry.operationId === 'operation-2')?.state).toBe('copying');
        expect(h.spawned).toHaveLength(1);
        const preparing = h.operationRuntime.store.get(scope, 'operation-2');
        expect(preparing).toMatchObject({ state: 'accepted', progress: { kind: 'phase', phase: 'preparing', label: expect.any(String) } });
        expect(preparing!.revision).toBeGreaterThan(queued!.revision);
        expect(preparing?.progress).not.toHaveProperty('current');
        expect(preparing?.progress).not.toHaveProperty('total');
        h.continueCopy();
        await expect.poll(() => h.spawned.length).toBe(2);
        h.spawned[1]!.pty.exit(0);
        await expect.poll(() => h.operationRuntime.store.get(scope, 'operation-2')?.state).toBe('succeeded');
        expect(h.runtime.workerAdmission.dependencies()).toEqual([]);
    });

    it('settles no-launch preparation on the same admitted operation without making a Session', async () => {
        const h = await harness();
        expect(await h.invoke('projects.prepare', { workspace: h.address, phase: 'setup' })).toMatchObject({ operation: { operationId: 'operation' } });
        const scope = { accountId: 'owner', machineId: 'machine' };
        await expect.poll(() => h.operationRuntime.store.get(scope, 'operation')?.state).toBe('succeeded');
        expect(h.operationRuntime.store.get(scope, 'operation')).toMatchObject({ result: { kind: 'notRequired', reviewedEffectDigest: expect.any(String) } });
        expect(h.runtime.workerAdmission.dependencies()).toEqual([]);
        expect(h.spawned).toEqual([]);
    });

    it('keeps the exact execution environment basis when setup consent and Script effect are reviewed separately', async () => {
        const h = await harness({ version: 1, environmentVariables: [{ name: 'MODE', kind: 'config', required: true }] }, 1);
        const input = { workspace: h.address, selection: { kind: 'native', source: { kind: 'native', tool: 'make', file: 'Makefile', target: 'check' } } };
        await h.invoke('projects.script.run', input);
        await expect.poll(() => h.spawned.length).toBe(1);
        expect(h.spawned[0]!.params.options.env).toMatchObject({ MODE: 'original' });
        await h.invoke('projects.script.run', input, { ...h.context, transportRequestId: 'second' });
        h.setConfigEnvironment('MODE', 'changed after admission');
        h.spawned[0]!.pty.exit(0);
        const scope = { accountId: 'owner', machineId: 'machine' };
        await expect.poll(() => h.operationRuntime.store.get(scope, 'operation-2')?.state).toBe('failed');
        expect(h.operationRuntime.store.get(scope, 'operation-2')).toMatchObject({ error: { errorCode: 'project_script_effect_changed' } });
        expect(h.spawned).toHaveLength(1);
        expect(h.runtime.workerAdmission.dependencies()).toEqual([]);
    });

    it('keeps cancelled admission reserved until the actual process exit is observed', async () => {
        const h = await harness();
        await h.invoke('projects.script.run', { workspace: h.address, selection: { kind: 'native', source: { kind: 'native', tool: 'make', file: 'Makefile', target: 'check' } } });
        await expect.poll(() => h.spawned.length).toBe(1);
        const scope = { accountId: 'owner', machineId: 'machine' };
        h.operationRuntime.runner.cancel(scope, 'operation');
        await turn();
        expect(h.operationRuntime.store.get(scope, 'operation')).toMatchObject({
            state: 'running', progress: { kind: 'phase', phase: 'stopping', label: expect.any(String) },
        });
        expect(h.runtime.workerAdmission.dependencies()).toMatchObject([{ operationId: 'operation', state: 'running' }]);
        h.spawned[0]!.pty.exit(0);
        await expect.poll(() => h.operationRuntime.store.get(scope, 'operation')?.state).toBe('cancelled');
        expect(h.runtime.workerAdmission.dependencies()).toEqual([]);
    });

    it('refuses a changed project-local native executable after queued admission', async () => {
        const h = await harness(undefined, 1);
        const executable = join(h.root, 'project-make');
        await writeFile(executable, 'original executable bytes');
        h.setToolExecutable(executable);
        const input = { workspace: h.address, selection: { kind: 'native', source: { kind: 'native', tool: 'make', file: 'Makefile', target: 'check' } } };
        await h.invoke('projects.script.run', input);
        await expect.poll(() => h.spawned.length).toBe(1);
        await h.invoke('projects.script.run', input, { ...h.context, transportRequestId: 'second' });
        await writeFile(executable, 'changed executable bytes');
        h.spawned[0]!.pty.exit(0);
        await expect.poll(() => h.operationRuntime.store.get({ accountId: 'owner', machineId: 'machine' }, 'operation-2')?.state).toBe('failed');
        expect(h.operationRuntime.store.get({ accountId: 'owner', machineId: 'machine' }, 'operation-2')).toMatchObject({ error: { errorCode: 'project_script_effect_changed' } });
        expect(h.spawned).toHaveLength(1);
    });

    it('returns a typed refusal rather than successful finite output when the Machine is not accepting', async () => {
        const h = await harness();
        h.refuseAdmission();
        expect(await h.rpcInvoke('projects.script.run', { workspace: h.address, selection: { kind: 'native', source: { kind: 'native', tool: 'make', file: 'Makefile', target: 'check' } } })).toMatchObject({ ok: false, errorCode: 'not_accepting' });
        expect(h.spawned).toEqual([]);
        expect(h.operationRuntime.store.get({ accountId: 'owner', machineId: 'machine' }, 'operation')?.state).toBe('failed');
    });

    it.each(['ask', 'primary', 'fail'] as const)('retains configured %s fallback on a receiving worker refusal without copying or launching', async unavailable => {
        const h = await harness(portableNativeManifest, null, 'source-machine');
        await h.addWorkerTarget();
        h.setWorkerUnavailable(unavailable);
        h.refuseAdmission();
        const result = await h.rpcInvoke('projects.script.run', { workspace: h.address,
            selection: { kind: 'named', name: 'checked' },
            choice: { kind: 'workers', destination: { kind: 'machine', machineId: 'machine' } } });
        expect.soft(result).toMatchObject({ ok: false, errorCode: 'not_accepting',
            details: { kind: 'no_worker_can_accept', unavailable, reason: 'not_accepting' } });
        expect(h.operationRuntime.store.get({ accountId: 'owner', machineId: 'machine' }, 'operation'))
            .toMatchObject({ state: 'failed', error: { errorCode: 'not_accepting',
                details: { kind: 'no_worker_can_accept', unavailable, reason: 'not_accepting' } } });
        expect(h.runtime.workerAdmission.dependencies()).toEqual([]);
        expect(h.spawned).toEqual([]);
    });

    it('does not treat a setup digest as approval of the exact requested Script effect', async () => {
        const h = await harness();
        const prepared = await h.invoke('projects.prepare', { workspace: h.address, phase: 'setup' });
        expect(prepared).toMatchObject({ operation: { operationId: 'operation' } });
        const scope = { accountId: 'owner', machineId: 'machine' };
        await expect.poll(() => h.operationRuntime.store.get(scope, 'operation')?.state).toBe('succeeded');
        const preparationResult = h.operationRuntime.store.get(scope, 'operation')!.result;
        if (!preparationResult || typeof preparationResult !== 'object' || !('reviewedEffectDigest' in preparationResult)) throw new Error('missing preparation review');
        expect(await h.invoke('projects.script.run', { workspace: h.address, selection: { kind: 'native', source: { kind: 'native', tool: 'make', file: 'Makefile', target: 'check' } },
            expectedEffectDigest: preparationResult.reviewedEffectDigest })).toMatchObject({ operation: { operationId: 'operation-2' } });
        await expect.poll(() => h.operationRuntime.store.get(scope, 'operation-2')?.state).toBe('failed');
        expect(h.operationRuntime.store.get(scope, 'operation-2')).toMatchObject({ error: { errorCode: 'project_script_effect_changed' } });
        expect(h.spawned).toEqual([]);
    });

    it('refuses a queued invocation when its actual requester credential lifetime retires', async () => {
        const h = await harness(undefined, 1);
        const input = { workspace: h.address, selection: { kind: 'native', source: { kind: 'native', tool: 'make', file: 'Makefile', target: 'check' } } };
        await h.invoke('projects.script.run', input);
        await expect.poll(() => h.spawned.length).toBe(1);
        await h.invoke('projects.script.run', input, { ...h.context, transportRequestId: 'second' });
        h.retireCredentials();
        h.spawned[0]!.pty.exit(0);
        await expect.poll(() => h.operationRuntime.store.get({ accountId: 'owner', machineId: 'machine' }, 'operation-2')?.state).toBe('failed');
        expect(h.operationRuntime.store.get({ accountId: 'owner', machineId: 'machine' }, 'operation-2')).toMatchObject({ error: { errorCode: 'project_requester_credentials_unavailable' } });
        expect(h.spawned).toHaveLength(1);
        expect(h.runtime.workerAdmission.dependencies()).toEqual([]);
    });

    it('does not infer configured Script invocation approval from raw Home-stamped Machine access', async () => {
        const h = await harness();
        h.requireInvocationApproval();
        const result = await h.rpcInvoke('projects.script.run', { workspace: h.address, selection: { kind: 'native', source: { kind: 'native', tool: 'make', file: 'Makefile', target: 'check' } } });
        expect(result).toMatchObject({ ok: false });
        expect(h.spawned).toEqual([]);
        expect(h.runtime.workerAdmission.dependencies()).toEqual([]);
        expect(h.operationRuntime.store.list({ accountId: 'owner', machineId: 'machine' }).items).toEqual([]);
    });

    it.each(['projects.script.run', 'session.spawn_new'] as const)('reuses only the exact finite operation owner, not an outer %s operation', async outerActionId => {
        const h = await harness();
        const input = { workspace: h.address, selection: { kind: 'native', source: { kind: 'native', tool: 'make', file: 'Makefile', target: 'check' } } };
        const accepted = await h.operationRuntime.observeExecution({ actionId: outerActionId, input: outerActionId === 'projects.script.run' ? input : { creationKey: 'outer' },
            actionRequestId: 'outer', execute: async operation => {
                const nested = await h.invoke('projects.script.run', input, { ...h.context, localActionContext: {
                    actionRequestId: operation.actionRequestId, operationAcceptance: operation.operationAcceptance,
                    operationOwnerUpdate: operation.operationOwnerUpdate, operationProgress: operation.operationProgress,
                } });
                const failed = ActionExecuteFailureSchema.safeParse(nested);
                return failed.success ? failed.data : { ok: true, result: nested };
            } });
        const expectedId = outerActionId === 'projects.script.run' ? 'operation' : 'operation-2';
        expect(accepted).toMatchObject({ ok: true, result: { operation: { actionId: 'projects.script.run', operationId: expectedId } } });
        await expect.poll(() => h.spawned.length).toBe(1);
        const scope = { accountId: 'owner', machineId: 'machine' };
        expect(h.operationRuntime.store.list(scope).items).toHaveLength(outerActionId === 'projects.script.run' ? 1 : 2);
        h.spawned[0]!.pty.exit(0);
        await expect.poll(() => h.operationRuntime.store.get(scope, expectedId)?.state).toBe('succeeded');
    });

    it('admits the immutable remote SOURCE before clean-copy and reviews only the copied worker target bytes', async () => {
        const h = await harness(portableNativeManifest, null, 'source-machine');
        const target = await h.addWorkerTarget();
        expect(await h.workspaceExecutionConfig.get({ workspace: { serverId: 'home', refId: h.address.workspaceId } }))
            .toMatchObject({ status: 'ready', preference: { enabled: true, destination: { kind: 'machine', machineId: 'machine' } } });
        const sourceInput = { workspace: h.address, selection: { kind: 'named', name: 'checked' },
            choice: { kind: 'workers', destination: { kind: 'machine', machineId: 'machine' } } };
        expect(await h.rpcInvoke('projects.script.run', sourceInput)).toMatchObject({ operation: { operationId: 'operation', domainRef: { workspaceRefId: target.id } } });
        await expect.poll(() => h.runtime.workerAdmission.dependencies({ workspaceRefId: h.address.workspaceId, relationshipId: 'source-worker' })[0]?.state).toBe('copying');
        expect(h.spawned).toEqual([]);
        h.continueCopy();
        await expect.poll(() => h.spawned.length).toBe(1);
        expect(h.spawned[0]!.params).toMatchObject({ args: ['-f', join(target.rootPath, 'Makefile'), 'check'], options: { cwd: target.rootPath } });
        expect(sourceInput.workspace.machineId).toBe('source-machine');
        h.spawned[0]!.pty.exit(0);
        await expect.poll(() => h.runtime.workerAdmission.dependencies()).toEqual([]);
        expect(await h.rpcInvoke('projects.script.run', { ...sourceInput, choice: { kind: 'primary' } }, { ...h.context, transportRequestId: 'remote-primary' }))
            .toMatchObject({ ok: false, errorCode: 'target_not_local' });
        expect(h.spawned).toHaveLength(1);
    });

    it.each(['explicit', 'workspace', 'withdrawn_after_copy'] as const)
    ('admits only the current authorized pool member at the addressed receiving Machine (%s)', async scenario => {
        // The Home authentication boundary supplies the current issued-token
        // provenance and epoch consumed by original Account Action delivery.
        const token = scenario === 'workspace' ? `header.${Buffer.from(JSON.stringify({ sub: 'owner', tokenEpoch: 1,
            provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature` : 'requester';
        const h = await harness({ version: 1, scripts: { checked: { execution: 'portable',
            source: { kind: 'native', tool: 'make', file: 'Makefile', target: 'check' } } } }, null, 'source-machine', token);
        const target = await h.addWorkerTarget();
        const poolId = '99d55938-f860-4af8-8023-01fecec86f35';
        h.setWorkerPool(poolId);
        let members: MachinePoolViewV1['pool']['members'] = [
            ...(scenario === 'workspace' ? [] : [{ machineId: 'another-machine', priorityTier: 0, enabled: true, state: 'connected' as const }]),
            { machineId: 'machine', priorityTier: 1, enabled: true, state: 'connected' },
        ];
        // Home HTTP is the genuine pool boundary; the Action parser/transport and receiving membership check stay real.
        vi.spyOn(axios, 'request').mockImplementation(async config => {
            expect(config.headers).toMatchObject({ Authorization: `Bearer ${token}` });
            if (scenario === 'workspace' && config.url === 'https://home.example/v1/account/encryption') {
                return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
            }
            if (scenario === 'workspace' && config.url === `https://home.example${WORKSPACE_EXECUTION_CONFIG_ROUTE_V1}/read`) {
                expect(config.data).toEqual({ address: { serverId: 'home', refId: h.address.workspaceId } });
                const preference = await h.workspaceExecutionConfig.get({ workspace: { serverId: 'home', refId: h.address.workspaceId } });
                if (preference.status !== 'ready') throw new Error('Fixture workspace preference unavailable');
                return { status: 200, data: { status: 'present', revision: 1, content: { t: 'plain', v: { ...preference.preference, services: {} } } } };
            }
            expect(config.url).toBe('https://home.example/v1/machines/pools/get');
            expect(config.method).toBe('POST');
            expect(config.data).toEqual({ poolId });
            const view: MachinePoolViewV1 = { pool: { id: poolId, name: 'Workers', description: null, revision: 1, createdAt: 1, updatedAt: 1, members },
                availability: { state: 'known', connectedCount: members.filter(member => member.enabled && member.state === 'connected').length,
                    enabledCount: members.filter(member => member.enabled).length } };
            return { status: 200, data: view };
        });
        const input = { workspace: h.address, selection: { kind: 'named', name: 'checked' },
            ...(scenario === 'workspace' ? {} : { choice: { kind: 'workers', destination: { kind: 'pool', poolId, selection: 'automatic' } } }) };
        let result: unknown;
        if (scenario === 'workspace') {
            const serverIdentityId = 'home-identity';
            const installed = ExternalActionMachineBootstrapV1Schema.parse({ id: 'machine', installationId: 'installation',
                active: true, revokedAt: null, replacedByMachineId: null, kind: 'persistent',
                access: { custodian: { accountId: 'owner', displayName: 'Owner' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' },
            });
            h.get.mockImplementation(async url => {
                if (String(url) === 'https://home.example/v1/machines') return { status: 200, data: [installed] };
                if (String(url) === 'https://home.example/v1/machines/machine') return { status: 200, data: { machine: installed } };
                return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
            });
            const homePost = h.post.getMockImplementation();
            if (!homePost) throw new Error('Expected existing Home HTTP fixture');
            h.post.mockImplementation(async (url, body, config) => {
                if (String(url) === `https://home.example${bindExternalActionExecutionAuthorizationHttpPathV1('projects.script.run')}`) {
                    expect(config?.headers).toMatchObject({ Authorization: `Bearer ${token}` });
                    const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
                    expect(request.machineId).toBe(installed.id);
                    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-issued-finite-authorization',
                        binding: { accountId: 'owner', authentication: { kind: 'account', tokenEpoch: 1 }, serverIdentityId,
                            machineId: installed.id, custodianAccountId: 'owner', installationId: installed.installationId,
                            accountEncryptionMode: 'plain', actionId: 'projects.script.run', requestId: request.envelope.requestId,
                            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope), target: request.envelope.target,
                        } });
                    return { status: 200, data: authorization };
                }
                if (String(url) !== 'https://home.example/v1/actions/projects.script.run') return await homePost(url, body, config);
                expect(config?.headers).toMatchObject({ Authorization: `Bearer ${token}` });
                const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
                const envelope = ExternalActionRequestEnvelopeV1Schema.parse(request.envelope);
                expect(request.executionAuthorization?.binding).toMatchObject({ serverIdentityId, machineId: installed.id,
                    installationId: installed.installationId, requestId: envelope.requestId,
                    requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), target: envelope.target });
                expect(envelope.target).toEqual({ kind: 'machine', machineId: 'machine' });
                const raw = await h.rpcInvoke('projects.script.run', envelope.input, { ...h.context, transportRequestId: envelope.requestId });
                const failure = ActionExecuteFailureSchema.safeParse(raw);
                return { status: 200, data: ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId: 'projects.script.run',
                    requestId: envelope.requestId, execution: failure.success ? failure.data : { ok: true, result: raw } }) };
            });
            const worker = createProjectWorkerAction({ serverId: 'home', machineId: 'machine', accountId: 'owner',
                credentials: h.runtime.credentials, serverHttpBaseUrl: h.runtime.serverHttpBaseUrl,
                admission: h.runtime.workerAdmission, isFiniteExecutionLive: h.isFiniteExecutionLive });
            vi.spyOn(machineRpcTransport, 'callExactMachineRpc').mockImplementation(async request => {
                if (request.method === 'daemon.projects.inspect.v1') {
                    expect(request.machineId).toBe('source-machine');
                    return await createProjectDefinitionAction({ serverId: 'home', machineId: 'source-machine', workingDirectory: h.root,
                        accessPolicy: { kind: 'restrictedRoots', roots: [h.root] }, nativeIo: h.runtime.nativeIo })({
                        actionId: 'projects.inspect', input: request.request, context: { serverId: 'home', signal: request.signal } });
                }
                expect(request.machineId).toBe('machine');
                if (request.method === 'projects.worker.status') return await worker({ actionId: 'projects.worker.status', input: ProjectWorkerStatusInputV1Schema.parse(request.request),
                    signal: request.signal, context: { surface: 'rpc', serverId: 'home', runtimeAccountId: 'owner', authority: 'account_automation' } });
                throw new Error('Personal finite execution must enter the original Account Home Action front door');
            });
            // The local OS credential boundary captured a stored-session token, not an API-token caller claiming present_user.
            const credentials = { ...h.runtime.credentials, credentialProvenance: 'stored_session' as const };
            const params = { credentials, token, mode: 'plain' as const, ctx: null, sessionId: 'pool-requester',
                serverId: 'home', serverIdentityId, serverHttpBaseUrl: h.runtime.serverHttpBaseUrl };
            const requester = createCliActionExecutor({ ...params, pluginActionExecutionOwner: 'current_process',
                actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1({ v: 1 }) },
                accountServerActionDeps: createAccountServerActionDeps(params) });
            const executed = await requester.execute('projects.script.run', input, { surface: 'cli', authority: 'present_user',
                presentUserConfirmation: { actionId: 'projects.script.run' }, actionRequestId: 'pool-request' });
            expect(executed, JSON.stringify(executed, null, 2)).toMatchObject({ ok: true });
            result = executed.ok ? executed.result : executed;
        } else result = await h.rpcInvoke('projects.script.run', input);
        expect(result).toMatchObject({ operation: { operationId: 'operation', domainRef: { workspaceRefId: target.id } } });
        await expect.poll(() => h.runtime.workerAdmission.dependencies()[0]?.state).toBe('copying');
        expect(h.spawned).toEqual([]);
        if (scenario === 'withdrawn_after_copy') members = members.filter(member => member.machineId !== 'machine');
        h.continueCopy();
        const scope = { accountId: 'owner', machineId: 'machine' };
        if (scenario === 'withdrawn_after_copy') {
            await expect.poll(() => h.operationRuntime.store.get(scope, 'operation')?.state).toBe('failed');
            expect(h.operationRuntime.store.get(scope, 'operation')).toMatchObject({ error: { errorCode: 'target_not_local' } });
            expect(h.spawned).toEqual([]);
        } else {
            await expect.poll(() => h.spawned.length).toBe(1);
            expect(h.spawned[0]!.params.options.cwd).toBe(target.rootPath);
            h.spawned[0]!.pty.exit(0);
            await expect.poll(() => h.operationRuntime.store.get(scope, 'operation')?.state).toBe('succeeded');
        }
        await expect.poll(() => h.runtime.workerAdmission.dependencies()).toEqual([]);
    });

    it('does not widen the held worker memory after copying a previously unavailable declaration', async () => {
        const h = await harness(portableNativeManifest, null, 'source-machine');
        await h.addWorkerTarget();
        expect(await h.workspaceExecutionConfig.get({ workspace: { serverId: 'home', refId: h.address.workspaceId } }))
            .toMatchObject({ status: 'ready', preference: { enabled: true, destination: { kind: 'machine', machineId: 'machine' } } });
        expect(await h.rpcInvoke('projects.script.run', { workspace: h.address,
            selection: { kind: 'named', name: 'checked' },
            choice: { kind: 'workers', destination: { kind: 'machine', machineId: 'machine' } },
        })).toMatchObject({ operation: { operationId: 'operation' } });
        await expect.poll(() => h.runtime.workerAdmission.dependencies()[0]?.state).toBe('copying');
        await writeFile(join(h.root, '.happier/project.json'), JSON.stringify({ ...portableNativeManifest,
            workspace: { memoryDemand: { bytes: 1024, basis: { kind: 'declared' } } } }));
        expect((await readProjectManifest({ root: h.root })).document).toMatchObject({ status: 'valid' });
        h.continueCopy();
        await expect.poll(() => h.operationRuntime.store.get({ accountId: 'owner', machineId: 'machine' }, 'operation')?.state).toBe('failed');
        expect(h.operationRuntime.store.get({ accountId: 'owner', machineId: 'machine' }, 'operation')).toMatchObject({ error: { errorCode: 'project_script_effect_changed' } });
        expect(h.spawned).toEqual([]);
        expect(h.runtime.workerAdmission.dependencies()).toEqual([]);
    });

    it.each(['queued', 'copied', 'consent_wake'] as const)('keeps the accepted effective memory bytes when only declaration labels change (%s)', async placement => {
        const manifest = { ...portableNativeManifest, workspace: { memoryDemand: { bytes: 1024, basis: { kind: 'declared' } },
            ...(placement === 'consent_wake' ? { setup: [{ kind: 'command', command: 'echo setup' }] } : {}),
        } };
        const h = await harness(manifest, placement === 'queued' ? 1 : null,
            placement === 'queued' ? 'machine' : 'source-machine');
        if (placement !== 'queued') await h.addWorkerTarget();
        const input = { workspace: h.address,
            selection: { kind: 'named', name: 'checked' },
            ...(placement !== 'queued' ? { choice: { kind: 'workers', destination: { kind: 'machine', machineId: 'machine' } } } : {}),
        };
        const scope = { accountId: 'owner', machineId: 'machine' };
        let operationId = 'operation';
        if (placement === 'queued') {
            expect(await h.rpcInvoke('projects.script.run', input)).toMatchObject({ operation: { operationId } });
            await expect.poll(() => h.spawned.length).toBe(1);
            operationId = 'operation-2';
        }
        expect(await h.rpcInvoke('projects.script.run', input, { ...h.context, transportRequestId: 'same-bytes' }))
            .toMatchObject({ operation: { operationId } });
        await expect.poll(() => h.runtime.workerAdmission.dependencies().find(entry => entry.operationId === operationId)?.state)
            .toBe(placement === 'queued' ? 'queued' : 'copying');
        if (placement === 'consent_wake') {
            h.continueCopy();
            await expect.poll(() => h.operationRuntime.store.get(scope, operationId)?.setupReview?.code)
                .toBe('project_setup_consent_required');
        }
        await writeFile(join(h.root, '.happier/project.json'), JSON.stringify({ ...manifest,
            workspace: { ...manifest.workspace, memoryDemand: { bytes: 1024, basis: { kind: 'measured',
                operation: { serverId: 'home', machineId: 'source-machine', operationId: 'measurement' },
            } } },
        }));
        if (placement === 'queued') h.spawned[0]!.pty.exit(0);
        else if (placement === 'consent_wake') {
            await h.rememberSetup(h.operationRuntime.store.get(scope, operationId)!.setupReview!.reviewedEffectDigest);
            expect(await h.rpcInvoke('projects.script.run', input, { ...h.context, transportRequestId: 'same-bytes' }))
                .toMatchObject({ operation: { operationId } });
        }
        else h.continueCopy();
        await expect.poll(() => h.operationRuntime.store.get(scope, operationId)?.state).toBe('running');
        expect(h.spawned).toHaveLength(placement === 'queued' ? 2 : 1);
        h.spawned.at(-1)!.pty.exit(0);
        if (placement === 'consent_wake') {
            await expect.poll(() => h.spawned.length).toBe(2);
            h.spawned[1]!.pty.exit(0);
        }
        await expect.poll(() => h.operationRuntime.store.get(scope, operationId)?.state).toBe('succeeded');
        expect(h.runtime.workerAdmission.dependencies()).toEqual([]);
    });

    it('projects the accepted SOURCE-relative ad-hoc cwd onto the copied target without rewriting the invocation', async () => {
        const h = await harness({ version: 1 }, null, 'source-machine');
        const target = await h.addWorkerTarget();
        h.allowAdHoc();
        await mkdir(join(h.root, 'nested'));
        const input = { workspace: h.address, executable: '/managed/echo', argv: ['one argument'], cwd: join(h.root, 'nested'),
            choice: { kind: 'workers', destination: { kind: 'machine', machineId: 'machine' } } };
        expect(await h.rpcInvoke('projects.compute.exec', { ...input, cwd: join(h.root, '..', 'outside') },
            { ...h.context, transportRequestId: 'outside-source' })).toMatchObject({ ok: false, errorCode: 'outside_root' });
        expect(h.runtime.workerAdmission.dependencies()).toEqual([]);
        expect(await h.rpcInvoke('projects.compute.exec', input)).toMatchObject({ operation: { operationId: 'operation', domainRef: { workspaceRefId: target.id } } });
        h.continueCopy();
        await expect.poll(() => h.spawned.length).toBe(1);
        expect(h.spawned[0]!.params).toMatchObject({ file: '/managed/echo', args: ['one argument'], options: { cwd: join(target.rootPath, 'nested') } });
        expect(input.cwd).toBe(join(h.root, 'nested'));
        h.spawned[0]!.pty.exit(0);
        await expect.poll(() => h.runtime.workerAdmission.dependencies()).toEqual([]);
    });

    it('preserves authenticated host workflow origin through the real direct Machine Action transport', async () => {
        const h = await harness(undefined, null, 'machine', ownerToken);
        h.installPreferenceReadHttpBoundary();
        const account = { token: h.runtime.credentials.token, credentials: h.runtime.credentials,
            serverId: 'home', serverHttpBaseUrl: h.runtime.serverHttpBaseUrl };
        const outer = createCliActionExecutor({ ...account, mode: 'plain', ctx: null, pluginActionExecutionOwner: 'current_process',
            sessionId: 'workflow-host', serverId: 'home', serverHttpBaseUrl: h.runtime.serverHttpBaseUrl,
            accountServerActionDeps: createAccountServerActionDeps(account),
            actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1({ v: 1,
                approvalWaivedSurfaces: { 'projects.script.run': ['agent'] } }) },
            machineActionDirectTargetTransport: { machineId: 'machine', invoke: async (method, request, options) => {
                if (method === 'daemon.projects.inspect.v1') return await createProjectDefinitionAction({ serverId: 'home', machineId: 'machine',
                    workingDirectory: h.root, accessPolicy: { kind: 'restrictedRoots', roots: [h.root] }, nativeIo: h.runtime.nativeIo })({
                    actionId: 'projects.inspect', input: request, context: { serverId: 'home', signal: options?.signal } });
                expect(method).toBe(PROJECT_FINITE_ACTION_RPC_METHODS_V1['projects.script.run']);
                return h.rpcInvoke('projects.script.run', request, { ...h.context,
                    ...(options?.localActionContext ? { localActionContext: options.localActionContext } : {}) });
            } },
        });
        const input = { workspace: h.address, selection: { kind: 'native', source: { kind: 'native', tool: 'make', file: 'Makefile', target: 'check' } } };
        expect(await outer.execute('projects.script.run', input, { surface: 'agent', authority: 'account_automation',
            actionRequestId: 'workflow-leaf', executionRunWorkflowRunId: 'admitted-workflow',
            actionsSettings: normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: { 'projects.script.run': ['agent'] } }),
        })).toMatchObject({ ok: true, result: { operation: { domainRef: {
            originRun: { kind: 'workflow_run', serverId: 'home', runId: 'admitted-workflow' },
        } } } });
        await expect.poll(() => h.spawned.length).toBe(1);
        h.spawned[0]!.pty.exit(0);
        await expect.poll(() => h.runtime.workerAdmission.dependencies()).toEqual([]);
    });

    it('receives finite origin from the actual accepted Workflow Action context producer', async () => {
        const h = await harness();
        const { buildWorkflowActionContext } = await import('@/daemon/workflows/daemonRuntime');
        const executionContext = buildWorkflowActionContext({ runId: 'accepted-host-run',
            authorization: { principal: { kind: 'host' }, admittedPermissionCeiling: 'default' } });
        const input = { workspace: h.address, selection: { kind: 'native', source: { kind: 'native', tool: 'make', file: 'Makefile', target: 'check' } } };
        expect(await h.rpcInvoke('projects.script.run', input, { ...h.context, localActionContext: {
            ...(executionContext.executionRunWorkflowRunId ? { executionRunWorkflowRunId: executionContext.executionRunWorkflowRunId } : {}),
        } })).toMatchObject({ operation: { domainRef: {
            originRun: { kind: 'workflow_run', serverId: 'home', runId: 'accepted-host-run' },
        } } });
        await expect.poll(() => h.spawned.length).toBe(1);
        h.spawned[0]!.pty.exit(0);
        await expect.poll(() => h.runtime.workerAdmission.dependencies()).toEqual([]);
    });

    it.each([false, true])('retains the actual final-target clean Sync timestamp through a worker Run (setup: %s)', async setup => {
        const source = { kind: 'native', tool: 'make', file: 'Makefile', target: 'check' } as const;
        const h = await harness({ version: 1,
            ...(setup ? { workspace: { setup: [{ kind: 'command', command: 'echo setup' }] } } : {}),
            scripts: { checked: { execution: 'portable', source } },
        }, null, 'source-machine', ownerToken);
        const target = await h.addWorkerTarget();
        const hubRoot = await mkdtemp(join(tmpdir(), 'happier-project-sync-hub-'));
        roots.push(hubRoot);
        const hub = { ...h.workspaceRefs[0]!, id: 'hub', machineId: 'hub-machine', rootPath: hubRoot };
        h.workspaceRefs.push(hub);
        const original = h.relationships[0]!;
        h.relationships.splice(0, 1,
            { ...original, relationshipId: 'source-hub', controllerMachineId: hub.machineId,
                alphaWorkspaceRefId: hub.id, betaWorkspaceRefId: h.address.workspaceId, mode: 'keep_both_in_sync' },
            { ...original, relationshipId: 'hub-target', controllerMachineId: hub.machineId,
                alphaWorkspaceRefId: hub.id, betaWorkspaceRefId: target.id });
        const previousGet = h.get.getMockImplementation()!;
        h.get.mockImplementation(async (...args) => {
            const url = String(args[0]);
            if (!url.includes('/v1/machines/')) return await previousGet(...args);
            const machineId = decodeURIComponent(url.slice(url.lastIndexOf('/') + 1));
            return { status: 200, data: { machine: { id: machineId, metadata: null, metadataVersion: 0,
                daemonState: null, daemonStateVersion: 0, storageMode: 'plain', revokedAt: null, replacedByMachineId: null } } };
        });
        let permitFlush!: () => void;
        const flushAllowed = new Promise<void>(resolve => { permitFlush = resolve; });
        const isCurrent = h.runtime.isCurrent;
        if (!isCurrent) throw new Error('The fixture must retain its actual requester lifetime');
        const workerPreparation = createWorkspaceSyncWorkerPreparation({ serverId: 'home',
            serverHttpBaseUrl: h.runtime.serverHttpBaseUrl, targetMachineId: 'machine', credentials: h.runtime.credentials,
            isCurrent,
            prepareBetween: async (request, signal) => prepareWorkspaceSyncBetween({ ...request, signal, serverId: 'home',
                readCurrent: async () => ({ workspaceRefs: h.workspaceRefs, relationships: h.relationships }),
                // Only the external Sync controller's completed file-transfer reply is substituted.
                flush: async relationshipId => {
                    await flushAllowed;
                    const first = relationshipId === 'source-hub';
                    const from = first ? h.root : hub.rootPath;
                    const to = first ? hub.rootPath : target.rootPath;
                    await cp(from, to, { recursive: true });
                    return { relationshipId, controllerMachineId: hub.machineId, state: 'watching',
                        alphaPath: hub.rootPath, betaPath: first ? h.root : target.rootPath,
                        mode: first ? 'keep_both_in_sync' : 'keep_synced',
                        endpointStates: {
                            alpha: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 },
                            beta: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 },
                        }, conflictCount: 0, lastCycleObservedAtMs: 999,
                        lastCleanSyncAtMs: first ? 222 : 450,
                    };
                },
            }),
        }) satisfies Pick<ProjectFiniteActionRuntime, 'resolveWorkerTarget' | 'prepareDequeue'>;
        Object.assign(h.runtime, workerPreparation);
        const input = { workspace: h.address, selection: { kind: 'named', name: 'checked' },
            choice: { kind: 'workers', destination: { kind: 'machine', machineId: 'machine' } } };
        const scope = { accountId: 'owner', machineId: 'machine' };
        expect(await h.rpcInvoke('projects.script.run', input)).toMatchObject({ operation: { operationId: 'operation' } });
        await expect.poll(() => h.runtime.workerAdmission.dependencies()[0]?.state).toBe('copying');
        expect(h.operationRuntime.store.get(scope, 'operation')?.domainRef).not.toHaveProperty('lastCleanSyncAtMs');
        permitFlush();
        if (setup) {
            await expect.poll(() => h.operationRuntime.store.get(scope, 'operation')?.setupReview?.code).toBe('project_setup_consent_required');
            expect.soft(h.operationRuntime.store.get(scope, 'operation')).toMatchObject({
                domainRef: { workspaceRefId: target.id, lastCleanSyncAtMs: 450 } });
            await h.rememberSetup(h.operationRuntime.store.get(scope, 'operation')!.setupReview!.reviewedEffectDigest);
            expect(await h.rpcInvoke('projects.script.run', input)).toMatchObject({ operation: { operationId: 'operation' } });
            await expect.poll(() => h.spawned.length).toBe(1);
            expect.soft(h.operationRuntime.store.get(scope, 'operation')).toMatchObject({ state: 'running',
                domainRef: { purpose: 'setup', workspaceRefId: target.id, lastCleanSyncAtMs: 450 } });
            h.spawned[0]!.pty.exit(0);
        }
        await expect.poll(() => h.spawned.length).toBe(setup ? 2 : 1);
        expect.soft(h.operationRuntime.store.get(scope, 'operation')).toMatchObject({ state: 'running',
            domainRef: { purpose: 'script', workspaceRefId: target.id, lastCleanSyncAtMs: 450 } });
        h.spawned.at(-1)!.pty.exit(0);
        await expect.poll(() => h.operationRuntime.store.get(scope, 'operation')?.state).toBe('succeeded');
        expect(h.operationRuntime.store.get(scope, 'operation')).toMatchObject({ domainRef: { lastCleanSyncAtMs: 450 } });
    });

    it.each([true, false])('admits a portable named SOURCE declaration using canonical inspection (explicit workers: %s)', async explicit => {
        const source = { kind: 'native', tool: 'make', file: 'Makefile', target: 'check' } as const;
        const h = await harness({ version: 1, scripts: { checked: { execution: 'portable', memoryDemand: { bytes: 1024, basis: { kind: 'declared' } },
            source } } }, null, 'source-machine');
        const target = await h.addWorkerTarget();
        expect(await h.rpcInvoke('projects.script.run', { workspace: h.address, selection: { kind: 'named', name: 'checked' },
            ...(explicit ? { choice: { kind: 'workers', destination: { kind: 'machine', machineId: 'machine' } } } : {}),
        })).toMatchObject({ operation: { operationId: 'operation', domainRef: { workspaceRefId: target.id, machineId: 'machine',
            sourceWorkspace: h.address, script: { name: 'checked', source } } } });
        await expect.poll(() => h.runtime.workerAdmission.dependencies()[0]?.state).toBe('copying');
        expect(h.spawned).toEqual([]);
        h.continueCopy();
        await expect.poll(() => h.spawned.length).toBe(1);
        expect(h.operationRuntime.store.get({ accountId: 'owner', machineId: 'machine' }, 'operation')).toMatchObject({
            domainRef: { machineId: 'machine', workspaceRefId: target.id, sourceWorkspace: h.address, script: { name: 'checked', source } },
        });
        expect(h.spawned[0]!.params).toMatchObject({ args: ['-f', join(target.rootPath, 'Makefile'), 'check'], options: { cwd: target.rootPath } });
        h.spawned[0]!.pty.exit(0);
        await expect.poll(() => h.runtime.workerAdmission.dependencies()).toEqual([]);
    });

    it('does not assume a named SOURCE declaration is portable when explicit workers were requested', async () => {
        const h = await harness({ version: 1, scripts: { checked: { execution: 'primary',
            source: { kind: 'native', tool: 'make', file: 'Makefile', target: 'check' } } } }, null, 'source-machine');
        await h.addWorkerTarget();
        expect(await h.rpcInvoke('projects.script.run', { workspace: h.address, selection: { kind: 'named', name: 'checked' },
            choice: { kind: 'workers', destination: { kind: 'machine', machineId: 'machine' } },
        })).toMatchObject({ ok: false, errorCode: 'primary_only' });
        expect(h.runtime.workerAdmission.dependencies()).toEqual([]);
        expect(h.spawned).toEqual([]);
    });

    it.each([['workers', 'setup'], ['workers', 'script'], ['primary', 'script']] as const)('retains current setup review inside the original %s reservation and resumes the exact operation after real Remember (%s failure)', async (placement, failedPhase) => {
        const manifest = { version: 1, scripts: { checked: { execution: 'portable',
            source: { kind: 'native', tool: 'make', file: 'Makefile', target: 'check' } } } };
        const h = await harness(manifest, 1, placement === 'workers' ? 'source-machine' : 'machine');
        if (placement === 'workers') await h.addWorkerTarget();
        const selection = { kind: 'named', name: 'checked' } as const;
        const script = { name: selection.name, source: manifest.scripts.checked.source };
        const input = { workspace: h.address,
            selection,
            choice: placement === 'workers' ? { kind: 'workers', destination: { kind: 'machine', machineId: 'machine' } } : { kind: 'primary' },
        };
        expect(await h.rpcInvoke('projects.script.run', input)).toMatchObject({ operation: { operationId: 'operation' } });
        h.continueCopy();
        await expect.poll(() => h.spawned.length).toBe(1);
        h.holdCopy();
        const ingress = { ...h.context, transportRequestId: 'queued-named-script' };
        expect.soft(await h.rpcInvoke('projects.script.run', input, ingress)).toMatchObject({
            operation: { operationId: 'operation-2', domainRef: { purpose: 'script', sourceWorkspace: h.address, script } },
        });
        const scope = { accountId: 'owner', machineId: 'machine' };
        await expect.poll(() => h.runtime.workerAdmission.dependencies().find(entry => entry.operationId === 'operation-2')?.state).toBe('queued');
        expect.soft(h.operationRuntime.store.get(scope, 'operation-2')).toMatchObject({
            state: 'accepted', domainRef: { purpose: 'script', sourceWorkspace: h.address, script },
        });
        await writeFile(join(h.root, '.happier/project.json'), JSON.stringify({ ...manifest,
            workspace: { setup: [{ kind: 'command', command: 'echo setup' }] },
        }));
        h.spawned[0]!.pty.exit(0);
        if (placement === 'workers') {
            await expect.poll(() => h.runtime.workerAdmission.dependencies().find(entry => entry.operationId === 'operation-2')?.state).toBe('copying');
            h.continueCopy();
        }
        await expect.poll(() => {
            const snapshot = h.operationRuntime.store.get(scope, 'operation-2');
            return snapshot?.setupReview !== undefined || snapshot?.state === 'failed';
        }).toBe(true);
        const pending = h.operationRuntime.store.get(scope, 'operation-2');
        expect.soft(pending).toMatchObject({ state: 'accepted', setupReview: { kind: 'pendingApproval', code: 'project_setup_consent_required',
            reviewedEffectDigest: expect.any(String), reviewedEffect: expect.any(Object) }, domainRef: { sourceWorkspace: h.address, script } });
        expect(h.spawned).toHaveLength(1);
        expect(h.runtime.workerAdmission.dependencies()).toMatchObject([{ operationId: 'operation-2', state: 'setup' }]);
        await h.rememberSetup(pending!.setupReview!.reviewedEffectDigest);
        expect(await h.operationRuntime.handlers.getV2({ operationId: 'operation-2' }))
            .toMatchObject({ kind: 'found', operation: { operationId: 'operation-2' } });
        await expect.poll(() => {
            const snapshot = h.operationRuntime.store.get(scope, 'operation-2');
            return { spawned: h.spawned.length, state: snapshot?.state, error: snapshot?.error,
                setupReviewDigest: snapshot?.setupReview?.reviewedEffectDigest,
                dependencies: h.runtime.workerAdmission.dependencies() };
        }).toEqual(expect.objectContaining({ spawned: 2 }));
        expect.soft(h.operationRuntime.store.get(scope, 'operation-2')).toMatchObject({
            state: 'running', domainRef: { purpose: 'setup', sourceWorkspace: h.address, script, terminalId: expect.any(String) },
        });
        const setupAttachment = h.operationRuntime.store.get(scope, 'operation-2')!.domainRef;
        const setupTerminalId = setupAttachment?.kind === 'projectCommand' ? setupAttachment.terminalId : undefined;
        let failedTerminalId = setupTerminalId;
        h.spawned[1]!.pty.exit(failedPhase === 'setup' ? 7 : 0);
        if (failedPhase === 'script') {
            await expect.poll(() => h.spawned.length).toBe(3);
            expect.soft(h.operationRuntime.store.get(scope, 'operation-2')).toMatchObject({
                state: 'running', domainRef: { purpose: 'script', sourceWorkspace: h.address, script, terminalId: expect.any(String) },
            });
            const scriptAttachment = h.operationRuntime.store.get(scope, 'operation-2')!.domainRef;
            failedTerminalId = scriptAttachment?.kind === 'projectCommand' ? scriptAttachment.terminalId : undefined;
            expect(failedTerminalId).not.toBe(setupTerminalId);
            h.spawned[2]!.pty.exit(7);
        }
        await expect.poll(() => h.operationRuntime.store.get(scope, 'operation-2')?.state).toBe('failed');
        expect(h.operationRuntime.store.get(scope, 'operation-2')).toMatchObject({
            error: { errorCode: failedPhase === 'setup' ? 'project_setup_step_failed' : 'project_command_step_failed' },
            domainRef: { purpose: failedPhase, sourceWorkspace: h.address, script, exitCode: 7, terminalId: failedTerminalId },
        });
        expect(h.spawned).toHaveLength(failedPhase === 'setup' ? 2 : 3);
        expect(h.operationRuntime.store.list(scope).items).toHaveLength(2);
        expect(h.runtime.workerAdmission.dependencies()).toEqual([]);
    });

    it('cancels an accepted worker waiting for post-copy setup consent without releasing before no-effect settlement', async () => {
        const h = await harness(portableNativeManifest, null, 'source-machine');
        await h.addWorkerTarget();
        expect(await h.rpcInvoke('projects.script.run', { workspace: h.address,
            selection: { kind: 'named', name: 'checked' },
            choice: { kind: 'workers', destination: { kind: 'machine', machineId: 'machine' } },
        })).toMatchObject({ operation: { operationId: 'operation' } });
        await expect.poll(() => h.runtime.workerAdmission.dependencies().find(entry => entry.operationId === 'operation')?.state).toBe('copying');
        await writeFile(join(h.root, '.happier/project.json'), JSON.stringify({ ...portableNativeManifest, workspace: { setup: [{ kind: 'command', command: 'echo setup' }] } }));
        h.continueCopy();
        const scope = { accountId: 'owner', machineId: 'machine' };
        await expect.poll(() => {
            const snapshot = h.operationRuntime.store.get(scope, 'operation');
            return snapshot?.setupReview !== undefined || snapshot?.state === 'failed';
        }).toBe(true);
        expect(h.operationRuntime.store.get(scope, 'operation')).toMatchObject({ setupReview: { code: 'project_setup_consent_required' } });
        expect(h.runtime.workerAdmission.dependencies()).toHaveLength(1);
        expect(h.operationRuntime.runner.cancel(scope, 'operation')).toEqual({ kind: 'requested' });
        await expect.poll(() => h.operationRuntime.store.get(scope, 'operation')?.state).toBe('cancelled');
        expect(h.runtime.workerAdmission.dependencies()).toEqual([]);
        expect(h.spawned).toEqual([]);
    });

    it('refuses an actually invalid SOURCE declaration before worker acceptance or target file reads', async () => {
        const h = await harness({ version: 1 }, null, 'source-machine');
        await h.addWorkerTarget();
        await writeFile(join(h.root, '.happier/project.json'), 'invalid source JSON');
        expect(await h.rpcInvoke('projects.script.run', { workspace: h.address, selection: { kind: 'named', name: 'checked' },
            choice: { kind: 'workers', destination: { kind: 'machine', machineId: 'machine' } },
        })).toMatchObject({ ok: false, errorCode: 'invalid_manifest' });
        expect(h.operationRuntime.store.list({ accountId: 'owner', machineId: 'machine' }).items).toEqual([]);
        expect(h.runtime.workerAdmission.dependencies()).toEqual([]);
        expect(h.spawned).toEqual([]);
    });

    it.each(['source-machine', 'machine'])('preserves the accepted host Machine baseline over SOURCE worker preferences (%s)', async sourceMachineId => {
        const h = await harness({ version: 1, scripts: { checked: { execution: 'portable',
            source: { kind: 'native', tool: 'make', file: 'Makefile', target: 'check' } } } }, null, sourceMachineId);
        const target = await h.addWorkerTarget();
        h.setWorkerDestination('different-worker');
        const { buildWorkflowActionContext } = await import('@/daemon/workflows/daemonRuntime');
        const context = buildWorkflowActionContext({ runId: 'accepted-run', workspace: { machineId: 'machine' },
            authorization: { principal: { kind: 'host' }, admittedPermissionCeiling: 'default' } });
        const localActionContext = { surface: context.surface, authority: context.authority,
            executionRunTargetMachineId: context.executionRunTargetMachineId ?? undefined, executionRunWorkflowRunId: context.executionRunWorkflowRunId };
        const sourceInput = { workspace: h.address, selection: { kind: 'named', name: 'checked' } };
        const { projectWorkflowFiniteActionInputV1 } = await import('@happier-dev/protocol/workflows/materializeWorkflowAcceptedSnapshotV1');
        const effectiveInput = sourceMachineId === 'machine' ? projectWorkflowFiniteActionInputV1({ machineId: 'machine',
            actionId: 'projects.script.run', input: sourceInput }) : sourceInput;
        expect(await h.rpcInvoke('projects.script.run', effectiveInput,
            { ...h.context, localActionContext })).toMatchObject({ operation: { operationId: 'operation', domainRef: {
                workspaceRefId: sourceMachineId === 'machine' ? h.address.workspaceId : target.id,
            } } });
        h.continueCopy();
        await expect.poll(() => h.spawned.length).toBe(1);
        expect(h.spawned[0]!.params.options.cwd).toBe(sourceMachineId === 'machine' ? h.root : target.rootPath);
        h.spawned[0]!.pty.exit(0);
        await expect.poll(() => h.runtime.workerAdmission.dependencies()).toEqual([]);
    });

    it('refuses an unreviewed override of the accepted host Machine through the real direct Action transport', async () => {
        const h = await harness(portableNativeManifest, null, 'source-machine', ownerToken);
        await h.addWorkerTarget();
        h.installPreferenceReadHttpBoundary();
        vi.spyOn(machineRpcTransport, 'callExactMachineRpc').mockImplementation(async request => {
            expect(request.machineId).toBe('source-machine');
            expect(request.method).toBe('daemon.projects.inspect.v1');
            return await createProjectDefinitionAction({ serverId: 'home', machineId: 'source-machine', workingDirectory: h.root,
                accessPolicy: { kind: 'restrictedRoots', roots: [h.root] }, nativeIo: h.runtime.nativeIo })({
                actionId: 'projects.inspect', input: request.request, context: { serverId: 'home', signal: request.signal } });
        });
        const { buildWorkflowActionContext } = await import('@/daemon/workflows/daemonRuntime');
        const context = buildWorkflowActionContext({ runId: 'accepted-run', workspace: { machineId: 'accepted-machine' },
            authorization: { principal: { kind: 'host' }, admittedPermissionCeiling: 'default' } });
        const account = { token: h.runtime.credentials.token, credentials: h.runtime.credentials,
            serverId: 'home', serverHttpBaseUrl: h.runtime.serverHttpBaseUrl };
        const outer = createCliActionExecutor({ ...account, mode: 'plain', ctx: null, pluginActionExecutionOwner: 'current_process',
            sessionId: 'workflow-host', serverId: 'home', serverHttpBaseUrl: h.runtime.serverHttpBaseUrl,
            accountServerActionDeps: createAccountServerActionDeps(account),
            actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1({ v: 1,
                approvalWaivedSurfaces: { 'projects.script.run': ['agent'] } }) },
            machineActionDirectTargetTransport: { machineId: 'machine', invoke: async (_method, request, options) => h.rpcInvoke('projects.script.run', request,
                { ...h.context, ...(options?.localActionContext ? { localActionContext: options.localActionContext } : {}) }) },
        });
        expect(await outer.execute('projects.script.run', { workspace: h.address,
            selection: { kind: 'named', name: 'checked' },
            choice: { kind: 'workers', destination: { kind: 'machine', machineId: 'machine' } },
        }, { ...context, actionRequestId: 'original-leaf', actionsSettings: normalizeActionsSettingsV1({ v: 1,
            approvalWaivedSurfaces: { 'projects.script.run': ['agent'] } }) }))
            .toMatchObject({ ok: false, errorCode: 'override_requires_review' });
        expect(h.runtime.workerAdmission.dependencies()).toEqual([]);
        expect(h.spawned).toEqual([]);
    });

    it('settles changed Source Script review after Remember inspection without using the setup grant to launch', async () => {
        const h = await harness({ ...portableNativeManifest, workspace: { setup: [{ kind: 'command', command: 'echo original setup' }] } }, 1, 'source-machine');
        await h.addWorkerTarget();
        const input = { workspace: h.address, selection: { kind: 'named', name: 'checked' },
            choice: { kind: 'workers', destination: { kind: 'machine', machineId: 'machine' } } };
        expect(await h.rpcInvoke('projects.script.run', input)).toMatchObject({ operation: { operationId: 'operation' } });
        h.continueCopy();
        const scope = { accountId: 'owner', machineId: 'machine' };
        await expect.poll(() => h.operationRuntime.store.get(scope, 'operation')?.setupReview !== undefined).toBe(true);
        const pending = h.operationRuntime.store.get(scope, 'operation')!.setupReview!;
        expect(h.spawned).toEqual([]);
        expect(h.runtime.workerAdmission.dependencies()).toMatchObject([{ operationId: 'operation', state: 'setup' }]);
        await h.rememberSetup(pending.reviewedEffectDigest);
        await writeFile(join(h.root, '.happier/project.json'), JSON.stringify({ ...portableNativeManifest,
            scripts: { checked: { execution: 'portable', source: { kind: 'command', command: 'echo changed Script' } } },
            workspace: { setup: [{ kind: 'command', command: 'echo original setup' }] },
        }));
        // Consume the actual public observation boundary's rejection on RED;
        // the deciding fact is whether its original retained operation settles.
        const inspection = await h.operationRuntime.handlers.getV2({ operationId: 'operation' }).catch(error => ({
            refreshError: error instanceof Error && 'code' in error ? error.code : 'unknown',
        }));
        await expect.poll(() => {
            const snapshot = h.operationRuntime.store.get(scope, 'operation');
            return { state: snapshot?.state, error: snapshot?.error, setupReviewDigest: snapshot?.setupReview?.reviewedEffectDigest,
                dependencies: h.runtime.workerAdmission.dependencies(), spawned: h.spawned.length };
        }).toEqual(expect.objectContaining({ state: 'failed' }));
        expect(inspection).toMatchObject({ kind: 'found' });
        expect(h.operationRuntime.store.get(scope, 'operation')).toMatchObject({ state: 'failed', error: {
            errorCode: 'project_script_effect_changed', details: { kind: 'pendingApproval', code: 'project_script_effect_changed',
                reviewedEffectDigest: expect.any(String), reviewedEffect: expect.anything() },
        } });
        expect(h.operationRuntime.store.get(scope, 'operation')).not.toHaveProperty('setupReview');
        expect(h.runtime.workerAdmission.dependencies()).toEqual([]);
        expect(h.spawned).toEqual([]);
    });

    it('re-copies the same accepted Sync route after review wake and does not use Remember for changed source effects', async () => {
        const h = await harness(portableNativeManifest, null, 'source-machine');
        await h.addWorkerTarget();
        const input = { workspace: h.address,
            selection: { kind: 'named', name: 'checked' },
            choice: { kind: 'workers', destination: { kind: 'machine', machineId: 'machine' } } };
        expect(await h.rpcInvoke('projects.script.run', input)).toMatchObject({ operation: { operationId: 'operation' } });
        await expect.poll(() => h.runtime.workerAdmission.dependencies().find(entry => entry.operationId === 'operation')?.state).toBe('copying');
        await writeFile(join(h.root, '.happier/project.json'), JSON.stringify({ ...portableNativeManifest, workspace: { setup: [{ kind: 'command', command: 'echo original setup' }] } }));
        h.continueCopy();
        const scope = { accountId: 'owner', machineId: 'machine' };
        await expect.poll(() => {
            const snapshot = h.operationRuntime.store.get(scope, 'operation');
            return snapshot?.setupReview !== undefined || snapshot?.state === 'failed';
        }).toBe(true);
        expect(h.operationRuntime.store.get(scope, 'operation')).toMatchObject({ setupReview: { code: 'project_setup_consent_required' } });
        const firstDigest = h.operationRuntime.store.get(scope, 'operation')!.setupReview!.reviewedEffectDigest;
        await writeFile(join(h.root, '.happier/project.json'), JSON.stringify({ ...portableNativeManifest, workspace: { setup: [{ kind: 'command', command: 'echo changed setup' }] } }));
        expect(await h.operationRuntime.handlers.getV2({ operationId: 'operation' }))
            .toMatchObject({ kind: 'found', operation: { operationId: 'operation', setupReview: {
                reviewedEffectDigest: expect.not.stringMatching(new RegExp(`^${firstDigest}$`)),
            } } });
        // The producer must expose the new effect before any Trust write, not
        // only discover it after granting the stale displayed target effect.
        await h.rememberSetup(firstDigest);
        await h.operationRuntime.handlers.getV2({ operationId: 'operation' });
        await expect.poll(() => {
            const snapshot = h.operationRuntime.store.get(scope, 'operation');
            return { reviewChanged: Boolean(snapshot?.setupReview && snapshot.setupReview.reviewedEffectDigest !== firstDigest),
                state: snapshot?.state, error: snapshot?.error, setupReviewDigest: snapshot?.setupReview?.reviewedEffectDigest,
                dependencies: h.runtime.workerAdmission.dependencies(), spawned: h.spawned.length };
        }).toEqual(expect.objectContaining({ reviewChanged: true }));
        expect(h.spawned).toEqual([]);
        expect(h.runtime.workerAdmission.dependencies()).toMatchObject([{ operationId: 'operation', state: 'setup' }]);
        expect(h.operationRuntime.runner.cancel(scope, 'operation')).toEqual({ kind: 'requested' });
        await expect.poll(() => h.operationRuntime.store.get(scope, 'operation')?.state).toBe('cancelled');
        expect(h.runtime.workerAdmission.dependencies()).toEqual([]);
    });
});
