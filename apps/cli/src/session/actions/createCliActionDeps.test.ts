import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createActionExecutor,
  admitAgentStartV1,
  SessionAgentSpawnPolicyV1StrictSchema,
  createProviderErrorV1,
  SessionSpawnNewResultV1Schema,
  type ActionExecutorContext,
  type ApprovalRequest,
  ProviderConnectionIdSchema,
  FeaturesResponseSchema,
  PluginContributionLocalIdSchema,
  PluginIdSchema,
  SessionCreationKeyV1Schema,
  deriveSessionCreationTagV1,
  computeWorkspaceSyncPolicyDigest,
  type ActionExecutorDeps,
} from '@happier-dev/protocol';
import { createActionToolExecutorBridge } from '@/agent/tools/happierTools/createActionToolExecutorBridge';
import { configuration } from '@/configuration';
import { createAuthenticationHttpStatusError } from '@/api/client/httpStatusError';
import { RPC_ERROR_CODES, RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createRpcCallError } from '@happier-dev/protocol/rpcErrors';
import { SPAWN_SESSION_ERROR_CODES } from '@/session/shared/spawnSessionContract';
import { buildProviderSpawnErrorResult } from '@/daemon/spawn/buildProviderSpawnErrorResult';
import { WorkspaceSyncController } from '@/workspaces/sync/workspaceSyncController';
import { createWorkspaceRootOwnershipManager } from '@/workspaces/sync/workspaceSyncRootOwnership';
import { registerMachineWorkspaceSyncRpcHandlers, type MachineWorkspaceSyncRpcService } from '@/api/machine/rpcHandlers.workspaceSync';
import type { RpcHandler, RpcHandlerContext, RpcHandlerRegistrar } from '@/api/rpc/types';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const {
  createSpawnedSession,
  sendSessionMessage,
  createCliApprovalsArtifactStore,
  emitSessionLifecycleHookEvent,
  resolveSessionTransportContext,
  listExecutionRuns,
  executeExecutionRunAction,
  callSessionRpc,
  callExactMachineRpc,
  callMachineRpc,
  hostSubagentStore,
  routeSessionGoalControl,
  routeSessionCatalogControl,
  routeSessionUsageLimitRecoveryCheckNow,
  routeSessionUsageLimitRecoverySwitchAccountNow,
  routeSessionUsageLimitRecoveryWaitResumeCancel,
  routeSessionUsageLimitRecoveryWaitResumeEnable,
  readSettings,
  getPreferredHostName,
  setSessionModel,
  createPluginPermissionGrantActionExecutor,
  createCliReviewCommentActionExecutorFromCredentials,
  readAgentCatalogSnapshot,
  readMachineOperationProtocolCapabilitiesV1,
  bootstrapAccountSettingsContext,
  updateAccountSettingsV2WithRetry,
  writePromptAsset,
  resolveReplaySeedDraft,
  fetchSessionByIdCompat,
  listSessions,
  lookupSessionsByTags,
  validateStoredAuthTokenAgainstActiveServer,
} = vi.hoisted(() => ({
  lookupSessionsByTags: vi.fn(),
  validateStoredAuthTokenAgainstActiveServer: vi.fn(),
  resolveReplaySeedDraft: vi.fn(),
  fetchSessionByIdCompat: vi.fn(),
  listSessions: vi.fn(),
  createSpawnedSession: vi.fn(),
  sendSessionMessage: vi.fn(),
  createCliApprovalsArtifactStore: vi.fn(() => ({})),
  emitSessionLifecycleHookEvent: vi.fn(),
  resolveSessionTransportContext: vi.fn(),
  listExecutionRuns: vi.fn(),
  executeExecutionRunAction: vi.fn(),
  callSessionRpc: vi.fn(),
  callExactMachineRpc: vi.fn(),
  callMachineRpc: vi.fn(),
  routeSessionGoalControl: vi.fn(),
  routeSessionCatalogControl: vi.fn(),
  routeSessionUsageLimitRecoveryCheckNow: vi.fn(),
  routeSessionUsageLimitRecoverySwitchAccountNow: vi.fn(),
  routeSessionUsageLimitRecoveryWaitResumeCancel: vi.fn(),
  routeSessionUsageLimitRecoveryWaitResumeEnable: vi.fn(),
  readSettings: vi.fn(),
  getPreferredHostName: vi.fn(),
  setSessionModel: vi.fn(),
  createPluginPermissionGrantActionExecutor: vi.fn(),
  createCliReviewCommentActionExecutorFromCredentials: vi.fn(),
  readAgentCatalogSnapshot: vi.fn(),
  readMachineOperationProtocolCapabilitiesV1: vi.fn(),
  bootstrapAccountSettingsContext: vi.fn(),
  updateAccountSettingsV2WithRetry: vi.fn(),
  writePromptAsset: vi.fn(),
  hostSubagentStore: {
    list: vi.fn(),
    get: vi.fn(),
    watch: vi.fn(),
    upsert: vi.fn(),
    updateStatus: vi.fn(),
    complete: vi.fn(),
  },
}));

vi.mock('@/session/services/createSpawnedSession', () => ({
  createSpawnedSession,
}));

// The transcript read/decrypt behind the Replay seed is a genuine boundary; the
// real recipe builder stays in the path so a delegation test still proves the
// composed lineage the creator receives.
vi.mock('@/session/replay/resolveReplaySeedDraft', () => ({
  resolveReplaySeedDraft,
}));

vi.mock('@/session/transport/http/sessionsHttp', async () => {
  const actual = await vi.importActual<any>('@/session/transport/http/sessionsHttp');
  return {
    ...actual,
    fetchSessionByIdCompat,
    lookupSessionsByTags,
  };
});

describe('workspace sync read Action transport', () => {
  it('routes a clean spoke to its current hub for all three reads', async () => {
    const credentials = { token: 'token', encryption: null };
    const contentPolicy = {
      v: 1 as const, selection: 'all_files' as const,
      extraIgnorePatterns: [], extraIncludePatterns: [],
      policyDigest: computeWorkspaceSyncPolicyDigest({
        v: 1, selection: 'all_files', extraIgnorePatterns: [], extraIncludePatterns: [],
      }),
    };
    const relation = (relationshipId: string, betaWorkspaceRefId: string) => ({
      v: 1 as const, relationshipId, controllerMachineId: 'machine-a',
      alphaWorkspaceRefId: 'workspace-a', betaWorkspaceRefId,
      mode: 'keep_both_in_sync' as const, contentPolicy,
      enabled: true, createdAtMs: 1, updatedAtMs: 1,
    });
    bootstrapAccountSettingsContext.mockResolvedValue({ settings: {
      workspaceRefsV1: [
        { id: 'workspace-a', serverId: 'server-a', machineId: 'machine-a', rootPath: '/a', createdAtMs: 1 },
        { id: 'workspace-b', serverId: 'server-a', machineId: 'machine-b', rootPath: '/b', createdAtMs: 1 },
        { id: 'workspace-c', serverId: 'server-a', machineId: 'machine-c', rootPath: '/c', createdAtMs: 1 },
      ],
      workspaceSyncRelationshipsV1: [relation('rel-ab', 'workspace-b'), relation('rel-ac', 'workspace-c')],
    } });
    const relationshipsResult = {
      controllerMachineId: 'machine-a',
      sets: [{ hubWorkspaceRefId: 'workspace-a', controllerMachineId: 'machine-a', relationshipIds: ['rel-ab', 'rel-ac'] }],
      relationships: [relation('rel-ab', 'workspace-b'), relation('rel-ac', 'workspace-c')].map((definition) => ({ definition, status: null })),
      remoteRelationships: [], membership: { workspaceRefId: 'workspace-c', found: true }, discoveryAvailable: true,
    };
    const conflictPage = { status: 'page' as const, relationshipId: 'rel-ab', conflicts: [], totalCount: 0, nextCursor: null };
    const inspectResult = {
      controllerMachineId: 'machine-a', hubWorkspaceRefId: 'workspace-a', path: 'src/index.ts',
      endpoints: ['workspace-a', 'workspace-b', 'workspace-c'].map((workspaceRefId) => ({
        workspaceRefId, outcome: 'observed' as const, observation: { kind: 'missing' as const }, selections: [],
      })),
      versions: [{ endpointWorkspaceRefIds: ['workspace-a', 'workspace-b', 'workspace-c'], entry: { kind: 'missing' as const } }],
      coverage: { complete: true },
    };
    callMachineRpc.mockResolvedValueOnce(relationshipsResult).mockResolvedValueOnce(conflictPage).mockResolvedValueOnce(inspectResult);
    const deps = createCliActionDeps({
      token: 'token', credentials, serverId: 'server-a', serverHttpBaseUrl: 'https://server-a.example.test',
      sessionId: 'session-c', mode: 'plain', ctx: null,
    });
    const signal = new AbortController().signal;
    await expect(deps.workspaceSyncRelationshipsList?.({ input: { workspaceRefId: 'workspace-c' }, signal })).resolves.toEqual(relationshipsResult);
    await expect(deps.workspaceSyncConflictsList?.({ input: { controllerMachineId: 'machine-a', relationshipId: 'rel-ab', limit: 50 }, signal })).resolves.toEqual(conflictPage);
    await expect(deps.workspaceSyncConflictInspect?.({ input: { workspaceRefId: 'workspace-c', path: 'src/index.ts' }, signal })).resolves.toEqual(inspectResult);
    expect(callMachineRpc.mock.calls.map(([request]) => [request.machineId, request.method, request.signal])).toEqual([
      ['machine-a', RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIPS_LIST, signal],
      ['machine-a', RPC_METHODS.DAEMON_WORKSPACE_SYNC_CONFLICTS_LIST, signal],
      ['machine-a', RPC_METHODS.DAEMON_WORKSPACE_SYNC_CONFLICT_INSPECT, signal],
    ]);
    expect(callMachineRpc.mock.calls.map(([request]) => request.request)).toEqual([
      { workspaceRefId: 'workspace-c' }, { relationshipId: 'rel-ab', limit: 50 }, { workspaceRefId: 'workspace-c', path: 'src/index.ts' },
    ]);

    // A projected Agent tool follows the same public Action executor and
    // authenticated Machine route; the direct dependency is not a dead stub.
    callMachineRpc.mockResolvedValueOnce(inspectResult);
    const executor = createActionExecutor({
      ...deps,
      isActionApprovalRequired: () => false,
      isApprovalExecutionOriginCurrent: async () => true,
    } as ActionExecutorDeps);
    const bridge = createActionToolExecutorBridge({ surface: 'agent', executor });
    await expect(bridge.executeActionByToolName(
      'action_execute',
      { actionId: 'workspace.sync.conflict.inspect', input: { workspaceRefId: 'workspace-c', path: 'src/index.ts' } },
      'session-c',
    )).resolves.toEqual({ ok: true, result: inspectResult });
    expect(callMachineRpc).toHaveBeenLastCalledWith(expect.objectContaining({
      machineId: 'machine-a', method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_CONFLICT_INSPECT,
    }));
    callMachineRpc.mockResolvedValueOnce(conflictPage).mockResolvedValueOnce(relationshipsResult);
    await expect(createActionToolExecutorBridge({ surface: 'mcp', executor }).executeActionByToolName(
      'workspace_sync_conflicts_list',
      { controllerMachineId: 'machine-a', relationshipId: 'rel-ab', limit: 50 },
      'session-c',
    )).resolves.toEqual({ ok: true, result: conflictPage });
    await expect(createActionToolExecutorBridge({ surface: 'cli', executor }).executeActionByToolName(
      'workspace_sync_relationships_list',
      { workspaceRefId: 'workspace-c' },
      'session-c',
    )).resolves.toEqual({ ok: true, result: relationshipsResult });
    expect(callMachineRpc.mock.calls.slice(-2).map(([request]) => [request.machineId, request.method])).toEqual([
      ['machine-a', RPC_METHODS.DAEMON_WORKSPACE_SYNC_CONFLICTS_LIST],
      ['machine-a', RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIPS_LIST],
    ]);
  });
});

describe('workspace sync resolution Action transport', () => {
  beforeEach(() => {
    callMachineRpc.mockReset();
  });

  it('carries spoke Agent reads and an approved partial resolution through controller RPC', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-agent-action-'));
    const hubRoot = join(fixture, 'hub');
    await mkdir(hubRoot);
    await mkdir(join(hubRoot, 'src'));
    const policy = {
      v: 1 as const, selection: 'all_files' as const,
      extraIgnorePatterns: [], extraIncludePatterns: [],
    };
    const contentPolicy = { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) };
    const relation = (relationshipId: string, betaWorkspaceRefId: string) => ({
      v: 1 as const, relationshipId, controllerMachineId: 'machine-a',
      alphaWorkspaceRefId: 'workspace-a', betaWorkspaceRefId,
      mode: 'keep_both_in_sync' as const, contentPolicy,
      enabled: true, createdAtMs: 1, updatedAtMs: 1,
    });
    const definitions = [relation('rel-ab', 'workspace-b'), relation('rel-ac', 'workspace-c')];
    const refs = [
      { id: 'workspace-a', serverId: 'server-a', machineId: 'machine-a', rootPath: hubRoot, createdAtMs: 1 },
      { id: 'workspace-b', serverId: 'server-a', machineId: 'machine-b', rootPath: '/remote/b', createdAtMs: 1 },
      { id: 'workspace-c', serverId: 'server-a', machineId: 'machine-c', rootPath: '/remote/c', createdAtMs: 1 },
    ];
    const status = (relationshipId: string) => ({
      relationshipId, controllerMachineId: 'machine-a', state: 'watching' as const,
      alphaPath: hubRoot, betaPath: `/remote/${relationshipId}`,
      mode: 'keep_both_in_sync' as const,
      endpointStates: {
        alpha: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 },
        beta: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 },
      },
      conflictCount: 1, lastCycleObservedAtMs: 1,
    });
    const approvals = new Map<string, Record<string, unknown>>();
    const applied: string[] = [];
    const adapter = {
      discoverCopyOnceRecoveries: vi.fn(async () => []),
      rehydrate: vi.fn(async () => []),
      ensure: vi.fn(async (definition: { relationshipId: string }) => status(definition.relationshipId)),
      copyOnce: vi.fn(async () => status('rel-ab')),
      get: vi.fn(async (id: string) => status(id)),
      list: vi.fn(async () => definitions.map((definition) => status(definition.relationshipId))),
      flush: vi.fn(async (id: string) => status(id)),
      pause: vi.fn(async (id: string) => ({ ...status(id), state: 'paused' as const })),
      resume: vi.fn(async (id: string) => status(id)),
      terminate: vi.fn(async () => undefined),
      listConflicts: vi.fn(async () => ({
        status: 'page' as const, relationshipId: 'rel-ab', totalCount: 1, nextCursor: null,
        conflicts: [{ relationshipId: 'rel-ab', path: 'src/index.ts', alpha: { kind: 'missing' as const }, beta: { kind: 'missing' as const } }],
      })),
      diagnoseSelection: vi.fn(async () => ({ status: 'included' as const })),
    };
    const controller = new WorkspaceSyncController({
      adapter,
      lifecycle: { start: async () => undefined, stop: async () => undefined },
      localMachineId: 'machine-a', localServerId: 'server-a',
      rootOwnershipManager: createWorkspaceRootOwnershipManager({ lockDirectory: join(fixture, 'locks') }),
      resolveWorkspaceRef: (id) => refs.find((ref) => ref.id === id) ?? null,
      resolveAllRelationshipDefinitions: async () => definitions,
      prepareRelationshipTarget: async () => undefined,
      observeEntryAtTarget: async () => ({ kind: 'missing' as const }),
      stageConflictResolutionAtTarget: async ({ targetWorkspaceRefId }) => {
        if (targetWorkspaceRefId === 'workspace-b') {
          throw Object.assign(new Error('Target changed'), { code: 'conflict_changed' });
        }
      },
      applyStagedConflictResolutionAtTarget: async ({ targetWorkspaceRefId }) => {
        applied.push(targetWorkspaceRefId);
        return { status: 'installed' as const };
      },
      assertConflictResolutionAuthorized: async (receipt, input) => {
        const approval = approvals.get(receipt);
        if (approval?.status !== 'executing' || JSON.stringify(approval.actionArgs) !== JSON.stringify(input)) {
          throw Object.assign(new Error('Approval is stale'), { code: 'approval_stale' });
        }
      },
    });
    const handlers = new Map<string, (raw: unknown, context?: RpcHandlerContext) => Promise<unknown>>();
    const registrar = {
      registerHandler: <TRequest, TResponse>(method: string, handler: RpcHandler<TRequest, TResponse>) => {
        handlers.set(method, async (raw, context) => await handler(raw as TRequest, context));
      },
    } satisfies RpcHandlerRegistrar;
    const unsupported = async (): Promise<never> => { throw new Error('Unexpected controller operation'); };
    const service: MachineWorkspaceSyncRpcService = {
      controller, prepareBetween: unsupported,
      relationshipOwner: { setEnabled: unsupported, stop: unsupported, create: unsupported },
      readFileAtTarget: unsupported, observeEntryAtTarget: unsupported,
      preflightHandoffTargetReplacement: unsupported,
      prepareBootstrapAtTarget: unsupported, releaseBootstrapAtTarget: unsupported,
      inspectRetiredState: async () => ({ status: 'absent' }),
      assertConflictResolutionAuthorized: async (receipt, input) => {
        const approval = approvals.get(receipt);
        if (approval?.status !== 'executing' || JSON.stringify(approval.actionArgs) !== JSON.stringify(input)) {
          throw Object.assign(new Error('Approval is stale'), { code: 'approval_stale' });
        }
      },
    };
    registerMachineWorkspaceSyncRpcHandlers({ rpcHandlerManager: registrar, service });
    callMachineRpc.mockImplementation(async ({ machineId, method, request, signal }: {
      machineId: string; method: string; request: unknown; signal?: AbortSignal;
    }) => {
      expect(machineId).toBe('machine-a');
      const handler = handlers.get(method);
      if (!handler) throw new Error(`Controller RPC not registered: ${method}`);
      return await handler(request, { signal: signal ?? new AbortController().signal });
    });
    bootstrapAccountSettingsContext.mockResolvedValue({ settings: {
      workspaceRefsV1: refs, workspaceSyncRelationshipsV1: definitions,
    } });
    try {
      for (const definition of definitions) await controller.ensure(definition);
      const { executor } = createCliActionExecutorHarness({
        token: 'token', credentials: { token: 'token', encryption: null },
        serverId: 'server-a', serverHttpBaseUrl: 'https://server-a.example.test',
        sessionId: 'session-c', mode: 'plain', ctx: null,
      }, {
        isActionApprovalRequired: () => false,
        approvalsCreate: async ({ request }) => {
          approvals.set('approval-controller', request as unknown as Record<string, unknown>);
          return { artifactId: 'approval-controller' };
        },
        approvalsGet: async ({ artifactId }) => approvals.get(artifactId) as never,
        approvalsUpdate: async ({ artifactId, request }) => {
          approvals.set(artifactId, request as unknown as Record<string, unknown>);
          return { ok: true as const };
        },
        isApprovalExecutionOriginCurrent: async () => true,
      });
      const agent = createActionToolExecutorBridge({ surface: 'agent', executor });
      await expect(agent.executeActionByToolName('action_execute', {
        actionId: 'workspace.sync.relationships.list', input: { workspaceRefId: 'workspace-c' },
      }, 'session-c')).resolves.toMatchObject({ ok: true, result: { controllerMachineId: 'machine-a', membership: { found: true } } });
      await expect(agent.executeActionByToolName('action_execute', {
        actionId: 'workspace.sync.conflicts.list', input: { relationshipId: 'rel-ab', controllerMachineId: 'machine-a', limit: 50 },
      }, 'session-c')).resolves.toMatchObject({ ok: true, result: { status: 'page', relationshipId: 'rel-ab' } });
      const inspection = await agent.executeActionByToolName('action_execute', {
        actionId: 'workspace.sync.conflict.inspect', input: { workspaceRefId: 'workspace-c', path: 'src/index.ts' },
      }, 'session-c');
      expect(inspection).toMatchObject({ ok: true, result: { controllerMachineId: 'machine-a', coverage: { complete: true } } });
      const input = {
        controllerMachineId: 'machine-a', hubWorkspaceRefId: 'workspace-a', path: 'src/index.ts',
        source: { workspaceRefId: 'workspace-c', expected: { kind: 'missing' as const } },
        targets: [
          { workspaceRefId: 'workspace-a', expected: { kind: 'missing' as const } },
          { workspaceRefId: 'workspace-b', expected: { kind: 'missing' as const } },
        ],
        relationshipIds: ['rel-ab', 'rel-ac'], strategy: 'use_source' as const,
      };
      await expect(agent.executeActionByToolName('action_execute', {
        actionId: 'workspace.sync.conflict.resolve', input,
      }, 'session-c', { actionRequestId: 'agent-controller-request' })).resolves.toMatchObject({
        ok: true, result: { kind: 'approval_request_created', artifactId: 'approval-controller' },
      });
      expect(approvals.get('approval-controller')).toMatchObject({
        status: 'open',
        actionArgs: input,
        executionOriginV1: {
          surface: 'agent', authority: 'account_automation', serverId: 'server-a',
          sessionId: 'session-c', requestId: 'agent-controller-request',
        },
      });
      expect(applied).toEqual([]);
      await expect(agent.executeActionByToolName('action_execute', {
        actionId: 'approval.request.decide', input: { artifactId: 'approval-controller', decision: 'approve' },
      }, 'session-c')).resolves.toMatchObject({ ok: false });
      expect(applied).toEqual([]);
      await expect(executor.execute('approval.request.decide', {
        artifactId: 'approval-controller', decision: 'approve',
      }, { surface: 'ui', authority: 'present_user', serverId: 'server-a' })).resolves.toMatchObject({
        ok: true, result: { status: 'executed', execution: { ok: true, result: { endpoints: [
          { workspaceRefId: 'workspace-a', status: 'applied' },
          { workspaceRefId: 'workspace-b', status: 'changed' },
        ] } } },
      });
      expect(applied).toEqual(['workspace-a']);
      await executor.execute('approval.request.decide', {
        artifactId: 'approval-controller', decision: 'approve',
      }, { surface: 'ui', authority: 'present_user', serverId: 'server-a' });
      expect(applied).toEqual(['workspace-a']);
      expect(callMachineRpc.mock.calls.map(([request]) => request.method)).toEqual([
        RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIPS_LIST,
        RPC_METHODS.DAEMON_WORKSPACE_SYNC_CONFLICTS_LIST,
        RPC_METHODS.DAEMON_WORKSPACE_SYNC_CONFLICT_INSPECT,
        RPC_METHODS.DAEMON_WORKSPACE_SYNC_CONFLICT_RESOLVE,
      ]);
    } finally {
      await controller.shutdown();
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('routes an approved spoke request to its exact controller with the artifact receipt', async () => {
    const result = { endpoints: [{ workspaceRefId: 'workspace-b', status: 'applied' as const }] };
    callMachineRpc.mockResolvedValueOnce(result);
    const deps = createCliActionDeps({
      token: 'token', credentials: { token: 'token', encryption: null },
      serverId: 'server-a', serverHttpBaseUrl: 'https://server-a.example.test',
      sessionId: 'session-c', mode: 'plain', ctx: null,
    });
    const input = {
      controllerMachineId: 'machine-a', hubWorkspaceRefId: 'workspace-a', path: 'src/index.ts',
      source: { workspaceRefId: 'workspace-c', expected: { kind: 'missing' as const } },
      targets: [{ workspaceRefId: 'workspace-b', expected: { kind: 'missing' as const } }],
      relationshipIds: ['rel-ab', 'rel-ac'], strategy: 'use_source' as const,
    };
    const signal = new AbortController().signal;
    await expect(deps.workspaceSyncConflictResolve?.({ actionReceiptId: 'approval-1', input, signal }))
      .resolves.toEqual(result);
    expect(callMachineRpc).toHaveBeenLastCalledWith(expect.objectContaining({
      machineId: 'machine-a', method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_CONFLICT_RESOLVE,
      request: { actionReceiptId: 'approval-1', actionInput: input }, signal,
    }));
  });

  it('returns an operation-scoped update requirement when the controller lacks resolve', async () => {
    const missingMethod = createRpcCallError({
      error: 'Controller method unavailable', errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
    });
    callMachineRpc.mockRejectedValueOnce(missingMethod);
    const deps = createCliActionDeps({
      token: 'token', credentials: { token: 'token', encryption: null },
      serverId: 'server-a', serverHttpBaseUrl: 'https://server-a.example.test',
      sessionId: 'session-c', mode: 'plain', ctx: null,
    });
    await expect(deps.workspaceSyncConflictResolve?.({
      actionReceiptId: 'approval-1',
      input: {
        controllerMachineId: 'machine-a', hubWorkspaceRefId: 'workspace-a', path: 'src/index.ts',
        source: { workspaceRefId: 'workspace-c', expected: { kind: 'missing' } },
        targets: [{ workspaceRefId: 'workspace-b', expected: { kind: 'missing' } }],
        relationshipIds: ['rel-ab', 'rel-ac'], strategy: 'use_source',
      },
    })).rejects.toMatchObject({ code: 'workspace_sync_update_required' });

    const approvals = new Map<string, Record<string, unknown>>();
    const { executor } = createCliActionExecutorHarness({
      token: 'token', credentials: { token: 'token', encryption: null },
      serverId: 'server-a', serverHttpBaseUrl: 'https://server-a.example.test',
      sessionId: 'session-c', mode: 'plain', ctx: null,
    }, {
      isActionApprovalRequired: () => false,
      approvalsCreate: async ({ request }) => {
        approvals.set('approval-old-controller', request as unknown as Record<string, unknown>);
        return { artifactId: 'approval-old-controller' };
      },
      approvalsGet: async ({ artifactId }) => approvals.get(artifactId) as never,
      approvalsUpdate: async ({ artifactId, request }) => {
        approvals.set(artifactId, request as unknown as Record<string, unknown>);
        return { ok: true as const };
      },
      isApprovalExecutionOriginCurrent: async () => true,
    });
    const input = {
      controllerMachineId: 'machine-a', hubWorkspaceRefId: 'workspace-a', path: 'src/index.ts',
      source: { workspaceRefId: 'workspace-c', expected: { kind: 'missing' as const } },
      targets: [{ workspaceRefId: 'workspace-b', expected: { kind: 'missing' as const } }],
      relationshipIds: ['rel-ab', 'rel-ac'], strategy: 'use_source' as const,
    };
    await expect(executor.execute('workspace.sync.conflict.resolve', input, {
      surface: 'agent', authority: 'account_automation', serverId: 'server-a',
      defaultSessionId: 'session-c', actionRequestId: 'agent-old-controller',
    })).resolves.toMatchObject({ ok: true, result: { artifactId: 'approval-old-controller' } });
    callMachineRpc.mockRejectedValueOnce(missingMethod);
    await expect(executor.execute('approval.request.decide', {
      artifactId: 'approval-old-controller', decision: 'approve',
    }, { surface: 'ui', authority: 'present_user', serverId: 'server-a' })).resolves.toMatchObject({
      ok: true,
      result: { status: 'failed', execution: { ok: false, errorCode: 'workspace_sync_update_required' } },
    });
  });

  it('keeps a spoke Agent request deferred until a human approves and returns the controller partial result once', async () => {
    const input = {
      controllerMachineId: 'machine-a', hubWorkspaceRefId: 'workspace-a', path: 'src/index.ts',
      source: { workspaceRefId: 'workspace-c', expected: { kind: 'missing' as const } },
      targets: [
        { workspaceRefId: 'workspace-a', expected: { kind: 'missing' as const } },
        { workspaceRefId: 'workspace-b', expected: { kind: 'missing' as const } },
      ],
      relationshipIds: ['rel-ab', 'rel-ac'], strategy: 'use_source' as const,
    };
    const partial = { endpoints: [
      { workspaceRefId: 'workspace-a', status: 'applied' as const },
      { workspaceRefId: 'workspace-b', status: 'changed' as const },
    ] };
    const approvals = new Map<string, Record<string, unknown>>();
    callMachineRpc.mockResolvedValueOnce(partial);
    const { executor } = createCliActionExecutorHarness({
      token: 'token', credentials: { token: 'token', encryption: null },
      serverId: 'server-a', serverHttpBaseUrl: 'https://server-a.example.test',
      sessionId: 'session-c', mode: 'plain', ctx: null,
    }, {
      isActionApprovalRequired: () => false,
      approvalsCreate: async ({ request }) => {
        approvals.set('approval-spoke', request as unknown as Record<string, unknown>);
        return { artifactId: 'approval-spoke' };
      },
      approvalsGet: async ({ artifactId }) => approvals.get(artifactId) as never,
      approvalsUpdate: async ({ artifactId, request }) => {
        approvals.set(artifactId, request as unknown as Record<string, unknown>);
        return { ok: true as const };
      },
      isApprovalExecutionOriginCurrent: async () => true,
    });
    const agent = createActionToolExecutorBridge({ surface: 'agent', executor });
    const pending = await agent.executeActionByToolName('action_execute', {
      actionId: 'workspace.sync.conflict.resolve', input,
    }, 'session-c', { actionRequestId: 'agent-request-1' });
    expect(pending).toMatchObject({
      ok: true, result: { kind: 'approval_request_created', artifactId: 'approval-spoke' },
    });
    expect(callMachineRpc).not.toHaveBeenCalled();
    await expect(agent.executeActionByToolName('action_execute', {
      actionId: 'approval.request.decide', input: { artifactId: 'approval-spoke', decision: 'approve' },
    }, 'session-c')).resolves.toMatchObject({ ok: false });
    expect(callMachineRpc).not.toHaveBeenCalled();
    await expect(executor.execute('approval.request.decide', {
      artifactId: 'approval-spoke', decision: 'approve',
    }, { surface: 'ui', authority: 'present_user', serverId: 'server-a' })).resolves.toMatchObject({
      ok: true, result: { status: 'executed', execution: { ok: true, result: partial } },
    });
    expect(callMachineRpc).toHaveBeenCalledTimes(1);
    expect(callMachineRpc).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'machine-a', method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_CONFLICT_RESOLVE,
      request: { actionReceiptId: 'approval-spoke', actionInput: input },
    }));
    await executor.execute('approval.request.decide', {
      artifactId: 'approval-spoke', decision: 'approve',
    }, { surface: 'ui', authority: 'present_user', serverId: 'server-a' });
    expect(callMachineRpc).toHaveBeenCalledTimes(1);
  });
});

