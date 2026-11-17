import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FeaturesResponseSchema, getActionSpec, ProjectWorkerActionInputSchemasV1 } from '@happier-dev/protocol';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { createHappierMcpServer } from './createHappierMcpServer';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { createAccountServerActionDeps } from '@/api/accountServerActionDeps';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';
import { configuration } from '@/configuration';
import { readProcessIdentityByPid } from '@/daemon/processIdentity';
import { createAgentSessionRunnerFactoryBinding } from '@/plugins/runtime/runner/agentSessionRunnerFactoryBinding';
import { removeAgentRuntimeDaemonServiceAuthorityIfOwned } from '@/daemon/agentRuntime/sessionBridgeAuthorization';
import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { createSessionDaemonAuthorityFixture } from './runtime/sessionDaemonAuthority.testkit';

const { io } = vi.hoisted(() => ({ io: vi.fn() }));
// Only Socket.IO, HTTP and OS process inspection are replaced. MCP composition,
// placement, Account delegation, credential codecs and output schemas stay real.
vi.mock('socket.io-client', () => ({ io }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('MCP worker Action composition', () => {
  it.each(['account', 'session'] as const)('routes %s authority through the credentialed worker owner with identical operands and results', async authorityScope => {
    const serverId = 'home';
    const serverHttpBaseUrl = `https://${authorityScope}-worker-mcp.test`;
    const sessionId = 'worker-mcp-session';
    const credentials = { token: 'worker-mcp-fixture', encryption: null };
    const inspect = ProjectWorkerActionInputSchemasV1['projects.worker.copy.inspect'].parse(
      JSON.parse(getActionSpec('projects.worker.copy.inspect').examples!.voice!.argsExample!),
    );
    const preview = { ok: true, preview: { targetMachineId: inspect.targetMachineId,
      workspaceRefId: inspect.targetWorkspaceRefId, rootFingerprint: 'c'.repeat(64), sizeBytes: 24 } };
    const status = { workspace: inspect.workspace, destination: { kind: 'machine', machineId: 'worker' }, purpose: 'finite' };
    const statusResult = { eligible: true, candidate: { serverId, machineId: 'worker' },
      load: { kind: 'unknown' }, explanation: 'load_unknown' };
    const machineRequests: unknown[] = [];
    let machineDenied = false;
    io.mockImplementation(() => createApiSessionSocketStub({ emitWithAck(event, rawPayload) {
      expect(event).toBe(SOCKET_RPC_EVENTS.CALL);
      if (!rawPayload || typeof rawPayload !== 'object' || !('method' in rawPayload)
        || typeof rawPayload.method !== 'string') throw new Error('Missing RPC method');
      const payload = rawPayload;
      machineRequests.push(payload);
      if (machineDenied) return { ok: true, result: { ok: false, errorCode: 'permission_denied', error: 'permission_denied' } };
      if (payload.method === `worker:projects.worker.status`) return { ok: true, result: statusResult };
      if (payload.method === `${inspect.machineId}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_COMMITTED_COPY_INSPECT}`) return { ok: true, result: preview };
      expect(payload.method).toBe(`${inspect.machineId}:projects.worker.copy.retire`);
      return { ok: true, result: { status: 'retired' } };
    } }));
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      if (url === `${serverHttpBaseUrl}/v1/account/encryption`) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      const machineId = String(url).split('/').at(-1);
      expect(['worker', inspect.machineId]).toContain(machineId);
      return { status: 200, data: { machine: { id: machineId, kind: 'persistent', storageMode: 'plain',
        dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER, revokedAt: null, replacedByMachineId: null } } };
    });
    vi.spyOn(axios, 'request').mockImplementation(async config => {
      if (config.url === `${serverHttpBaseUrl}/v1/account/encryption`) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      expect(config.url).toBe(`${serverHttpBaseUrl}/v1/projects/execution/config/read`);
      expect(config.data).toEqual({ address: inspect.workspace });
      return { status: 200, data: { status: 'absent' } };
    });
    const settings = { getActionsSettings: () => normalizeActionsSettingsV1({ v: 1,
      approvalWaivedSurfaces: { 'projects.worker.copy.retire': ['agent', 'cli'] } }), getAccountSettings: () => null };
    const account = createCliActionExecutor({ token: credentials.token, credentials, sessionId, mode: 'plain', ctx: null,
      serverId, serverHttpBaseUrl, actionsSettingsProvider: settings, pluginActionExecutionOwner: 'current_process',
      accountServerActionDeps: createAccountServerActionDeps({ token: credentials.token, credentials, serverId, serverHttpBaseUrl }) });
    const accountActions: string[] = [];
    let witnessCurrent = true;
    const daemon = await createSessionDaemonAuthorityFixture({ sessionId,
      retainedAgent: createAgentSessionRunnerFactoryBinding({
        v: 1, pluginId: 'acme.plugin', pluginVersion: '1.2.3', agentId: 'acme-agent', localAgentId: 'acme-agent',
        sourceCustody: { kind: 'managed', immutableGenerationId: `sha256:${'1'.repeat(64)}`, installSource: 'localPath' },
        locator: { module: './runtime.mjs', export: 'createRuntime', runtimeApiVersion: 1 },
        normalizedModulePath: '/immutable/acme/runtime.mjs', loadMode: 'immutable-js',
      }),
      execute: async operation => {
        expect(operation.witness).toMatchObject({ turnId: 'worker-turn', inputId: 'worker-input' });
        accountActions.push(operation.actionId);
        return await account.execute(ActionIdSchema.parse(operation.actionId), operation.input,
          { surface: 'agent', authority: 'account_automation' });
      },
    });
    const runnerProcess = await readProcessIdentityByPid(process.pid);
    if (!runnerProcess) throw new Error('Missing fixture runner process identity');
    const authority = { happyHomeDir: configuration.happyHomeDir, publicReleaseRing: configuration.publicReleaseRing,
      path: daemon.trackedSession.agentRuntimeDaemonServiceAuthorityFilePath,
      capabilityDigest: daemon.trackedSession.agentRuntimeDaemonServiceCapabilityHash };
    const runtime = createHappierMcpServer({ sessionId, getServerBinding: () => ({ serverId, serverUrl: serverHttpBaseUrl }),
      rpcHandlerManager: new RpcHandlerManager({ scopePrefix: sessionId, encryptionMode: 'plain' }), updateMetadata() {},
      getMetadataSnapshot: () => createTestMetadata({ machineId: 'source', path: '/source' }),
      getWorkDepth: () => 0, getHostTurnWorkDepth: () => 0, getPermissionMode: () => 'yolo',
      getCurrentSessionLocation: () => ({ machineId: 'source', path: '/source' }),
      getActiveTurnPermissionWitness: () => ({ turnId: 'worker-turn',
        causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'yolo' } }),
      getActiveTurnAdmissionWitness: () => witnessCurrent ? ({ inputId: 'worker-input', turnId: 'worker-turn', userMessageSeq: 1, userMessageSeqs: [1],
        causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'yolo' } }) : null,
      getServerFeaturesSnapshot: () => ({ status: 'ready', provenance: 'authenticated',
        features: FeaturesResponseSchema.parse({ features: {}, capabilities: {} }) }),
    }, { authorityScope, ...(authorityScope === 'account' ? { credentials }
      : { sessionCredentials: { token: 'session-only-fixture', encryption: null } }), actionsSettingsProvider: settings });
    const invoke = (actionId: string, input: unknown) => runtime.executeTool({ toolName: 'action_execute', args: { actionId, input } });
    try {
      expect(await invoke('projects.worker.status', status)).toEqual({ ok: true, result: statusResult });
      expect(await invoke('projects.worker.copy.inspect', inspect)).toMatchObject({ ok: true, result: preview });
      expect(await invoke('projects.worker.copy.retire', { workspace: inspect.workspace, machineId: inspect.machineId,
        expectedRelationship: inspect.expectedRelationship })).toMatchObject({ ok: true, result: { status: 'retired' } });
      expect(await invoke('projects.worker.preferences.get', { workspace: inspect.workspace }))
        .toMatchObject({ ok: true, result: { status: 'ready', revision: 'absent' } });
      expect(accountActions).toEqual(['projects.worker.status', 'projects.worker.copy.inspect',
        'projects.worker.copy.retire', 'projects.worker.preferences.get']);
      expect(machineRequests).toEqual([
        expect.objectContaining({ method: 'worker:projects.worker.status', params: status }),
        expect.objectContaining({ method: `${inspect.machineId}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_COMMITTED_COPY_INSPECT}`, params: inspect }),
        expect.objectContaining({ method: `${inspect.machineId}:projects.worker.copy.retire` }),
      ]);
      const retire = { workspace: inspect.workspace, machineId: inspect.machineId, expectedRelationship: inspect.expectedRelationship };
      // Compare surfaces under the same admitted Session authority. Unbound
      // terminal enrollment is a separate Home admission, not runner custody.
      const cliContext = { surface: 'cli' as const, authority: 'account_automation' as const,
        causalPermissionAuthority: { kind: 'admittedSessionInputV1' as const, admittedPermissionCeiling: 'yolo' as const } };
      for (const [actionId, input] of [
        ['projects.worker.status', status], ['projects.worker.copy.inspect', inspect], ['projects.worker.copy.retire', retire],
      ] as const) {
        const cli = await account.execute(actionId, input, cliContext);
        expect(await invoke(actionId, input)).toEqual(cli);
      }
      machineDenied = true;
      const cliDenied = await account.execute('projects.worker.status', status, cliContext);
      expect(cliDenied).toMatchObject({ ok: false, errorCode: 'permission_denied' });
      expect(await invoke('projects.worker.status', status)).toEqual(cliDenied);
      machineDenied = false;
      {
        const before = machineRequests.length;
        witnessCurrent = false;
        expect(await invoke('projects.worker.status', status)).toMatchObject({ ok: false, errorCode: 'target_unavailable' });
        witnessCurrent = true;
        vi.mocked(readProcessIdentityByPid).mockResolvedValue({ ...runnerProcess,
          processStartTimeMs: daemon.runner.processStartTimeMs + 60_000 });
        expect(await invoke('projects.worker.status', status)).toMatchObject({ ok: false, errorCode: 'target_unavailable' });
        vi.mocked(readProcessIdentityByPid).mockResolvedValue(runnerProcess);
        await removeAgentRuntimeDaemonServiceAuthorityIfOwned(authority);
        expect(await invoke('projects.worker.status', status)).toMatchObject({ ok: false, errorCode: 'target_unavailable' });
        expect(machineRequests).toHaveLength(before);
        expect(await account.execute('projects.worker.status', status, cliContext))
          .toEqual({ ok: true, result: statusResult });
      }
    } finally {
      try { await runtime.mcp.close(); }
      finally { await daemon.close(); }
    }
  });
});
