import axios from 'axios';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { chmod, copyFile, mkdir, readFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it, onTestFailed, onTestFinished, vi } from 'vitest';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { ExecutionRunStartResponseSchema } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import type { RpcHandler } from '@/api/rpc/types';
import { createInstalledProjectAgentLaunchFixture } from '@/daemon/testkit/installedProjectAgentLaunchFixture';
import { prepareProjectAgentLaunch } from '@/workspaces/projectSetup/projectAgentLaunch';
import { projectRuntimeAccountRowsInput } from '@/workspaces/projectAccountRows';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import type { ActionOperationDomainOwner } from '@/daemon/actionOperations/actionOperationTypes';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { writeCredentialsTokenOnly, writeDaemonState } from '@/persistence';
import { PROCESS_OWNER_ENV_KEY, parseProcessOwnerTag } from '@/processes/ownerTag';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import type { PtyExitEvent, PtyProcess, PtySpawnParams } from '@/terminal/pty/provider';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { registerMachineRpcHandlers } from './rpcHandlers';
import { readRetainedExecutionRunRecord } from '@/daemon/executionRunRegistry';
import { admitRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { projectExternalActionRequesterHttpAuthorization } from '@/api/externalActionExecutionAuthorization';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { SocketRpcMachineAdmissionContextV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
import { decodeBase64 } from '@/api/encryption';
import type { AccountSettingsSnapshotResolver } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { PromptLibraryCatalogKeyV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { emptyPromptLibraryRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';

const ptyBoundary = vi.hoisted(() => ({ spawns: [] as Array<{ launch: PtySpawnParams; finish(): void }> }));
const requesterAccountToken = `e30.${Buffer.from(JSON.stringify({ sub: 'requester',
  provenance: { v: 1, kind: 'terminal', authority: 'account_automation' },
})).toString('base64url')}.signature`;
// Native PTY creation is the setup-process boundary. The finite terminal,
// reservation, review producer and Run controller remain their real owners.
vi.mock('@/terminal/pty/provider', async importOriginal => ({
  ...await importOriginal<typeof import('@/terminal/pty/provider')>(),
  createNodePtyProvider: () => ({ spawn(launch: PtySpawnParams) {
    const exits = new Set<(event: PtyExitEvent) => void>();
    const pty: PtyProcess = { pid: 2_147_483_647, ownedProcessGroupId: 2_147_483_647,
      write() {}, resize() {}, kill() {}, onData: () => ({ dispose() {} }),
      onExit(listener) { exits.add(listener); return { dispose: () => { exits.delete(listener); } }; } };
    ptyBoundary.spawns.push({ launch, finish() { for (const listener of exits) listener({ exitCode: 0, signal: 0 }); } });
    return pty;
  } }),
}));

describe('detached execution-run Machine composition', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); ptyBoundary.spawns.length = 0; });

  it('refuses detached reads without requester custody on the installed Machine transport', async () => {
    const rpc = new RpcHandlerManager({ scopePrefix: 'machine-detached', encryptionMode: 'plain' });
    const registration = registerMachineRpcHandlers({
      rpcHandlerManager: rpc,
      handlers: {
        spawnSession: async () => ({ type: 'success', sessionId: 'unused' }),
        stopSession: async () => true,
        requestShutdown: () => {},
      },
      deps: { currentMachineId: 'machine-detached' },
    });
    // HTTP is a genuine system boundary. Installed transport alone supplies
    // no requester Account proof for detached Run reads.
    vi.spyOn(axios, 'get').mockRejectedValue(new Error('network unavailable'));
    const deps = createCliActionDeps({
      sessionId: 'cli-global', token: 'token', mode: 'plain', ctx: null,
      credentials: { token: 'token', encryption: null },
      machineActionDirectTargetTransport: {
        machineId: 'machine-detached',
        invoke: (method, request, options) => rpc.invokeLocal(method, request, options),
      },
    });
    try {
      const options = { exactMachineId: 'machine-detached' };
      const listed = await deps.executionRunList(null, { limit: 3 }, options);
      expect(listed).toMatchObject({ ok: false, errorCode: 'execution_run_not_found' });
      await expect(deps.executionRunGet(null, { runId: 'missing-run' }, options))
        .resolves.toMatchObject({ ok: false, errorCode: 'execution_run_not_found' });
    } finally {
      await registration.dispose();
    }
  });

  it('retains the preparation decision owner in the installed Machine Project runtime', async () => {
    const h = await createInstalledProjectAgentLaunchFixture();
    // The real external-operation projection reads the installed Account's
    // credential partition even when this Project operation does not exist.
    await writeCredentialsTokenOnly({ token: requesterAccountToken });
    const runtime = await h.machine.resolveProjectFiniteRuntime({ signal: h.signal, requesterSessionBootstrap: h.f.bootstrap });
    if (!runtime) throw new Error('Missing installed requester Project runtime');
    await expect(runtime.operationRuntime.decideSetupReview(
      { accountId: 'requester', machineId: 'machine' }, randomUUID(),
      { serverId: 'session-home', machineId: 'machine', workspaceId: 'workspace', rootPath: h.cwd }, 'setup',
      { reviewedEffectDigest: 'missing-effect', skipForInvocation: false },
    )).resolves.toBeNull();
  });

  it.each([false, true])('detaches the original Run operation owner when Machine registration is disposed (transport cleanup fails: %s)', async cleanupFails => {
    const actionOperations = createHostActionOperationRuntime({ machineId: 'machine', resolveAccountId: async () => 'requester' });
    let runOwner: ActionOperationDomainOwner | undefined;
    const registration = registerMachineRpcHandlers({
      rpcHandlerManager: new RpcHandlerManager({ scopePrefix: 'machine', encryptionMode: 'plain' }),
      handlers: { spawnSession: async () => ({ type: 'success', sessionId: 'unused' }), stopSession: async () => true, requestShutdown() {},
        ...(cleanupFails ? { transferRelayV2Channel: { machineId: 'machine',
          // A transport's unsubscribe is a genuine external-system boundary.
          onEnvelope: () => () => { throw new Error('fixture_transport_cleanup_failed'); }, sendEnvelope() {},
        } } : {}),
      },
      deps: { currentMachineId: 'machine', actionOperations: { ...actionOperations,
        attachOwner(owner) {
          // Observe the actual constructor attachment while preserving the
          // canonical owner's attachment and subscription lifecycle.
          if (owner.actionIds.includes('execution.run.start')) runOwner = owner;
          return actionOperations.attachOwner(owner);
        },
      } },
    });
    onTestFinished(() => registration.dispose());
    const attachedRunOwner = runOwner;
    if (!attachedRunOwner) throw new Error('The Machine constructor did not attach its Run operation owner');
    expect(() => actionOperations.attachOwner(attachedRunOwner)).toThrow('action_operation_domain_owner_already_attached');
    if (cleanupFails) await expect(registration.dispose()).rejects.toThrow('fixture_transport_cleanup_failed');
    else await registration.dispose();
    const detach = actionOperations.attachOwner(attachedRunOwner);
    detach();
  });

  it.each([
    { requesterKind: 'session', rootActionId: 'execution.run.start' },
    { requesterKind: 'account', rootActionId: 'execution.run.start' },
    { requesterKind: 'account', rootActionId: 'execution.run.start', roleId: 'scout' },
    { requesterKind: 'account', rootActionId: 'scm.diffSummary.generate' },
    { requesterKind: 'account', rootActionId: 'execution.run.start', selectedMcp: 'owner' },
    { requesterKind: 'account', rootActionId: 'execution.run.start', selectedMcp: 'member' },
    { requesterKind: 'account', rootActionId: 'execution.run.start', selectedMcp: 'foreign-requester' },
  ] as const)('carries the captured $requesterKind requester under $rootActionId through real Action dispatch and Machine registration ($selectedMcp, Role $roleId)', async row => {
    const { requesterKind, rootActionId } = row;
    const selectedMcp = 'selectedMcp' in row ? row.selectedMcp : undefined;
    const roleId = 'roleId' in row ? row.roleId : undefined;
    const custodianAccountId = selectedMcp === 'member' ? 'other-custodian' : 'requester';
    const actorAccountId = selectedMcp === 'foreign-requester' ? 'member' : 'requester';
    const memberCredentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'member',
      provenance: { v: 1, kind: 'terminal', authority: 'account_automation' },
    })).toString('base64url')}.signature`, encryption: null };
    let phase = 'Project fixture admission';
    let readFailedRun: (() => Promise<unknown>) | undefined;
    onTestFailed(async () => {
      console.error(`Machine composition failed during: ${phase}`, readFailedRun ? await readFailedRun() : undefined);
    });
    const h = await createInstalledProjectAgentLaunchFixture({ accountActionCredentials: { token: requesterAccountToken, encryption: null },
      ...(selectedMcp ? { homeServerIdentityId: 'srv_session_home', agentIsolationEnabled: false,
        ...(selectedMcp === 'foreign-requester' ? { additionalAccountCredentials: [memberCredentials] } : {}),
        machineAccess: { custodianAccountId, role: 'manage' }, mcpCatalog: { v: 1, servers: [{ id: 'selected', name: 'selected', title: 'Selected fixture',
          transport: 'stdio', stdio: { command: process.execPath, args: ['-e', 'process.stdin.resume()'] },
          env: {}, createdAt: 1, updatedAt: 1 }], bindings: [{ id: 'selected-all', serverId: 'selected', enabled: true,
          target: { t: 'allMachines' }, createdAt: 1, updatedAt: 1 }] } } : {}),
    });
    const { f, cwd, finite } = h;
    if (roleId) {
      // The Home rows are the storage boundary. Seed the current empty library
      // so Role admission does not require unrelated legacy history migration.
      for (const key of PromptLibraryCatalogKeyV1Schema.options) f.mutatePromptLibraryRow(key, {
        expectedRevision: 'absent', sourceSettingsVersion: 0, content: { t: 'plain', v: emptyPromptLibraryRecordV1(key) },
      });
    }
    const callerCredentials = selectedMcp === 'foreign-requester' ? memberCredentials : f.bootstrap.credentials;
    expect(f.bootstrap.savedSecretOperationContext.readSnapshot()?.scopeKey, 'The admitted requester must belong to the current fixture Home')
      .toBe(resolveAccountSettingsScopeKey(f.bootstrap.credentials));
    const bin = join(f.directory, 'bin');
    await mkdir(bin);
    const toolName = process.platform === 'win32' ? 'fixture-project-agent.exe' : 'fixture-project-agent';
    await copyFile(process.execPath, join(bin, toolName));
    if (process.platform !== 'win32') await chmod(join(bin, toolName), 0o755);
    const env = createEnvKeyScope(['PATH']);
    env.patch({ PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` });
    onTestFinished(() => env.restore());
    const receipt = join(f.directory, 'native-child.json');
    const child = `require('node:fs').writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({
      executable: process.execPath, cwd: process.cwd(), native: process.env.NATIVE, original: process.env.ORIGINAL,
      owner: process.env[${JSON.stringify(PROCESS_OWNER_ENV_KEY)}], args: process.argv.slice(1) }));`;
    const pluginId = 'acme.detached-project';
    const backendTarget = roleId ? { kind: 'agent' as const, identity: { pluginId, localId: 'agent' } }
      : { kind: 'backend' as const, backendId: `${pluginId}/agent` };
    const plugin = await createAuthoredAdmittedPluginRuntimeFixture({ happyHomeDir: f.directory, controller: pluginReloadController,
      plugins: [{ manifest: createPluginManifestV2Fixture({ id: pluginId,
        hostAccess: { required: [{ id: 'process', capability: 'process', reason: 'Launch the fixture Agent',
          scope: { executables: [{ kind: 'systemTool', id: 'fixture-cli' }], envKeys: ['ORIGINAL'] } },
        { id: 'workspace', capability: 'filesystem', reason: 'Use the admitted Project working directory',
          scope: { locations: [{ root: 'workspace' }], access: ['read'] } }], optional: [] },
        contributes: { agents: [{ id: 'agent', title: 'Detached Project Agent', runtime: { kind: 'custom' }, primary: 'sessions',
          capabilities: { ...(selectedMcp ? { tools: { delivery: 'native_mcp', mcpToolControl: { off: 'blocked', approval: 'host' } } } : {}), sessions: { open: ['create', 'resume'], delivery: ['newTurn'], cancel: true,
            executionRunContext: { versions: [1] } } } }],
        systemTools: [{ id: 'fixture-cli', title: 'Fixture Agent', executableNames: [toolName] }] } }),
        files: { 'daemon.mjs': `import { factory } from './agent.mjs';
          export function activate(api) { api.agents.register('agent', factory, {
            sessionRunnerFactory: { module: './agent.mjs', export: 'factory', runtimeApiVersion: 1 } }); }`,
          'agent.mjs': `import { createExecutionRunHostBackendFromConversationRuntime } from '@happier-dev/plugin-sdk/agents/runtime';
          async function openConversation(request, context) {
            if (request.kind === 'fork') throw new Error('Fixture supports create and resume');
            if (${Boolean(selectedMcp)}) {
              const servers = await context.executionRun.services.mcp.resolveServers();
              if (!request.mcpServers?.selected || !servers.some(server => server.id === 'selected' && server.transport.kind === 'stdio')) {
                throw new Error('Selected MCP material did not reach the native Agent');
              }
              if (request.mcpToolPolicy?.selected?.unlisted !== 'deny') {
                throw new Error('Retained Agent host control did not enforce read-only MCP policy');
              }
            }
            const result = await context.services.exec.run({ executable: { kind: 'systemTool', id: 'fixture-cli' },
              args: ['-e', ${JSON.stringify(child)}, '--', '--cold-run', request.kind], cwd: { root: 'workspace', relativePath: '' },
              env: { ORIGINAL: 'host' } }, { nativeLaunch: context.executionRun.services.nativeLaunch });
            if (result.termination.observed.kind !== 'exit' || result.termination.observed.exitCode !== 0) {
              throw new Error('Fixture Agent child failed');
            }
            let listener;
            return { watch(next) { listener = next; next({ kind: 'provider-session-id', providerSessionId: 'native-project-thread' });
                return { dispose() { listener = undefined; } }; },
              async send(input) {
                const turnId = input.delivery.turnId;
                listener?.({ kind: 'input-accepted', inputIds: input.inputIds, delivery: input.delivery });
                listener?.({ kind: 'turn-start', turnId, startedBy: 'host' });
                listener?.({ kind: 'message-delta', turnId, channel: 'assistant', text: 'Native Project Run completed.' });
                listener?.({ kind: 'turn-complete', turnId });
                return { status: 'admitted' };
              },
              async cancel() { return { status: 'notRunning' }; }, async dispose() { listener = undefined; },
            };
          }
          export function factory() { return { sessions: {
            async open() { throw new Error('A detached Run cannot open a Happier Session'); },
            executionRunContextV1: { openConversation, async open(request, context) {
              if (request.kind === 'fork') throw new Error('Fixture supports create and resume');
              return await createExecutionRunHostBackendFromConversationRuntime({ request,
                readCheckpointId: event => event.kind === 'provider-session-id' ? event.providerSessionId : null,
                openConversation: () => openConversation(request, context) });
            } },
          } }; }` } }] });
    onTestFinished(() => plugin.dispose());
    // The loopback daemon admission endpoint is the network boundary. Its real
    // client and response parser consume the isolated Home's fixture state.
    const daemonHttp = createServer((request, response) => {
      if (request.url !== '/execution-run/admission') { response.writeHead(404).end(); return; }
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ admitted: true }));
    });
    await new Promise<void>(resolve => daemonHttp.listen(0, '127.0.0.1', resolve));
    onTestFinished(() => new Promise<void>((resolve, reject) => daemonHttp.close(error => error ? reject(error) : resolve())));
    const daemonAddress = daemonHttp.address();
    if (!daemonAddress || typeof daemonAddress === 'string') throw new Error('Missing fixture daemon endpoint');
    writeDaemonState({ pid: process.pid, httpPort: daemonAddress.port, startedAt: Date.now(), startedWithCliVersion: 'fixture', controlToken: 'fixture-control-token' });
    const incoming = new Map<string, RpcHandler>();
    // Observe the callbacks installed for the authenticated Home transport;
    // registration, Action dispatch and the complete Run controller remain real.
    class HomeRpc extends RpcHandlerManager {
      override registerHandler<TRequest, TResponse>(method: string, handler: RpcHandler<TRequest, TResponse>) {
        super.registerHandler(method, handler);
        incoming.set(method, handler);
      }
    }
    const rpc = new HomeRpc({ scopePrefix: 'machine', encryptionMode: 'plain' });
    const readSnapshot = () => {
      const snapshot = f.bootstrap.savedSecretOperationContext.readSnapshot();
      if (!snapshot) throw new Error('Requester Account lifetime retired');
      return snapshot;
    };
    // Observe the resolver built by the actual ApiMachine constructor, rather
    // than authoring an Agent-context callback in this receiving transport fixture.
    const installedSnapshot = Reflect.get(h.machine, 'executionRunAccountSnapshots') as AccountSettingsSnapshotResolver | undefined;
    const readRunSnapshot = selectedMcp ? installedSnapshot : readSnapshot;
    if (typeof readRunSnapshot !== 'function') throw new Error('Missing installed Machine Account snapshot owner');
    const actionOperations = createHostActionOperationRuntime({ machineId: 'machine', resolveAccountId: async () => 'requester',
      custodyBinding: { serverId: 'session-home', installationId: f.installation.installationId } });
    const actionsSettingsProvider = createActionSettingsProvider({ getAccountSettings: () => readSnapshot().settings,
      scopeKey: readSnapshot().scopeKey, allowEnvironmentOverride: false });
    const registration = registerMachineRpcHandlers({ rpcHandlerManager: rpc,
      handlers: { spawnSession: async () => { throw new Error('No replacement Session expected'); },
        stopSession: async () => true, requestShutdown() {} },
      deps: { currentMachineId: 'machine', currentServerId: 'session-home', workingDirectory: cwd,
        executionRunRuntimeAccountId: 'requester', createProjectFiniteRuntime: finite, actionOperations, actionsSettingsProvider,
        executionRunAccountSettings: { serverUrl: 'https://session-home.test', resolveAccountSettings: () => readSnapshot().settings,
          resolveAccountSettingsSnapshot: readRunSnapshot,
          actionsSettingsProvider } } });
    onTestFinished(() => registration.dispose());
    // An installed CLI's Account token is not an authenticated requester
    // carrier at the receiving Machine. Ordinary direct transport must refuse
    // before creating a Run; it cannot borrow this daemon's Account custody.
    const unscopedCli = createCliActionDeps({ sessionId: 'cli-global', token: f.bootstrap.credentials.token,
      mode: 'plain', ctx: null, credentials: f.bootstrap.credentials, serverId: 'session-home',
      serverHttpBaseUrl: 'https://session-home.test', machineActionDirectTargetTransport: {
        machineId: 'machine', invoke: (method, request, options) => rpc.invokeLocal(method, request, options),
      } });
    expect(await unscopedCli.executionRunStart(null, { intent: 'agent', ...(roleId ? { roleId } : {}),
      backendTarget, instructions: 'Run the native Project Agent.',
      cwd, permissionMode: 'read_only', retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response',
    }, { exactMachineId: 'machine' })).toMatchObject({ ok: false,
      errorCode: 'project_requester_credentials_unavailable', details: { executionRunStart: { runCreation: 'noRunCreated' } } });
    expect(await unscopedCli.executionRunList(null, {}, { exactMachineId: 'machine' }))
      .toMatchObject({ ok: false, errorCode: 'execution_run_not_found' });
    expect(h.nativeEffects()).toBe(0);
    let currentIngress = new AbortController();
    const accountRequester = requesterKind === 'account' ? await admitRequesterAccountActionContext({
      authorization: ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'native-run-root', binding: {
        accountId: actorAccountId, custodianAccountId, authentication: { kind: 'account', tokenEpoch: 1 },
        accountEncryptionMode: 'plain', serverIdentityId: 'srv_session_home', machineId: 'machine', installationId: f.installation.installationId,
        actionId: rootActionId, requestId: randomUUID(), requestEnvelopeDigest: 'a'.repeat(43), target: { kind: 'machine', machineId: 'machine' },
      } }), credentials: callerCredentials,
      serverId: 'session-home', serverIdentityId: 'srv_session_home',
      serverHttpBaseUrl: 'https://session-home.test', isCurrent: async () => f.isHomeCurrent(), isCustodyCurrent: async () => f.isHomeCurrent(),
    }) : null;
    if (requesterKind === 'account' && !accountRequester) throw new Error('Account requester admission failed');
    if (accountRequester) onTestFinished(() => accountRequester.dispose());
    const accountAuthorization = accountRequester ? await projectExternalActionRequesterHttpAuthorization({
      authorization: accountRequester.authorization, serverId: 'session-home', serverIdentityId: 'srv_session_home',
      serverHttpBaseUrl: 'https://session-home.test', target: { kind: 'machine', machineId: 'machine' },
      installationId: f.installation.installationId, privateKey: decodeBase64(f.installation.privateKey, 'base64url'),
      isCurrent: accountRequester.isCustodyCurrent,
    }) : null;
    if (accountRequester && !accountAuthorization) throw new Error('Account requester HTTP projection failed');
    const machineAdmission = SocketRpcMachineAdmissionContextV1Schema.parse({ actorAccountId: actorAccountId, custodianAccountId,
      machineId: 'machine', installationId: f.installation.installationId, role: 'manage', encryptionMode: 'plain' });
    const deps = createCliActionDeps({ sessionId: 'cli-global', token: callerCredentials.token, mode: 'plain', ctx: null,
      credentials: callerCredentials, serverId: 'session-home', serverHttpBaseUrl: 'https://session-home.test',
      externalActionMachineInstallationId: f.installation.installationId,
      externalActionMachineRequestPrivateKey: decodeBase64(f.installation.privateKey, 'base64url'),
      ...(requesterKind === 'session' ? { requesterSessionBootstrap: f.bootstrap } : {}),
      machineActionDirectTargetTransport: { machineId: 'machine', async invoke(method, request, options) {
        return await rpc.invokeLocal(method, request, { ...options, signal: options?.signal ?? currentIngress.signal,
          // The receiving Home transport stamps every call, including reads,
          // with its admitted caller; installed runtime identity is insufficient.
          rpcContext: { ...options?.rpcContext, machineAdmission, verifyMachineAdmissionCurrent: f.bootstrap.isCurrent,
            ...(accountAuthorization && method === SESSION_RPC_METHODS.EXECUTION_RUN_START
              ? { callerInputAuthorization: accountAuthorization, verifyMachineAdmissionCurrent: accountRequester!.isCurrent }
              : {}) } });
      } } });
    const options = { exactMachineId: 'machine', surface: 'cli' as const, authority: 'present_user' as const };
    phase = 'initial native Run admission';
    const action = await createActionExecutor(deps).execute('execution.run.start', { sessionId: null,
      intent: 'agent', ...(roleId ? { roleId } : {}), backendTarget,
      instructions: 'Run the native Project Agent.', permissionMode: 'read_only', retentionPolicy: requesterKind === 'account' && !selectedMcp && !roleId ? 'resumable' : 'ephemeral',
      cwd, runClass: requesterKind === 'account' && !selectedMcp && !roleId ? 'long_lived' : 'bounded', ioMode: 'request_response',
      ...(selectedMcp ? { capabilitySelection: { mcp: { managedServersEnabled: true } } } : {}),
      ...(requesterKind === 'account' ? { connectedServices: { v: 2, bindingsByServiceId: {} } } : {}),
    }, { surface: 'cli', authority: 'present_user',
      executionRunTargetMachineId: 'machine', serverId: 'session-home', runtimeAccountId: actorAccountId, actionRequestId: randomUUID(),
      ...(accountRequester ? { externalActionExecutionAuthorization: accountRequester.authorization,
        externalActionTarget: { kind: 'machine' as const, machineId: 'machine' } } : {}) });
    if (selectedMcp === 'member' || selectedMcp === 'foreign-requester') {
      // The registered Action owner refuses this authority before creating a
      // Run. Do not bypass that owner merely to exercise a deeper MCP callee.
      expect(action).toMatchObject({ ok: false, errorCode: 'target_unavailable',
        details: { executionRunStart: { runCreation: 'outcomeUnknown' } } });
      expect(await deps.executionRunList(null, {}, options)).toMatchObject({ runs: [] });
      expect(h.nativeEffects()).toBe(0);
      return;
    }
    expect(action, JSON.stringify(action)).toMatchObject({ ok: true });
    if (!action.ok) throw new Error(`Action start refused: ${action.errorCode}`);
    const started = action.result;
    expect(started, JSON.stringify(started)).toMatchObject({ runId: expect.any(String) });
    const runId = ExecutionRunStartResponseSchema.parse(started).runId;
    if (roleId) {
      phase = 'admitted Role Run projection';
      expect(await deps.executionRunGet(null, { runId }, options)).toMatchObject({ run: {
        runId, intent: 'task', permissionMode: 'read-only', retentionPolicy: 'ephemeral', runClass: 'bounded',
      } });
      // The real persisted Run records the canonical admission output even if
      // this fixture's custom Agent cannot complete its later native launch.
      await vi.waitFor(async () => {
        expect(await readRetainedExecutionRunRecord(runId)).toMatchObject({ state: {
          runId, sessionId: null, roleId: 'scout', intent: 'task', depth: 0,
          permissionMode: 'read-only', workspaceWrites: 'deny',
        } });
      });
      return;
    }
    if (selectedMcp) {
      phase = 'bounded Machine selected-MCP settlement';
      const settled = await deps.executionRunWait(null, { runId, timeoutSeconds: 30 }, options);
      expect(settled).toMatchObject({ ok: true, status: 'succeeded', result: { run: { status: 'succeeded' } } });
      expect(h.nativeEffects()).toBe(1);
      return;
    }
    // The original Account Action returns before the native Run opens. Its
    // private requester must survive through the Run's own runtime lifetime.
    await accountRequester?.dispose();
    let latestRunSnapshot: unknown;
    let latestNativeChild: unknown;
    readFailedRun = async () => ({
      run: latestRunSnapshot,
      nativeEffects: h.nativeEffects(),
      nativeChild: latestNativeChild,
    });
    phase = 'initial native Project launch';
    await vi.waitFor(async () => {
      latestRunSnapshot = await deps.executionRunGet(null, { runId }, options);
      expect(h.nativeEffects(), JSON.stringify(latestRunSnapshot)).toBe(1);
    }, { timeout: 30_000 });
    phase = 'initial native child execution';
    const observedChild = await vi.waitFor(async () => {
      latestRunSnapshot = await deps.executionRunGet(null, { runId }, options);
      latestNativeChild = JSON.parse(await readFile(receipt, 'utf8'));
      return latestNativeChild;
    }, { timeout: 30_000 });
    expect(observedChild).toEqual({ executable: join(bin, toolName), cwd, native: 'active', args: ['--cold-run', 'create'], owner: expect.any(String) });
    if (!observedChild || typeof observedChild !== 'object' || !('owner' in observedChild)) throw new Error('Missing native process owner');
    expect(parseProcessOwnerTag(String(observedChild.owner))?.owner).toEqual({ kind: 'run', runId });
    if (accountRequester) {
      await vi.waitFor(async () => {
        expect(await deps.executionRunGet(null, { runId }, options)).toMatchObject({ run: { runId, status: 'running', turnInFlight: false } });
      }, { timeout: 30_000 });
      expect(await accountRequester.isCurrent()).toBe(true);
      expect(h.accountReads()).not.toContain('Bearer custodian-token');
      expect(await deps.executionRunStop(null, { runId }, options)).toMatchObject({ ok: true });
      await deps.executionRunWait(null, { runId }, options);
      await vi.waitFor(async () => { expect(await accountRequester.isCurrent()).toBe(false); });
      phase = 'retired requester refuses replacement native launch';
      expect(await deps.executionRunStart(null, { intent: 'agent',
        backendTarget: { kind: 'backend', backendId: `${pluginId}/agent` },
        instructions: 'Must not launch with released requester custody.', cwd,
        permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'request_response',
      }, options)).toMatchObject({ ok: false, errorCode: 'target_unavailable' });
      expect(h.nativeEffects()).toBe(1);
      return;
    }
    phase = 'initial native Run settlement';
    const waited = await deps.executionRunWait(null, { runId, timeoutSeconds: 30 }, options);
    expect(waited).not.toHaveProperty('disposition');
    expect(waited, JSON.stringify(waited)).toMatchObject({ ok: true, status: 'succeeded', result: { run: { status: 'succeeded' } } });
    expect(h.nativeEffects()).toBe(1);
    expect(h.accountReads()).not.toContain('Bearer custodian-token');

    phase = 'resumable native Run admission';
    const retainedStart = await deps.executionRunStart(null, { intent: 'agent', backendTarget: { kind: 'backend', backendId: `${pluginId}/agent` },
      instructions: 'Prepare the retained native Run.', permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'request_response' }, options);
    expect(retainedStart, JSON.stringify(retainedStart)).toMatchObject({ runId: expect.any(String) });
    const retainedRunId = ExecutionRunStartResponseSchema.parse(retainedStart).runId;
    phase = 'retained native Run checkpoint and idle';
    await vi.waitFor(async () => {
      expect(await deps.executionRunGet(null, { runId: retainedRunId }, options)).toMatchObject({
        run: { runId: retainedRunId, turnInFlight: false, resumeHandle: { kind: 'provider_session.v1', providerSessionId: 'native-project-thread' } },
      });
    }, { timeout: 30_000 });
    for (const method of ['ensure', 'send'] as const) {
      phase = `native Run stop before cold ${method}`;
      expect(await deps.executionRunStop(null, { runId: retainedRunId }, options)).toMatchObject({ ok: true });
      await deps.executionRunWait(null, { runId: retainedRunId }, options);
      currentIngress.abort();
      currentIngress = new AbortController();
      const beforeResume = h.nativeEffects();
      phase = `actual Machine cold ${method}`;
      const resumed = method === 'ensure'
        ? await deps.executionRunEnsure(null, { runId: retainedRunId, resume: true }, options)
        : await deps.detachedExecutionRunSend(null, { runId: retainedRunId, resume: true, message: 'Continue the original native Run.' }, options);
      expect(resumed, JSON.stringify(resumed)).toMatchObject({ ok: true });
      expect(h.nativeEffects()).toBe(beforeResume + 1);
      const resumedChild = JSON.parse(await readFile(receipt, 'utf8'));
      expect(resumedChild.args).toEqual(['--cold-run', 'resume']);
      expect(parseProcessOwnerTag(resumedChild.owner)?.owner).toEqual({ kind: 'run', runId: retainedRunId });
    }
    await deps.executionRunStop(null, { runId: retainedRunId }, options);
    const nativeBeforeSetup = h.nativeEffects();

    await h.requireSetup();
    const projectRuntime = await h.machine.resolveProjectFiniteRuntime({ signal: h.signal, requesterSessionBootstrap: f.bootstrap });
    if (!projectRuntime) throw new Error('Missing original Project runtime');
    expect(await prepareProjectAgentLaunch({ cwd, machineId: 'machine', serverId: 'session-home', serverHttpBaseUrl: 'https://session-home.test',
      account: projectRuntimeAccountRowsInput(projectRuntime), nativeIo: projectRuntime.nativeIo, successHomeDir: projectRuntime.successHomeDir,
      platform: { os: 'linux', arch: 'x64' }, signal: h.signal })).toMatchObject({ kind: 'prepared', outcome: { kind: 'pendingApproval' } });
    phase = 'original setup-held Run admission';
    const heldStart = await deps.executionRunStart(null, { intent: 'agent', backendTarget: { kind: 'backend', backendId: `${pluginId}/agent` },
      instructions: 'Continue this same Run after setup.', permissionMode: 'read_only', retentionPolicy: 'ephemeral',
      runClass: 'bounded', ioMode: 'request_response' }, options);
    const heldRunId = ExecutionRunStartResponseSchema.parse(heldStart).runId;
    let heldSnapshot: unknown;
    readFailedRun = async () => ({ operation: heldSnapshot, run: await deps.executionRunGet(null, { runId: heldRunId }, options),
      reservations: h.admission.dependencies(), nativeEffects: h.nativeEffects() });
    const ingress = { signal: h.signal, requesterSessionBootstrap: f.bootstrap };
    phase = 'original setup review projection';
    const held = await vi.waitFor(async () => {
      const observed = await actionOperations.handlers.getV2({ operationId: heldRunId, refreshSetupReview: true }, ingress);
      heldSnapshot = observed;
      expect(observed).toMatchObject({ kind: 'found', operation: { operationId: heldRunId,
        actionId: 'execution.run.start', state: 'running', setupReview: { code: 'project_setup_consent_required' } } });
      return observed;
    }, { timeout: 30_000 });
    if (held.kind !== 'found' || !held.operation.setupReview) throw new Error('Missing original Run setup review');
    expect(ptyBoundary.spawns).toHaveLength(0);
    expect(h.nativeEffects()).toBe(nativeBeforeSetup);
    const prepare = incoming.get(RPC_METHODS.DAEMON_PROJECTS_PREPARE);
    if (!prepare) throw new Error('Missing production preparation decision registration');
    phase = 'retained setup decision and native setup spawn';
    const decision = prepare({ workspace: { serverId: 'session-home', machineId: 'machine', workspaceId: 'workspace', rootPath: cwd },
      phase: 'setup', heldOperationId: heldRunId, expectedEffectDigest: held.operation.setupReview.reviewedEffectDigest, consentScope: 'thisTime' },
    // The approving Account is separately admitted; Session-write credentials
    // may observe the Run but cannot supply a human setup decision.
    { signal: h.signal, callerAuthority: 'present_user', localActionContext: { surface: 'rpc', authority: 'present_user', actionRequestId: randomUUID() },
      machineAdmission: { actorAccountId: 'requester', custodianAccountId: 'requester', machineId: 'machine',
        installationId: f.installation.installationId, role: 'use', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: f.bootstrap.isCurrent });
    let decisionResult: unknown;
    void decision.then(result => { decisionResult = result; });
    await vi.waitFor(() => expect(ptyBoundary.spawns, JSON.stringify(decisionResult)).toHaveLength(1), { timeout: 30_000 });
    expect(ptyBoundary.spawns[0]!.launch.options).toMatchObject({ cwd, env: { NATIVE: 'active' } });
    ptyBoundary.spawns[0]!.finish();
    phase = 'retained setup decision completion';
    expect(await decision).toMatchObject({ operation: { operationId: heldRunId } });
    phase = 'continued native Run settlement';
    const continued = await deps.executionRunWait(null, { runId: heldRunId }, options);
    expect(continued, JSON.stringify(continued)).toMatchObject({ ok: true, status: 'succeeded', result: { run: { runId: heldRunId, status: 'succeeded' } } });
    const continuedChild = JSON.parse(await readFile(receipt, 'utf8'));
    expect(parseProcessOwnerTag(continuedChild.owner)?.owner).toEqual({ kind: 'run', runId: heldRunId });
    expect(ptyBoundary.spawns).toHaveLength(1);
    expect(h.trustWrites()).toBe(1);
    const operations = await actionOperations.handlers.listV2({}, ingress);
    expect(operations.items.filter(operation => operation.actionId === 'projects.prepare')).toHaveLength(0);
    expect(operations.items.map(operation => operation.operationId)).toContain(heldRunId);
    phase = 'Machine registration disposal';
    await registration.dispose();
    const disposedOperations = await actionOperations.handlers.listV2({}, ingress);
    expect(disposedOperations.items.filter(operation => operation.actionId === 'execution.run.start')).toEqual([]);
  }, 120_000);
});