// HTTP authentication is outside the real Session creation/settlement path.
vi.mock('@/auth/validateStoredAuthTokenAgainstActiveServer', () => ({
  validateStoredAuthTokenAgainstActiveServer,
}));

vi.mock('@/session/services/sendSessionMessage', () => ({
  sendSessionMessage,
}));

vi.mock('@/session/services/listSessions', () => ({
  listSessions,
}));

vi.mock('@/session/services/setSessionModel', () => ({
  setSessionModel,
}));

vi.mock('@/session/actions/approvals/artifactStore', () => ({
  createCliApprovalsArtifactStore,
}));

vi.mock('@/session/services/resolveSessionTransportContext', () => ({
  resolveSessionTransportContext,
}));

vi.mock('@/session/services/executionRuns', async () => {
  const actual = await vi.importActual<any>('@/session/services/executionRuns');
  return {
    ...actual,
    listExecutionRuns,
    executeExecutionRunAction,
  };
});

vi.mock('@/session/transport/rpc/sessionRpc', () => ({
  callSessionRpc,
}));

vi.mock('@/session/transport/rpc/machineRpc', () => ({
  callExactMachineRpc,
  callMachineRpc,
}));

vi.mock('@/session/goalControls/sessionGoalControlRouter', () => ({
  routeSessionGoalControl,
}));

vi.mock('@/session/catalogControls/sessionCatalogControlRouter', () => ({
  routeSessionCatalogControl,
}));

vi.mock('@/session/usageLimitRecoveryControls/sessionUsageLimitRecoveryControlRouter', () => ({
  routeSessionUsageLimitRecoveryCheckNow,
  routeSessionUsageLimitRecoveryWaitResumeCancel,
  routeSessionUsageLimitRecoveryWaitResumeEnable,
}));

vi.mock('@/session/usageLimitRecoveryControls/sessionUsageLimitRecoverySwitchAccountNow', () => ({
  routeSessionUsageLimitRecoverySwitchAccountNow,
}));

vi.mock('@/persistence', async () => {
  const actual = await vi.importActual<any>('@/persistence');
  return {
    ...actual,
    readSettings,
  };
});

vi.mock('@/daemon/machine/metadata', () => ({
  getPreferredHostName,
}));

vi.mock('@/session/subagents/hostSubagentStore', async () => {
  const actual = await vi.importActual<any>('@/session/subagents/hostSubagentStore');
  return {
    ...actual,
    hostSubagentStore,
  };
});

vi.mock('@/agent/runtime/bridges/session/SessionHostBridge', () => ({
  getSessionHostBridge: () => ({
    emitLifecycleHookEvent: emitSessionLifecycleHookEvent,
  }),
}));

vi.mock('@/plugins/runtime/lifecycle/permissions/pluginPermissionGrantActionExecutor', () => ({
  createPluginPermissionGrantActionExecutor,
}));

vi.mock('@/agent/reviews/comments/executor', () => ({
  createCliReviewCommentActionExecutorFromCredentials,
}));

vi.mock('@/agent/catalog/snapshot', () => ({
  readAgentCatalogSnapshot,
}));

vi.mock('@/api/machine/machineOperationProtocolCapabilities', () => ({
  readMachineOperationProtocolCapabilitiesV1,
}));

vi.mock('@/settings/accountSettings/bootstrapAccountSettingsContext', () => ({
  bootstrapAccountSettingsContext,
}));

vi.mock('@/settings/accountSettings/updateAccountSettingsV2WithRetry', () => ({
  updateAccountSettingsV2WithRetry,
}));

vi.mock('@/prompts/assets/actions', async () => {
  const actual = await vi.importActual<any>('@/prompts/assets/actions');
  return { ...actual, writePromptAsset };
});

import {
  createCliActionDeps,
  projectSessionInitialAccessEnvelopeHostErrorResult,
} from './createCliActionDeps';
import { createCliActionExecutorHarness } from './createCliActionExecutorHarness';
import { SessionInitialAccessEnvelopeHostError } from '@/api/session/sessionCreationInitialAccess';
import {
  registerCurrentSessionUiBinding,
  type CurrentSessionCapabilityBinding,
} from '@/session/presentation/currentSessionUiBindings';
import { createHostSubagentStore } from '@/session/subagents/hostSubagentStore';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';

type MediatedPermissionResponse = Awaited<ReturnType<
  NonNullable<CurrentSessionCapabilityBinding['permissionHandler']>['respondToMediatedPendingPermission']
>>;

/** No external-Action authorization: these Action reads carry the daemon credential. */
const actionContext: ActionExecutorContext = {};

