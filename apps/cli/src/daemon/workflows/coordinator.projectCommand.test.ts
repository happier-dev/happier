import axios, { AxiosHeaders } from 'axios';
import tweetnacl from 'tweetnacl';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCliActionExecutorHarness } from '@/session/actions/createCliActionExecutorHarness';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';
import { createAccountServerActionDeps } from '@/api/accountServerActionDeps';
import { createProjectDefinitionAction, registerProjectDefinitionHandlers } from '@/rpc/handlers/projectDefinitions';
import * as machineTransport from '@/session/transport/rpc/machineRpc';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import type { WorkflowDefinitionV1 } from '@happier-dev/protocol/workflows';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { createTerminalPtySessionManager } from '@/terminal/pty/sessions';
import type { PtyExitEvent, PtyProcess, PtyProvider } from '@/terminal/pty/provider';
import { createProjectFiniteAction } from '@/workspaces/projectSetup/projectFiniteAction';
import { createWorkspaceExecutionConfigClientV1 } from '@happier-dev/protocol/workspaces/workspaceExecutionConfigClientV1';
import { createProjectWorkerAdmission } from '@/workspaces/execution/projectWorkerAdmission';
import { createDaemonAdmissionDrain } from '@/daemon/lifecycle/admissionDrain';
import { reviewProjectSetupEffect, type ProjectSetupPreparationInput } from '@/workspaces/projectSetup/projectSetupPreparation';
import { createTestWorkflowCoordinator, createInMemoryWorkflowCoordinatorStore } from './workflowCoordinator.testkit';
import { registerProjectFiniteRpcHandlers } from '@/rpc/handlers/projects/registerProjectFiniteRpcHandlers';
import { registerActionOperationRpcHandlers } from '@/daemon/actionOperations/actionOperationRpcHandlers';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { authorizeMachineRpcRequest, verifyMachineRpcAdmissionCurrent } from '@/api/machine/machineRpcAuthorization';
import { ACTION_OPERATION_RPC_METHODS_V2, ActionOperationGetV1ResponseSchema } from '@happier-dev/protocol/actions/operations/v1';
import { createCoordinatorWorkspaceResolver } from './resolveWorkflowWorkspace';
import { createGitWorkflowWorkspaceTestDependencies } from './workflowWorkspace.testkit';
import { createProjectSetupTrustClient } from '@/workspaces/projectSetup/projectSetupTrust';
import { createProjectNativeEnvironmentIoForHost } from '@/plugins/runtime/invocation/services/exec';
import { ProjectTrustMutationRequestV1Schema, type ProjectTrustContentV1 } from '@happier-dev/protocol/workspaces/projectSetup/projectTrustRowV1';

// Only the OS process and authenticated HTTP transport are substituted.
// Preparation, final Exec authorization, PTY custody, Actions, operation owner,
// frozen Workflow materialization and completion all run their real logic.
class FinitePty implements PtyProcess {
  readonly pid = 12345;
  readonly ownedProcessGroupId = 12345;
  private readonly exits = new Set<(event: PtyExitEvent) => void>();
  write() { throw new Error('Finite commands never use interactive terminal input'); }
  resize() {}
  kill() {}
  onData() { return { dispose() {} }; }
  onExit(listener: (event: PtyExitEvent) => void) {
    this.exits.add(listener);
    return { dispose: () => this.exits.delete(listener) };
  }
  exit(exitCode: number) { for (const listener of this.exits) listener({ exitCode, signal: 0 }); }
}