describe('createCliActionDeps hook dispatch', () => {
  it('answers detached requests on the exact machine and preserves stale-request refusal', async () => {
    const credentials = { token: 'token', encryption: null };
    const deps = createCliActionDeps({ token: 'token', credentials,
      sessionId: 'cli-global', mode: 'plain', ctx: null,
      serverId: 'home-a', serverHttpBaseUrl: 'https://home-a.example.test',
    });
    const executor = createActionExecutor({ ...deps, isActionApprovalRequired: () => false });
    const signal = new AbortController().signal;
    const request = { runId: 'run-1', requestId: 'request-1', approved: false };
    callExactMachineRpc.mockResolvedValue({ ok: false, errorCode: 'permission_request_not_found', error: 'Not found' });
    expect(await executor.execute('execution.run.permission.respond', request, {
      surface: 'cli', authority: 'present_user', serverId: 'home-a', executionRunTargetMachineId: 'machine-1', signal,
    })).toEqual({ ok: false, errorCode: 'permission_request_not_found', error: 'Not found' });
    expect(callExactMachineRpc).toHaveBeenCalledWith({
      credentials, machineId: 'machine-1', method: RPC_METHODS.DAEMON_EXECUTION_RUN_PERMISSION_RESPOND,
      request, signal, serverUrl: 'https://home-a.example.test',
    });
    expect(callMachineRpc).not.toHaveBeenCalled();
  });
  it('refuses a detached response whose Home differs from the captured credential scope', async () => {
    const deps = createCliActionDeps({ token: 'token', credentials: { token: 'token', encryption: null },
      sessionId: 'cli-global', mode: 'plain', ctx: null, serverId: 'home-a',
      serverHttpBaseUrl: 'https://home-a.example.test',
    });
    const executor = createActionExecutor({ ...deps, isActionApprovalRequired: () => false });
    callExactMachineRpc.mockResolvedValue({ ok: true });

    expect(await executor.execute('execution.run.permission.respond', {
      runId: 'run-1', requestId: 'request-1', approved: true,
    }, { surface: 'cli', authority: 'present_user', serverId: 'home-b', executionRunTargetMachineId: 'machine-1' }))
      .toMatchObject({ ok: false, errorCode: 'server_scope_mismatch' });
    expect(callExactMachineRpc).not.toHaveBeenCalled();
  });
  it('refuses autonomous remote role edits and report copies without a trusted RPC origin', async () => {
    const deps = createCliActionDeps({ token: 'token', credentials: { token: 'token', encryption: null },
      sessionId: 'lead', mode: 'plain', ctx: null,
    });
    for (const request of [
      { actionId: 'session.notes.set' as const, input: { sessionId: 'child', notes: 'Coordinate' } },
      { actionId: 'session.roles.apply_to_reports' as const, input: { sessionId: 'lead' } },
    ]) {
      await expect(deps.roleActionExecute!({ ...request, context: { authority: 'account_automation', surface: 'agent' } }))
        .rejects.toMatchObject({ code: 'role_rpc_origin_unavailable' });
    }
  });

  it('refuses led-session role forwarding without an authenticated autonomous origin through the real executor', async () => {
    const deps = createCliActionDeps({ token: 'token', credentials: { token: 'token', encryption: null },
      sessionId: 'lead', mode: 'plain', ctx: null,
    });
    const executor = createActionExecutor(deps);
    const context: ActionExecutorContext = {
      authority: 'account_automation', surface: 'agent', defaultSessionId: 'lead', workspaceWrites: 'allow',
      agentStartContext: { caller: { kind: 'session', sessionId: 'lead', starterDepth: 0, turnDepth: 0 },
        baseline: { machineId: 'machine-1', directory: '/repo' }, ledSubtreeSessionIds: ['child'],
        workDepthLimit: 4, roles: {}, callerPermissionCeiling: 'default' },
    };
    for (const request of [
      { actionId: 'session.role.set' as const, input: { sessionId: 'child', roleId: 'builder' } },
      { actionId: 'session.roles.override.set' as const, input: { sessionId: 'child', roleId: 'builder', workspaceWrites: 'deny' as const } },
    ]) {
      expect(await executor.execute(request.actionId, request.input, context))
        .toMatchObject({ ok: false, errorCode: 'action_failed', error: 'role_rpc_origin_unavailable' });
      expect(await executor.execute(request.actionId, { ...request.input, sessionId: 'unrelated' }, context))
        .toMatchObject({ ok: false, errorCode: 'subtree_denied' });
    }
    expect(callSessionRpc).not.toHaveBeenCalled();
  });

  beforeEach(() => {
    callExactMachineRpc.mockReset();
    createSpawnedSession.mockReset();
    lookupSessionsByTags.mockReset();
    validateStoredAuthTokenAgainstActiveServer.mockReset();
    sendSessionMessage.mockReset();
    createCliApprovalsArtifactStore.mockReset();
    emitSessionLifecycleHookEvent.mockReset();
    resolveSessionTransportContext.mockReset();
    listExecutionRuns.mockReset();
    executeExecutionRunAction.mockReset();
    callSessionRpc.mockReset();
    callMachineRpc.mockReset();
    listSessions.mockReset();
    readAgentCatalogSnapshot.mockReset();
    readAgentCatalogSnapshot.mockReturnValue({
      agentDefinitionsById: new Map([['codex', {
        id: 'codex',
        identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
        provenance: 'first_party',
        source: { kind: 'bundled' },
        definition: {},
      }]]),
      catalogEntriesById: {},
    });
    readMachineOperationProtocolCapabilitiesV1.mockReset();
    readMachineOperationProtocolCapabilitiesV1.mockResolvedValue({
      capabilities: { sessionSpawn: { protocolVersions: [1] } },
      revision: 1,
    });
    routeSessionGoalControl.mockReset();
    routeSessionCatalogControl.mockReset();
    routeSessionUsageLimitRecoveryCheckNow.mockReset();
    routeSessionUsageLimitRecoverySwitchAccountNow.mockReset();
    routeSessionUsageLimitRecoveryWaitResumeCancel.mockReset();
    routeSessionUsageLimitRecoveryWaitResumeEnable.mockReset();
    readSettings.mockReset();
    getPreferredHostName.mockReset();
    setSessionModel.mockReset();
    createPluginPermissionGrantActionExecutor.mockReset();
    createCliReviewCommentActionExecutorFromCredentials.mockReset();
    bootstrapAccountSettingsContext.mockReset();
    updateAccountSettingsV2WithRetry.mockReset();
    writePromptAsset.mockReset();
    fetchSessionByIdCompat.mockReset();
    resolveReplaySeedDraft.mockReset();
    readSettings.mockResolvedValue({ machineId: 'local-machine' });
    getPreferredHostName.mockResolvedValue('local-machine.local');
    hostSubagentStore.list.mockReset();
    hostSubagentStore.get.mockReset();
    hostSubagentStore.watch.mockReset();
    hostSubagentStore.upsert.mockReset();
    hostSubagentStore.updateStatus.mockReset();
    hostSubagentStore.complete.mockReset();
  });

  it.each(['agent_cli_missing', 'agent_signed_out', 'SPAWN_VALIDATION_FAILED'] as const)(
    'preserves %s from the daemon through real creation settlement', async (errorCode) => {
      const realCatalog = await vi.importActual<typeof import('@/agent/catalog/snapshot')>('@/agent/catalog/snapshot');
      readAgentCatalogSnapshot.mockImplementation(realCatalog.readAgentCatalogSnapshot);
      const realCreation = await vi.importActual<typeof import('@/session/services/createSpawnedSession')>('@/session/services/createSpawnedSession');
      createSpawnedSession.mockImplementation(realCreation.createSpawnedSession);
      lookupSessionsByTags.mockResolvedValue({ state: 'available', tags: [], sessions: [] });
      validateStoredAuthTokenAgainstActiveServer.mockResolvedValue({ state: 'valid', httpStatus: 200 });
      const spawn = async () => ({ type: 'error' as const, errorCode, errorMessage: 'Agent setup is required.', ...(errorCode === 'SPAWN_VALIDATION_FAILED' ? {} : { agentId: 'codex' }) });
      const deps = createCliActionDeps({
        token: 'token', credentials: { token: 'token', encryption: null },
        sessionId: 'sess-parent', mode: 'plain', ctx: null,
        sessionSpawnDirectTargetTransport: {
          machineId: 'machine-1',
          prepare: async () => ({ ok: true, directory: '/repo', directoryKind: 'path' as const, directoryCreationRequired: false, checkout: null }),
          spawnedSession: { spawn, resolveSpawnSessionByNonce: async () => ({ status: 'not_found' }) },
        },
      });
      const result = await deps.sessionSpawnNew({
        creationKey: SessionCreationKeyV1Schema.parse('agent-preconditions'),
        sessionCreationTag: deriveSessionCreationTagV1({ callerCreationNamespace: 'user', creationKey: 'agent-preconditions' }),
        executionTarget: { serverId: configuration.activeServerId, machineId: 'machine-1' },
        directory: { kind: 'path' as const, path: '/repo' }, agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
        connectedServices: { v: 2, bindingsByServiceId: {} }, actionCaller: { kind: 'host' },
      });
      expect(result).toEqual(errorCode === 'SPAWN_VALIDATION_FAILED'
        ? { type: 'error', code: 'spawn_failed', retryable: true }
        : { type: 'error', code: errorCode, agentId: 'codex', retryable: false });
      expect(SessionSpawnNewResultV1Schema.safeParse(result)).toMatchObject({ success: true, data: result });
    },
  );

  it.each(['provider_not_enabled_on_machine', 'provider_endpoint_unavailable'] as const)(
    'preserves %s from the daemon through real creation settlement', async (code) => {
      const realCatalog = await vi.importActual<typeof import('@/agent/catalog/snapshot')>('@/agent/catalog/snapshot');
      readAgentCatalogSnapshot.mockImplementation(realCatalog.readAgentCatalogSnapshot);
      const realCreation = await vi.importActual<typeof import('@/session/services/createSpawnedSession')>(
        '@/session/services/createSpawnedSession',
      );
      createSpawnedSession.mockImplementation(realCreation.createSpawnedSession);
      lookupSessionsByTags.mockResolvedValue({ state: 'available', tags: [], sessions: [] });
      validateStoredAuthTokenAgainstActiveServer.mockResolvedValue({ state: 'valid', httpStatus: 200 });
      const providerError = createProviderErrorV1(code, { connectionId: 'pc_work', machineId: 'machine-1' });
      const spawn = vi.fn(async () => buildProviderSpawnErrorResult(providerError));
      const deps = createCliActionDeps({
        token: 'token',
        credentials: { token: 'token', encryption: null },
        sessionId: 'sess-parent', mode: 'plain', ctx: null,
        sessionSpawnDirectTargetTransport: {
          machineId: 'machine-1',
          prepare: async () => ({ ok: true, directory: '/repo', directoryKind: 'path' as const, directoryCreationRequired: false, checkout: null }),
          spawnedSession: {
            spawn,
            resolveSpawnSessionByNonce: async () => ({ status: 'not_found' }),
          },
        },
      });
      const result = await deps.sessionSpawnNew({
        creationKey: SessionCreationKeyV1Schema.parse('provider-recovery'),
        sessionCreationTag: deriveSessionCreationTagV1({ callerCreationNamespace: 'user', creationKey: 'provider-recovery' }),
        executionTarget: { serverId: configuration.activeServerId, machineId: 'machine-1' },
        directory: { kind: 'path' as const, path: '/repo' },
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
        modelSelection: {
          v: 1, updatedAt: 1,
          ref: { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: ProviderConnectionIdSchema.parse('pc_work'), modelId: 'model-a' },
        },
        connectedServices: { v: 2, bindingsByServiceId: {} },
        actionCaller: { kind: 'host' },
      });
      await expect(createSpawnedSession.mock.results[0]?.value).rejects.toMatchObject({
        details: buildProviderSpawnErrorResult(providerError),
      });
      expect(spawn).toHaveBeenCalled();
      expect(result).toEqual({ type: 'error', code: 'spawn_failed', retryable: providerError.retryable, providerError });
      expect(SessionSpawnNewResultV1Schema.safeParse(result)).toMatchObject({ success: true, data: result });
    },
  );

  it('reaches the daemon transport with the canonical Agent key the model selection was authored with', async () => {
    const agentTargetKey = 'agent:happier.agent.claude/claude';
    const realCatalog = await vi.importActual<typeof import('@/agent/catalog/snapshot')>('@/agent/catalog/snapshot');
    readAgentCatalogSnapshot.mockImplementation(realCatalog.readAgentCatalogSnapshot);
    const realCreation = await vi.importActual<typeof import('@/session/services/createSpawnedSession')>(
      '@/session/services/createSpawnedSession',
    );
    createSpawnedSession.mockImplementation(realCreation.createSpawnedSession);
    lookupSessionsByTags.mockResolvedValue({ state: 'available', tags: [], sessions: [] });
    validateStoredAuthTokenAgainstActiveServer.mockResolvedValue({ state: 'valid', httpStatus: 200 });
    const providerError = createProviderErrorV1('provider_endpoint_unavailable', { connectionId: 'pc_work', machineId: 'machine-1' });
    const spawn = vi.fn(async () => buildProviderSpawnErrorResult(providerError));
    const deps = createCliActionDeps({
      token: 'token',
      credentials: { token: 'token', encryption: null },
      sessionId: 'sess-parent', mode: 'plain', ctx: null,
      sessionSpawnDirectTargetTransport: {
        machineId: 'machine-1',
        prepare: async () => ({ ok: true, directory: '/repo', directoryKind: 'path' as const, directoryCreationRequired: false, checkout: null }),
        spawnedSession: {
          spawn,
          resolveSpawnSessionByNonce: async () => ({ status: 'not_found' }),
        },
      },
    });

    await deps.sessionSpawnNew({
      creationKey: SessionCreationKeyV1Schema.parse('model-selection-key'),
      sessionCreationTag: deriveSessionCreationTagV1({ callerCreationNamespace: 'user', creationKey: 'model-selection-key' }),
      executionTarget: { serverId: configuration.activeServerId, machineId: 'machine-1' },
      directory: { kind: 'path' as const, path: '/repo' },
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
      modelSelection: {
        v: 1, updatedAt: 1,
        ref: { agentTargetKey, providerConnectionId: null, modelId: 'claude-sonnet-5' },
      },
      connectedServices: { v: 2, bindingsByServiceId: {} },
      actionCaller: { kind: 'host' },
    });

    // The daemon routes by the backend target but keys the selection by the one
    // canonical Agent key, so nothing is translated at this seam.
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({
      backendTarget: expect.objectContaining({ backendId: 'claude' }),
      modelSelection: expect.objectContaining({
        ref: expect.objectContaining({ agentTargetKey, modelId: 'claude-sonnet-5' }),
      }),
    }), undefined);
  });

  it('routes a filtered Session list through the canonical list service with both scope and cancellation', async () => {
    const query = {
      v: 1 as const,
      storage: 'active' as const,
      includeInactive: false,
      scope: 'assigned_to_me' as const,
      attention: 'any' as const,
      audiences: [],
      tagIds: [],
    };
    const signal = new AbortController().signal;
    const credentials = {
      token: 'token-1',
      encryption: null,
    } as const;
    listSessions.mockResolvedValueOnce({
      sessions: [],
      nextCursor: 'cursor_v1_next',
      hasNext: true,
      attentionNextCursor: 'cursor_v1_attention',
      attentionHasNext: true,
    });
    const deps = createCliActionDeps({
      token: credentials.token,
      credentials,
      sessionId: 'session-1',
      mode: 'plain',
      ctx: null,
    });

    await expect(deps.sessionList({
      context: actionContext,
      query,
      view: 'summary',
      serverId: 'home-1',
      signal,
    })).resolves.toMatchObject({
      nextCursor: 'cursor_v1_next',
      attentionNextCursor: 'cursor_v1_attention',
    });
    expect(listSessions).toHaveBeenCalledWith({
      credentials,
      query,
      view: 'summary',
      includeSystem: false,
      resumableOnly: false,
      includeRows: false,
      includeLastMessagePreview: false,
      resolveAuthorizationHeaders: expect.any(Function),
      signal,
    });
  });

  it('keeps a fixed Session-list Home id and HTTP endpoint together at the dependency boundary', async () => {
    const credentials = { token: 'token-1', encryption: null } as const;
    let observedServerHttpBaseUrl: string | null = null;
    listSessions.mockImplementationOnce(async () => {
      observedServerHttpBaseUrl = resolveServerHttpBaseUrl();
      return { sessions: [], nextCursor: null, hasNext: false };
    });
    const deps = createCliActionDeps({
      token: credentials.token,
      credentials,
      serverId: 'home-fixed',
      serverHttpBaseUrl: 'https://fixed-home.example.test/',
      sessionId: 'session-1',
      mode: 'plain',
      ctx: null,
    });

    await expect(deps.sessionList({ context: actionContext, serverId: 'home-fixed' })).resolves.toMatchObject({
      sessions: [],
      nextCursor: null,
      hasNext: false,
    });
    expect(observedServerHttpBaseUrl).toBe('https://fixed-home.example.test');
  });

  it('keeps a successful prompt export successful when external-link persistence conflicts', async () => {
    const credentials = {
      token: 'token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
    };
    createCliApprovalsArtifactStore.mockReturnValue({
      promptLibraryStore: {
        read: vi.fn(async () => ({
          id: 'prompt-1',
          header: { title: 'Review prompt' },
          body: JSON.stringify({ v: 1, markdown: '# Review', createdAtMs: 1, updatedAtMs: 1 }),
        })),
        update: vi.fn(async () => {}),
      },
    });
    bootstrapAccountSettingsContext.mockResolvedValue({ settings: {} });
    writePromptAsset.mockResolvedValue({
      ok: true,
      externalRef: { path: 'review.md' },
      digest: 'external-digest',
    });
    updateAccountSettingsV2WithRetry.mockResolvedValue({
      status: 'conflict',
      currentVersion: 17,
    });

    const deps = createCliActionDeps({
      token: credentials.token,
      credentials,
      sessionId: 'plugin-global',
      mode: 'plain',
      ctx: null,
    });

    await expect(deps.promptAssetExport?.({
      artifactId: 'prompt-1',
      machineId: 'local-machine',
      assetTypeId: 'external.prompt',
      scope: 'user',
      targetPath: 'review.md',
    })).resolves.toMatchObject({
      ok: true,
      artifactId: 'prompt-1',
      exported: true,
      externalLinkPersistence: {
        status: 'conflict',
        currentVersion: 17,
      },
    });
  });

  it('keeps a successful prompt export successful when external-link persistence throws', async () => {
    const credentials = {
      token: 'token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
    };
    createCliApprovalsArtifactStore.mockReturnValue({
      promptLibraryStore: {
        read: vi.fn(async () => ({
          id: 'prompt-1',
          header: { title: 'Review prompt' },
          body: JSON.stringify({ v: 1, markdown: '# Review', createdAtMs: 1, updatedAtMs: 1 }),
        })),
        update: vi.fn(async () => {}),
      },
    });
    bootstrapAccountSettingsContext.mockResolvedValue({ settings: {} });
    writePromptAsset.mockResolvedValue({
      ok: true,
      externalRef: { path: 'review.md' },
      digest: 'external-digest',
    });
    updateAccountSettingsV2WithRetry.mockRejectedValue(new Error('settings unavailable'));

    const deps = createCliActionDeps({
      token: credentials.token,
      credentials,
      sessionId: 'plugin-global',
      mode: 'plain',
      ctx: null,
    });

    await expect(deps.promptAssetExport?.({
      artifactId: 'prompt-1',
      machineId: 'local-machine',
      assetTypeId: 'external.prompt',
      scope: 'user',
      targetPath: 'review.md',
    })).resolves.toMatchObject({
      ok: true,
      artifactId: 'prompt-1',
      exported: true,
      externalLinkPersistence: {
        status: 'unavailable',
        retryable: false,
      },
    });
  });

  it('redacts Account Settings from a successful prompt export external-link settlement', async () => {
    const credentials = {
      token: 'token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
    };
    createCliApprovalsArtifactStore.mockReturnValue({
      promptLibraryStore: {
        read: vi.fn(async () => ({
          id: 'prompt-1',
          header: { title: 'Review prompt' },
          body: JSON.stringify({ v: 1, markdown: '# Review', createdAtMs: 1, updatedAtMs: 1 }),
        })),
        update: vi.fn(async () => {}),
      },
    });
    bootstrapAccountSettingsContext.mockResolvedValue({ settings: {} });
    writePromptAsset.mockResolvedValue({
      ok: true,
      externalRef: { path: 'review.md' },
      digest: 'external-digest',
    });
    updateAccountSettingsV2WithRetry.mockResolvedValue({
      status: 'applied',
      version: 18,
      settings: { secretValue: 'must-not-appear-in-action-result' },
    });

    const deps = createCliActionDeps({
      token: credentials.token,
      credentials,
      sessionId: 'plugin-global',
      mode: 'plain',
      ctx: null,
    });

    const result = await deps.promptAssetExport?.({
      artifactId: 'prompt-1',
      machineId: 'local-machine',
      assetTypeId: 'external.prompt',
      scope: 'user',
      targetPath: 'review.md',
    });

    expect(result).toMatchObject({
      ok: true,
      externalLinkPersistence: { status: 'applied', version: 18 },
    });
    expect(JSON.stringify(result)).not.toContain('must-not-appear-in-action-result');
  });

  it('preserves a malformed present prompt-external-links root and reports typed invalid persistence', async () => {
    const credentials = {
      token: 'token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
    };
    createCliApprovalsArtifactStore.mockReturnValue({
      promptLibraryStore: {
        read: vi.fn(async () => ({
          id: 'prompt-1',
          header: { title: 'Review prompt' },
          body: JSON.stringify({ v: 1, markdown: '# Review', createdAtMs: 1, updatedAtMs: 1 }),
        })),
        update: vi.fn(async () => {}),
      },
    });
    bootstrapAccountSettingsContext.mockResolvedValue({
      settings: { promptExternalLinksV1: 'malformed-present-root' },
    });
    writePromptAsset.mockResolvedValue({
      ok: true,
      externalRef: { path: 'review.md' },
      digest: 'external-digest',
    });
    updateAccountSettingsV2WithRetry.mockResolvedValue({
      status: 'applied',
      version: 18,
      settings: {},
    });

    const deps = createCliActionDeps({
      token: credentials.token,
      credentials,
      sessionId: 'plugin-global',
      mode: 'plain',
      ctx: null,
    });

    await expect(deps.promptAssetExport?.({
      artifactId: 'prompt-1',
      machineId: 'local-machine',
      assetTypeId: 'external.prompt',
      scope: 'user',
      targetPath: 'review.md',
    })).resolves.toMatchObject({
      ok: true,
      exported: true,
      externalLinkPersistence: {
        status: 'invalid',
        reason: 'invalidValue',
      },
    });
    expect(updateAccountSettingsV2WithRetry).not.toHaveBeenCalled();
  });

  it('binds the authenticated plugin-permission operation owner into ActionExecutor deps', async () => {
    const executePermissionAction = vi.fn(async () => ({ grants: [], pendingRequests: [] }));
    createPluginPermissionGrantActionExecutor.mockReturnValue(executePermissionAction);
    const credentials = {
      token: 'token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
    };
    const deps = createCliActionDeps({
      token: credentials.token,
      credentials,
      sessionId: 'sess-current',
      mode: 'plain',
      ctx: null,
    });
    const request = {
      actionId: 'plugins.permissions.grants.list' as const,
      input: {
        pluginId: 'acme.voice',
        includeRevoked: false,
        includeResolvedRequests: false,
        limit: 50,
      },
      caller: { kind: 'plugin' as const, pluginId: 'acme.voice' },
    };

    await expect(deps.pluginPermissionGrantAction?.(request))
      .resolves.toEqual({ grants: [], pendingRequests: [] });
    expect(createPluginPermissionGrantActionExecutor).toHaveBeenCalledWith({ credentials });
    expect(executePermissionAction).toHaveBeenCalledWith(request);
  });

  it('binds the credentialed review-comment transport without defaulting a plugin principal to the user', async () => {
    const executeReviewCommentAction = vi.fn(async () => ({ items: [], cursor: null }));
    createCliReviewCommentActionExecutorFromCredentials.mockReturnValue(executeReviewCommentAction);
    const credentials = {
      token: 'token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
    };
    const deps = createCliActionDeps({
      token: credentials.token,
      credentials,
      sessionId: 'sess-current',
      mode: 'plain',
      ctx: null,
    });
    const reviewCommentPrincipal = {
      actor: { kind: 'plugin' as const, pluginId: 'acme.review' },
    };
    const signal = new AbortController().signal;

    await expect(deps.reviewCommentAction?.({
      actionId: 'reviews.comments.list',
      input: { projectId: 'project-1' },
      reviewCommentPrincipal,
      signal,
    })).resolves.toEqual({ items: [], cursor: null });

    expect(createCliReviewCommentActionExecutorFromCredentials).toHaveBeenCalledWith({ credentials });
    expect(executeReviewCommentAction).toHaveBeenCalledWith(
      'reviews.comments.list',
      { projectId: 'project-1' },
      { principal: reviewCommentPrincipal, signal },
    );
  });

  it('preserves the active transition owner result when setting a session model', async () => {
    setSessionModel.mockResolvedValue({
      ok: true,
      status: 'applied',
      sessionId: 'sess-1',
      modelId: 'model-a',
      activeSelection: {
        agentTargetKey: 'agent:happier.agent.codex/codex',
        providerConnectionId: ProviderConnectionIdSchema.parse('pc_work'),
        modelId: 'model-a',
      },
    });
    const deps = createCliActionDeps({
      token: 'token',
      credentials: {
        token: 'token',
        encryption: { type: 'legacy' as const, secret: new Uint8Array([1, 2, 3, 4]) },
      },
      sessionId: 'sess-current',
      mode: 'plain',
      ctx: null,
    });

    await expect(deps.sessionModelSet?.({
      sessionId: 'sess-1',
      modelId: 'model-a',
      providerConnectionId: ProviderConnectionIdSchema.parse('pc_work'),
    })).resolves.toEqual({
      ok: true,
      status: 'applied',
      sessionId: 'sess-1',
      modelId: 'model-a',
      activeSelection: {
        agentTargetKey: 'agent:happier.agent.codex/codex',
        providerConnectionId: 'pc_work',
        modelId: 'model-a',
      },
    });

    expect(setSessionModel).toHaveBeenCalledWith(expect.objectContaining({
      idOrPrefix: 'sess-1',
      modelId: 'model-a',
      providerConnectionId: 'pc_work',
    }));
  });

  it('preserves the inactive intent owner timestamp and structured selection', async () => {
    const selection = {
      agentTargetKey: 'agent:happier.agent.codex/codex',
      providerConnectionId: ProviderConnectionIdSchema.parse('pc_work'),
      modelId: 'model-a',
    };
    setSessionModel.mockResolvedValue({
      ok: true,
      status: 'intent_updated',
      sessionId: 'sess-1',
      modelId: 'model-a',
      selection,
      updatedAt: 123,
      metadata: { ignored: true },
      version: 7,
    });
    const deps = createCliActionDeps({
      token: 'token',
      credentials: {
        token: 'token',
        encryption: { type: 'legacy' as const, secret: new Uint8Array([1, 2, 3, 4]) },
      },
      sessionId: 'sess-current',
      mode: 'plain',
      ctx: null,
    });

    await expect(deps.sessionModelSet?.({
      sessionId: 'sess-1',
      modelId: 'model-a',
      providerConnectionId: selection.providerConnectionId,
    })).resolves.toEqual({
      ok: true,
      status: 'intent_updated',
      sessionId: 'sess-1',
      modelId: 'model-a',
      selection,
      updatedAt: 123,
    });
  });

  it('preserves exact active and requested facts when a session model transition requires restart', async () => {
    setSessionModel.mockResolvedValue({
      ok: false,
      status: 'restart_required',
      sessionId: 'sess-1',
      activeSelection: {
        agentTargetKey: 'agent:happier.agent.codex/codex',
        providerConnectionId: ProviderConnectionIdSchema.parse('pc_work'),
        modelId: 'model-old',
      },
      requestedSelection: {
        agentTargetKey: 'agent:happier.agent.codex/codex',
        providerConnectionId: ProviderConnectionIdSchema.parse('pc_other'),
        modelId: 'model-a',
      },
      reason: 'provider_source_change_requires_restart',
    });
    const deps = createCliActionDeps({
      token: 'token',
      credentials: {
        token: 'token',
        encryption: { type: 'legacy' as const, secret: new Uint8Array([1, 2, 3, 4]) },
      },
      sessionId: 'sess-current',
      mode: 'plain',
      ctx: null,
    });

    await expect(deps.sessionModelSet?.({
      sessionId: 'sess-1',
      modelId: 'model-a',
      providerConnectionId: 'pc_other',
    })).resolves.toEqual({
      ok: false,
      errorCode: 'restart_required',
      error: 'restart_required',
      details: {
        status: 'restart_required',
        activeSelection: {
          agentTargetKey: 'agent:happier.agent.codex/codex',
          providerConnectionId: 'pc_work',
          modelId: 'model-old',
        },
        requestedSelection: {
          agentTargetKey: 'agent:happier.agent.codex/codex',
          providerConnectionId: 'pc_other',
          modelId: 'model-a',
        },
        reason: 'provider_source_change_requires_restart',
      },
    });
  });

  it('settles canonical session.spawn_new with exact placement and an atomic structured initial input handoff', async () => {
    const sessionCreationTag = deriveSessionCreationTagV1({
      callerCreationNamespace: 'plugin:acme.plugin',
      creationKey: 'create-1',
    });
    const creationKey = SessionCreationKeyV1Schema.parse('create-1');
    const machineAdmissionTransport = vi.fn(async () => ({
      status: 'accepted' as const,
      localId: 'plugin-input-v1:spawn-transport',
    }));
    callMachineRpc.mockResolvedValue({
      ok: true,
      directory: '/repo/exact',
      directoryKind: 'path' as const, directoryCreationRequired: false,
      checkout: null,
    });
    createSpawnedSession.mockImplementation(async (input) => {
      const initialInputHandoff = input.buildInitialInputHandoff?.('plugin-input-v1:spawn-transport');
      expect(initialInputHandoff).toEqual({
        localId: 'plugin-input-v1:spawn-transport',
        inputAdmission: {
          provenance: {
            v: 1,
            kind: 'pluginSession',
            pluginId: 'acme.plugin',
            contributionLocalId: 'spawn',
            surface: 'unspecified',
          },
          request: {
            v: 1,
            producer: 'pluginSession',
            caller: {
              kind: 'plugin',
              pluginId: 'acme.plugin',
              contributionLocalId: 'spawn',
            },
            permission: {},
          },
        },
        meta: {
          happierStructuredInputV1: {
            v: 1,
            mentions: [{ kind: 'partner.reference', ref: 'partner:issue-42', token: '@issue' }],
            composerAttachments: [{
              v: 1,
              instanceId: 'plugin-input-v1:spawn-transport#0',
              attachment: { pluginId: 'acme.plugin', localId: 'entry' },
              key: 'forge/items:pull-request:origin:42',
              value: { v: 1, entryId: '42' },
              presentation: {
                label: 'Replace the duplicated normalizer',
                description: 'example/repository',
                typeLabel: 'Replace the duplicated normalizer',
              },
            }],
          },
        },
      });
      return {
        disposition: 'rejoined',
        sessionId: 'sess-new',
        organizationPlacement: { folderId: 'folder-1', tagIds: ['tag-a', 'tag-b'] },
        initialInput: {
          status: 'alreadyAccepted',
          localId: initialInputHandoff!.localId,
        },
        session: { id: 'sess-new' },
      };
    });
    const deps = createCliActionDeps({
      token: 'token',
      credentials: {
        token: 'token',
        encryption: {
          type: 'legacy' as const,
          secret: new Uint8Array([1, 2, 3, 4]),
        },
      },
      sessionId: 'sess-parent',
      mode: 'plain',
      ctx: null,
      happyHomeDir: '/tmp/happier-home',
      machineAdmissionTransport,
    });

    await expect(deps.sessionSpawnNew({
      creationKey,
      sessionCreationTag,
      executionTarget: {
        serverId: configuration.activeServerId,
        machineId: 'machine-exact',
      },
      directory: { kind: 'path' as const, path: '/repo/exact' },
      organizationPlacement: {
        folderId: 'folder-1',
        tagIds: ['tag-b', 'tag-a'],
      },
      agentTarget: {
        kind: 'agent',
        identity: {
          pluginId: 'happier.agent.codex',
          localId: 'codex',
        },
      },
      modelSelection: {
        v: 1,
        updatedAt: 4,
        ref: {
          agentTargetKey: 'agent:happier.agent.codex/codex',
          providerConnectionId: null,
          modelId: 'gpt-5',
        },
      },
      title: 'Atomic title',
      initialInput: {
        text: 'Inspect the repository',
        structuredInput: { v: 1, mentions: [{ kind: 'partner.reference', ref: 'partner:issue-42', token: '@issue' }] },
        attachments: [{
          attachmentLocalId: 'entry',
          value: {
            key: 'forge/items:pull-request:origin:42',
            value: { v: 1, entryId: '42' },
            presentation: {
              label: 'Replace the duplicated normalizer',
              description: 'example/repository',
            },
          },
        }],
      },
      environmentVariables: { TOKEN: 'raw-launch-value' },
      actionRequestId: 'spawn-attempt-1',
      actionCaller: {
        kind: 'plugin',
        pluginId: 'acme.plugin',
        contributionLocalId: 'spawn',
      },
      callerSurface: 'plugin',
    })).resolves.toEqual({
      type: 'success',
      disposition: 'rejoined',
      sessionId: 'sess-new',
      executionTarget: {
        serverId: configuration.activeServerId,
        machineId: 'machine-exact',
      },
      organizationPlacement: {
        folderId: 'folder-1',
        tagIds: ['tag-a', 'tag-b'],
      },
      initialInput: {
        status: 'alreadyAccepted',
        localId: expect.stringMatching(/^plugin-input-v1:/u),
      },
    });

    expect(createSpawnedSession).toHaveBeenCalledWith(expect.objectContaining({
      directory: '/repo/exact',
      machineId: 'machine-exact',
      sessionCreationTag,
      organizationPlacement: {
        folderId: 'folder-1',
        tagIds: ['tag-a', 'tag-b'],
      },
      initialTitle: 'Atomic title',
      initialInput: {
        text: 'Inspect the repository',
        structuredInput: { v: 1, mentions: [{ kind: 'partner.reference', ref: 'partner:issue-42', token: '@issue' }] },
        attachments: [{
          attachmentLocalId: 'entry',
          value: {
            key: 'forge/items:pull-request:origin:42',
            value: { v: 1, entryId: '42' },
            presentation: {
              label: 'Replace the duplicated normalizer',
              description: 'example/repository',
            },
          },
        }],
      },
      buildInitialInputHandoff: expect.any(Function),
      machineAdmissionTransport,
      spawnNonce: expect.stringMatching(/^session\.spawn_new\.action:/u),
      sessionCreationCorrespondence: expect.objectContaining({
        v: 1,
        sessionCreationTag,
        recipe: expect.objectContaining({
          execution: {
            machineId: 'machine-exact',
            directory: { kind: 'path' as const, path: '/repo/exact' },
          },
          organization: {
            folderId: 'folder-1',
            tagIds: ['tag-a', 'tag-b'],
          },
          agentTarget: {
            kind: 'agent',
            identity: {
              pluginId: 'happier.agent.codex',
              localId: 'codex',
            },
          },
        }),
      }),
    }));
    // Raw launch environment reaches the direct spawn verbatim and never the
    // server-visible creation correspondence.
    expect(createSpawnedSession.mock.calls[0]?.[0]).toMatchObject({
      environmentVariables: { TOKEN: 'raw-launch-value' },
    });
    expect(createSpawnedSession.mock.calls[0]?.[0]?.sessionCreationCorrespondence?.recipe)
      .not.toHaveProperty('environmentVariables');
    expect(createSpawnedSession.mock.calls[0]?.[0]).not.toHaveProperty('pendingFirstInput');
    expect(createSpawnedSession.mock.calls[0]?.[0]).not.toHaveProperty('tag');
    expect(createSpawnedSession.mock.calls[0]?.[0]).not.toHaveProperty('path');
    expect(callMachineRpc).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'machine-exact',
      method: RPC_METHODS.DAEMON_SESSION_CREATION_PREPARE,
      request: { directory: '/repo/exact' },
    }));
  });

  it('uses the host-private exact target transport for a portable Account server identity', async () => {
    const controller = new AbortController();
    const prepare = vi.fn(async () => ({
      ok: true as const,
      directory: '/repo/direct',
      directoryKind: 'path' as const, directoryCreationRequired: false,
      checkout: null,
    }));
    const spawnedSession = {
      spawn: vi.fn(),
      resolveSpawnSessionByNonce: vi.fn(),
    };
    createSpawnedSession.mockResolvedValue({
      disposition: 'created',
      sessionId: 'sess-direct',
      organizationPlacement: { folderId: null, tagIds: [] },
      initialInput: { status: 'notRequested' },
    });
    const deps = createCliActionDeps({
      token: 'token',
      credentials: {
        token: 'token',
        encryption: {
          type: 'legacy' as const,
          secret: new Uint8Array([1, 2, 3, 4]),
        },
      },
      sessionId: 'cli-global',
      mode: 'plain',
      ctx: null,
      sessionSpawnDirectTargetTransport: {
        machineId: 'machine-exact',
        prepare,
        spawnedSession,
      },
    });

    await expect(deps.sessionSpawnNew({
      creationKey: SessionCreationKeyV1Schema.parse('automation-run:run-1'),
      sessionCreationTag: deriveSessionCreationTagV1({
        callerCreationNamespace: 'automation:automation-1',
        creationKey: 'automation-run:run-1',
      }),
      executionTarget: {
        serverId: 'srv_account_current',
        machineId: 'machine-exact',
      },
      directory: { kind: 'path' as const, path: '/repo/direct' },
      organizationPlacement: { folderId: null, tagIds: [] },
      placementOrigin: {
        kind: 'machine_pool',
        poolId: '0191f11b-4ab2-7ef2-8dd2-268abc9c191f',
      },
      agentTarget: {
        kind: 'agent',
        identity: {
          pluginId: 'happier.agent.codex',
          localId: 'codex',
        },
      },
      connectedServices: { v: 2, bindingsByServiceId: {} },
      actionCaller: {
        kind: 'automationRun',
        automationId: 'automation-1',
        runId: 'run-1',
        cause: { kind: 'manual', invokedAt: 1 },
      },
      callerSurface: 'cli',
      signal: controller.signal,
    })).resolves.toMatchObject({
      type: 'success',
      sessionId: 'sess-direct',
    });

    expect(prepare).toHaveBeenCalledWith(
      {
        directory: { kind: 'path', path: '/repo/direct' },
        sessionCreationTag: deriveSessionCreationTagV1({
          callerCreationNamespace: 'automation:automation-1',
          creationKey: 'automation-run:run-1',
        }),
      },
      { signal: controller.signal },
    );
    expect(createSpawnedSession).toHaveBeenCalledWith(expect.objectContaining({
      directTransport: spawnedSession,
      machineId: 'machine-exact',
      placementOrigin: {
        kind: 'machine_pool',
        poolId: '0191f11b-4ab2-7ef2-8dd2-268abc9c191f',
      },
    }));
    expect(readMachineOperationProtocolCapabilitiesV1).not.toHaveBeenCalled();
    expect(callMachineRpc).not.toHaveBeenCalled();
  });

  it('passes pool origin to a remote spawn only when the target advertises support', async () => {
    const placementOrigin = {
      kind: 'machine_pool' as const,
      poolId: '0191f11b-4ab2-7ef2-8dd2-268abc9c191f',
    };
    createSpawnedSession.mockResolvedValue({
      disposition: 'created',
      sessionId: 'sess-origin',
      organizationPlacement: { folderId: null, tagIds: [] },
      initialInput: { status: 'notRequested' },
    });
    callMachineRpc.mockResolvedValue({
      ok: true,
      directory: '/repo/exact',
      directoryKind: 'path' as const, directoryCreationRequired: false,
      checkout: null,
    });
    readMachineOperationProtocolCapabilitiesV1.mockResolvedValue({
      capabilities: {
        sessionSpawn: { protocolVersions: [1] },
        sessionSpawnPlacementOrigin: { protocolVersions: [1] },
      },
      revision: 2,
    });
    const deps = createCliActionDeps({
      token: 'token',
      credentials: {
        token: 'token',
        encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3, 4]) },
      },
      sessionId: 'sess-parent',
      mode: 'plain',
      ctx: null,
    });

    await deps.sessionSpawnNew({
      creationKey: SessionCreationKeyV1Schema.parse('pool-origin-supported'),
      sessionCreationTag: deriveSessionCreationTagV1({ callerCreationNamespace: 'user', creationKey: 'pool-origin-supported' }),
      executionTarget: { serverId: configuration.activeServerId, machineId: 'machine-exact' },
      directory: { kind: 'path' as const, path: '/repo/exact' },
      placementOrigin,
      agentTarget: {
        kind: 'agent',
        identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
      },
      actionCaller: { kind: 'host' },
    });

    expect(createSpawnedSession).toHaveBeenCalledWith(expect.objectContaining({ placementOrigin }));
  });

  it('omits cosmetic pool origin before dispatch when the remote target lacks support', async () => {
    const placementOrigin = {
      kind: 'machine_pool' as const,
      poolId: '0191f11b-4ab2-7ef2-8dd2-268abc9c191f',
    };
    createSpawnedSession.mockResolvedValue({
      disposition: 'created',
      sessionId: 'sess-origin-omitted',
      organizationPlacement: { folderId: null, tagIds: [] },
      initialInput: { status: 'notRequested' },
    });
    callMachineRpc.mockResolvedValue({
      ok: true,
      directory: '/repo/exact',
      directoryKind: 'path' as const, directoryCreationRequired: false,
      checkout: null,
    });
    readMachineOperationProtocolCapabilitiesV1.mockResolvedValue({
      capabilities: { sessionSpawn: { protocolVersions: [1] } },
      revision: 1,
    });
    const deps = createCliActionDeps({
      token: 'token',
      credentials: {
        token: 'token',
        encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3, 4]) },
      },
      sessionId: 'sess-parent',
      mode: 'plain',
      ctx: null,
    });

    await deps.sessionSpawnNew({
      creationKey: SessionCreationKeyV1Schema.parse('pool-origin-unsupported'),
      sessionCreationTag: deriveSessionCreationTagV1({ callerCreationNamespace: 'user', creationKey: 'pool-origin-unsupported' }),
      executionTarget: { serverId: configuration.activeServerId, machineId: 'machine-exact' },
      directory: { kind: 'path' as const, path: '/repo/exact' },
      placementOrigin,
      agentTarget: {
        kind: 'agent',
        identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
      },
      actionCaller: { kind: 'host' },
    });

    expect(createSpawnedSession).toHaveBeenCalledWith(
      expect.not.objectContaining({ placementOrigin: expect.anything() }),
    );
  });

  it('compares Agent child-Session choices with the live parent before approval', async () => {
    const deps = createCliActionDeps({
      token: 'token',
      credentials: {
        token: 'token',
        encryption: { type: 'legacy' as const, secret: new Uint8Array([1, 2, 3, 4]) },
      },
      sessionId: 'parent-session',
      rawSession: { path: '/repo/current', machineId: 'machine-current', workDepth: 0 },
      getCurrentSessionBackendTarget: () => ({
        kind: 'backend',
        backendId: 'codex',
        sourceKind: 'built_in',
      }),
      mode: 'plain',
      ctx: null,
    });
    const policy = SessionAgentSpawnPolicyV1StrictSchema.parse({
      v: 1 as const,
      allowCustomDirectory: false,
      allowCrossMachine: false,
      allowBackendTargetOverride: false,
      allowModelOverride: false,
      allowPermissionModeOverride: false,
      allowAgentModeOverride: false,
      allowConfigOptionOverrides: false,
      allowProfileOverride: false,
      allowConnectedServicesOverride: false,
      allowMcpSelectionOverride: false,
      allowTranscriptStorageOverride: false,
      permissionCeiling: null,
    });
    const baseInput = {
      creationKey: SessionCreationKeyV1Schema.parse('agent-child'),
      executionTarget: { serverId: configuration.activeServerId, machineId: 'machine-current' },
      directory: { kind: 'path' as const, path: '/repo/current' },
      agentTarget: {
        kind: 'agent' as const,
        identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
      },
    };

    const context = await deps.resolveAgentStartContext?.({ defaultSessionId: 'parent-session', callerPermissionMode: 'default' });
    expect(context).not.toBeNull();
    if (!context) throw new Error('parent snapshot unavailable');
    const facts = { machineId: baseInput.executionTarget.machineId, directory: baseInput.directory.path, agentTarget: baseInput.agentTarget };
    expect(admitAgentStartV1(policy, { kind: 'spawn_new', facts }, context)).toMatchObject({ ok: true });
    expect(admitAgentStartV1(policy, { kind: 'spawn_new', facts: { ...facts, machineId: 'machine-other' } }, context))
      .toMatchObject({ ok: false, refusal: { code: 'policy_denied_field', field: 'executionTarget.machineId' } });
  });

  it('preserves a portable Account server identity in target-owned directory approval on the exact daemon', async () => {
    const prepare = vi.fn(async () => ({
      ok: true as const,
      directory: '/repo/new-directory',
      directoryKind: 'path' as const, directoryCreationRequired: true,
      checkout: null,
    }));
    const input = {
      creationKey: SessionCreationKeyV1Schema.parse('portable-directory-approval'),
      executionTarget: {
        serverId: 'srv_account_current',
        machineId: 'machine-exact',
      },
      directory: { kind: 'path' as const, path: '/repo/new-directory' },
      agentTarget: {
        kind: 'agent' as const,
        identity: {
          pluginId: 'happier.agent.codex',
          localId: 'codex',
        },
      },
    };
    const deps = createCliActionDeps({
      token: 'token',
      credentials: {
        token: 'token',
        encryption: {
          type: 'legacy' as const,
          secret: new Uint8Array([1, 2, 3, 4]),
        },
      },
      sessionId: 'cli-global',
      mode: 'plain',
      ctx: null,
      sessionSpawnDirectTargetTransport: {
        machineId: 'machine-exact',
        prepare,
        spawnedSession: {
          spawn: vi.fn(),
          resolveSpawnSessionByNonce: vi.fn(),
        },
      },
    });

    await expect(deps.sessionSpawnNewDirectoryApprovalPreflight?.({ input })).resolves.toEqual({
      type: 'approval_required',
      approval: {
        v: 1,
        executionTarget: input.executionTarget,
        directory: '/repo/new-directory',
      },
    });
    expect(prepare).toHaveBeenCalledWith(
      { directory: '/repo/new-directory' },
      undefined,
    );
    expect(callMachineRpc).not.toHaveBeenCalled();
  });

  it('requires exact target directory approval before the private spawn bridge can create a missing directory', async () => {
    const v2Input = {
      creationKey: SessionCreationKeyV1Schema.parse('create-missing-directory'),
      executionTarget: {
        serverId: configuration.activeServerId,
        machineId: 'machine-exact',
      },
      directory: { kind: 'path' as const, path: '/repo/new-directory' },
      agentTarget: {
        kind: 'agent' as const,
        identity: {
          pluginId: 'happier.agent.codex',
          localId: 'codex',
        },
      },
    };
    const sessionCreationTag = deriveSessionCreationTagV1({
      callerCreationNamespace: 'user',
      creationKey: v2Input.creationKey,
    });
    callMachineRpc.mockResolvedValue({
      ok: true,
      directory: '/repo/new-directory',
      directoryKind: 'path' as const, directoryCreationRequired: true,
      checkout: null,
    });
    createSpawnedSession.mockResolvedValue({
      disposition: 'created',
      sessionId: 'sess-directory-approved',
      organizationPlacement: { folderId: null, tagIds: [] },
      initialInput: { status: 'notRequested' },
      session: { id: 'sess-directory-approved' },
    });
    const deps = createCliActionDeps({
      token: 'token',
      credentials: {
        token: 'token',
        encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3, 4]) },
      },
      sessionId: 'sess-parent',
      mode: 'plain',
      ctx: null,
    });

    const preflight = await deps.sessionSpawnNewDirectoryApprovalPreflight?.({ input: v2Input });
    expect(preflight).toEqual({
      type: 'approval_required',
      approval: {
        v: 1,
        executionTarget: v2Input.executionTarget,
        directory: '/repo/new-directory',
      },
    });

    await expect(deps.sessionSpawnNew({
      ...v2Input,
      sessionCreationTag,
      actionCaller: { kind: 'host' },
    })).resolves.toEqual({
      type: 'error',
      code: 'permission_denied',
      retryable: false,
    });
    expect(createSpawnedSession).not.toHaveBeenCalled();

    await expect(deps.sessionSpawnNew({
      ...v2Input,
      sessionCreationTag,
      actionCaller: { kind: 'host' },
      sessionCreationDirectoryApproval: {
        v: 1,
        executionTarget: {
          ...v2Input.executionTarget,
          machineId: 'different-machine',
        },
        directory: '/repo/new-directory',
      },
    })).resolves.toEqual({
      type: 'error',
      code: 'permission_denied',
      retryable: false,
    });
    expect(createSpawnedSession).not.toHaveBeenCalled();

    if (!preflight || preflight.type !== 'approval_required') {
      throw new Error('expected target-owned directory approval preflight');
    }
    await expect(deps.sessionSpawnNew({
      ...v2Input,
      sessionCreationTag,
      actionCaller: { kind: 'host' },
      sessionCreationDirectoryApproval: preflight.approval,
    })).resolves.toMatchObject({
      type: 'success',
      sessionId: 'sess-directory-approved',
    });
    expect(createSpawnedSession).toHaveBeenCalledWith(expect.objectContaining({
      approvedNewDirectoryCreation: true,
      directory: '/repo/new-directory',
    }));
  });

  it('delegates a sourceContext spawn to the canonical creator as a replay-seeded creation', async () => {
    const v2Input = {
      creationKey: SessionCreationKeyV1Schema.parse('configure-from-source'),
      executionTarget: {
        serverId: configuration.activeServerId,
        machineId: 'machine-exact',
      },
      directory: { kind: 'path' as const, path: '/repo' },
      agentTarget: {
        kind: 'agent' as const,
        identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
      },
      sourceContext: {
        v: 1 as const,
        kind: 'session_replay' as const,
        sourceSessionId: 'source-session',
        forkPoint: { type: 'seq' as const, upToSeqInclusive: 12 },
      },
    };
    const sessionCreationTag = deriveSessionCreationTagV1({
      callerCreationNamespace: 'user',
      creationKey: v2Input.creationKey,
    });
    callMachineRpc.mockResolvedValue({
      ok: true,
      directory: '/repo',
      directoryKind: 'path' as const, directoryCreationRequired: false,
      checkout: null,
    });
    fetchSessionByIdCompat.mockResolvedValue({ share: null, machineId: 'machine-exact' });
    resolveReplaySeedDraft.mockResolvedValue({
      status: 'seeded',
      seedDraft: 'Continue this conversation',
      dialog: [],
      summaryText: null,
      sourceCutoffSeqInclusive: 12,
      referencedSessionMediaWorkspacePaths: [],
    });
    createSpawnedSession.mockResolvedValue({
      disposition: 'created',
      sessionId: 'sess-source-context',
      organizationPlacement: { folderId: null, tagIds: [] },
      initialInput: { status: 'notRequested' },
    });
    const deps = createCliActionDeps({
      token: 'token',
      credentials: {
        token: 'token',
        encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3, 4]) },
      },
      sessionId: 'cli-global',
      mode: 'plain',
      ctx: null,
    });

    await expect(deps.sessionSpawnNew({
      ...v2Input,
      sessionCreationTag,
      actionCaller: { kind: 'host' },
    })).resolves.toMatchObject({ type: 'success', sessionId: 'sess-source-context' });

    // The ingress must hand the resolved recipe to the canonical creator rather
    // than reacquiring any creation behaviour of its own.
    const spawnArgs = createSpawnedSession.mock.calls[0]?.[0];
    expect(spawnArgs?.replaySeededCreation).toMatchObject({
      tag: sessionCreationTag,
      sourceRecipe: { sourceSessionId: 'source-session', cutoffSeqInclusive: 12 },
    });
    expect(spawnArgs?.replaySeededCreation?.metadata).toMatchObject({
      forkV1: {
        v: 1,
        parentSessionId: 'source-session',
        parentCutoffSeqInclusive: 12,
        strategy: 'replay',
      },
      replaySeedV1: {
        v: 1,
        seedText: 'Continue this conversation',
        sourceSessionId: 'source-session',
        sourceCutoffSeqInclusive: 12,
      },
    });
    // The recipe travels inside the canonical creation identity, never as a
    // second correspondence recipe field.
    expect(spawnArgs?.sessionCreationTag).toBe(sessionCreationTag);
  });

  it('rejoins a latest sourceContext attempt without resolving latest a second time', async () => {
    const sourceContext = {
      v: 1 as const,
      kind: 'session_replay' as const,
      sourceSessionId: 'source-session',
      forkPoint: { type: 'latest' as const },
    };
    const creationKey = SessionCreationKeyV1Schema.parse('resume-source-context-latest');
    const sessionCreationTag = deriveSessionCreationTagV1({
      callerCreationNamespace: 'user',
      creationKey,
    });
    callMachineRpc.mockResolvedValue({
      ok: true,
      directory: '/repo',
      directoryKind: 'path' as const, directoryCreationRequired: false,
      checkout: null,
    });
    createSpawnedSession.mockResolvedValue({
      disposition: 'rejoined',
      sessionId: 'sess-source-context',
      organizationPlacement: { folderId: null, tagIds: [] },
      initialInput: { status: 'notRequested' },
    });
    const deps = createCliActionDeps({
      token: 'token',
      credentials: {
        token: 'token',
        encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3, 4]) },
      },
      sessionId: 'cli-global',
      mode: 'plain',
      ctx: null,
    });

    await expect(deps.sessionSpawnNew({
      creationKey,
      sessionCreationTag,
      executionTarget: {
        serverId: configuration.activeServerId,
        machineId: 'machine-exact',
      },
      directory: { kind: 'path' as const, path: '/repo' },
      agentTarget: {
        kind: 'agent',
        identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
      },
      sourceContext,
      actionRequestId: 'resume-source-context-latest-attempt',
      resumeActionRequest: true,
      actionCaller: { kind: 'host' },
    })).resolves.toMatchObject({
      type: 'success',
      disposition: 'rejoined',
      sessionId: 'sess-source-context',
    });

    expect(fetchSessionByIdCompat).not.toHaveBeenCalled();
    expect(resolveReplaySeedDraft).not.toHaveBeenCalled();
    expect(createSpawnedSession).toHaveBeenCalledWith(expect.objectContaining({
      sourceContext,
      resumeOnly: true,
    }));
    expect(createSpawnedSession.mock.calls[0]?.[0]).not.toHaveProperty('replaySeededCreation');
  });

  it('refuses a shared sourceContext before it creates a child Session', async () => {
    const v2Input = {
      creationKey: SessionCreationKeyV1Schema.parse('shared-source-context'),
      executionTarget: {
        serverId: configuration.activeServerId,
        machineId: 'machine-exact',
      },
      directory: { kind: 'path' as const, path: '/repo' },
      agentTarget: {
        kind: 'agent' as const,
        identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
      },
      sourceContext: {
        v: 1 as const,
        kind: 'session_replay' as const,
        sourceSessionId: 'shared-source-session',
        forkPoint: { type: 'latest' as const },
      },
    };
    callMachineRpc.mockResolvedValue({
      ok: true,
      directory: '/repo',
      directoryKind: 'path' as const, directoryCreationRequired: false,
      checkout: null,
    });
    fetchSessionByIdCompat.mockResolvedValue({
      share: { accessLevel: 'edit', canApprovePermissions: false },
      machineId: 'machine-exact',
    });
    resolveReplaySeedDraft.mockResolvedValue({
      status: 'seeded',
      seedDraft: 'Do not copy this shared Session.',
      dialog: [],
      summaryText: null,
      sourceCutoffSeqInclusive: 12,
      referencedSessionMediaWorkspacePaths: [],
    });
    createSpawnedSession.mockResolvedValue({
      disposition: 'created',
      sessionId: 'must-not-exist',
      organizationPlacement: { folderId: null, tagIds: [] },
      initialInput: { status: 'notRequested' },
    });
    const deps = createCliActionDeps({
      token: 'token',
      credentials: {
        token: 'token',
        encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3, 4]) },
      },
      sessionId: 'cli-global',
      mode: 'plain',
      ctx: null,
    });

    await expect(deps.sessionSpawnNew({
      ...v2Input,
      sessionCreationTag: deriveSessionCreationTagV1({
        callerCreationNamespace: 'user',
        creationKey: v2Input.creationKey,
      }),
      actionCaller: { kind: 'host' },
    })).resolves.toEqual({
      type: 'error',
      code: 'permission_denied',
      retryable: false,
    });

    expect(createSpawnedSession).not.toHaveBeenCalled();
  });

  it('omits source-local media when a direct child target is not the source machine', async () => {
    const v2Input = {
      creationKey: SessionCreationKeyV1Schema.parse('cross-machine-source-context'),
      executionTarget: {
        serverId: configuration.activeServerId,
        machineId: 'machine-exact',
      },
      directory: { kind: 'path' as const, path: '/repo' },
      agentTarget: {
        kind: 'agent' as const,
        identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
      },
      sourceContext: {
        v: 1 as const,
        kind: 'session_replay' as const,
        sourceSessionId: 'source-on-another-machine',
        forkPoint: { type: 'latest' as const },
      },
    };
    const prepare = vi.fn().mockResolvedValue({
      ok: true,
      directory: '/repo',
      directoryKind: 'path' as const, directoryCreationRequired: false,
      checkout: null,
    });
    fetchSessionByIdCompat.mockResolvedValue({ share: null, machineId: 'source-machine' });
    resolveReplaySeedDraft.mockResolvedValue({
      status: 'seeded',
      seedDraft: 'Source dialog',
      dialog: [],
      summaryText: null,
      sourceCutoffSeqInclusive: 12,
      referencedSessionMediaWorkspacePaths: ['/source-only/attachment.png'],
    });
    createSpawnedSession.mockResolvedValue({
      disposition: 'created',
      sessionId: 'sess-cross-machine-source-context',
      organizationPlacement: { folderId: null, tagIds: [] },
      initialInput: { status: 'notRequested' },
    });
    const deps = createCliActionDeps({
      token: 'token',
      credentials: {
        token: 'token',
        encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3, 4]) },
      },
      sessionId: 'cli-global',
      mode: 'plain',
      ctx: null,
      sessionSpawnDirectTargetTransport: {
        machineId: 'machine-exact',
        prepare,
        spawnedSession: {
          spawn: vi.fn(),
          resolveSpawnSessionByNonce: vi.fn(),
        },
      },
    });

    await expect(deps.sessionSpawnNew({
      ...v2Input,
      sessionCreationTag: deriveSessionCreationTagV1({
        callerCreationNamespace: 'user',
        creationKey: v2Input.creationKey,
      }),
      actionCaller: { kind: 'host' },
    })).resolves.toMatchObject({
      type: 'success',
      sessionId: 'sess-cross-machine-source-context',
    });

    const spawnArgs = createSpawnedSession.mock.calls[0]?.[0];
    expect(spawnArgs?.replaySeededCreation?.metadata).not.toHaveProperty('sessionMediaContinuityV1');
  });

  it('creates no child when the source recipe cannot be resolved', async () => {
    const v2Input = {
      creationKey: SessionCreationKeyV1Schema.parse('configure-from-unreadable-source'),
      executionTarget: {
        serverId: configuration.activeServerId,
        machineId: 'machine-exact',
      },
      directory: { kind: 'path' as const, path: '/repo' },
      agentTarget: {
        kind: 'agent' as const,
        identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
      },
      sourceContext: {
        v: 1 as const,
        kind: 'session_replay' as const,
        sourceSessionId: 'source-session',
        forkPoint: { type: 'latest' as const },
      },
    };
    const rollbackCheckout = vi.fn().mockResolvedValue(undefined);
    const prepare = vi.fn().mockResolvedValue({
      ok: true,
      directory: '/repo/.dev/worktree/replay',
      directoryKind: 'path' as const, directoryCreationRequired: false,
      checkout: {
        kind: 'git_worktree',
        finalDirectory: '/repo/.dev/worktree/replay',
        baseRef: null,
        branchMode: 'new',
        created: true,
      },
    });
    fetchSessionByIdCompat.mockResolvedValue({ share: null, machineId: 'machine-exact' });
    resolveReplaySeedDraft.mockResolvedValue({ status: 'unavailable' });
    const deps = createCliActionDeps({
      token: 'token',
      credentials: {
        token: 'token',
        encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3, 4]) },
      },
      sessionId: 'cli-global',
      mode: 'plain',
      ctx: null,
      sessionSpawnDirectTargetTransport: {
        machineId: 'machine-exact',
        prepare,
        rollbackCheckout,
        spawnedSession: {
          spawn: vi.fn(),
          resolveSpawnSessionByNonce: vi.fn(),
        },
      },
    });

    await expect(deps.sessionSpawnNew({
      ...v2Input,
      sessionCreationTag: deriveSessionCreationTagV1({
        callerCreationNamespace: 'user',
        creationKey: v2Input.creationKey,
      }),
      actionCaller: { kind: 'host' },
    })).resolves.toMatchObject({ type: 'error' });
    // Required semantics: an unresolvable source leaves the authoring draft
    // intact and commits nothing.
    expect(createSpawnedSession).not.toHaveBeenCalled();
    expect(rollbackCheckout).toHaveBeenCalledWith({
      kind: 'git_worktree',
      finalDirectory: '/repo/.dev/worktree/replay',
      baseRef: null,
      branchMode: 'new',
      created: true,
    });
  });

  it('never rolls back a reused checkout when pre-spawn source resolution fails', async () => {
    const rollbackCheckout = vi.fn().mockResolvedValue(undefined);
    fetchSessionByIdCompat.mockResolvedValue({ share: null, machineId: 'machine-exact' });
    resolveReplaySeedDraft.mockResolvedValue({ status: 'unavailable' });
    const creationKey = SessionCreationKeyV1Schema.parse('reused-unreadable-source');
    const deps = createCliActionDeps({
      token: 'token',
      credentials: {
        token: 'token',
        encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3, 4]) },
      },
      sessionId: 'cli-global',
      mode: 'plain',
      ctx: null,
      sessionSpawnDirectTargetTransport: {
        machineId: 'machine-exact',
        prepare: vi.fn().mockResolvedValue({
          ok: true,
          directory: '/repo/.dev/worktree/reused',
          directoryKind: 'path' as const, directoryCreationRequired: false,
          checkout: {
            kind: 'git_worktree',
            finalDirectory: '/repo/.dev/worktree/reused',
            baseRef: null,
            branchMode: 'existing',
            created: false,
          },
        }),
        rollbackCheckout,
        spawnedSession: {
          spawn: vi.fn(),
          resolveSpawnSessionByNonce: vi.fn(),
        },
      },
    });

    await expect(deps.sessionSpawnNew({
      creationKey,
      sessionCreationTag: deriveSessionCreationTagV1({ callerCreationNamespace: 'user', creationKey }),
      executionTarget: {
        serverId: configuration.activeServerId,
        machineId: 'machine-exact',
      },
      directory: { kind: 'path' as const, path: '/repo' },
      agentTarget: {
        kind: 'agent',
        identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
      },
      sourceContext: {
        v: 1,
        kind: 'session_replay',
        sourceSessionId: 'source-session',
        forkPoint: { type: 'latest' },
      },
      actionCaller: { kind: 'host' },
    })).resolves.toMatchObject({ type: 'error' });

    expect(rollbackCheckout).not.toHaveBeenCalled();
    expect(createSpawnedSession).not.toHaveBeenCalled();
  });

  it('rejects an opaque V2 target that disagrees with the local direct daemon', async () => {
    const prepare = vi.fn();
    const deps = createCliActionDeps({
      token: 'token',
      credentials: {
        token: 'token',
        encryption: {
          type: 'legacy' as const,
          secret: new Uint8Array([1, 2, 3, 4]),
        },
      },
      sessionId: 'cli-global',
      mode: 'plain',
      ctx: null,
      sessionSpawnDirectTargetTransport: {
        machineId: 'machine-exact',
        prepare,
        spawnedSession: {
          spawn: vi.fn(),
          resolveSpawnSessionByNonce: vi.fn(),
        },
      },
    });

    await expect(deps.sessionSpawnNew({
      creationKey: SessionCreationKeyV1Schema.parse('automation-run:run-1'),
      sessionCreationTag: deriveSessionCreationTagV1({
        callerCreationNamespace: 'automation:automation-1',
        creationKey: 'automation-run:run-1',
      }),
      executionTarget: {
        serverId: configuration.activeServerId,
        machineId: 'different-machine',
      },
      directory: { kind: 'path' as const, path: '/repo/direct' },
      organizationPlacement: { folderId: null, tagIds: [] },
      agentTarget: {
        kind: 'agent',
        identity: {
          pluginId: 'happier.agent.codex',
          localId: 'codex',
        },
      },
      actionCaller: { kind: 'host' },
    })).resolves.toEqual({
      type: 'error',
      code: 'target_unavailable',
      retryable: false,
    });

    expect(prepare).not.toHaveBeenCalled();
    expect(createSpawnedSession).not.toHaveBeenCalled();
    expect(readMachineOperationProtocolCapabilitiesV1).not.toHaveBeenCalled();
    expect(callMachineRpc).not.toHaveBeenCalled();
  });

  it('keeps the provenance-pinned V1 approval readable but refuses execution without immutable origin', async () => {
    // Current moving-predecessor grammar: remote-dev@f2a7083932fca91be5ace2437cbc330ee1c045be
    // still emits the pre-V2 flat Action shape. It remains history, but it
    // cannot establish the execution origin required for replay.
    const predecessorActionArgs = {
      tag: 'predecessor metadata label',
      agentId: 'codex',
      modelId: 'gpt-5',
      directory: '/workspace/project',
      machineId: 'machine-1',
      prompt: 'Inspect this repository.',
    } as const;
    let persistedApproval: ApprovalRequest | null = {
      v: 1,
      status: 'open',
      createdAtMs: 42,
      updatedAtMs: 42,
      createdBy: { surface: 'cli' },
      requestedSurface: 'cli',
      actionId: 'session.spawn_new',
      actionArgs: predecessorActionArgs,
      summary: 'Create session',
      serverId: configuration.activeServerId,
    };
    const approvalsGet = vi.fn(async (): Promise<ApprovalRequest | null> => persistedApproval);
    const approvalsUpdate = vi.fn(async ({ request }: Readonly<{ request: ApprovalRequest }>) => {
      persistedApproval = request;
      return { ok: true as const };
    });
    callMachineRpc.mockResolvedValue({
      ok: true,
      directory: '/workspace/project',
      directoryKind: 'path' as const, directoryCreationRequired: false,
      checkout: null,
    });
    createSpawnedSession.mockResolvedValue({
      disposition: 'created',
      sessionId: 'sess-predecessor',
      organizationPlacement: { folderId: null, tagIds: [] },
      initialInput: { status: 'notRequested' },
      session: { id: 'sess-predecessor' },
    });
    const deps = createCliActionDeps({
      token: 'token',
      credentials: {
        token: 'token',
        encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3, 4]) },
        credentialProvenance: 'stored_session',
      },
      sessionId: 'sess-parent',
      mode: 'plain',
      ctx: null,
    });
    const executor = createActionExecutor({
      ...deps,
      approvalsGet,
      approvalsUpdate,
    });

    const approvalDecision = await executor.execute('approval.request.decide', {
      artifactId: 'approval-remote-dev-1',
      decision: 'approve',
    }, { surface: 'cli', authority: 'present_user' });
    expect(approvalDecision).toMatchObject({
      ok: true,
      result: { status: 'failed', execution: { ok: false, errorCode: 'approval_stale' } },
    });

    expect(approvalsGet).toHaveBeenCalledWith({
      artifactId: 'approval-remote-dev-1',
      serverId: null,
    });
    expect(callMachineRpc).not.toHaveBeenCalled();
    expect(createSpawnedSession).not.toHaveBeenCalled();
    expect(persistedApproval).toMatchObject({ status: 'failed', execution: { ok: false, errorCode: 'approval_stale' } });
  });

  it('materializes a checkout on the exact target before correspondence and spawn', async () => {
    const sessionCreationTag = deriveSessionCreationTagV1({
      callerCreationNamespace: 'user',
      creationKey: SessionCreationKeyV1Schema.parse('create-checkout'),
    });
    callMachineRpc.mockResolvedValue({
      ok: true,
      directory: '/repo/.dev/worktree/feature-session',
      directoryKind: 'path' as const, directoryCreationRequired: false,
      checkout: {
        kind: 'git_worktree',
        finalDirectory: '/repo/.dev/worktree/feature-session',
        baseRef: 'main',
        branchMode: 'new',
      },
    });
    createSpawnedSession.mockResolvedValue({
      disposition: 'created',
      sessionId: 'sess-checkout',
      organizationPlacement: { folderId: null, tagIds: [] },
      initialInput: { status: 'notRequested' },
      session: { id: 'sess-checkout' },
    });
    const deps = createCliActionDeps({
      token: 'token',
      credentials: {
        token: 'token',
        encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3, 4]) },
      },
      sessionId: 'sess-parent',
      mode: 'plain',
      ctx: null,
    });

    await expect(deps.sessionSpawnNew({
      creationKey: SessionCreationKeyV1Schema.parse('create-checkout'),
      sessionCreationTag,
      executionTarget: {
        serverId: configuration.activeServerId,
        machineId: 'machine-exact',
      },
      directory: { kind: 'path' as const, path: '~/repo' },
      checkoutCreationDraft: {
        kind: 'git_worktree',
        displayName: 'feature-session',
        baseRef: 'main',
        branchMode: 'new',
      },
      agentTarget: {
        kind: 'agent',
        identity: {
          pluginId: 'happier.agent.codex',
          localId: 'codex',
        },
      },
      actionCaller: { kind: 'host' },
    })).resolves.toEqual(expect.objectContaining({
      type: 'success',
      disposition: 'created',
      sessionId: 'sess-checkout',
    }));

    expect(callMachineRpc).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'machine-exact',
      method: RPC_METHODS.DAEMON_SESSION_CREATION_PREPARE,
      request: {
        directory: '~/repo',
        checkoutCreationDraft: {
          kind: 'git_worktree',
          displayName: 'feature-session',
          baseRef: 'main',
          branchMode: 'new',
        },
      },
    }));
    expect(createSpawnedSession).toHaveBeenCalledWith(expect.objectContaining({
      directory: '/repo/.dev/worktree/feature-session',
      sessionCreationCorrespondence: expect.objectContaining({
        recipe: expect.objectContaining({
          execution: {
            machineId: 'machine-exact',
            directory: { kind: 'path' as const, path: '/repo/.dev/worktree/feature-session' },
          },
          checkout: {
            kind: 'git_worktree',
            finalDirectory: '/repo/.dev/worktree/feature-session',
            baseRef: 'main',
            branchMode: 'new',
          },
        }),
      }),
    }));
  });

  it('resolves a resumed Action attempt through its stable spawn nonce without submitting a second create', async () => {
    callMachineRpc.mockResolvedValue({
      ok: true,
      directory: '/repo/exact',
      directoryKind: 'path' as const, directoryCreationRequired: false,
      checkout: null,
    });
    createSpawnedSession.mockResolvedValue({
      disposition: 'rejoined',
      sessionId: 'sess-resumed',
      organizationPlacement: { folderId: null, tagIds: [] },
      initialInput: { status: 'notRequested' },
      session: { id: 'sess-resumed' },
    });
    const sessionCreationTag = deriveSessionCreationTagV1({
      callerCreationNamespace: 'user',
      creationKey: SessionCreationKeyV1Schema.parse('create-resume'),
    });
    const deps = createCliActionDeps({
      token: 'token',
      credentials: {
        token: 'token',
        encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3, 4]) },
      },
      sessionId: 'sess-parent',
      mode: 'plain',
      ctx: null,
    });

    await expect(deps.sessionSpawnNew({
      creationKey: SessionCreationKeyV1Schema.parse('create-resume'),
      sessionCreationTag,
      executionTarget: {
        serverId: configuration.activeServerId,
        machineId: 'machine-exact',
      },
      directory: { kind: 'path' as const, path: '/repo/exact' },
      agentTarget: {
        kind: 'agent',
        identity: {
          pluginId: 'happier.agent.codex',
          localId: 'codex',
        },
      },
      actionRequestId: 'resume-attempt-1',
      resumeActionRequest: true,
      actionCaller: { kind: 'host' },
    })).resolves.toEqual({
      type: 'success',
      disposition: 'rejoined',
      sessionId: 'sess-resumed',
      executionTarget: {
        serverId: configuration.activeServerId,
        machineId: 'machine-exact',
      },
      organizationPlacement: { folderId: null, tagIds: [] },
      initialInput: { status: 'notRequested' },
    });

    expect(createSpawnedSession).toHaveBeenCalledWith(expect.objectContaining({
      spawnNonce: expect.stringMatching(/^session\.spawn_new\.action:/u),
      resumeOnly: true,
    }));
  });

  it('preserves an admitted-but-unresolved spawn as pending with an unknown outcome', async () => {
    callMachineRpc.mockResolvedValue({
      ok: true,
      directory: '/repo/exact',
      directoryKind: 'path' as const, directoryCreationRequired: false,
      checkout: {
        kind: 'git_worktree',
        finalDirectory: '/repo/exact',
        baseRef: null,
        branchMode: 'new',
        created: true,
      },
    });
    const error = new Error('Timed out waiting for the child Session webhook');
    (error as Error & { code: string }).code = 'SESSION_WEBHOOK_TIMEOUT';
    createSpawnedSession.mockRejectedValue(error);
    const sessionCreationTag = deriveSessionCreationTagV1({
      callerCreationNamespace: 'user',
      creationKey: SessionCreationKeyV1Schema.parse('create-outcome-unknown'),
    });
    const deps = createCliActionDeps({
      token: 'token',
      credentials: {
        token: 'token',
        encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3, 4]) },
      },
      sessionId: 'sess-parent',
      mode: 'plain',
      ctx: null,
    });

    await expect(deps.sessionSpawnNew({
      creationKey: SessionCreationKeyV1Schema.parse('create-outcome-unknown'),
      sessionCreationTag,
      executionTarget: {
        serverId: configuration.activeServerId,
        machineId: 'machine-exact',
      },
      directory: { kind: 'path' as const, path: '/repo/exact' },
      agentTarget: {
        kind: 'agent',
        identity: {
          pluginId: 'happier.agent.codex',
          localId: 'codex',
        },
      },
      actionCaller: { kind: 'host' },
    })).resolves.toEqual({
      type: 'pending',
      retryWithSameCreationKey: true,
      outcome: 'unknown',
    });
    expect(callMachineRpc).not.toHaveBeenCalledWith(expect.objectContaining({
      method: RPC_METHODS.SCM_WORKTREE_REMOVE,
    }));
  });

  it('maps the exact terminal organization-placement refusal without parsing message text', async () => {
    callMachineRpc.mockResolvedValue({
      ok: true,
      directory: '/repo/exact',
      directoryKind: 'path' as const, directoryCreationRequired: false,
      checkout: null,
    });
    const error = new Error('opaque daemon wording') as Error & {
      code: string;
      details: unknown;
    };
    error.code = SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED;
    error.details = {
      spawnResponse: {
        errorDetail: {
          kind: 'session_creation_organization_invalid',
          code: 'organization_invalid',
        },
      },
    };
    createSpawnedSession.mockRejectedValue(error);
    const sessionCreationTag = deriveSessionCreationTagV1({
      callerCreationNamespace: 'user',
      creationKey: SessionCreationKeyV1Schema.parse('create-invalid-placement'),
    });
    const deps = createCliActionDeps({
      token: 'token',
      credentials: {
        token: 'token',
        encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3, 4]) },
      },
      sessionId: 'sess-parent',
      mode: 'plain',
      ctx: null,
    });

    await expect(deps.sessionSpawnNew({
      creationKey: SessionCreationKeyV1Schema.parse('create-invalid-placement'),
      sessionCreationTag,
      executionTarget: {
        serverId: configuration.activeServerId,
        machineId: 'machine-exact',
      },
      directory: { kind: 'path' as const, path: '/repo/exact' },
      organizationPlacement: { folderId: 'folder-invalid', tagIds: [] },
      agentTarget: {
        kind: 'agent',
        identity: {
          pluginId: 'happier.agent.codex',
          localId: 'codex',
        },
      },
      actionCaller: { kind: 'host' },
    })).resolves.toEqual({
      type: 'error',
      code: 'organization_invalid',
      retryable: false,
    });
  });

  it('maps the exact terminal creation-correspondence conflict without parsing message text', async () => {
    callMachineRpc.mockResolvedValue({
      ok: true,
      directory: '/repo/exact',
      directoryKind: 'path' as const, directoryCreationRequired: false,
      checkout: null,
    });
    const error = new Error('opaque daemon wording') as Error & {
      code: string;
      details: unknown;
    };
    error.code = SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED;
    error.details = {
      spawnResponse: {
        errorDetail: {
          kind: 'session_creation_correspondence_conflict',
          code: 'creation_conflict',
        },
      },
    };
    createSpawnedSession.mockRejectedValue(error);
    const sessionCreationTag = deriveSessionCreationTagV1({
      callerCreationNamespace: 'user',
      creationKey: SessionCreationKeyV1Schema.parse('create-correspondence-conflict'),
    });
    const deps = createCliActionDeps({
      token: 'token',
      credentials: {
        token: 'token',
        encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3, 4]) },
      },
      sessionId: 'sess-parent',
      mode: 'plain',
      ctx: null,
    });

    await expect(deps.sessionSpawnNew({
      creationKey: SessionCreationKeyV1Schema.parse('create-correspondence-conflict'),
      sessionCreationTag,
      executionTarget: {
        serverId: configuration.activeServerId,
        machineId: 'machine-exact',
      },
      directory: { kind: 'path' as const, path: '/repo/exact' },
      agentTarget: {
        kind: 'agent',
        identity: {
          pluginId: 'happier.agent.codex',
          localId: 'codex',
        },
      },
      actionCaller: { kind: 'host' },
    })).resolves.toEqual({
      type: 'error',
      code: 'creation_conflict',
      retryable: false,
    });
  });

  it('keeps a possibly admitted spawn pending when caller cancellation races its settlement', async () => {
    callMachineRpc.mockResolvedValue({
      ok: true,
      directory: '/repo/exact',
      directoryKind: 'path' as const, directoryCreationRequired: false,
      checkout: null,
    });
    const controller = new AbortController();
    createSpawnedSession.mockImplementation(async () => {
      controller.abort();
      const error = new Error('Caller cancellation raced session-spawn submission') as Error & {
        code: string;
        details: { spawnNonce: string };
      };
      error.code = SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT;
      error.details = { spawnNonce: 'session.spawn_new.action:ambiguous' };
      throw error;
    });
    const sessionCreationTag = deriveSessionCreationTagV1({
      callerCreationNamespace: 'user',
      creationKey: SessionCreationKeyV1Schema.parse('create-cancellation-race'),
    });
    const deps = createCliActionDeps({
      token: 'token',
      credentials: {
        token: 'token',
        encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3, 4]) },
      },
      sessionId: 'sess-parent',
      mode: 'plain',
      ctx: null,
    });

    await expect(deps.sessionSpawnNew({
      creationKey: SessionCreationKeyV1Schema.parse('create-cancellation-race'),
      sessionCreationTag,
      executionTarget: {
        serverId: configuration.activeServerId,
        machineId: 'machine-exact',
      },
      directory: { kind: 'path' as const, path: '/repo/exact' },
      agentTarget: {
        kind: 'agent',
        identity: {
          pluginId: 'happier.agent.codex',
          localId: 'codex',
        },
      },
      actionCaller: { kind: 'host' },
      signal: controller.signal,
    })).resolves.toEqual({
      type: 'pending',
      retryWithSameCreationKey: true,
      outcome: 'unknown',
    });
  });

  it('returns a typed pre-submission target failure when preparation times out without spawning', async () => {
    callMachineRpc.mockRejectedValue(Object.assign(
      new Error('Machine RPC call timeout'),
      { code: 'MACHINE_RPC_TIMEOUT' },
    ));
    const sessionCreationTag = deriveSessionCreationTagV1({
      callerCreationNamespace: 'user',
      creationKey: SessionCreationKeyV1Schema.parse('create-preparation-timeout'),
    });
    const deps = createCliActionDeps({
      token: 'token',
      credentials: {
        token: 'token',
        encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3, 4]) },
      },
      sessionId: 'sess-parent',
      mode: 'plain',
      ctx: null,
    });

    await expect(deps.sessionSpawnNew({
      creationKey: SessionCreationKeyV1Schema.parse('create-preparation-timeout'),
      sessionCreationTag,
      executionTarget: {
        serverId: configuration.activeServerId,
        machineId: 'machine-exact',
      },
      directory: { kind: 'path' as const, path: '~/repo' },
      checkoutCreationDraft: {
        kind: 'git_worktree',
        displayName: 'feature-timeout',
        baseRef: null,
      },
      agentTarget: {
        kind: 'agent',
        identity: {
          pluginId: 'happier.agent.codex',
          localId: 'codex',
        },
      },
      actionCaller: { kind: 'host' },
    })).resolves.toEqual({
      type: 'error',
      code: 'machine_offline',
      retryable: true,
    });
    expect(createSpawnedSession).not.toHaveBeenCalled();
  });

  it('projects a preparation RPC authentication failure as permission denied before spawning', async () => {
    callMachineRpc.mockRejectedValue(createAuthenticationHttpStatusError(401, 'Session creation requires authentication.'));
    const sessionCreationTag = deriveSessionCreationTagV1({
      callerCreationNamespace: 'user',
      creationKey: SessionCreationKeyV1Schema.parse('create-preparation-authentication-failure'),
    });
    const deps = createCliActionDeps({
      token: 'token',
      credentials: {
        token: 'token',
        encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3, 4]) },
      },
      sessionId: 'sess-parent',
      mode: 'plain',
      ctx: null,
    });

    await expect(deps.sessionSpawnNew({
      creationKey: SessionCreationKeyV1Schema.parse('create-preparation-authentication-failure'),
      sessionCreationTag,
      executionTarget: {
        serverId: configuration.activeServerId,
        machineId: 'machine-exact',
      },
      directory: { kind: 'path' as const, path: '/repo/exact' },
      agentTarget: {
        kind: 'agent',
        identity: {
          pluginId: 'happier.agent.codex',
          localId: 'codex',
        },
      },
      actionCaller: { kind: 'host' },
    })).resolves.toEqual({
      type: 'error',
      code: 'permission_denied',
      retryable: false,
    });
    expect(createSpawnedSession).not.toHaveBeenCalled();
  });

  it('fails closed when the exact target lacks the live session-spawn handler', async () => {
    callMachineRpc.mockResolvedValue({
      ok: true,
      directory: '/repo/exact',
      directoryKind: 'path' as const, directoryCreationRequired: false,
      checkout: null,
    });
    const error = new Error('The exact machine does not expose session spawning');
    (error as Error & { code: string }).code = SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE;
    createSpawnedSession.mockRejectedValue(error);
    const sessionCreationTag = deriveSessionCreationTagV1({
      callerCreationNamespace: 'user',
      creationKey: SessionCreationKeyV1Schema.parse('create-live-capability-negative'),
    });
    const deps = createCliActionDeps({
      token: 'token',
      credentials: {
        token: 'token',
        encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3, 4]) },
      },
      sessionId: 'sess-parent',
      mode: 'plain',
      ctx: null,
    });

    await expect(deps.sessionSpawnNew({
      creationKey: SessionCreationKeyV1Schema.parse('create-live-capability-negative'),
      sessionCreationTag,
      executionTarget: {
        serverId: configuration.activeServerId,
        machineId: 'machine-exact',
      },
      directory: { kind: 'path' as const, path: '/repo/exact' },
      agentTarget: {
        kind: 'agent',
        identity: {
          pluginId: 'happier.agent.codex',
          localId: 'codex',
        },
      },
      actionCaller: { kind: 'host' },
    })).resolves.toEqual({
      type: 'error',
      code: 'incompatible_target',
      retryable: false,
    });
  });

  it('fails closed for a mismatched server or unregistered qualified Agent target', async () => {
    const sessionCreationTag = deriveSessionCreationTagV1({
      callerCreationNamespace: 'user',
      creationKey: 'create-2',
    });
    const creationKey = SessionCreationKeyV1Schema.parse('create-2');
    const deps = createCliActionDeps({
      token: 'token',
      credentials: {
        token: 'token',
        encryption: {
          type: 'legacy' as const,
          secret: new Uint8Array([1, 2, 3, 4]),
        },
      },
      sessionId: 'sess-parent',
      mode: 'plain',
      ctx: null,
    });
    const base = {
      creationKey,
      sessionCreationTag,
      executionTarget: {
        serverId: 'different-server',
        machineId: 'machine-exact',
      },
      directory: { kind: 'path' as const, path: '/repo/exact' },
      agentTarget: {
        kind: 'agent' as const,
        identity: {
          pluginId: PluginIdSchema.parse('happier.agent.codex'),
          localId: PluginContributionLocalIdSchema.parse('codex'),
        },
      },
      actionCaller: { kind: 'host' as const },
    };

    await expect(deps.sessionSpawnNew(base)).resolves.toEqual({
      type: 'error',
      code: 'target_unavailable',
      retryable: false,
    });
    expect(createSpawnedSession).not.toHaveBeenCalled();

    await expect(deps.sessionSpawnNew({
      ...base,
      executionTarget: {
        serverId: configuration.activeServerId,
        machineId: 'machine-exact',
      },
      agentTarget: {
        kind: 'agent',
        identity: {
          pluginId: 'missing.plugin',
          localId: 'missing',
        },
      },
    })).resolves.toEqual({
      type: 'error',
      code: 'target_unavailable',
      retryable: false,
    });
    expect(createSpawnedSession).not.toHaveBeenCalled();
  });

  it('rejects an exact target without the persisted session-spawn capability before it can create a Session', async () => {
    readMachineOperationProtocolCapabilitiesV1.mockResolvedValue({
      capabilities: {},
      revision: 1,
    });
    const sessionCreationTag = deriveSessionCreationTagV1({
      callerCreationNamespace: 'user',
      creationKey: SessionCreationKeyV1Schema.parse('create-capability-negative'),
    });
    const credentials = {
      token: 'token',
      encryption: {
        type: 'legacy' as const,
        secret: new Uint8Array([1, 2, 3, 4]),
      },
    };
    const deps = createCliActionDeps({
      token: credentials.token,
      credentials,
      sessionId: 'sess-parent',
      mode: 'plain',
      ctx: null,
    });

    await expect(deps.sessionSpawnNew({
      creationKey: SessionCreationKeyV1Schema.parse('create-capability-negative'),
      sessionCreationTag,
      legacyMetadataLabel: 'predecessor metadata label',
      executionTarget: {
        serverId: configuration.activeServerId,
        machineId: 'machine-incompatible',
      },
      directory: { kind: 'path' as const, path: '/repo/exact' },
      agentTarget: {
        kind: 'agent',
        identity: {
          pluginId: 'happier.agent.codex',
          localId: 'codex',
        },
      },
      actionCaller: { kind: 'host' },
    })).resolves.toEqual({
      type: 'error',
      code: 'incompatible_target',
      retryable: false,
    });

    expect(readMachineOperationProtocolCapabilitiesV1).toHaveBeenCalledWith({
      credentials,
      machineId: 'machine-incompatible',
    });
    expect(createSpawnedSession).not.toHaveBeenCalled();
  });

  it('requires Session-spawn V2 before dispatching a one-launch Saved Secret overlay', async () => {
    readMachineOperationProtocolCapabilitiesV1.mockResolvedValue({
      capabilities: { sessionSpawn: { protocolVersions: [1] } },
      revision: 1,
    });
    const credentials = {
      token: 'token',
      encryption: {
        type: 'legacy' as const,
        secret: new Uint8Array([1, 2, 3, 4]),
      },
    };
    const deps = createCliActionDeps({
      token: credentials.token,
      credentials,
      sessionId: 'sess-parent',
      mode: 'plain',
      ctx: null,
    });

    await expect(deps.sessionSpawnNew({
      creationKey: SessionCreationKeyV1Schema.parse('secret-overlay-capability-negative'),
      sessionCreationTag: deriveSessionCreationTagV1({
        callerCreationNamespace: 'user',
        creationKey: 'secret-overlay-capability-negative',
      }),
      executionTarget: {
        serverId: configuration.activeServerId,
        machineId: 'machine-v1-only',
      },
      directory: { kind: 'path' as const, path: '/repo/exact' },
      agentTarget: {
        kind: 'agent',
        identity: {
          pluginId: 'happier.agent.codex',
          localId: 'codex',
        },
      },
      profileId: 'profile-1',
      secretReferenceOverlay: {
        v: 1,
        bindings: {
          API_KEY: { ref: 'happier:shared-secret:v1:resource_1', revision: 2 },
        },
      },
      actionCaller: { kind: 'host' },
    })).resolves.toEqual({
      type: 'error',
      code: 'update_required',
      retryable: false,
      details: {
        kind: 'update_required',
        operation: 'session.spawn_new',
        component: 'daemon',
        reason: 'session_secret_reference_overlay_update_required',
      },
    });

    expect(createSpawnedSession).not.toHaveBeenCalled();
  });

  it('dispatches a session.message.send hook event after a successful send', async () => {
    sendSessionMessage.mockResolvedValue({
      ok: true,
      sessionId: 'sess-1',
      localId: 'local-1',
      waited: false,
    });
    const deps = createCliActionDeps({
      token: 'token',
      credentials: {
        token: 'token',
        encryption: {
          type: 'legacy',
          secret: new Uint8Array([1, 2, 3, 4]),
        },
      },
      sessionId: 'sess-1',
      mode: 'plain',
      ctx: null,
      rawSession: {
        machineId: 'machine-1',
        path: '/repo',
        metadata: {
          workspaceId: 'workspace-1',
        },
      },
      happyHomeDir: '/tmp/happier-home',
    });

    await expect(deps.sessionSendMessage({
      context: actionContext,
      sessionId: 'sess-1',
      message: 'Hello world',
      requestedAction: { v: 1, kind: 'steer_if_active' },
      wait: true,
      timeoutSeconds: 30,
      permissionModeOverride: 'read_only',
      modelOverride: 'gpt-4o',
      providerConnectionId: ProviderConnectionIdSchema.parse('pc_work'),
      // A caller-retained durable identity must reach the send seam so a retry
      // rejoins the same pending input instead of queueing a second message.
      localId: 'retained-1',
    })).resolves.toEqual({ status: 'accepted', localId: 'local-1' });

    expect(sendSessionMessage).toHaveBeenCalledWith({
      credentials: expect.objectContaining({ token: 'token' }),
      idOrPrefix: 'sess-1',
      message: 'Hello world',
      requestedAction: { v: 1, kind: 'steer_if_active' },
      wait: true,
      timeoutMs: 30000,
      localId: 'retained-1',
      permissionModeOverride: 'read_only',
      modelSelectionInput: {
        providerConnectionId: 'pc_work',
        modelId: 'gpt-4o',
      },
    });
    expect(emitSessionLifecycleHookEvent).toHaveBeenCalledWith(expect.objectContaining({
      happyHomeDir: '/tmp/happier-home',
      eventId: 'session.message.send',
      happySessionId: 'sess-1',
      machineId: 'machine-1',
      cwd: '/repo',
      workspaceId: 'workspace-1',
      payload: {
        sessionId: 'sess-1',
        text: 'Hello world',
        source: 'user',
      },
    }));
  });

  it('sends with the exact Home feature snapshot the Session resolution is already bound to', async () => {
    sendSessionMessage.mockResolvedValue({
      ok: true,
      sessionId: 'sess-1',
      localId: 'local-1',
      waited: false,
    });
    const serverFeaturesSnapshot = {
      status: 'ready' as const,
      provenance: 'authenticated' as const,
      features: FeaturesResponseSchema.parse({
        features: {
          sessions: { enabled: true },
        },
        capabilities: {},
      }),
    };
    const deps = createCliActionDeps({
      token: 'token',
      credentials: {
        token: 'token',
        encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3, 4]) },
      },
      sessionId: 'sess-1',
      mode: 'plain',
      ctx: null,
      resolveServerFeaturesSnapshot: async () => serverFeaturesSnapshot,
    });

    await expect(deps.sessionSendMessage({
      context: actionContext,
      sessionId: 'sess-1',
      message: 'Hello collective',
      requestedAction: { v: 1, kind: 'steer_if_active' },
    })).resolves.toEqual({ status: 'accepted', localId: 'local-1' });

    expect(sendSessionMessage).toHaveBeenCalledWith(expect.objectContaining({
      idOrPrefix: 'sess-1',
      serverFeaturesSnapshot,
    }));
  });

  it('keeps a native --model default a reset instead of a structured per-message selection', async () => {
    sendSessionMessage.mockResolvedValue({
      ok: true,
      sessionId: 'sess-1',
      localId: 'local-1',
      waited: false,
    });
    const deps = createCliActionDeps({
      token: 'token',
      credentials: {
        token: 'token',
        encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3, 4]) },
      },
      sessionId: 'sess-1',
      mode: 'plain',
      ctx: null,
    });

    // `--model default` binds to the canonical `modelOverride: null` reset.
    await expect(deps.sessionSendMessage({
      context: actionContext,
      sessionId: 'sess-1',
      message: 'Reset the model',
      requestedAction: { v: 1, kind: 'steer_if_active' },
      modelOverride: null,
    })).resolves.toEqual({ status: 'accepted', localId: 'local-1' });
    expect(sendSessionMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      modelOverride: null,
    }));
    expect(sendSessionMessage.mock.lastCall?.[0]).not.toHaveProperty('modelSelectionInput');

    // A concrete native model stays a structured per-message selection.
    await expect(deps.sessionSendMessage({
      context: actionContext,
      sessionId: 'sess-1',
      message: 'Use sonnet',
      requestedAction: { v: 1, kind: 'steer_if_active' },
      modelOverride: 'claude-sonnet-4',
    })).resolves.toEqual({ status: 'accepted', localId: 'local-1' });
    expect(sendSessionMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      modelSelectionInput: { modelId: 'claude-sonnet-4' },
    }));
    expect(sendSessionMessage.mock.lastCall?.[0]).not.toHaveProperty('modelOverride');

    // A provider may publish a literal model named `default`; it is a real model.
    await expect(deps.sessionSendMessage({
      context: actionContext,
      sessionId: 'sess-1',
      message: 'Use the provider default model',
      requestedAction: { v: 1, kind: 'steer_if_active' },
      modelOverride: 'default',
      providerConnectionId: ProviderConnectionIdSchema.parse('pc_work'),
    })).resolves.toEqual({ status: 'accepted', localId: 'local-1' });
    expect(sendSessionMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      modelSelectionInput: { providerConnectionId: 'pc_work', modelId: 'default' },
    }));
  });

  it('preserves an execution-run outcomeUnknown admission instead of converting it to an Action failure', async () => {
    sendSessionMessage.mockResolvedValue({
      ok: false,
      code: 'wait_failed',
      admissionResult: {
        status: 'outcomeUnknown',
        localId: 'run-input-1',
        code: 'session_input_turn_outcome_unknown',
      },
    });
    const deps = createCliActionDeps({
      token: 'token',
      credentials: {
        token: 'token',
        encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3, 4]) },
      },
      sessionId: 'sess-1',
      mode: 'plain',
      ctx: null,
    });

    await expect(deps.sessionSendMessage({
      context: actionContext,
      sessionId: 'sess-1',
      message: 'Run this',
      recipient: { kind: 'execution_run', runId: 'run-1' },
      localId: 'run-input-1',
      requestedAction: { v: 1, kind: 'steer_if_active' },
      wait: true,
    })).resolves.toEqual({
      status: 'outcomeUnknown',
      localId: 'run-input-1',
      code: 'session_input_turn_outcome_unknown',
    });
    expect(sendSessionMessage).toHaveBeenCalledWith(expect.objectContaining({
      recipient: { kind: 'execution_run', runId: 'run-1' },
      localId: 'run-input-1',
    }));
    expect(emitSessionLifecycleHookEvent).not.toHaveBeenCalled();
  });

  it.each([
    ['failed', 'session_input_turn_failed'],
    ['cancelled', 'session_input_turn_cancelled'],
  ] as const)('preserves an exact execution-run %s settlement and admitted local id', async (status, code) => {
    sendSessionMessage.mockResolvedValue({
      ok: false,
      code: 'wait_failed',
      settlementResult: { status, localId: 'run-input-settled', code },
    });
    const deps = createCliActionDeps({
      token: 'token',
      credentials: {
        token: 'token',
        encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3, 4]) },
      },
      sessionId: 'sess-1',
      mode: 'plain',
      ctx: null,
    });

    await expect(deps.sessionSendMessage({
      context: actionContext,
      sessionId: 'sess-1',
      message: 'Run this',
      recipient: { kind: 'execution_run', runId: 'run-1' },
      localId: 'run-input-settled',
      requestedAction: { v: 1, kind: 'steer_if_active' },
      wait: true,
    })).resolves.toEqual({ status, localId: 'run-input-settled', code });
    expect(emitSessionLifecycleHookEvent).not.toHaveBeenCalled();
  });

  it('derives plugin admission identity and protected metadata from the host-stamped Action caller', async () => {
    sendSessionMessage.mockImplementation(async (request) => ({
      ok: true,
      sessionId: 'sess-1',
      localId: request.localId,
      waited: false,
      admissionResult: { status: 'accepted', localId: request.localId },
    }));
    const deps = createCliActionDeps({
      token: 'token',
      credentials: {
        token: 'token',
        encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3, 4]) },
      },
      sessionId: 'sess-1',
      mode: 'plain',
      ctx: null,
      rawSession: {
        machineId: 'machine-1',
        path: '/repo',
        metadata: { workspaceId: 'workspace-1' },
      },
      happyHomeDir: '/tmp/happier-home',
    });
    const cancellation = new AbortController();

    const result = await deps.sessionSendMessage({
      context: actionContext,
      sessionId: 'sess-1',
      message: 'Forward this',
      requestedAction: { v: 1, kind: 'steer_if_active' },
      actionCaller: {
        kind: 'plugin',
        pluginId: 'acme.channels',
        contributionLocalId: 'inbound',
      },
      callerSurface: 'mcp',
      signal: cancellation.signal,
      idempotencyKey: 'message-42',
      source: {
        sourceRef: 'channel-7',
        sourceRevisionOrEpoch: 'message-42',
        remoteApprovalMaxScope: 'request',
        requestedPermissionCeiling: 'read-only',
        externalActor: { kind: 'human', displayNameSnapshot: 'Ada' },
        contentProvenance: 'forwarded',
      },
    });

    expect(result).toEqual({
      status: 'accepted',
      localId: expect.stringMatching(/^plugin-input-v1:[A-Za-z0-9_-]{43}$/u),
    });
    expect(sendSessionMessage).toHaveBeenCalledWith(expect.objectContaining({
      signal: cancellation.signal,
      localId: expect.stringMatching(/^plugin-input-v1:[A-Za-z0-9_-]{43}$/u),
      inputAdmission: {
        provenance: {
          v: 1,
          kind: 'pluginSession',
          pluginId: 'acme.channels',
          contributionLocalId: 'inbound',
          surface: 'mcp',
          sourceRef: 'channel-7',
          sourceRevisionOrEpoch: 'message-42',
          externalActor: { kind: 'human', displayNameSnapshot: 'Ada' },
          contentProvenance: 'forwarded',
        },
        request: {
          v: 1,
          producer: 'pluginSession',
          caller: {
            kind: 'plugin',
            pluginId: 'acme.channels',
            contributionLocalId: 'inbound',
          },
          sourceAuthority: {
            mediatorPluginId: 'acme.channels',
            sourceRef: 'channel-7',
            sourceRevisionOrEpoch: 'message-42',
            remoteApprovalMaxScope: 'request',
          },
          permission: { requestedPermissionCeiling: 'read-only' },
        },
      },
    }));
    expect(emitSessionLifecycleHookEvent).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ source: 'plugin' }),
    }));
  });

  it('rejects a plugin global permission-mode override before it reaches protected Session persistence', async () => {
    sendSessionMessage.mockResolvedValue({
      ok: true,
      sessionId: 'sess-1',
      localId: 'unexpected',
      waited: false,
    });
    const deps = createCliActionDeps({
      token: 'token',
      credentials: {
        token: 'token',
        encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3, 4]) },
      },
      sessionId: 'sess-1',
      mode: 'plain',
      ctx: null,
      rawSession: {
        machineId: 'machine-1',
        path: '/repo',
        metadata: { workspaceId: 'workspace-1' },
      },
    });

    await expect(deps.sessionSendMessage({
      context: actionContext,
      sessionId: 'sess-1',
      message: 'Forward this',
      requestedAction: { v: 1, kind: 'steer_if_active' },
      actionCaller: {
        kind: 'plugin',
        pluginId: 'acme.channels',
        contributionLocalId: 'inbound',
      },
      callerSurface: 'plugin',
      idempotencyKey: 'message-42',
      permissionModeOverride: 'yolo',
      source: {
        sourceRef: 'channel-7',
        sourceRevisionOrEpoch: 'message-42',
        remoteApprovalMaxScope: 'request',
        requestedPermissionCeiling: 'read-only',
      },
    })).resolves.toEqual({
      status: 'rejected',
      code: 'session_input_invalid',
    });
    expect(sendSessionMessage).not.toHaveBeenCalled();
  });

  it('dispatches session.message.send hooks with the resolved canonical session id when invoked by prefix', async () => {
    sendSessionMessage.mockResolvedValue({
      ok: true,
      sessionId: 'sess-1',
      localId: 'local-1',
      waited: false,
    });
    const deps = createCliActionDeps({
      token: 'token',
      credentials: {
        token: 'token',
        encryption: {
          type: 'legacy',
          secret: new Uint8Array([1, 2, 3, 4]),
        },
      },
      sessionId: 'sess-1',
      mode: 'plain',
      ctx: null,
      rawSession: {
        machineId: 'machine-1',
        path: '/repo',
      },
      happyHomeDir: '/tmp/happier-home',
    });

    await expect(deps.sessionSendMessage({
      context: actionContext,
      sessionId: 'sess',
      message: 'Hello world',
      requestedAction: { v: 1, kind: 'steer_if_active' },
      wait: false,
      timeoutSeconds: 15,
    })).resolves.toEqual({ status: 'accepted', localId: 'local-1' });

    expect(sendSessionMessage).toHaveBeenCalledWith({
      credentials: expect.objectContaining({ token: 'token' }),
      idOrPrefix: 'sess',
      message: 'Hello world',
      requestedAction: { v: 1, kind: 'steer_if_active' },
      wait: false,
      timeoutMs: 15000,
    });
    expect(emitSessionLifecycleHookEvent).toHaveBeenCalledWith(expect.objectContaining({
      happyHomeDir: '/tmp/happier-home',
      eventId: 'session.message.send',
      happySessionId: 'sess-1',
      payload: {
        sessionId: 'sess-1',
        text: 'Hello world',
        source: 'user',
      },
    }));
  });

  it('dispatches session.message.send hooks with the resolved target session context', async () => {
    sendSessionMessage.mockResolvedValue({
      ok: true,
      sessionId: 'sess-target',
      localId: 'local-target',
      waited: false,
    });
    resolveSessionTransportContext.mockResolvedValue({
      ok: true,
      sessionId: 'sess-target',
      rawSession: {
        machineId: 'target-machine',
        path: '/repo/target',
        metadata: {
          workspaceId: 'target-workspace',
        },
      },
      mode: 'plain',
      ctx: null,
    });
    const deps = createCliActionDeps({
      token: 'token',
      credentials: {
        token: 'token',
        encryption: {
          type: 'legacy',
          secret: new Uint8Array([1, 2, 3, 4]),
        },
      },
      sessionId: 'sess-parent',
      mode: 'plain',
      ctx: null,
      rawSession: {
        machineId: 'parent-machine',
        path: '/repo/parent',
        metadata: {
          workspaceId: 'parent-workspace',
        },
      },
      happyHomeDir: '/tmp/happier-home',
    });

    await expect(deps.sessionSendMessage({
      context: actionContext,
      sessionId: 'sess-target',
      message: 'Hello target',
      requestedAction: { v: 1, kind: 'steer_if_active' },
    })).resolves.toEqual({ status: 'accepted', localId: 'local-target' });

    expect(resolveSessionTransportContext).toHaveBeenCalledWith(expect.objectContaining({
      idOrPrefix: 'sess-target',
    }));
    expect(emitSessionLifecycleHookEvent).toHaveBeenCalledWith(expect.objectContaining({
      happySessionId: 'sess-target',
      machineId: 'target-machine',
      cwd: '/repo/target',
      workspaceId: 'target-workspace',
      payload: {
        sessionId: 'sess-target',
        text: 'Hello target',
        source: 'user',
      },
    }));
  });

  it('routes execution-run parent-session permission responses through session permission RPC', async () => {
    resolveSessionTransportContext.mockResolvedValue({
      ok: true,
      sessionId: 'sess-1',
      rawSession: {
        metadata: {},
        agentState: {
          requests: {
            'perm-1': {
              tool: 'Write',
              arguments: {
                executionRun: {
                  responseTarget: {
                    kind: 'execution_run_host_bridge',
                    sessionId: 'sess-1',
                    runId: 'run-1',
                    callId: 'call-1',
                    sidechainId: 'sidechain-1',
                    backendId: 'opencode',
                    runtimeKind: 'server',
                    providerRequestId: 'perm-1',
                  },
                },
              },
            },
          },
        },
      },
      ctx: {
        encryptionKey: new Uint8Array([1, 2, 3, 4]),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
    });
    executeExecutionRunAction.mockResolvedValue({ ok: true });
    callSessionRpc.mockResolvedValue({ ok: true });

    const deps = createCliActionDeps({
      token: 'token',
      credentials: {
        token: 'token',
        encryption: {
          type: 'legacy',
          secret: new Uint8Array([1, 2, 3, 4]),
        },
      },
      sessionId: 'sess-1',
      mode: 'plain',
      ctx: null,
      rawSession: {
        metadata: {},
      },
    });
    const sessionPermissionRespond = deps.sessionPermissionRespond;
    expect(sessionPermissionRespond).toBeTypeOf('function');

    await expect(sessionPermissionRespond!({
      sessionId: 'sess-1',
      decision: 'allow',
      requestId: 'perm-1',
      turnId: 'turn-perm-1',
    })).resolves.toEqual({ ok: true });

    expect(callSessionRpc).toHaveBeenCalledWith(expect.objectContaining({
      token: 'token',
      sessionId: 'sess-1',
      method: 'sess-1:session.permission.respond',
      request: { id: 'perm-1', turnId: 'turn-perm-1', approved: true },
    }));
    expect(executeExecutionRunAction).not.toHaveBeenCalled();
  });

  it('routes an exact completed permission response to the canonical session handler for rejoin', async () => {
    const rawSession = {
      metadata: {},
      agentState: {
        requests: {},
        completedRequests: {
          'perm-done': {
            kind: 'permission',
            tool: 'Bash',
            status: 'approved',
          },
        },
      },
    };
    resolveSessionTransportContext.mockResolvedValue({
      ok: true,
      sessionId: 'sess-1',
      rawSession,
      ctx: {
        encryptionKey: new Uint8Array([1, 2, 3, 4]),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
    });
    callSessionRpc.mockResolvedValue({ ok: true });

    const deps = createCliActionDeps({
      token: 'token',
      credentials: {
        token: 'token',
        encryption: {
          type: 'legacy',
          secret: new Uint8Array([1, 2, 3, 4]),
        },
      },
      sessionId: 'sess-1',
      mode: 'plain',
      ctx: null,
      rawSession: {
        metadata: {},
      },
    });

    await expect(deps.sessionPermissionRespond?.({
      sessionId: 'sess-1',
      decision: 'allow',
      requestId: 'perm-done',
    })).resolves.toEqual({ ok: true });

    expect(callSessionRpc).toHaveBeenCalledTimes(1);
    expect(callSessionRpc).toHaveBeenCalledWith(expect.objectContaining({
      token: 'token',
      sessionId: 'sess-1',
      method: 'sess-1:session.permission.respond',
      request: { id: 'perm-done', approved: true },
    }));
    expect(rawSession.agentState).toEqual({
      requests: {},
      completedRequests: {
        'perm-done': {
          kind: 'permission',
          tool: 'Bash',
          status: 'approved',
        },
      },
    });
  });

  it('forwards a distinct completed permission response once for canonical conflict adjudication', async () => {
    resolveSessionTransportContext.mockResolvedValue({
      ok: true,
      sessionId: 'sess-1',
      rawSession: {
        metadata: {},
        agentState: {
          requests: {},
          completedRequests: {
            'perm-done': {
              kind: 'permission',
              tool: 'Bash',
              status: 'approved',
            },
          },
        },
      },
      ctx: {
        encryptionKey: new Uint8Array([1, 2, 3, 4]),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
    });
    callSessionRpc.mockResolvedValue({
      ok: false,
      errorCode: 'permission_request_not_found',
      errorMessage: 'permission_request_not_found',
      sessionId: 'sess-1',
    });
    const deps = createCliActionDeps({
      token: 'token',
      credentials: {
        token: 'token',
        encryption: {
          type: 'legacy',
          secret: new Uint8Array([1, 2, 3, 4]),
        },
      },
      sessionId: 'sess-1',
      mode: 'plain',
      ctx: null,
      rawSession: {
        metadata: {},
      },
    });

    await expect(deps.sessionPermissionRespond?.({
      sessionId: 'sess-1',
      decision: 'deny',
      requestId: 'perm-done',
    })).resolves.toEqual({
      ok: false,
      errorCode: 'permission_request_not_found',
      errorMessage: 'permission_request_not_found',
      sessionId: 'sess-1',
    });

    expect(callSessionRpc).toHaveBeenCalledTimes(1);
    expect(callSessionRpc).toHaveBeenCalledWith(expect.objectContaining({
      token: 'token',
      sessionId: 'sess-1',
      method: 'sess-1:session.permission.respond',
      request: { id: 'perm-done', approved: false, decision: 'denied' },
    }));
  });

  it('fails remote permission actions closed without creating an unauthenticated Session RPC path', async () => {
    const deps = createCliActionDeps({
      token: 'token',
      credentials: {
        token: 'token',
        encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3, 4]) },
      },
      sessionId: 'sess-1',
      mode: 'plain',
      ctx: null,
      rawSession: { metadata: {} },
    });
    const remoteAction = deps.sessionPermissionRemoteAction;

    expect(remoteAction).toBeTypeOf('function');
    await expect(remoteAction!({
      actionId: 'session.permission.remote.pending.list',
      input: {
        sessionId: 'sess-1',
        sourceRef: 'binding:ops',
        sourceRevisionOrEpoch: '42',
      },
      caller: {
        kind: 'plugin',
        pluginId: 'happier.channels',
        contributionLocalId: 'discord',
      },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'ownerMachineUnavailable',
      error: 'ownerMachineUnavailable',
    });

    const executor = createActionExecutor(deps);
    await expect(executor.execute(
      'session.permission.remote.pending.list',
      {
        sessionId: 'sess-1',
        sourceRef: 'binding:ops',
        sourceRevisionOrEpoch: '42',
      },
      {
        surface: 'plugin',
        actionCaller: {
          kind: 'plugin',
          pluginId: 'happier.channels',
          contributionLocalId: 'discord',
        },
      },
    )).resolves.toEqual({
      ok: false,
      errorCode: 'ownerMachineUnavailable',
      error: 'ownerMachineUnavailable',
    });

    const aborted = new AbortController();
    aborted.abort();
    await expect(remoteAction!({
      actionId: 'session.permission.remote.respond',
      input: {
        sessionId: 'sess-1',
        turnId: 'turn-request-1',
        requestId: 'request-1',
        sourceRef: 'binding:ops',
        sourceRevisionOrEpoch: '42',
        idempotencyKey: 'retry-1',
        actor: { namespace: 'discord', principalId: 'person-1' },
        decision: 'allow',
        scope: 'request',
      },
      caller: { kind: 'plugin', pluginId: 'happier.channels' },
      signal: aborted.signal,
    })).resolves.toEqual({ status: 'rejected', code: 'canceled' });
    expect(callSessionRpc).not.toHaveBeenCalled();
  });

  it('carries the pending-projection keyset continuation to and from the Session permission owner', async () => {
    // The bounded projection is only reachable page by page. If this boundary
    // drops the continuation, the owner silently re-answers the first page
    // forever and a mediator holding custody for a later request can never
    // reach it — the starvation the keyset exists to remove, with no other
    // observable symptom.
    const abort = new AbortController();
    const list = vi.fn((params: Readonly<{ cursor?: string | null }>) => (
      params.cursor === 'page-1-end'
        ? {
          requests: [{ requestId: 'remote-32', turnId: 'turn-32', createdAtMs: 33, allowedScopes: ['request'] as const }],
          truncated: false,
          nextCursor: null,
        }
        : {
          requests: [{ requestId: 'remote-00', turnId: 'turn-00', createdAtMs: 1, allowedScopes: ['request'] as const }],
          truncated: false,
          nextCursor: 'page-1-end',
        }
    ));
    const dispose = registerCurrentSessionUiBinding({
      sessionId: 'sess-keyset',
      service: {} as never,
      signal: abort.signal,
      isCurrent: () => true,
      capabilities: {
        permissionHandler: {
          handleToolCall: vi.fn(),
          listMediatedPendingRequests: list,
        } as never,
        readPermissionMode: () => 'default',
      },
    });
    const remoteAction = createCliActionDeps({
      token: 'token',
      sessionId: 'sess-unrelated',
      mode: 'plain',
      ctx: null,
    }).sessionPermissionRemoteAction;
    expect(remoteAction).toBeTypeOf('function');

    try {
      await expect(remoteAction!({
        actionId: 'session.permission.remote.pending.list',
        input: {
          sessionId: 'sess-keyset',
          sourceRef: 'binding:ops',
          sourceRevisionOrEpoch: '42',
        },
        caller: { kind: 'plugin', pluginId: 'happier.channels', contributionLocalId: 'discord' },
      })).resolves.toEqual({
        requests: [{ requestId: 'remote-00', turnId: 'turn-00', createdAtMs: 1, allowedScopes: ['request'] }],
        truncated: false,
        nextCursor: 'page-1-end',
      });

      await expect(remoteAction!({
        actionId: 'session.permission.remote.pending.list',
        input: {
          sessionId: 'sess-keyset',
          sourceRef: 'binding:ops',
          sourceRevisionOrEpoch: '42',
          cursor: 'page-1-end',
        },
        caller: { kind: 'plugin', pluginId: 'happier.channels', contributionLocalId: 'discord' },
      })).resolves.toEqual({
        requests: [{ requestId: 'remote-32', turnId: 'turn-32', createdAtMs: 33, allowedScopes: ['request'] }],
        truncated: false,
        nextCursor: null,
      });
      expect(list.mock.calls.map(([params]) => params)).toEqual([
        { mediatorPluginId: 'happier.channels', sourceRef: 'binding:ops', sourceRevisionOrEpoch: '42' },
        { mediatorPluginId: 'happier.channels', sourceRef: 'binding:ops', sourceRevisionOrEpoch: '42', cursor: 'page-1-end' },
      ]);
    } finally {
      dispose();
      abort.abort();
    }
  });

  it('routes every remote mediation operation through only the exact current Session permission owner', async () => {
    const firstAbort = new AbortController();
    const secondAbort = new AbortController();
    const firstList = vi.fn(() => ({
      requests: [{ requestId: 'first-request', turnId: 'turn-first', createdAtMs: 1, allowedScopes: ['request'] as const }],
      truncated: true,
    }));
    const secondList = vi.fn(() => ({
      requests: [{ requestId: 'second-request', turnId: 'turn-second', createdAtMs: 2, allowedScopes: ['request'] as const }],
      truncated: false,
    }));
    const firstRespond = vi.fn<
      NonNullable<CurrentSessionCapabilityBinding['permissionHandler']>['respondToMediatedPendingPermission']
    >(async () => ({
      status: 'applied' as const,
      settlementId: 'settlement-1',
      requestId: 'first-request',
      decision: 'allow' as const,
      effect: { kind: 'allowOnce' as const },
    }));
    const firstUserActionAnswer = vi.fn(async () => ({
      status: 'applied' as const,
      requestId: 'question-request',
    }));
    const firstGrants = vi.fn(async () => ({
      grants: [],
      nextCursor: null,
    }));
    const firstRevoke = vi.fn(async () => ({
      status: 'revoked' as const,
      grantId: 'grant-1',
    }));
    let firstCurrent = true;
    const register = (
      signal: AbortSignal,
      isCurrent: () => boolean,
      permissionHandler: Readonly<Record<string, unknown>>,
    ) => (
      registerCurrentSessionUiBinding({
        sessionId: 'sess-mediated',
        service: {} as never,
        signal,
        isCurrent,
        capabilities: {
          permissionHandler: {
            handleToolCall: vi.fn(),
            ...permissionHandler,
          } as never,
          readPermissionMode: () => 'default',
        },
      })
    );
    const disposeFirst = register(firstAbort.signal, () => firstCurrent, {
      listMediatedPendingRequests: firstList,
      respondToMediatedPendingPermission: firstRespond,
      respondToMediatedPendingUserAction: firstUserActionAnswer,
      listMediatedPermissionGrants: firstGrants,
      revokeMediatedPermissionGrant: firstRevoke,
    });
    const deps = createCliActionDeps({
      token: 'token',
      sessionId: 'sess-unrelated',
      mode: 'plain',
      ctx: null,
    });
    const remoteAction = deps.sessionPermissionRemoteAction;
    expect(remoteAction).toBeTypeOf('function');
    const listInput = {
      actionId: 'session.permission.remote.pending.list' as const,
      input: {
        sessionId: 'sess-mediated',
        sourceRef: 'binding:ops',
        sourceRevisionOrEpoch: '42',
      },
      caller: {
        kind: 'plugin' as const,
        pluginId: 'happier.channels',
        contributionLocalId: 'discord',
      },
    };

    try {
      await expect(remoteAction!(listInput)).resolves.toEqual({
        requests: [{ requestId: 'first-request', turnId: 'turn-first', createdAtMs: 1, allowedScopes: ['request'] }],
        truncated: true,
      });
      expect(firstList).toHaveBeenCalledWith({
        mediatorPluginId: 'happier.channels',
        sourceRef: 'binding:ops',
        sourceRevisionOrEpoch: '42',
      });

      await expect(remoteAction!({
        actionId: 'session.permission.remote.respond',
        input: {
          sessionId: 'sess-mediated',
          turnId: 'turn-first',
          requestId: 'first-request',
          sourceRef: 'binding:ops',
          sourceRevisionOrEpoch: '42',
          idempotencyKey: 'retry-1',
          actor: { namespace: 'discord', principalId: 'person-1' },
          decision: 'allow',
          scope: 'request',
        },
        caller: listInput.caller,
      })).resolves.toEqual({
        status: 'applied',
        settlementId: 'settlement-1',
        requestId: 'first-request',
        decision: 'allow',
        effect: { kind: 'allowOnce' },
      });
      expect(firstRespond).toHaveBeenCalledWith({
        sessionId: 'sess-mediated',
        turnId: 'turn-first',
        requestId: 'first-request',
        sourceRef: 'binding:ops',
        sourceRevisionOrEpoch: '42',
        idempotencyKey: 'retry-1',
        actor: { namespace: 'discord', principalId: 'person-1' },
        decision: 'allow',
        scope: 'request',
        mediator: { pluginId: 'happier.channels', contributionLocalId: 'discord' },
      });

      await expect(remoteAction!({
        actionId: 'session.user_action.remote.answer',
        input: {
          sessionId: 'sess-mediated',
          turnId: 'turn-question',
          requestId: 'question-request',
          sourceRef: 'binding:ops',
          sourceRevisionOrEpoch: '42',
          answers: [{ questionIndex: 0, values: ['fast'] }],
        },
        caller: listInput.caller,
      })).resolves.toEqual({
        status: 'applied',
        requestId: 'question-request',
      });
      expect(firstUserActionAnswer).toHaveBeenCalledWith({
        sessionId: 'sess-mediated',
        turnId: 'turn-question',
        requestId: 'question-request',
        sourceRef: 'binding:ops',
        sourceRevisionOrEpoch: '42',
        answers: [{ questionIndex: 0, values: ['fast'] }],
        mediator: { pluginId: 'happier.channels', contributionLocalId: 'discord' },
      });

      await expect(remoteAction!({
        actionId: 'session.permission.remote.grants.list',
        input: { sessionId: 'sess-mediated', limit: 50, cursor: 'page-1' },
        caller: listInput.caller,
      })).resolves.toEqual({ grants: [], nextCursor: null });
      expect(firstGrants).toHaveBeenCalledWith({
        viewer: { kind: 'mediatorPlugin', pluginId: 'happier.channels' },
        limit: 50,
        cursor: 'page-1',
      });

      await expect(remoteAction!({
        actionId: 'session.permission.remote.grants.list',
        input: { sessionId: 'sess-mediated', limit: 1 },
        caller: { kind: 'host' },
      })).resolves.toEqual({ grants: [], nextCursor: null });
      expect(firstGrants).toHaveBeenLastCalledWith({
        viewer: { kind: 'host' },
        limit: 1,
      });

      await expect(remoteAction!({
        actionId: 'session.permission.remote.grants.revoke',
        input: { sessionId: 'sess-mediated', turnId: 'turn-first', requestId: 'first-request', grantId: 'grant-1' },
        caller: listInput.caller,
      })).resolves.toEqual({ status: 'revoked', grantId: 'grant-1' });
      expect(firstRevoke).toHaveBeenCalledWith({
        turnId: 'turn-first',
        requestId: 'first-request',
        grantId: 'grant-1',
        caller: { kind: 'mediatorPlugin', pluginId: 'happier.channels' },
      });

      await expect(remoteAction!({
        actionId: 'session.permission.remote.grants.revoke',
        input: { sessionId: 'sess-mediated', turnId: 'turn-first', requestId: 'first-request', grantId: 'grant-1' },
        caller: { kind: 'host' },
      })).resolves.toEqual({ status: 'revoked', grantId: 'grant-1' });
      expect(firstRevoke).toHaveBeenLastCalledWith({
        turnId: 'turn-first',
        requestId: 'first-request',
        grantId: 'grant-1',
        caller: { kind: 'host' },
      });

      let resolveStaleRespond: (result: MediatedPermissionResponse) => void = () => {
        throw new Error('stale response resolver was not initialized');
      };
      firstRespond.mockImplementationOnce(async () => await new Promise<MediatedPermissionResponse>((resolve) => {
        resolveStaleRespond = resolve;
      }));
      const staleResponse = remoteAction!({
        actionId: 'session.permission.remote.respond',
        input: {
          sessionId: 'sess-mediated',
          turnId: 'turn-first',
          requestId: 'first-request',
          sourceRef: 'binding:ops',
          sourceRevisionOrEpoch: '42',
          idempotencyKey: 'retry-stale',
          actor: { namespace: 'discord', principalId: 'person-1' },
          decision: 'allow',
          scope: 'request',
        },
        caller: listInput.caller,
      });
      expect(firstRespond).toHaveBeenCalledTimes(2);

      const disposeSecond = register(secondAbort.signal, () => true, {
        listMediatedPendingRequests: secondList,
      });
      firstCurrent = false;
      disposeFirst();

      resolveStaleRespond({
        status: 'applied',
        settlementId: 'settlement-stale',
        requestId: 'first-request',
        decision: 'allow',
        effect: { kind: 'allowOnce' },
      });
      await expect(staleResponse).resolves.toEqual({
        status: 'rejected',
        code: 'ownerMachineUnavailable',
      });

      await expect(remoteAction!(listInput)).resolves.toEqual({
        requests: [{ requestId: 'second-request', turnId: 'turn-second', createdAtMs: 2, allowedScopes: ['request'] }],
        truncated: false,
      });
      expect(firstList).toHaveBeenCalledTimes(1);
      expect(secondList).toHaveBeenCalledTimes(1);

      secondAbort.abort();
      await expect(remoteAction!(listInput)).resolves.toEqual({
        ok: false,
        errorCode: 'ownerMachineUnavailable',
        error: 'ownerMachineUnavailable',
      });

      const invocationAbort = new AbortController();
      invocationAbort.abort();
      await expect(remoteAction!({
        ...listInput,
        signal: invocationAbort.signal,
      })).resolves.toEqual({ ok: false, errorCode: 'canceled', error: 'canceled' });
      expect(secondList).toHaveBeenCalledTimes(1);

      disposeSecond();
    } finally {
      disposeFirst();
      firstAbort.abort();
      secondAbort.abort();
    }
  });

  it('fails explicit completed user-action request ids locally instead of acknowledging stale answers', async () => {
    resolveSessionTransportContext.mockResolvedValue({
      ok: true,
      sessionId: 'sess-1',
      rawSession: {
        metadata: {},
        agentState: {
          requests: {},
          completedRequests: {
            'question-done': {
              kind: 'user_action',
              tool: 'AskUserQuestion',
              status: 'approved',
            },
          },
        },
      },
      ctx: {
        encryptionKey: new Uint8Array([1, 2, 3, 4]),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
    });
    callSessionRpc.mockResolvedValue({ ok: true });

    const deps = createCliActionDeps({
      token: 'token',
      credentials: {
        token: 'token',
        encryption: {
          type: 'legacy',
          secret: new Uint8Array([1, 2, 3, 4]),
        },
      },
      sessionId: 'sess-1',
      mode: 'plain',
      ctx: null,
      rawSession: {
        metadata: {},
      },
    });

    await expect(deps.sessionUserActionAnswer?.({
      sessionId: 'sess-1',
      requestId: 'question-done',
      answers: [{ question: 'Continue?', values: ['Yes'] }],
    })).resolves.toEqual({
      ok: false,
      errorCode: 'permission_request_not_found',
      errorMessage: 'permission_request_not_found',
      sessionId: 'sess-1',
    });

    expect(callSessionRpc).not.toHaveBeenCalled();
  });

  it.each([
    ['permission', 'sessionPermissionRespond', { decision: 'allow' }],
    ['user_action', 'sessionUserActionAnswer', { answers: [{ question: 'Continue?', values: ['Yes'] }] }],
  ] as const)('routes a trusted plugin answer to the current %s request through the live Session RPC', async (kind, depName, response) => {
    resolveSessionTransportContext.mockResolvedValue({
      ok: true,
      sessionId: 'sess-1',
      rawSession: {
        metadata: {},
        agentState: {
          requests: {
            'owned-request': {
              kind,
              tool: kind === 'permission' ? 'Bash' : 'AskUserQuestion',
              arguments: {},
              owner: { kind: 'plugin', pluginId: 'plugin.owner', runtimeId: 'plugin.owner/actions/run' },
            },
          },
          completedRequests: {},
        },
      },
      ctx: {
        encryptionKey: new Uint8Array([1, 2, 3, 4]),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
    });
    callSessionRpc.mockResolvedValue({ ok: true });
    const deps = createCliActionDeps({
      token: 'token',
      credentials: {
        token: 'token',
        encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3, 4]) },
      },
      sessionId: 'sess-1',
      mode: 'plain',
      ctx: null,
      rawSession: { metadata: {} },
    });

    await expect(deps[depName]?.({
      sessionId: 'sess-1',
      requestId: 'owned-request',
      ...response,
    } as never)).resolves.toEqual({ ok: true });
    expect(callSessionRpc).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess-1',
      method: `sess-1:${kind === 'permission' ? 'session.permission.respond' : 'session.user_action.answer'}`,
      request: expect.not.objectContaining({ requesterPluginId: expect.anything() }),
    }));
  });

  it.each([
    ['permission', 'sessionPermissionRespond', { decision: 'allow' }],
    ['user_action', 'sessionUserActionAnswer', { answers: [{ question: 'Continue?', values: ['Yes'] }] }],
  ] as const)('routes a trusted plugin answer to its own %s request with caller cancellation', async (kind, depName, response) => {
    resolveSessionTransportContext.mockResolvedValue({
      ok: true,
      sessionId: 'sess-1',
      rawSession: {
        metadata: {},
        agentState: {
          requests: {
            'owned-request': {
              kind,
              tool: kind === 'permission' ? 'Bash' : 'AskUserQuestion',
              arguments: {},
              owner: { kind: 'plugin', pluginId: 'plugin.caller', runtimeId: 'plugin.caller/actions/run' },
            },
          },
          completedRequests: {},
        },
      },
      ctx: null,
      mode: 'plain',
    });
    callSessionRpc.mockResolvedValue({ ok: true });
    const deps = createCliActionDeps({
      token: 'token',
      credentials: {
        token: 'token',
        encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3, 4]) },
      },
      sessionId: 'sess-1',
      mode: 'plain',
      ctx: null,
      rawSession: { metadata: {} },
    });
    const signal = new AbortController().signal;

    await expect(deps[depName]?.({
      sessionId: 'sess-1',
      requestId: 'owned-request',
      signal,
      ...response,
    } as never)).resolves.toEqual({ ok: true });
    expect(callSessionRpc).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess-1',
      method: `sess-1:${kind === 'permission' ? 'session.permission.respond' : 'session.user_action.answer'}`,
      signal,
    }));
  });

  it('routes terminal composer clear through the live session RPC transport', async () => {
    resolveSessionTransportContext.mockResolvedValue({
      ok: true,
      sessionId: 'sess-remote',
      rawSession: {
        metadata: {},
      },
      ctx: {
        encryptionKey: new Uint8Array([1, 2, 3, 4]),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
    });
    callSessionRpc.mockResolvedValue({ ok: true, status: 'cleared', sessionId: 'sess-remote' });

    const deps = createCliActionDeps({
      token: 'token',
      credentials: {
        token: 'token',
        encryption: {
          type: 'legacy',
          secret: new Uint8Array([1, 2, 3, 4]),
        },
      },
      sessionId: 'sess-current',
      mode: 'plain',
      ctx: null,
      rawSession: {
        metadata: {},
      },
    });

    await expect((deps as any).sessionTerminalComposerClear({
      sessionId: 'sess-remote',
      expectedStateAtMs: 42,
    })).resolves.toEqual({ ok: true, status: 'cleared', sessionId: 'sess-remote' });

    expect(callSessionRpc).toHaveBeenCalledWith(expect.objectContaining({
      token: 'token',
      sessionId: 'sess-remote',
      method: 'sess-remote:session.terminalComposer.clear',
      request: {
        sessionId: 'sess-remote',
        expectedStateAtMs: 42,
      },
    }));
  });

  it('routes inactive session goal controls with the local machine id from settings', async () => {
    resolveSessionTransportContext.mockResolvedValue({
      ok: true,
      sessionId: 'sess-remote',
      rawSession: {
        id: 'sess-remote',
        machineId: 'target-machine',
        path: '/remote/repo',
        metadata: { machineId: 'target-machine' },
      },
      ctx: {
        encryptionKey: new Uint8Array([1, 2, 3, 4]),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
    });
    routeSessionGoalControl.mockResolvedValue({ ok: true });

    const deps = createCliActionDeps({
      token: 'token',
      credentials: {
        token: 'token',
        encryption: {
          type: 'legacy',
          secret: new Uint8Array([1, 2, 3, 4]),
        },
      },
      sessionId: 'sess-current',
      mode: 'plain',
      ctx: null,
      rawSession: {
        machineId: 'target-machine',
        metadata: { machineId: 'target-machine' },
      },
    });

    await expect(deps.sessionGoalGet?.({ sessionId: 'sess-remote' })).resolves.toEqual({ ok: true });

    expect(routeSessionGoalControl).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess-remote',
      currentMachineId: 'local-machine',
    }));
  });

  it('delegates inactive usage-limit wait-resume controls to the exact target daemon', async () => {
    callMachineRpc
      .mockResolvedValueOnce({ ok: true, status: 'waiting', sessionId: 'sess-remote' })
      .mockResolvedValueOnce({ ok: true, status: 'cancelled', sessionId: 'sess-remote' });
    resolveSessionTransportContext.mockResolvedValue({
      ok: true,
      sessionId: 'sess-remote',
      rawSession: {
        id: 'sess-remote',
        active: false,
        path: '/repo',
        machineId: 'target-machine',
        metadata: { machineId: 'target-machine' },
      },
      ctx: {
        encryptionKey: new Uint8Array([1, 2, 3, 4]),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
    });
    callSessionRpc.mockResolvedValue({ ok: true, recovery: { status: 'waiting' } });

    const deps = createCliActionDeps({
      token: 'token',
      credentials: {
        token: 'token',
        encryption: {
          type: 'legacy',
          secret: new Uint8Array([1, 2, 3, 4]),
        },
      },
      sessionId: 'sess-current',
      mode: 'plain',
      ctx: null,
      rawSession: {
        metadata: {},
      },
      isUsageLimitRecoveryEnabled: async () => true,
    });

    await expect(deps.sessionUsageLimitWaitResumeEnable?.({
      sessionId: 'sess-remote',
      issueFingerprint: 'usage-limit:sess-remote:reset',
      remember: true,
      resumePromptMode: 'off',
    })).resolves.toMatchObject({ ok: true, status: 'waiting', sessionId: 'sess-remote' });
    await expect(deps.sessionUsageLimitWaitResumeCancel?.({
      sessionId: 'sess-remote',
      issueFingerprint: 'usage-limit:sess-remote:reset',
      armedAtMs: 1,
      runtimeAuthRecoveryAttemptId: 'runtime-auth-attempt:exact-1',
    })).resolves.toEqual({ ok: true, status: 'cancelled', sessionId: 'sess-remote' });
    expect(callSessionRpc).not.toHaveBeenCalled();
    expect(callMachineRpc).toHaveBeenNthCalledWith(1, {
      credentials: expect.objectContaining({ token: 'token' }),
      machineId: 'target-machine',
      method: RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_WAIT_RESUME_ENABLE,
      request: {
        sessionId: 'sess-remote',
        issueFingerprint: 'usage-limit:sess-remote:reset',
        rememberPreference: true,
        resumePromptMode: 'off',
      },
    });
    expect(callMachineRpc).toHaveBeenNthCalledWith(2, {
      credentials: expect.objectContaining({ token: 'token' }),
      machineId: 'target-machine',
      method: RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_WAIT_RESUME_CANCEL,
      request: {
        sessionId: 'sess-remote',
        issueFingerprint: 'usage-limit:sess-remote:reset',
        armedAtMs: 1,
        runtimeAuthRecoveryAttemptId: 'runtime-auth-attempt:exact-1',
      },
    });
    expect(routeSessionUsageLimitRecoveryWaitResumeEnable).not.toHaveBeenCalled();
    expect(routeSessionUsageLimitRecoveryWaitResumeCancel).not.toHaveBeenCalled();
  });

  it('fails closed on inactive target-machine mismatch without opening a local owner', async () => {
    resolveSessionTransportContext.mockResolvedValue({
      ok: true,
      sessionId: 'sess-remote',
      rawSession: {
        id: 'sess-remote',
        active: false,
        machineId: 'machine-raw',
        metadata: { machineId: 'machine-metadata' },
      },
      ctx: { encryptionKey: new Uint8Array([1, 2, 3, 4]), encryptionVariant: 'legacy' },
      mode: 'plain',
    });
    const deps = createCliActionDeps({
      token: 'token',
      credentials: {
        token: 'token',
        encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3, 4]) },
      },
      sessionId: 'sess-current',
      mode: 'plain',
      ctx: null,
      isUsageLimitRecoveryEnabled: async () => true,
    });

    await expect(deps.sessionUsageLimitCheckNow?.({ sessionId: 'sess-remote' })).resolves.toEqual({
      ok: false,
      status: 'unsupported',
      sessionId: 'sess-remote',
      errorCode: 'session_usage_limit_recovery_control_target_machine_mismatch',
    });
    expect(callMachineRpc).not.toHaveBeenCalled();
    expect(routeSessionUsageLimitRecoveryCheckNow).not.toHaveBeenCalled();
  });

  it('reports an unavailable target daemon without falling back to local persistence', async () => {
    resolveSessionTransportContext.mockResolvedValue({
      ok: true,
      sessionId: 'sess-remote',
      rawSession: {
        id: 'sess-remote',
        active: false,
        machineId: 'target-machine',
        metadata: { machineId: 'target-machine' },
      },
      ctx: { encryptionKey: new Uint8Array([1, 2, 3, 4]), encryptionVariant: 'legacy' },
      mode: 'plain',
    });
    callMachineRpc.mockRejectedValueOnce(new Error('daemon offline'));
    const deps = createCliActionDeps({
      token: 'token',
      credentials: {
        token: 'token',
        encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3, 4]) },
      },
      sessionId: 'sess-current',
      mode: 'plain',
      ctx: null,
      isUsageLimitRecoveryEnabled: async () => true,
    });

    await expect(deps.sessionUsageLimitCheckNow?.({ sessionId: 'sess-remote' })).resolves.toEqual({
      ok: false,
      status: 'session_unreachable',
      sessionId: 'sess-remote',
      errorCode: 'session_usage_limit_recovery_control_target_machine_unavailable',
    });
    expect(routeSessionUsageLimitRecoveryCheckNow).not.toHaveBeenCalled();
  });

  it('keeps independent non-daemon action compositions as daemon-RPC delegates', async () => {
    resolveSessionTransportContext.mockResolvedValue({
      ok: true,
      sessionId: 'sess-remote',
      rawSession: {
        id: 'sess-remote',
        active: false,
        machineId: 'target-machine',
        metadata: { machineId: 'target-machine' },
      },
      ctx: { encryptionKey: new Uint8Array([1, 2, 3, 4]), encryptionVariant: 'legacy' },
      mode: 'plain',
    });
    callMachineRpc.mockResolvedValue({ ok: true, status: 'waiting', sessionId: 'sess-remote' });
    const createDeps = () => createCliActionDeps({
      token: 'token',
      credentials: {
        token: 'token',
        encryption: { type: 'legacy' as const, secret: new Uint8Array([1, 2, 3, 4]) },
      },
      sessionId: 'sess-current',
      mode: 'plain' as const,
      ctx: null,
      isUsageLimitRecoveryEnabled: async () => true,
    });

    await createDeps().sessionUsageLimitCheckNow?.({ sessionId: 'sess-remote' });
    await createDeps().sessionUsageLimitCheckNow?.({ sessionId: 'sess-remote' });

    expect(callMachineRpc).toHaveBeenCalledTimes(2);
    expect(routeSessionUsageLimitRecoveryCheckNow).not.toHaveBeenCalled();
  });

  it('skips live execution-run list rpc for inactive resolved sessions', async () => {
    resolveSessionTransportContext.mockResolvedValue({
      ok: true,
      sessionId: 'sess-inactive',
      rawSession: {
        id: 'sess-inactive',
        active: false,
        metadata: {},
      },
      ctx: {
        encryptionKey: new Uint8Array([1, 2, 3, 4]),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
    });
    listExecutionRuns.mockResolvedValue({ ok: true, data: { runs: [] } });

    const deps = createCliActionDeps({
      token: 'token',
      credentials: {
        token: 'token',
        encryption: {
          type: 'legacy',
          secret: new Uint8Array([1, 2, 3, 4]),
        },
      },
      sessionId: 'sess-current',
      mode: 'plain',
      ctx: null,
      rawSession: {
        metadata: {},
      },
    });

    await expect(deps.executionRunList('sess-inactive', { limit: 5 })).resolves.toEqual({
      ok: true,
      data: { runs: [] },
    });

    expect(listExecutionRuns).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess-inactive',
      request: { limit: 5 },
      skipLiveRpc: true,
    }));
  });

  it('delegates inactive usage-limit check-now through daemon RPC when enabled', async () => {
    callMachineRpc.mockResolvedValueOnce({ ok: true, status: 'ready', sessionId: 'sess-remote' });
    resolveSessionTransportContext.mockResolvedValue({
      ok: true,
      sessionId: 'sess-remote',
      rawSession: {
        id: 'sess-remote',
        active: false,
        path: '/repo',
        machineId: 'target-machine',
        metadata: { machineId: 'target-machine' },
      },
      ctx: {
        encryptionKey: new Uint8Array([1, 2, 3, 4]),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
    });

    const deps = createCliActionDeps({
      token: 'token',
      credentials: {
        token: 'token',
        encryption: {
          type: 'legacy',
          secret: new Uint8Array([1, 2, 3, 4]),
        },
      },
      sessionId: 'sess-current',
      mode: 'plain',
      ctx: null,
      rawSession: {
        metadata: {},
      },
      isUsageLimitRecoveryEnabled: async () => true,
    });

    await expect(deps.sessionUsageLimitCheckNow?.({
      sessionId: 'sess-remote',
      agentId: ' codex ',
    })).resolves.toEqual({ ok: true, status: 'ready', sessionId: 'sess-remote' });

    expect(callSessionRpc).not.toHaveBeenCalled();
    expect(callMachineRpc).toHaveBeenCalledWith({
      credentials: expect.objectContaining({ token: 'token' }),
      machineId: 'target-machine',
      method: RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_CHECK_NOW,
      request: { sessionId: 'sess-remote', agentId: 'codex' },
    });
    expect(routeSessionUsageLimitRecoveryCheckNow).not.toHaveBeenCalled();
  });

  it('keeps active usage-limit reset-credit consumption in runner SESSION RPC custody', async () => {
    callSessionRpc.mockResolvedValueOnce({ ok: true, status: 'waiting', sessionId: 'sess-remote' });
    resolveSessionTransportContext.mockResolvedValue({
      ok: true,
      sessionId: 'sess-remote',
      rawSession: {
        id: 'sess-remote',
        active: true,
        path: '/repo',
        machineId: 'target-machine',
        metadata: { machineId: 'target-machine' },
      },
      ctx: {
        encryptionKey: new Uint8Array([1, 2, 3, 4]),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
    });
    readSettings.mockResolvedValue({ machineId: 'target-machine' });

    const deps = createCliActionDeps({
      token: 'token',
      credentials: {
        token: 'token',
        encryption: {
          type: 'legacy',
          secret: new Uint8Array([1, 2, 3, 4]),
        },
      },
      sessionId: 'sess-current',
      mode: 'plain',
      ctx: null,
      rawSession: {
        metadata: {},
      },
      isUsageLimitRecoveryEnabled: async () => true,
    });

    await expect(deps.sessionUsageLimitConsumeResetCredit?.({
      sessionId: 'sess-remote',
      agentId: ' codex ',
      resumePromptMode: 'custom',
    })).resolves.toEqual({ ok: true, status: 'waiting', sessionId: 'sess-remote' });

    expect(callSessionRpc).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess-remote',
      method: `sess-remote:${SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_CONSUME_RESET_CREDIT}`,
      request: {
        sessionId: 'sess-remote',
        agentId: 'codex',
        operation: 'consume_reset_credit',
        resumePromptMode: 'custom',
      },
    }));
    expect(callMachineRpc).not.toHaveBeenCalled();
    expect(routeSessionUsageLimitRecoveryCheckNow).not.toHaveBeenCalled();
  });

  it('keeps active usage-limit switch-account controls in runner SESSION RPC custody', async () => {
    callSessionRpc.mockResolvedValueOnce({ ok: true, status: 'waiting', sessionId: 'sess-group' });
    resolveSessionTransportContext.mockResolvedValue({
      ok: true,
      sessionId: 'sess-group',
      rawSession: {
        id: 'sess-group',
        active: true,
        latestTurnStatus: 'failed',
        lastRuntimeIssue: {
          v: 1,
          scope: 'primary_session',
          status: 'failed',
          code: 'usage_limit',
          source: 'usage_limit',
          agentId: 'codex',
          agentTurnId: 'turn-1',
          occurredAt: 1_700_000_000_000,
          usageLimit: {
            v: 1,
            resetAtMs: null,
            retryAfterMs: null,
            quotaScope: 'account',
            recoverability: 'switch_account',
            connectedService: {
              serviceId: 'openai-codex',
              profileId: 'primary',
              groupId: 'codex-main',
            },
          },
        },
        metadata: {
          machineId: 'target-machine',
        },
      },
      ctx: {
        encryptionKey: new Uint8Array([1, 2, 3, 4]),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
    });

    const deps = createCliActionDeps({
      token: 'token',
      credentials: {
        token: 'token',
        encryption: {
          type: 'legacy',
          secret: new Uint8Array([1, 2, 3, 4]),
        },
      },
      sessionId: 'sess-current',
      mode: 'plain',
      ctx: null,
      rawSession: {
        metadata: {},
      },
      isUsageLimitRecoveryEnabled: async () => true,
    });

    await expect(deps.sessionUsageLimitSwitchAccountNow?.({
      sessionId: 'sess-group',
      agentId: ' codex ',
      resumePromptMode: 'custom',
    })).resolves.toEqual({ ok: true, status: 'waiting', sessionId: 'sess-group' });

    expect(callSessionRpc).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess-group',
      method: `sess-group:${SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_CHECK_NOW}`,
      request: {
        sessionId: 'sess-group',
        agentId: 'codex',
        operation: 'switch_account_now',
        resumePromptMode: 'custom',
      },
    }));
    expect(callMachineRpc).not.toHaveBeenCalled();
    expect(routeSessionUsageLimitRecoverySwitchAccountNow).not.toHaveBeenCalled();
  });

  it('normalizes usage-limit recovery action-deps authentication failures', async () => {
    const deps = createCliActionDeps({
      token: 'token',
      sessionId: 'sess-current',
      mode: 'plain',
      ctx: null,
      rawSession: {
        metadata: {},
      },
      isUsageLimitRecoveryEnabled: async () => true,
    });

    await expect(deps.sessionUsageLimitCheckNow?.({
      sessionId: 'sess-remote',
    })).resolves.toEqual({
      ok: false,
      status: 'unsupported',
      sessionId: 'sess-remote',
      errorCode: 'not_authenticated',
    });
    expect(resolveSessionTransportContext).not.toHaveBeenCalled();
  });

  it('normalizes usage-limit recovery action-deps transport failures', async () => {
    resolveSessionTransportContext.mockResolvedValue({
      ok: false,
      code: 'session_transport_unresolved',
      candidates: [{ sessionId: 'other-session' }],
    });

    const deps = createCliActionDeps({
      token: 'token',
      credentials: {
        token: 'token',
        encryption: {
          type: 'legacy',
          secret: new Uint8Array([1, 2, 3, 4]),
        },
      },
      sessionId: 'sess-current',
      mode: 'plain',
      ctx: null,
      rawSession: {
        metadata: {},
      },
      isUsageLimitRecoveryEnabled: async () => true,
    });

    await expect(deps.sessionUsageLimitWaitResumeEnable?.({
      sessionId: 'sess-remote',
    })).resolves.toEqual({
      ok: false,
      status: 'unsupported',
      sessionId: 'sess-remote',
      errorCode: 'session_transport_unresolved',
    });
  });

  it('fails closed for usage-limit recovery controls when the feature is disabled', async () => {
    const deps = createCliActionDeps({
      token: 'token',
      credentials: {
        token: 'token',
        encryption: {
          type: 'legacy',
          secret: new Uint8Array([1, 2, 3, 4]),
        },
      },
      sessionId: 'sess-current',
      mode: 'plain',
      ctx: null,
      rawSession: {
        metadata: {},
      },
      isUsageLimitRecoveryEnabled: async () => false,
    });

    await expect(deps.sessionUsageLimitWaitResumeEnable?.({
      sessionId: 'sess-remote',
    })).resolves.toEqual({
      ok: false,
      status: 'unsupported',
      sessionId: 'sess-remote',
      errorCode: 'feature_disabled',
    });

    expect(callSessionRpc).not.toHaveBeenCalled();
  });

  it('registers subagent watches through the bounded host watcher and returns the initial snapshot', async () => {
    const subagents = Object.freeze([
      {
        id: 'subagent-1',
        parentSessionId: 'sess-1',
        origin: 'plugin',
        kind: 'custom',
        status: 'running',
        createdAt: 1,
      },
    ]);
    const unsubscribe = vi.fn();
    hostSubagentStore.watch.mockImplementation((_args, onEvent) => {
      onEvent(Object.freeze({ kind: 'snapshot', subagents }));
      return Object.freeze({ unsubscribe });
    });

    const deps = createCliActionDeps({
      token: 'token',
      credentials: {
        token: 'token',
        encryption: {
          type: 'legacy',
          secret: new Uint8Array([1, 2, 3, 4]),
        },
      },
      sessionId: 'sess-1',
      mode: 'plain',
      ctx: null,
      rawSession: {
        metadata: {},
      },
    });

    await expect(deps.subagentsWatch?.({
      parentSessionId: 'sess-1',
      id: 'subagent-1',
    })).resolves.toEqual({
      kind: 'snapshot',
      subagents,
    });

    expect(hostSubagentStore.watch).toHaveBeenCalledWith({
      parentSessionId: 'sess-1',
      id: 'subagent-1',
    }, expect.any(Function));
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(hostSubagentStore.list).not.toHaveBeenCalled();
  });

  it('derives mutating HostSubagentStore actors only from the stamped action caller', async () => {
    const store = createHostSubagentStore();
    hostSubagentStore.upsert.mockImplementation((args) => store.upsert(args));
    hostSubagentStore.updateStatus.mockImplementation((args) => store.updateStatus(args));
    hostSubagentStore.complete.mockImplementation((args) => store.complete(args));
    const deps = createCliActionDeps({
      token: 'token',
      credentials: {
        token: 'token',
        encryption: {
          type: 'legacy',
          secret: new Uint8Array([1, 2, 3, 4]),
        },
      },
      sessionId: 'sess-1',
      mode: 'plain',
      ctx: null,
      rawSession: { metadata: {} },
    });
    const executor = createActionExecutor(deps);
    const owner = {
      kind: 'plugin' as const,
      pluginId: 'happier.agent.acme',
      contributionLocalId: 'acme.sample',
    };
    // Raw subagent mutations declare `surfaces: { rpc: true }` only, so the
    // Plugin Action surface is refused by the spec owner before any dep runs
    // (`actionExecutor.subagents.test.ts`). What this test owns is the CLI's
    // actor derivation, which reads only the STAMPED caller and never the
    // surface. No production path stamps a plugin `actionCaller` on `rpc`
    // today — `plugins/runtime/invocation/services/actions.ts` is the only
    // producer of a plugin caller and always pairs it with `surface:
    // 'plugin'` — so this case pins `deriveHostSubagentActor`'s contract, not
    // a reachable flow. The reachable production plugin write is
    // `session/subagents/pluginSubagentsService.ts`, which builds its own
    // plugin actor and never passes through this dep.
    const ownerContext = { surface: 'rpc' as const, actionCaller: owner };
    const input = {
      id: 'subagent-1',
      parentSessionId: 'sess-1',
      origin: 'agent' as const,
      kind: 'native' as const,
      agentRef: { agentId: 'acme.sample' },
    };

    await expect(executor.execute('sessions.subagents.upsert', input, ownerContext)).resolves.toMatchObject({
      ok: true,
      result: { id: 'subagent-1', status: 'pending' },
    });
    await expect(executor.execute('sessions.subagents.updateStatus', {
      id: 'subagent-1',
      parentSessionId: 'sess-1',
      status: 'running',
    }, ownerContext)).resolves.toMatchObject({
      ok: true,
      result: { id: 'subagent-1', status: 'running' },
    });
    await expect(executor.execute('sessions.subagents.complete', {
      id: 'subagent-1',
      parentSessionId: 'sess-1',
      status: 'completed',
    }, ownerContext)).resolves.toMatchObject({
      ok: true,
      result: { id: 'subagent-1', status: 'completed' },
    });

    expect(hostSubagentStore.upsert).toHaveBeenCalledWith({
      actor: { kind: 'plugin', pluginId: 'happier.agent.acme', agentId: 'acme.sample' },
      input,
    });
    expect(hostSubagentStore.updateStatus).toHaveBeenCalledWith({
      actor: { kind: 'plugin', pluginId: 'happier.agent.acme', agentId: 'acme.sample' },
      id: 'subagent-1',
      parentSessionId: 'sess-1',
      status: 'running',
    });
    expect(hostSubagentStore.complete).toHaveBeenCalledWith({
      actor: { kind: 'plugin', pluginId: 'happier.agent.acme', agentId: 'acme.sample' },
      id: 'subagent-1',
      parentSessionId: 'sess-1',
      status: 'completed',
    });

    await expect(executor.execute('sessions.subagents.updateStatus', {
      id: 'subagent-1',
      parentSessionId: 'sess-1',
      status: 'running',
    }, {
      surface: 'rpc',
      actionCaller: {
        kind: 'plugin',
        pluginId: 'happier.agent.peer',
        contributionLocalId: 'peer.sample',
      },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'subagent_write_forbidden',
      error: 'subagent_write_forbidden',
    });

    const rpcInput = {
      id: 'subagent-rpc',
      parentSessionId: 'sess-1',
      origin: 'plugin' as const,
      kind: 'custom' as const,
    };
    await expect(executor.execute('sessions.subagents.upsert', rpcInput, {
      surface: 'rpc',
    })).resolves.toEqual({
      ok: false,
      errorCode: 'subagent_write_forbidden',
      error: 'subagent_write_forbidden',
    });
    expect(hostSubagentStore.upsert).toHaveBeenLastCalledWith({
      actor: { kind: 'externalRpc' },
      input: rpcInput,
    });
  });
});

describe('Session initial-access spawn settlement', () => {
  it.each([
    ['recipient_key_unavailable', false],
    ['session_access_invalid_recipient_envelope', false],
    ['session_access_subject_not_found', false],
    ['session_data_key_unavailable', false],
    ['session_access_request_failed', true],
  ] as const)('preserves %s instead of collapsing it to spawn_failed', (code, retryable) => {
    expect(projectSessionInitialAccessEnvelopeHostErrorResult(
      new SessionInitialAccessEnvelopeHostError(code),
    )).toEqual({ type: 'error', code, retryable });
  });

  it('maps authentication to the existing permission denial and ignores unrelated errors', () => {
    expect(projectSessionInitialAccessEnvelopeHostErrorResult(
      new SessionInitialAccessEnvelopeHostError('not_authenticated', 401),
    )).toEqual({ type: 'error', code: 'permission_denied', retryable: false });
    expect(projectSessionInitialAccessEnvelopeHostErrorResult(new Error('unrelated'))).toBeNull();
  });

  it.each([
    'session_access_subject_ineligible',
    'session_access_external_sharing_requires_team_admin',
    'session_access_external_sharing_disabled',
    'session_access_authentication_required',
    'session_access_authentication_unavailable',
  ] as const)('preserves the server-proven %s result as terminal', (code) => {
    expect(projectSessionInitialAccessEnvelopeHostErrorResult(
      Object.assign(new Error(code), { code, retryable: false }),
    )).toEqual({ type: 'error', code, retryable: false });
  });

  it('preserves a validated physical-host code after the Machine RPC error boundary', () => {
    const error = Object.assign(new Error('Failed to spawn session'), {
      code: 'session_access_request_failed',
    });
    expect(projectSessionInitialAccessEnvelopeHostErrorResult(error)).toEqual({
      type: 'error',
      code: 'session_access_request_failed',
      retryable: true,
    });
  });

  it.each(['initial_access', 'terminal_host'] as const)('carries %s through the real spawn dependency result', async (failure) => {
    const realCatalog = await vi.importActual<typeof import('@/agent/catalog/snapshot')>('@/agent/catalog/snapshot');
    readAgentCatalogSnapshot.mockImplementation(realCatalog.readAgentCatalogSnapshot);
    const realCreation = await vi.importActual<typeof import('@/session/services/createSpawnedSession')>(
      '@/session/services/createSpawnedSession',
    );
    createSpawnedSession.mockImplementation(realCreation.createSpawnedSession);
    lookupSessionsByTags.mockResolvedValue({ state: 'available', tags: [], sessions: [] });
    validateStoredAuthTokenAgainstActiveServer.mockResolvedValue({ state: 'valid', httpStatus: 200 });
    const spawn = vi.fn(async () => ({
      success: false as const,
      error: 'Failed to spawn session',
      errorCode: failure === 'initial_access' ? 'session_access_invalid_recipient_envelope' : 'SPAWN_FAILED',
      ...(failure === 'terminal_host' ? { errorDetail: {
        kind: 'terminal_host_unavailable' as const, host: 'herdr' as const, reason: 'installation_unavailable' as const,
      } } : {}),
    }));
    const deps = createCliActionDeps({
      token: 'token',
      credentials: {
        token: 'token',
        encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3, 4]) },
      },
      sessionId: 'sess-parent',
      mode: 'plain',
      ctx: null,
      sessionSpawnDirectTargetTransport: {
        machineId: 'machine-1',
        prepare: async () => ({
          ok: true,
          directory: '/repo',
          directoryKind: 'path' as const, directoryCreationRequired: false,
          checkout: null,
        }),
        spawnedSession: {
          spawn,
          resolveSpawnSessionByNonce: async () => ({ status: 'not_found' }),
        },
      },
    });

    const creationKey = SessionCreationKeyV1Schema.parse('initial-access-repair');
    const result = await deps.sessionSpawnNew({
      creationKey,
      sessionCreationTag: deriveSessionCreationTagV1({
        callerCreationNamespace: 'user',
        creationKey,
      }),
      executionTarget: {
        serverId: configuration.activeServerId,
        machineId: 'machine-1',
      },
      directory: { kind: 'path' as const, path: '/repo' },
      agentTarget: {
        kind: 'agent',
        identity: {
          pluginId: 'happier.agent.codex',
          localId: 'codex',
        },
      },
      initialAccess: {
        grants: [{
          subject: { kind: 'account', accountId: 'reader' },
          accessLevel: 'view',
          canApprovePermissions: false,
        }],
      },
      actionCaller: { kind: 'host' },
    });
    await expect(createSpawnedSession.mock.results.at(-1)?.value).rejects.toMatchObject({
      code: failure === 'initial_access' ? 'session_access_invalid_recipient_envelope' : 'SPAWN_FAILED',
    });
    expect(result).toEqual(failure === 'initial_access' ? {
      type: 'error',
      code: 'session_access_invalid_recipient_envelope',
      retryable: false,
    } : {
      type: 'error', code: 'incompatible_target', retryable: false,
      terminalHostError: { kind: 'terminal_host_unavailable', host: 'herdr', reason: 'installation_unavailable' },
    });
    expect(spawn).toHaveBeenCalledOnce();
  });
});