describe('finite Project command Workflow completion', () => {
  const roots: string[] = [];
  const managers: Array<ReturnType<typeof createTerminalPtySessionManager>> = [];
  afterEach(async () => {
    managers.splice(0).forEach(manager => manager.dispose());
    vi.restoreAllMocks();
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  });

  it.each(['setup', 'script', 'consent'] as const)('retains accepted script custody through the real %s boundary', async failedPhase => {
    expect(getActionSpec('projects.script.run').operation).toBeDefined();
    const root = await mkdtemp(join(tmpdir(), 'happier-finite-workflow-'));
    roots.push(root);
    await mkdir(join(root, '.happier'));
    await mkdir(join(root, 'command-subdirectory'));
    await writeFile(join(root, '.happier/project.json'), JSON.stringify({ version: 1,
      workspace: { setup: [{ kind: 'command', command: 'echo finite' }] },
      scripts: { check: { source: { kind: 'command', command: 'echo script', cwd: 'command-subdirectory' } } } }));
    const machineId = 'machine-1'; // The accepted Workflow fixture's canonical Machine.
    const workspace = { id: 'workspace', serverId: 'home', machineId, rootPath: root,
      projectKey: 'project', createdAtMs: 1 };
    const preparation = { workspace,
      projectAssociation: { workspace, project: { serverId: 'home', projectId: 'project' } },
      requester: { credentials: { token: 'requester', encryption: null }, serverHttpBaseUrl: 'https://requester.example' },
      purpose: 'setup', platform: { os: 'linux', arch: 'x64' }, successHomeDir: join(root, 'completed'),
      nativeIo: { resolveTool: async () => null } } satisfies ProjectSetupPreparationInput;
    const reviewed = await reviewProjectSetupEffect(preparation);
    if (reviewed.kind !== 'reviewed') throw new Error(reviewed.code);
    let trustRevision = 1;
    let trustContent: ProjectTrustContentV1 = { t: 'plain', v: { project: preparation.projectAssociation.project,
      reviewedEffectDigest: reviewed.plan.reviewedEffectDigest, approvedAtMs: 1 } };
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { mode: 'plain', updatedAt: 1 } });
    vi.spyOn(axios, 'request').mockImplementation(async request => {
      const reply = (data: unknown) => ({ status: 200, data, statusText: 'OK', headers: {}, config: { headers: new AxiosHeaders() } });
      if (request.url === `${preparation.requester.serverHttpBaseUrl}/v1/account/encryption`) return reply({ mode: 'plain', updatedAt: 1 });
      if (request.url === `${preparation.requester.serverHttpBaseUrl}/v1/projects/execution/config/read`) return reply({
        status: 'present', revision: 1, content: { t: 'plain', v: {
          enabled: false, unavailable: 'ask', allowAdHoc: false, scriptOverrides: {}, services: {},
        } },
      });
      throw new Error(`Unexpected requester Home request: ${request.url}`);
    });
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      if (String(url).endsWith('/admission/verify')) return { status: 200, data: { v: 1, ok: true },
        statusText: 'OK', headers: {}, config: { headers: new AxiosHeaders() } };
      if (String(url).endsWith('/project-trust/read')) return { status: 200, data: { status: 'present', revision: trustRevision,
        content: trustContent } };
      if (String(url).endsWith('/project-trust/mutate')) {
        const mutation = ProjectTrustMutationRequestV1Schema.parse(body);
        if (mutation.expectedRevision !== trustRevision || !mutation.content) throw new Error('Unexpected trust mutation');
        trustContent = mutation.content;
        return { status: 200, data: { status: 'updated', revision: ++trustRevision, cursor: 1 } };
      }
      const key = { kind: 'workspace-ref', serverId: 'home', id: workspace.id };
      return { status: 200, data: { status: 'listed', coverage: 'complete', rows: [{ key, revision: 1,
        content: { t: 'plain', v: { key, value: workspace } } }] } };
    });
    const processes: FinitePty[] = [];
    let stopRequests = 0;
    const provider: PtyProvider = { spawn() { const process = new FinitePty(); processes.push(process); return process; } };
    const terminals = createTerminalPtySessionManager({ ptyProvider: provider, env: { NODE_ENV: 'test', SHELL: '/bin/bash' },
      stopProcessTree: async () => { stopRequests++; },
      // The OS boundary fixture has no surviving descendants after exit.
      probeProcessGroup: () => 'absent',
      config: { maxSessions: 10, idleTimeoutMs: 60000, bufferMaxBytes: 100000, bufferMaxEvents: 1000,
        bufferRetentionMs: 600000, urlParseBufferLimit: 32768, maxWriteChunkBytes: 16384, defaultCols: 80, defaultRows: 24 } });
    managers.push(terminals);
    let operationSequence = 0;
    const operations = createHostActionOperationRuntime({ serverId: 'home', machineId, resolveAccountId: async () => 'account',
      custodyBinding: { serverId: 'home', installationId: 'installation' },
      generateOperationId: () => failedPhase === 'consent' && operationSequence++ === 0 ? 'blocker' : 'finite' });
    const config = createWorkspaceExecutionConfigClientV1({ mode: 'plain', material: null, isCurrent: () => true,
      randomBytes: length => new Uint8Array(length), transport: {
        read: async () => ({ status: 'present', revision: 1, content: { t: 'plain', v: {
          enabled: false, unavailable: 'ask', allowAdHoc: false, scriptOverrides: {}, services: {} } } }),
        mutate: async () => { throw new Error('Read-only configuration transport'); },
      } });
    const workerAdmission = createProjectWorkerAdmission({ machineId, admissionDrain: createDaemonAdmissionDrain(),
      readPolicy: async () => ({ status: 'ready', policy: { accepting: true, runAtMost: failedPhase === 'consent' ? 1 : null }, source: 'stored', metadataVersion: 1 }) });
    const finiteRuntime = { accountId: 'account', serverId: 'home', machineId,
      credentials: preparation.requester.credentials, serverHttpBaseUrl: preparation.requester.serverHttpBaseUrl,
      operationRuntime: operations, workerAdmission, resolveWorkspaceExecutionConfig: async () => config,
      nativeIo: preparation.nativeIo, terminalSessions: terminals, platform: 'linux' as const, arch: 'x64',
      hostEnvironment: { NODE_ENV: 'test' as const, SHELL: '/bin/bash' }, successHomeDir: preparation.successHomeDir,
      environmentIo: createProjectNativeEnvironmentIoForHost({ resolveTool: async () => null }),
    };
    const settings = ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: { 'projects.script.run': ['agent', 'api'] } });
    const keys = tweetnacl.sign.keyPair();
    const rpc = new RpcHandlerManager({ scopePrefix: machineId, encryptionMode: 'plain',
      authorizeRequest: request => authorizeMachineRpcRequest(request, { machineId,
        resolveCustodianAccountId: async () => 'account', resolveInstallationId: () => 'installation',
        verifyMachineAdmission: input => verifyMachineRpcAdmissionCurrent({ ...input, privateKey: keys.secretKey,
          daemonToken: 'daemon', serverHttpBaseUrl: 'https://requester.example' }) }) });
    const definitions = createCliActionExecutorHarness({ mode: 'plain', ctx: null, token: preparation.requester.credentials.token,
      credentials: preparation.requester.credentials, sessionId: 'cli-global', serverId: 'home',
      serverHttpBaseUrl: preparation.requester.serverHttpBaseUrl, actionsSettingsProvider: { getActionsSettings: () => settings },
    }, { projectDefinitionAction: createProjectDefinitionAction({ serverId: 'home', machineId, workingDirectory: root,
      accessPolicy: { kind: 'restrictedRoots', roots: [root] }, nativeIo: preparation.nativeIo }) }).executor;
    registerProjectDefinitionHandlers({ rpcHandlerManager: rpc, machineId, actionExecutor: definitions });
    registerActionOperationRpcHandlers(rpc, operations.handlers);
    registerProjectFiniteRpcHandlers(rpc, { serverId: 'home', machineId, runtime: finiteRuntime,
      createActionExecutor: (runtime, ingress) => {
        if (!runtime.credentials) throw new Error('Finite Workflow fixture requires credentials');
        return createCliActionExecutorHarness({ mode: 'plain', ctx: null, token: runtime.credentials.token, credentials: runtime.credentials,
          sessionId: 'cli-global', serverId: runtime.serverId, serverHttpBaseUrl: runtime.serverHttpBaseUrl,
          actionsSettingsProvider: { getActionsSettings: () => settings },
        }, { projectAction: createProjectFiniteAction(runtime, ingress) }).executor;
      } });
    const machineAdmission = { actorAccountId: 'account', custodianAccountId: 'account', machineId,
      installationId: 'installation', role: 'manage' as const, encryptionMode: 'plain' as const };
    const call = (method: string, params: unknown, requestId?: string, timeoutMs?: number) => rpc.handleRequest({ method: `${machineId}:${method}`, params,
      ...(requestId ? { requestId } : {}), ...(timeoutMs === undefined ? {} : { timeoutMs }),
      machineAdmission, callerAuthority: 'present_user' });
    const acceptedRequest: { current?: Readonly<{ method: string; input: unknown; requestId: string }> } = {};
    let lastFiniteResponse: unknown;
    // Emulate only the external Machine RPC network; the real outgoing CLI
    // Action adapter and installed authenticated receiver stay in the path.
    const send = async ({ method, request: input, requestId, signal }: Parameters<typeof machineTransport.callExactMachineRpc>[0]) => {
      signal?.throwIfAborted();
      if (method === getActionSpec('projects.script.run').bindings?.rpcMethod) {
        if (!requestId) throw new Error('Missing real Workflow request identity');
        acceptedRequest.current = { method, input, requestId };
      }
      const response = await call(method, input, requestId);
      if (method === getActionSpec('projects.script.run').bindings?.rpcMethod) lastFiniteResponse = response;
      return response;
    };
    vi.spyOn(machineTransport, 'callExactMachineRpc').mockImplementation(send);
    vi.spyOn(machineTransport, 'callMachineRpc').mockImplementation(send);
    const executor = createCliActionExecutor({ mode: 'plain', ctx: null, token: preparation.requester.credentials.token,
      credentials: preparation.requester.credentials, sessionId: 'cli-global', serverId: 'home',
      serverHttpBaseUrl: preparation.requester.serverHttpBaseUrl, actionsSettingsProvider: { getActionsSettings: () => settings },
      pluginActionExecutionOwner: 'current_process', accountServerActionDeps: createAccountServerActionDeps({
        token: preparation.requester.credentials.token, credentials: preparation.requester.credentials,
        serverId: 'home', serverHttpBaseUrl: preparation.requester.serverHttpBaseUrl,
      }) });
    const context = { surface: 'agent' as const, authority: 'account_automation' as const, serverId: 'home',
      actionsSettings: settings };
    const store = createInMemoryWorkflowCoordinatorStore();
    let downstream = false;
    const coordinator = createTestWorkflowCoordinator({ store, isAcceptedAuthorizationCurrent: async () => true,
      resolveWorkspace: createCoordinatorWorkspaceResolver({ store,
        projectWorkspace: { machineId, directory: root, checkoutRootPath: root },
        scm: createGitWorkflowWorkspaceTestDependencies() }),
      executeStep: async () => { downstream = true; return { kind: 'completed', result: 'after' }; },
      action: { executor, buildContext: async () => context,
        observeOperation: async target => {
          const observed = ActionOperationGetV1ResponseSchema.parse(await call(ACTION_OPERATION_RPC_METHODS_V2.get,
            { operationId: target.operationId, waitForTerminal: true, includeSetupReview: true }));
          if (observed.kind !== 'found') throw new Error('Exact operation unavailable');
          return observed.operation;
        }, observeRun: async () => { throw new Error('No invented Execution Run'); } } });
    const agentTarget = { kind: 'agent', identity: { pluginId: 'happier.agent.test', localId: 'test' } } as const;
    const definition: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults: { agentTarget }, blocks: [
      { kind: 'action', id: 'script', actionId: 'projects.script.run', input: {
        workspace: { kind: 'literal', value: { workspaceId: workspace.id, serverId: workspace.serverId,
          machineId: workspace.machineId, rootPath: workspace.rootPath } },
        selection: { kind: 'literal', value: { kind: 'named', name: 'check' } } } },
      { kind: 'step', id: 'after', document: { text: 'after', references: [], attachments: [] }, input: [], result: { kind: 'text' } },
    ] };
    const runInput = { runId: 'run', definition, inputs: {}, executionTarget: { kind: 'session' as const },
      authorization: { admittedPermissionCeiling: 'default' as const, principal: { kind: 'host' as const } } };
    if (failedPhase === 'consent') {
      expect(await executor.execute('projects.script.run', { workspace: { serverId: 'home', machineId,
        workspaceId: workspace.id, rootPath: root }, selection: { kind: 'named', name: 'check' } },
      { ...context, actionRequestId: 'blocker' })).toMatchObject({ ok: true, result: { operation: { operationId: 'blocker' } } });
      await expect.poll(() => processes.length).toBe(1);
      processes[0]!.exit(0);
      await expect.poll(() => processes.length).toBe(2);
    }
    const executing = coordinator.run(runInput);
    if (failedPhase === 'consent') {
      const scope = { accountId: 'account', machineId };
      await expect.poll(() => store.list().find(row => row.blockId === 'script')?.execution)
        .toMatchObject({ awaitedOperations: [{ operationId: 'finite' }] });
      expect(workerAdmission.dependencies()).toHaveLength(2);
      await writeFile(join(root, '.happier/project.json'), JSON.stringify({ version: 1,
        workspace: { setup: [{ kind: 'command', command: 'echo newly reviewed setup' }] },
        scripts: { check: { source: { kind: 'command', command: 'echo script', cwd: 'command-subdirectory' } } } }));
      processes[1]!.exit(0);
      expect(await executing).toMatchObject({ state: 'interrupted', reason: 'project_setup_consent_required' });
      const held = store.list().find(row => row.blockId === 'script');
      expect(held).toMatchObject({ lifecycle: 'needs_attention', attempt: 0, reason: 'project_setup_consent_required',
        execution: { awaitedOperations: [{ serverId: 'home', machineId, operationId: 'finite' }],
          output: { operation: { operationId: 'finite', setupReview: { code: 'project_setup_consent_required' } } } } });
      expect(held?.review).toBeUndefined();
      expect(downstream).toBe(false);
      expect(processes).toHaveLength(2);
      expect(workerAdmission.dependencies()).toMatchObject([{ operationId: 'finite', state: 'setup' }]);
      const pending = operations.store.get(scope, 'finite');
      if (!pending?.setupReview) throw new Error('Missing actual retained setup review');
      const remembered = await createProjectSetupTrustClient(preparation.requester).approveReviewedEffect({
        project: preparation.projectAssociation.project, reviewedEffectDigest: pending.setupReview.reviewedEffectDigest,
        currentEffectDigest: pending.setupReview.reviewedEffectDigest, expectedRevision: trustRevision, approvedAtMs: 2,
        authority: 'present_user' });
      expect(remembered).toMatchObject({ status: 'updated' });
      const resumed = coordinator.run(runInput);
      const resumedDiagnostic = () => ({ processCount: processes.length,
        invocation: store.list().find(row => row.blockId === 'script'),
        operation: operations.store.get(scope, 'finite'), finiteResponse: lastFiniteResponse });
      try {
        await expect.poll(() => processes.length === 3 ? 3 : resumedDiagnostic()).toBe(3);
      } catch (error) {
        throw new Error(`Retained setup review did not resume the continued process: ${JSON.stringify(resumedDiagnostic())}`, { cause: error });
      }
      const continued = store.list().find(row => row.blockId === 'script');
      expect(continued?.recordId).toBe(held?.recordId);
      expect(continued?.execution).toMatchObject({ kind: 'action',
        actionRequestId: held?.execution?.kind === 'action' ? held.execution.actionRequestId : undefined,
        input: held?.execution?.kind === 'action' ? held.execution.input : undefined,
        awaitedOperations: [{ operationId: 'finite' }] });
      processes[2]!.exit(0);
      await expect.poll(() => processes.length).toBe(4);
      processes[3]!.exit(0);
      expect(await resumed).toMatchObject({ state: 'succeeded' });
      expect(operations.store.list(scope).items).toHaveLength(2);
      expect(workerAdmission.dependencies()).toEqual([]);
      expect(downstream).toBe(true);
      return;
    }
    await expect.poll(() => processes.length || {
      invocation: store.list().find(row => row.blockId === 'script'),
      finiteResponse: lastFiniteResponse,
    }).toBe(1);
    await expect.poll(() => store.list().find(row => row.blockId === 'script')?.execution)
      .toMatchObject({ kind: 'action', awaitedOperations: [{ serverId: 'home', machineId, operationId: 'finite' }] });
    expect(downstream).toBe(false);
    expect(operations.store.list({ accountId: 'account', machineId }).items).toHaveLength(1);
    expect((await operations.activity.read()).items).toContainEqual(expect.objectContaining({ ownerRef: 'finite',
      attribution: { serverId: 'home', accountId: 'account', machineId, installationId: 'installation' },
    }));
    if (!acceptedRequest.current) throw new Error('Missing accepted RPC request');
    expect(await call(acceptedRequest.current.method, acceptedRequest.current.input, acceptedRequest.current.requestId))
      .toMatchObject({ operation: { operationId: 'finite', state: 'accepted' } });
    expect(rpc.getActiveHandlerExecutions()).not.toContainEqual(expect.objectContaining({ method: acceptedRequest.current.method }));
    // The real receiving RPC deadline ends only this observation. The accepted
    // command has already survived the invocation handler's complete cleanup.
    expect(await call(ACTION_OPERATION_RPC_METHODS_V2.get, { operationId: 'finite', waitForTerminal: true }, undefined, 1))
      .toMatchObject({ error: expect.any(String) });
    expect(operations.store.get({ accountId: 'account', machineId }, 'finite')).toMatchObject({ state: 'running' });
    expect(stopRequests).toBe(0);
    expect(processes).toHaveLength(1);
    expect(operations.store.list({ accountId: 'account', machineId }).items).toHaveLength(1);
    const waiting = executor.execute('wait', { target: { kind: 'action_operation', serverId: 'home', machineId,
      operationId: 'finite' }, condition: { kind: 'terminal' } }, context);
    processes[0]!.exit(failedPhase === 'setup' ? 7 : 0);
    if (failedPhase === 'script') {
      await expect.poll(() => processes.length).toBe(2);
      const scriptOperation = operations.store.get({ accountId: 'account', machineId }, 'finite');
      expect(scriptOperation?.domainRef).toMatchObject({ cwd: join(root, 'command-subdirectory'), terminalId: expect.any(String) });
      if (scriptOperation?.domainRef?.kind !== 'projectCommand' || !scriptOperation.domainRef.terminalId) throw new Error('Actual finite terminal missing');
      expect(terminals.getCustody(scriptOperation.domainRef.terminalId)).toMatchObject({ rootPath: root,
        requesterAccountId: 'account', installationId: 'installation' });
      expect(downstream).toBe(false);
      processes[1]!.exit(7);
    }
    const errorCode = failedPhase === 'setup' ? 'project_setup_step_failed' : 'project_command_step_failed';
    expect(await executing).toMatchObject({ state: 'failed', reason: errorCode });
    expect(await waiting).toMatchObject({ ok: true, result: { disposition: 'matched', snapshot: { state: 'failed',
      error: { errorCode }, domainRef: { kind: 'projectCommand', purpose: failedPhase, terminalId: expect.any(String) } } } });
    expect(downstream).toBe(false);
    expect(processes).toHaveLength(failedPhase === 'setup' ? 1 : 2);
  });
});