describe('createCliActionDeps session lifecycle bindings', () => {
  const credentials = {
    token: 'token',
    encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
  };

  beforeEach(() => {
    resolveSessionTransportContext.mockReset();
    callSessionRpc.mockReset();
    callMachineRpc.mockReset();
    readSettings.mockReset();
    readSettings.mockResolvedValue({ machineId: 'machine-current' });
    // Resuming an inactive Session resolves its persisted Agent against the
    // one catalog projection, so this describe owns its own catalog state
    // instead of inheriting whatever another describe left on the mock.
    readAgentCatalogSnapshot.mockReset();
    readAgentCatalogSnapshot.mockReturnValue({
      agentDefinitionsById: new Map([['claude', {
        id: 'claude',
        identity: { pluginId: 'happier.agent.claude', localId: 'claude' },
        provenance: 'first_party',
        source: { kind: 'bundled' },
        definition: {},
      }]]),
      catalogEntriesById: {
        claude: { id: 'claude' },
      },
    });
  });

  function resolveSession(active = false, metadata: Record<string, unknown> = {}) {
    resolveSessionTransportContext.mockResolvedValue({
      ok: true,
      sessionId: 'session-1',
      rawSession: {
        id: 'session-1',
        active,
        machineId: 'machine-source',
        path: '/repo',
        seq: 17,
        metadata,
      },
      accountEncryptionCurrentness: { mode: 'plain' },
      mode: 'plain',
      ctx: null,
    });
  }

  /**
   * `V2SessionRecord.metadata` is a STRING on the wire (plain JSON or
   * ciphertext) and `metadataLayoutVersion` selects shared-vs-legacy reading.
   * Owners that open OWNER metadata read through those two fields, so the
   * loose object above cannot exercise them; handoff source authority is one
   * such owner and gets the real record shape.
   */
  function resolveSessionWithStoredMetadata(
    active: boolean,
    metadata: Record<string, unknown>,
  ) {
    resolveSessionTransportContext.mockResolvedValue({
      ok: true,
      sessionId: 'session-1',
      rawSession: {
        id: 'session-1',
        active,
        machineId: 'machine-source',
        path: '/repo',
        seq: 17,
        metadata: JSON.stringify(metadata),
        metadataLayoutVersion: 0,
        ownerMetadata: null,
        encryptionMode: 'plain',
      },
      accountEncryptionCurrentness: { mode: 'plain' },
      mode: 'plain',
      ctx: null,
    });
  }

  function createDeps() {
    return createCliActionDeps({
      token: credentials.token,
      credentials,
      serverId: 'server-a',
      serverHttpBaseUrl: 'https://server-a.example.test',
      sessionId: 'session-current',
      mode: 'plain',
      ctx: null,
    });
  }

  it('routes inactive session.open through the canonical resume owner with host-stamped attempt identity', async () => {
    resolveSession(false, {
      machineId: 'machine-source',
      path: '/repo',
      runtimeDescriptorV1: { v: 1, agentId: 'claude', agent: {} },
      claudeSessionId: 'provider-session-1',
    });
    callMachineRpc.mockResolvedValue({ type: 'success', sessionId: 'session-1' });
    const signal = new AbortController().signal;

    await expect(createDeps().sessionOpen({
      sessionId: 'session-1',
      serverId: 'server-a',
      actionRequestId: 'plugin-invocation-1:session.open:1',
      signal,
    })).resolves.toEqual({
      ok: true,
      status: 'opened',
      sessionId: 'session-1',
      serverId: 'server-a',
      address: { serverId: 'server-a', sessionId: 'session-1' },
    });

    expect(callMachineRpc).toHaveBeenCalledWith(expect.objectContaining({
      credentials,
      machineId: 'machine-source',
      method: RPC_METHODS.SPAWN_HAPPY_SESSION,
      signal,
      request: expect.objectContaining({
        type: 'resume-session',
        sessionId: 'session-1',
        executionAuthorization: {
          provenance: 'user_request',
          requestId: 'plugin-invocation-1:session.open:1',
        },
      }),
    }));
  });

  it('treats an already-active session.open as satisfied without spawning another runtime', async () => {
    resolveSession(true);

    await expect(createDeps().sessionOpen({ sessionId: 'session-1', serverId: 'server-a' }))
      .resolves.toEqual({
        ok: true,
        status: 'opened',
        sessionId: 'session-1',
        serverId: 'server-a',
        address: { serverId: 'server-a', sessionId: 'session-1' },
      });

    expect(callMachineRpc).not.toHaveBeenCalled();
  });

  it('does not re-resolve an exact session.open address through a different bound Home', async () => {
    resolveSession(true);
    const deps = createCliActionDeps({
      token: credentials.token,
      credentials,
      serverId: 'server-a',
      serverHttpBaseUrl: 'https://server-a.example.test',
      sessionId: 'session-current',
      mode: 'plain',
      ctx: null,
    });

    await expect(deps.sessionOpen({ sessionId: 'session-1', serverId: 'server-b' }))
      .resolves.toEqual({ ok: false, errorCode: 'session_not_found', error: 'session_not_found' });

    expect(resolveSessionTransportContext).not.toHaveBeenCalled();
    expect(callMachineRpc).not.toHaveBeenCalled();
  });

  it('routes fork and replay continuation through the canonical machine lifecycle RPC owner', async () => {
    resolveSession(true);
    callMachineRpc
      .mockResolvedValueOnce({ ok: true, childSessionId: 'session-child' })
      .mockResolvedValueOnce({ type: 'success', sessionId: 'session-replayed' });
    const signal = new AbortController().signal;
    const deps = createDeps();

    await expect(deps.sessionFork({
      sessionId: 'session-1',
      forkPoint: { type: 'seq', upToSeqInclusive: 7 },
      strategy: 'replay',
      replaySummaryRunner: {
        v: 1,
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        modelId: 'default',
        permissionMode: 'no_tools',
      },
      replayMaxSeedChars: 12_345,
      requestId: 'fork-request-1',
      signal,
    }))
      .resolves.toEqual({ ok: true, childSessionId: 'session-child' });
    const replayInput = {
      directory: '/repo',
      backendTarget: { kind: 'backend' as const, backendId: 'claude', sourceKind: 'built_in' as const },
      approvedNewDirectoryCreation: true,
      replay: { previousSessionId: 'session-1', strategy: 'recent_messages' as const },
      signal,
    };
    await expect(deps.sessionContinueWithReplay?.(replayInput))
      .resolves.toEqual({ type: 'success', sessionId: 'session-replayed' });

    expect(callMachineRpc.mock.calls).toEqual([
      [expect.objectContaining({
        credentials,
        machineId: 'machine-source',
        method: RPC_METHODS.SESSION_FORK,
        request: {
          parentSessionId: 'session-1',
          forkPoint: { type: 'seq', upToSeqInclusive: 7 },
          strategy: 'replay',
          replaySummaryRunner: {
            v: 1,
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
            modelId: 'default',
            permissionMode: 'no_tools',
          },
          replayMaxSeedChars: 12_345,
          requestId: 'fork-request-1',
        },
        signal,
      })],
      [expect.objectContaining({
        credentials,
        machineId: 'machine-current',
        method: RPC_METHODS.SESSION_CONTINUE_WITH_REPLAY,
        request: expect.not.objectContaining({ signal: expect.anything() }),
        signal,
      })],
    ]);
  });

  it('routes rollback and checkpoint actions through the canonical live Session RPC owner', async () => {
    resolveSession(true);
    callSessionRpc.mockResolvedValue({ ok: true });
    const signal = new AbortController().signal;
    const deps = createDeps();
    const checkpointRequest = {
      v: 1 as const,
      sessionId: 'session-1',
      scopes: ['workspace' as const],
      candidate: { source: 'happier_scm' as const },
      timing: 'idle' as const,
    };
    const restoreRequest = {
      v: 1 as const,
      sessionId: 'session-1',
      scopes: ['workspace' as const],
      candidate: {
        source: 'happier_scm' as const,
        checkpointRef: 'refs/happier/checkpoints/session/turn-final/turn-1',
      },
      confirmation: { sourceChoiceConfirmed: true },
    };
    const codeRollbackRequest = {
      v: 1 as const,
      sessionId: 'session-1',
      turnId: 'turn-1',
      cwd: '/repo',
      codeMode: 'code_only_without_stash' as const,
      backupMode: 'happier_checkpoint_only' as const,
      expectedStartRef: 'refs/happier/checkpoints/session/turn-start/turn-1',
      expectedFinalRef: 'refs/happier/checkpoints/session/turn-final/turn-1',
      codeOnlyTranscriptDivergenceConfirmed: true,
    };

    await deps.sessionRollback({ sessionId: 'session-1', target: { type: 'latest_turn' }, signal });
    await deps.checkpointCodeRollback?.({ request: codeRollbackRequest, signal });
    await deps.sessionCheckpoint?.({ request: checkpointRequest, signal });
    await deps.sessionRestore?.({ request: restoreRequest, signal });

    expect(callSessionRpc.mock.calls.map(([call]) => ({
      method: call.method,
      request: call.request,
      signal: call.signal,
    }))).toEqual([
      {
        method: `session-1:${SESSION_RPC_METHODS.SESSION_ROLLBACK}`,
        request: { sessionId: 'session-1', target: { type: 'latest_turn' } },
        signal,
      },
      {
        method: `session-1:${SESSION_RPC_METHODS.SESSION_CHECKPOINT_CODE_ROLLBACK}`,
        request: codeRollbackRequest,
        signal,
      },
      {
        method: `session-1:${SESSION_RPC_METHODS.SESSION_CHECKPOINT}`,
        request: checkpointRequest,
        signal,
      },
      {
        method: `session-1:${SESSION_RPC_METHODS.SESSION_RESTORE}`,
        request: restoreRequest,
        signal,
      },
    ]);
  });

  it('host-stamps handoff source facts and routes only the high-level action to its source-machine owner', async () => {
    resolveSessionWithStoredMetadata(true, { path: '/repo' });
    callMachineRpc.mockResolvedValue({ handoffId: 'handoff-1' });
    const signal = new AbortController().signal;

    const deps = createDeps();
    const workspaceAction = {
      kind: 'relationship' as const,
      relationshipId: 'relationship-1',
      flushBeforeCommit: true,
    };
    await expect(deps.sessionHandoffStart?.({
      sessionId: 'session-1',
      targetMachineId: 'machine-target',
      targetPath: '/target/repo',
      targetSessionStorageMode: 'direct',
      workspaceAction,
      signal,
    })).resolves.toEqual({ handoffId: 'handoff-1' });

    expect(callMachineRpc).toHaveBeenCalledWith({
      credentials,
      machineId: 'machine-source',
      method: RPC_METHODS.DAEMON_SESSION_HANDOFF_START_V3,
      signal,
      request: {
        sessionId: 'session-1',
        sourceMachineId: 'machine-source',
        targetMachineId: 'machine-target',
        sessionStorageMode: 'persisted',
        targetPath: '/target/repo',
        targetSessionStorageMode: 'direct',
        preferredTransportStrategies: ['direct_peer', 'server_routed_stream'],
        workspaceAction,
      },
    });
    expect(deps.sessionHandoffPrepareTarget).toBeUndefined();
    expect(deps.sessionHandoffPrepareTargetResume).toBeUndefined();
    expect(deps.sessionHandoffCommit).toBeUndefined();
    expect(deps.sessionHandoffAbort).toBeUndefined();
  });

  /**
   * `sessionStorageMode` is stamped on the RPC that stops the source and tells
   * the target which storage to import into. A link that cannot be resolved has
   * no storage answer, and the read this path used returned the same `null` for
   * "no link" and "unusable link" — so an unusable link went out as `persisted`.
   */
  it('refuses to stamp a handoff start when the source link cannot be resolved', async () => {
    resolveSessionWithStoredMetadata(true, {
      path: '/repo',
      machineId: 'machine-source',
      externalSessionV1: {
        v: 1,
        agentId: 'codex',
        machineId: 'machine-source',
        remoteSessionId: 'remote-1',
        source: { kind: 'codexHome', home: 'user' },
        followStatusV1: { v: 1, status: 'not-a-status', updatedAtMs: 10 },
      },
    });
    const signal = new AbortController().signal;

    await expect(createDeps().sessionHandoffStart?.({
      sessionId: 'session-1',
      targetMachineId: 'machine-target',
      signal,
    })).resolves.toEqual({
      ok: false,
      errorCode: 'linked_session_invalid',
      error: 'linked_session_invalid:canonical_invalid',
    });
    expect(callMachineRpc).not.toHaveBeenCalled();
  });
});
