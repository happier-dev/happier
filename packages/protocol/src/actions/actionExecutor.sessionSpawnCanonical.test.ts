import { describe, expect, it, vi } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { z } from 'zod';

import { RPC_ERROR_CODES } from '../rpc/index.js';
import { RpcError } from '../rpc/errors.js';
import { deriveSessionCreationTagV1 } from '../sessions/creation/sessionCreationIdentityV1.js';
import { createActionExecutor } from './actionExecutor.js';
import { actionSpecToActionDefinitionV1, projectActionDefinitionForExternalDiscovery } from './actionCatalog.js';
import { getActionSpec } from './actionSpecs.js';
import type { ActionExecutorDeps } from './executor/types.js';
import type { ResolvedRolesSnapshotV1 } from '../prompts/roles/rolesV1.js';
import { API_TOKEN_FULL_GRANT_V1 } from '../auth/apiTokenGrant.js';
import { DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1 } from '../account/settings/sessionAgentSpawnPolicyV1.js';
import { ActionDefinitionV1Schema } from './actionDefinitionV1.js';

const canonicalInput = {
  creationKey: 'plugin-operation-7',
  executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
  directory: { kind: 'path', path: '/workspace/project' },
  organizationPlacement: { folderId: null, tagIds: [] },
  agentTarget: {
    kind: 'agent',
    identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
  },
} as const;

const apiSpawnInput = {
  creationKey: 'api-operation-7',
  directory: { kind: 'path', path: '/workspace/project' },
  organizationPlacement: { folderId: null, tagIds: [] },
  agentTarget: {
    kind: 'agent',
    identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
  },
} as const;

const agentStartContext = {
  caller: { kind: 'session', sessionId: 'parent-session', starterDepth: 0, turnDepth: 0 },
  baseline: { machineId: 'parent-machine', directory: canonicalInput.directory.path, configuration: { agentTarget: canonicalInput.agentTarget } },
  roles: {}, ledSubtreeSessionIds: [], workDepthLimit: 4, callerPermissionCeiling: 'yolo',
} as const;

function createExternalSpawnApprovalContext(requestId: string) {
  const target = { kind: 'machine' as const, machineId: 'machine-host' };
  const credentialId = '11111111-1111-4111-8111-111111111111';
  return {
    surface: 'api' as const,
    authority: 'account_automation' as const,
    actionCaller: { kind: 'host' as const },
    serverId: 'server-host',
    actionRequestId: requestId,
    externalActionCredential: { accountId: 'account-1', principalId: 'account-1', credentialId, grant: API_TOKEN_FULL_GRANT_V1 },
    externalActionTarget: target,
    externalActionExecutionAuthorization: {
      v: 1 as const,
      token: 'opaque-authorization',
      binding: {
        serverIdentityId: 'stable-home-1',
        accountId: 'account-1',
        principalId: 'account-1',
        credentialId,
        grant: API_TOKEN_FULL_GRANT_V1,
        machineId: target.machineId,
        actionId: 'session.spawn_new' as const,
        requestId,
        requestEnvelopeDigest: 'a'.repeat(43),
        target,
      },
    },
    signExternalActionApprovalInput: () => 'a'.repeat(86),
  };
}

describe('session.spawn_new canonical execution', () => {
  it.each([{ FEATURE_FLAG: 'enabled' }, {}])('refuses the environment policy before approval or native spawn: %j', async (environmentVariables) => {
    // Approval storage and native Session creation are genuine system boundaries.
    const approvalsCreate = vi.fn();
    const sessionSpawnNew = vi.fn();
    // Unused transport dependencies are omitted: policy rejection precedes every effect.
    const executor = createActionExecutor({ approvalsCreate, sessionSpawnNew, isActionApprovalRequired: () => true } as unknown as ActionExecutorDeps);
    expect(await executor.execute('session.spawn_new', { ...canonicalInput, environmentVariables }, {
      surface: 'agent', defaultSessionId: 'parent-session', agentStartContext,
      callerPermissionMode: 'yolo',
      causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'yolo' },
      sessionInputSource: { sourceSessionId: 'parent-session', sourceTurnId: 'parent-turn-1', via: 'action' },
      sessionAgentSpawnPolicyV1: { ...DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1, allowEnvironmentVariables: false },
    })).toMatchObject({ ok: false, errorCode: 'policy_denied_field',
      details: { code: 'policy_denied_field', field: 'environmentVariables' } });
    expect(approvalsCreate).not.toHaveBeenCalled();
    expect(sessionSpawnNew).not.toHaveBeenCalled();
  });

  it('snapshots the host-resolved complete roles and notes without inheriting the lead role selection', async () => {
    const roles: ResolvedRolesSnapshotV1 = {
      builder: { roleId: 'builder', name: 'Builder', instructions: 'Resolved project and Account instructions',
        engine: { agentTargetKey: 'agent:codex', modelId: 'worker-model', effort: 'high' },
        runsAs: { kind: 'session' }, workspaceWrites: 'allow', secondOpinion: 'encouraged', enabled: true },
      orchestrator: { roleId: 'orchestrator', name: 'Orchestrator', instructions: 'Lead only',
        engine: { agentTargetKey: 'agent:codex' }, runsAs: { kind: 'session' },
        workspaceWrites: 'deny', secondOpinion: 'off', enabled: true },
    };
    const sessionSpawnNew = vi.fn<ActionExecutorDeps['sessionSpawnNew']>(async () => ({ type: 'pending' as const,
      retryWithSameCreationKey: true as const, outcome: 'accepted' as const }));
    const executor = createActionExecutor({ sessionSpawnNew } as unknown as ActionExecutorDeps);
    const context = {
      surface: 'plugin' as const,
      actionCaller: { kind: 'plugin' as const, pluginId: 'plugin.example', contributionLocalId: 'feature-a' },
      defaultSessionId: 'parent-session',
      agentStartContext: { ...agentStartContext, roles },
      sessionRoleConfiguration: { sessionRoles: {}, overrides: {}, notes: 'Finish the bounded worker task',
        memoryDocRef: { kind: 'doc' as const, artifactId: 'lead-memory' } },
    };

    expect((await executor.execute('session.spawn_new', { ...canonicalInput, roleId: 'builder' }, context)).ok).toBe(true);
    expect(sessionSpawnNew.mock.calls[0]?.[0]).toMatchObject({ initialSessionRolesV1: {
      roleId: 'builder', inheritedFrom: 'parent-session', overrides: {}, sessionRoles: roles,
      notes: 'Finish the bounded worker task', memoryDocRef: { kind: 'doc', artifactId: 'lead-memory' },
    } });
    roles.builder!.instructions = 'A later edit';
    expect(sessionSpawnNew.mock.calls[0]?.[0].initialSessionRolesV1?.sessionRoles.builder?.instructions)
      .toBe('Resolved project and Account instructions');

    expect((await executor.execute('session.spawn_new', canonicalInput, context)).ok).toBe(true);
    expect(sessionSpawnNew.mock.calls[1]?.[0].initialSessionRolesV1).not.toHaveProperty('roleId');
  });

  it('rejects a caller-supplied role snapshot before spawn dispatch', async () => {
    const sessionSpawnNew = vi.fn();
    const executor = createActionExecutor({ sessionSpawnNew } as unknown as ActionExecutorDeps);
    const result = await executor.execute('session.spawn_new', {
      ...canonicalInput, initialSessionRolesV1: { overrides: {}, sessionRoles: {}, notes: 'forged' },
    }, { surface: 'plugin', actionCaller: { kind: 'plugin', pluginId: 'plugin.example', contributionLocalId: 'feature-a' } });
    expect(result).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    expect(sessionSpawnNew).not.toHaveBeenCalled();
  });

  it('signs the exact materialized API spawn input persisted for deferred replay', async () => {
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'approval-api-spawn' }));
    const signExternalActionApprovalInput = vi.fn(() => 'a'.repeat(86));
    const executor = createActionExecutor({
      approvalsCreate,
      sessionSpawnNew: vi.fn(),
      isActionApprovalRequired: () => true,
    } as unknown as ActionExecutorDeps);
    const { creationKey: _creationKey, ...input } = apiSpawnInput;
    const target = { kind: 'machine' as const, machineId: 'machine-1' };

    const result = await executor.execute('session.spawn_new', input, {
      surface: 'api',
      authority: 'account_automation',
      serverId: 'server-1',
      actionRequestId: 'spawn-request-1',
      actionCaller: { kind: 'host' },
      externalActionCredential: {
        accountId: 'account-1',
        principalId: 'account-1',
        credentialId: '11111111-1111-4111-8111-111111111111',
        grant: API_TOKEN_FULL_GRANT_V1,
      },
      externalActionTarget: target,
      externalActionExecutionAuthorization: {
        v: 1,
        token: 'opaque-authorization',
        binding: {
          serverIdentityId: 'stable-home-1',
          accountId: 'account-1',
          principalId: 'account-1',
          credentialId: '11111111-1111-4111-8111-111111111111',
          grant: API_TOKEN_FULL_GRANT_V1,
          machineId: 'machine-1',
          actionId: 'session.spawn_new',
          requestId: 'spawn-request-1',
          requestEnvelopeDigest: 'a'.repeat(43),
          target,
        },
      },
      signExternalActionApprovalInput,
    });
    expect(result).toEqual({
      ok: true,
      result: {
        kind: 'approval_request_created',
        artifactId: 'approval-api-spawn',
        actionId: 'session.spawn_new',
      },
    });

    const persistedRequest = approvalsCreate.mock.calls[0]?.[0].request;
    expect(persistedRequest.actionArgs).toMatchObject({
      creationKey: 'action-request:spawn-request-1',
    });
    expect(signExternalActionApprovalInput).toHaveBeenCalledWith(expect.objectContaining({
      actionId: 'session.spawn_new',
      input: persistedRequest.actionArgs,
    }));
  });

  it('enforces the live Agent spawn policy before creating an approval artifact', async () => {
    const approvalsCreate = vi.fn();
    const sessionSpawnNew = vi.fn();
    const executor = createActionExecutor({
      approvalsCreate,
      sessionSpawnNew,
      resolveAgentStartContext: async () => agentStartContext,
      isActionApprovalRequired: () => true,
    } as unknown as ActionExecutorDeps);

    await expect(executor.execute('session.spawn_new', canonicalInput, {
      surface: 'agent',
      defaultSessionId: 'parent-session',
      callerPermissionMode: 'yolo',
      causalPermissionAuthority: {
        kind: 'admittedSessionInputV1',
        admittedPermissionCeiling: 'yolo',
      },
      sessionInputSource: {
        sourceSessionId: 'parent-session',
        sourceTurnId: 'parent-turn-1',
        via: 'action',
      },
      sessionAgentSpawnPolicyV1: {
        v: 1,
        allowCustomDirectory: true,
        allowCrossMachine: false,
        allowBackendTargetOverride: true,
        allowModelOverride: true,
        allowPermissionModeOverride: true,
        allowAgentModeOverride: true,
        allowConfigOptionOverrides: true,
        allowProfileOverride: true,
        allowConnectedServicesOverride: true,
        allowMcpSelectionOverride: true,
        allowTranscriptStorageOverride: true,
        permissionCeiling: null,
      },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'policy_denied_field',
      error: 'policy_denied_field',
      details: { code: 'policy_denied_field', field: 'executionTarget.machineId' },
    });
    expect(approvalsCreate).not.toHaveBeenCalled();
    expect(sessionSpawnNew).not.toHaveBeenCalled();
  });

  it('persists the Agent spawn permission ceiling in the approval input', async () => {
    const approvalsCreate = vi.fn(async ({ request }: { request: Record<string, unknown> }) => ({
      artifactId: 'approval-agent-spawn',
      request,
    }));
    const executor = createActionExecutor({
      approvalsCreate,
      sessionSpawnNew: vi.fn(),
      resolveAgentStartContext: async () => agentStartContext,
      isActionApprovalRequired: () => true,
    } as unknown as ActionExecutorDeps);

    await executor.execute('session.spawn_new', { ...canonicalInput, permissionMode: 'read-only' }, {
      surface: 'agent',
      defaultSessionId: 'parent-session',
      callerPermissionMode: 'yolo',
      causalPermissionAuthority: {
        kind: 'admittedSessionInputV1',
        admittedPermissionCeiling: 'yolo',
      },
      sessionAgentSpawnPolicyV1: {
        v: 1,
        allowCustomDirectory: true,
        allowCrossMachine: true,
        allowBackendTargetOverride: true,
        allowModelOverride: true,
        allowPermissionModeOverride: true,
        allowAgentModeOverride: true,
        allowConfigOptionOverrides: true,
        allowProfileOverride: true,
        allowConnectedServicesOverride: true,
        allowMcpSelectionOverride: true,
        allowTranscriptStorageOverride: true,
        permissionCeiling: 'read-only',
      },
    });

    expect(approvalsCreate).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        actionArgs: expect.objectContaining({ permissionMode: 'read-only' }),
      }),
    }));
  });

  it('binds API session spawn placement only from host-stamped daemon context', async () => {
    const sessionSpawnNew = vi.fn(async () => ({
      type: 'pending' as const,
      retryWithSameCreationKey: true as const,
      outcome: 'accepted' as const,
    }));
    const executor = createActionExecutor({
      sessionSpawnNew,
      isActionApprovalRequired: () => false,
    } as unknown as ActionExecutorDeps);

    await expect(executor.execute('session.spawn_new', apiSpawnInput, {
      surface: 'api',
      authority: 'present_user',
      actionCaller: { kind: 'host' },
      serverId: 'server-host',
      externalActionTarget: { kind: 'machine', machineId: 'machine-host' },
    })).resolves.toMatchObject({ ok: true });

    expect(sessionSpawnNew).toHaveBeenCalledWith(expect.objectContaining({
      executionTarget: { serverId: 'server-host', machineId: 'machine-host' },
    }));
  });

  it('rejects deterministic user Session identity without host-stamped present-user authority', async () => {
    const sessionSpawnNew = vi.fn();
    const executor = createActionExecutor({
      sessionSpawnNew,
      isActionApprovalRequired: () => false,
    } as unknown as ActionExecutorDeps);

    await expect(executor.execute('session.spawn_new', apiSpawnInput, {
      surface: 'api',
      actionCaller: { kind: 'host' },
      serverId: 'server-host',
      externalActionTarget: { kind: 'machine', machineId: 'machine-host' },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
    });
    expect(sessionSpawnNew).not.toHaveBeenCalled();
  });

  it('derives deterministic Account-automation Session identity only from a verified API principal', async () => {
    const sessionSpawnNew = vi.fn(async () => ({
      type: 'pending' as const,
      retryWithSameCreationKey: true as const,
      outcome: 'accepted' as const,
    }));
    const executor = createActionExecutor({
      sessionSpawnNew,
      isActionApprovalRequired: () => false,
    } as unknown as ActionExecutorDeps);

    await expect(executor.execute('session.spawn_new', apiSpawnInput, {
      surface: 'api',
      authority: 'account_automation',
      actionCaller: { kind: 'host' },
      serverId: 'server-host',
      externalActionTarget: { kind: 'machine', machineId: 'machine-host' },
      externalActionCredential: {
        accountId: 'account-1',
        principalId: 'principal-1',
        credentialId: 'credential-1',
        grant: API_TOKEN_FULL_GRANT_V1,
      },
    })).resolves.toMatchObject({ ok: true });

    expect(sessionSpawnNew).toHaveBeenCalledWith(expect.objectContaining({
      sessionCreationTag: deriveSessionCreationTagV1({
        callerCreationNamespace: 'api-principal:account-1:principal-1',
        creationKey: apiSpawnInput.creationKey,
      }),
    }));
  });

  it('fails deterministic Account-automation Session spawn closed without verified API principal identity', async () => {
    const sessionSpawnNew = vi.fn();
    const executor = createActionExecutor({
      sessionSpawnNew,
      isActionApprovalRequired: () => false,
    } as unknown as ActionExecutorDeps);

    await expect(executor.execute('session.spawn_new', apiSpawnInput, {
      surface: 'api',
      authority: 'account_automation',
      actionCaller: { kind: 'host' },
      serverId: 'server-host',
      externalActionTarget: { kind: 'machine', machineId: 'machine-host' },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
    });
    await expect(executor.execute('session.spawn_new', apiSpawnInput, {
      surface: 'api',
      authority: 'account_automation',
      actionCaller: { kind: 'host' },
      serverId: 'server-host',
      externalActionTarget: { kind: 'machine', machineId: 'machine-host' },
      externalActionCredential: {
        accountId: 'account-1',
        principalId: '',
        credentialId: 'credential-1',
        grant: API_TOKEN_FULL_GRANT_V1,
      },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
    });
    expect(sessionSpawnNew).not.toHaveBeenCalled();
  });

  it('binds host Voice creation retries to the admitted Home and Account without promoting authority', async () => {
    const sessionSpawnNew = vi.fn<ActionExecutorDeps['sessionSpawnNew']>(async () => ({
      type: 'pending', retryWithSameCreationKey: true, outcome: 'accepted',
    }));
    const executor = createActionExecutor({ sessionSpawnNew, isActionApprovalRequired: () => false } as unknown as ActionExecutorDeps);
    const context = {
      surface: 'voice' as const, authority: 'account_automation' as const,
      actionCaller: { kind: 'host' as const }, serverId: 'server-1', runtimeAccountId: 'account-1',
      actionRequestId: 'voice-request-1',
    };
    const { creationKey: _creationKey, ...input } = canonicalInput;
    for (const scope of [context, context, { ...context, runtimeAccountId: 'account-2' }, { ...context, serverId: 'server-2' }]) {
      expect(await executor.execute('session.spawn_new', input, scope)).toMatchObject({ ok: true });
    }
    const args = sessionSpawnNew.mock.calls.map(([args]) => args);
    expect(args[0]?.sessionCreationTag).toBe(deriveSessionCreationTagV1({
      callerCreationNamespace: JSON.stringify(['voice', 'server-1', 'account-1']),
      creationKey: 'action-request:voice-request-1',
    }));
    expect(args[1]?.sessionCreationTag).toBe(args[0]?.sessionCreationTag);
    expect(new Set(args.map((args) => args.sessionCreationTag)).size).toBe(3);
    expect(args.every((args) => args.context?.authority === 'account_automation')).toBe(true);
  });

  it.each([
    { serverId: 'server-1' },
    { runtimeAccountId: 'account-1' },
    { serverId: 'server-1', runtimeAccountId: 'account-1', authority: undefined },
  ])('refuses host Voice creation with incomplete admitted scope: %j', async (scope) => {
    const sessionSpawnNew = vi.fn();
    const executor = createActionExecutor({ sessionSpawnNew, isActionApprovalRequired: () => false } as unknown as ActionExecutorDeps);
    expect(await executor.execute('session.spawn_new', canonicalInput, {
      surface: 'voice', authority: 'account_automation', actionCaller: { kind: 'host' }, ...scope,
    })).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    expect(sessionSpawnNew).not.toHaveBeenCalled();
  });

  it('retains required approval for a scoped host Voice creation', async () => {
    const sessionSpawnNew = vi.fn();
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'voice-spawn-approval' }));
    const executor = createActionExecutor({ sessionSpawnNew, approvalsCreate, isActionApprovalRequired: () => true } as unknown as ActionExecutorDeps);
    expect(await executor.execute('session.spawn_new', canonicalInput, {
      surface: 'voice', authority: 'account_automation', actionCaller: { kind: 'host' },
      serverId: 'server-1', runtimeAccountId: 'account-1',
    })).toMatchObject({ ok: true, result: { kind: 'approval_request_created', artifactId: 'voice-spawn-approval' } });
    expect(sessionSpawnNew).not.toHaveBeenCalled();
  });

  it.each([
    ['missing target', {}],
    ['Session target', { externalActionTarget: { kind: 'session' as const, sessionId: 'session-1' } }],
  ])('rejects API session spawn with a %s before creating a Session', async (_name, targetContext) => {
    const sessionSpawnNew = vi.fn();
    const executor = createActionExecutor({
      sessionSpawnNew,
      isActionApprovalRequired: () => false,
    } as unknown as ActionExecutorDeps);

    await expect(executor.execute('session.spawn_new', apiSpawnInput, {
      surface: 'api',
      authority: 'present_user',
      actionCaller: { kind: 'host' },
      serverId: 'server-host',
      ...targetContext,
    })).resolves.toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
    });

    expect(sessionSpawnNew).not.toHaveBeenCalled();
  });

  it('persists and replays the host-bound canonical target for an API spawn approval', async () => {
    const sessionSpawnNew = vi.fn(async () => ({
      type: 'pending' as const,
      retryWithSameCreationKey: true as const,
      outcome: 'accepted' as const,
    }));
    let persistedApproval: unknown = null;
    const approvalsCreate = vi.fn(async ({ request }: Readonly<{ request: unknown }>) => {
      persistedApproval = request;
      return { artifactId: 'approval-api-spawn-1' };
    });
    const approvalsGet = vi.fn(async () => persistedApproval);
    const approvalsUpdate = vi.fn(async ({ request }: Readonly<{ request: unknown }>) => {
      persistedApproval = request;
      return { ok: true as const };
    });
    const executor = createActionExecutor({
      sessionSpawnNew,
      approvalsCreate,
      approvalsGet,
      approvalsUpdate,
      isApprovalExecutionOriginCurrent: async () => true,
      isActionApprovalRequired: (actionId, context) => (
        actionId === 'session.spawn_new' && context.surface === 'api'
      ),
    } as unknown as ActionExecutorDeps);

    await expect(executor.execute(
      'session.spawn_new',
      apiSpawnInput,
      createExternalSpawnApprovalContext('api-spawn-approval-1'),
    )).resolves.toMatchObject({
      ok: true,
      result: { kind: 'approval_request_created', artifactId: 'approval-api-spawn-1' },
    });
    expect(persistedApproval).toMatchObject({
      actionId: 'session.spawn_new',
      actionArgs: expect.objectContaining({
        executionTarget: { serverId: 'server-host', machineId: 'machine-host' },
      }),
    });

    await expect(executor.execute('approval.request.decide', {
      artifactId: 'approval-api-spawn-1',
      decision: 'approve',
    }, { surface: 'cli', authority: 'present_user' })).resolves.toMatchObject({ ok: true });
    expect(sessionSpawnNew).toHaveBeenCalledWith(expect.objectContaining({
      executionTarget: { serverId: 'server-host', machineId: 'machine-host' },
    }));
  });

  it('replays an API spawn approval when its creation identity came from the host request id', async () => {
    const sessionSpawnNew = vi.fn(async () => ({
      type: 'pending' as const,
      retryWithSameCreationKey: true as const,
      outcome: 'accepted' as const,
    }));
    let persistedApproval: Record<string, unknown> | null = null;
    const approvalsCreate = vi.fn(async ({ request }: Readonly<{ request: Record<string, unknown> }>) => {
      persistedApproval = request;
      return { artifactId: 'approval-api-request-id-spawn-1' };
    });
    const approvalsGet = vi.fn(async () => persistedApproval);
    const approvalsUpdate = vi.fn(async ({ request }: Readonly<{ request: Record<string, unknown> }>) => {
      persistedApproval = request;
      return { ok: true as const };
    });
    const executor = createActionExecutor({
      sessionSpawnNew,
      approvalsCreate,
      approvalsGet,
      approvalsUpdate,
      isApprovalExecutionOriginCurrent: async () => true,
      isActionApprovalRequired: (actionId, context) => (
        actionId === 'session.spawn_new' && context.surface === 'api'
      ),
    } as unknown as ActionExecutorDeps);
    const { creationKey: _creationKey, ...apiInputWithoutCreationKey } = apiSpawnInput;

    await expect(executor.execute(
      'session.spawn_new',
      apiInputWithoutCreationKey,
      createExternalSpawnApprovalContext('api-request-identity-7'),
    )).resolves.toMatchObject({
      ok: true,
      result: { kind: 'approval_request_created', artifactId: 'approval-api-request-id-spawn-1' },
    });

    await expect(executor.execute('approval.request.decide', {
      artifactId: 'approval-api-request-id-spawn-1',
      decision: 'approve',
    }, { surface: 'cli', authority: 'present_user' })).resolves.toMatchObject({
      ok: true,
      result: { status: 'executed', execution: { ok: true } },
    });

    expect(persistedApproval).toMatchObject({
      actionArgs: expect.objectContaining({
        creationKey: 'action-request:api-request-identity-7',
        executionTarget: { serverId: 'server-host', machineId: 'machine-host' },
      }),
      status: 'executed',
    });
    expect(sessionSpawnNew).toHaveBeenCalledWith(expect.objectContaining({
      creationKey: 'action-request:api-request-identity-7',
      executionTarget: { serverId: 'server-host', machineId: 'machine-host' },
    }));
  });

  it('replays a manually-created spawn approval with its host request identity', async () => {
    const sessionSpawnNew = vi.fn(async () => ({
      type: 'pending' as const,
      retryWithSameCreationKey: true as const,
      outcome: 'accepted' as const,
    }));
    let persistedApproval: Record<string, unknown> | null = null;
    const approvalsCreate = vi.fn(async ({ request }: Readonly<{ request: Record<string, unknown> }>) => {
      persistedApproval = request;
      return { artifactId: 'approval-manual-request-id-spawn-1' };
    });
    const approvalsGet = vi.fn(async () => persistedApproval);
    const approvalsUpdate = vi.fn(async ({ request }: Readonly<{ request: Record<string, unknown> }>) => {
      persistedApproval = request;
      return { ok: true as const };
    });
    const executor = createActionExecutor({
      sessionSpawnNew,
      approvalsCreate,
      approvalsGet,
      approvalsUpdate,
      isApprovalExecutionOriginCurrent: async () => true,
    } as unknown as ActionExecutorDeps);
    const { creationKey: _creationKey, ...inputWithoutCreationKey } = canonicalInput;

    await expect(executor.execute('approval.request.create', {
      actionId: 'session.spawn_new',
      actionArgs: inputWithoutCreationKey,
      summary: 'Create a session',
      createdBy: { surface: 'system' },
    }, {
      surface: 'cli',
      authority: 'present_user',
      actionRequestId: 'manual-request-identity-7',
    })).resolves.toMatchObject({ ok: true });

    await expect(executor.execute('approval.request.decide', {
      artifactId: 'approval-manual-request-id-spawn-1',
      decision: 'approve',
    }, { surface: 'cli', authority: 'present_user' })).resolves.toMatchObject({
      ok: true,
      result: { status: 'executed', execution: { ok: true } },
    });

    expect(persistedApproval).toMatchObject({
      actionArgs: expect.objectContaining({
        creationKey: 'action-request:manual-request-identity-7',
        executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
      }),
      status: 'executed',
    });
    expect(sessionSpawnNew).toHaveBeenCalledWith(expect.objectContaining({
      creationKey: 'action-request:manual-request-identity-7',
    }));
  });

  it('projects compact spawn input schemas and hints when API callers discover Action specs', async () => {
    // Exercise the real catalog first so serialization failures retain their
    // cause instead of the executor's generic invalid_parameters result.
    projectActionDefinitionForExternalDiscovery(actionSpecToActionDefinitionV1(
      getActionSpec('session.spawn_new'), { surface: 'api' },
    ));
    const executor = createActionExecutor({
      isActionApprovalRequired: () => false,
    } as unknown as ActionExecutorDeps);
    const context = {
      surface: 'api' as const,
      authority: 'account_automation' as const,
      actionCaller: { kind: 'host' as const },
    };

    const getResult = await executor.execute('action.spec.get', {
      id: 'session.spawn_new',
    }, context);
    const searchResult = await executor.execute('action.spec.search', {
      query: 'session.spawn_new',
      limit: 1,
    }, context);

    expect(getResult).toMatchObject({
      ok: true,
      result: {
        actionSpec: {
          kindVersion: 1,
          inputHints: {
            fields: expect.arrayContaining([
              expect.objectContaining({ path: 'directory' }),
            ]),
          },
        },
      },
    });
    if (!getResult.ok) throw new Error('Action discovery failed');
    const { actionSpec: definition } = z.object({ actionSpec: ActionDefinitionV1Schema }).parse(getResult.result);
    const projectedInput = z.object({
      properties: z.record(z.string(), z.unknown()),
      $defs: z.record(z.string(), z.unknown()).optional(),
    }).parse(definition.inputSchema);
    const directorySchema = z.record(z.string(), z.unknown()).parse(projectedInput.properties.directory);
    const ajv = new Ajv2020({ strict: false });
    addFormats(ajv);
    // Validate this field's advertised semantics whether Zod emits it inline or by reference.
    const validate = ajv.compile({ ...directorySchema, $defs: projectedInput.$defs });
    expect(validate(apiSpawnInput.directory)).toBe(true);
    expect(validate({ kind: 'managed' })).toBe(true);
    expect(validate({ kind: 'path', path: '' })).toBe(false);
    expect(validate({ kind: 'unknown' })).toBe(false);
    expect(getResult).not.toMatchObject({
      result: {
        actionSpec: {
          inputSchema: { properties: { executionTarget: expect.anything() } },
        },
      },
    });
    expect(getResult).not.toMatchObject({
      result: {
        actionSpec: {
          inputHints: {
            fields: expect.arrayContaining([
              expect.objectContaining({ path: 'executionTarget.serverId' }),
            ]),
          },
        },
      },
    });
    expect(getResult).not.toMatchObject({
      result: {
        actionSpec: {
          inputHints: {
            fields: expect.arrayContaining([
              expect.objectContaining({ path: 'executionTarget.machineId' }),
            ]),
          },
        },
      },
    });
    expect(searchResult).toMatchObject({
      ok: true,
      result: {
        actionSpecs: [expect.objectContaining({
          id: 'session.spawn_new',
          inputHints: expect.objectContaining({
            fields: expect.arrayContaining([
              expect.objectContaining({ path: 'directory' }),
            ]),
          }),
        })],
      },
    });
    expect(searchResult).not.toMatchObject({
      result: {
        actionSpecs: [expect.objectContaining({
          id: 'session.spawn_new',
          inputHints: {
            fields: expect.arrayContaining([
              expect.objectContaining({ path: 'executionTarget.serverId' }),
            ]),
          },
        })],
      },
    });
    expect(searchResult).not.toMatchObject({
      result: {
        actionSpecs: [expect.objectContaining({
          id: 'session.spawn_new',
          inputHints: {
            fields: expect.arrayContaining([
              expect.objectContaining({ path: 'executionTarget.machineId' }),
            ]),
          },
        })],
      },
    });
  });

  it('host-stamps plugin creation identity and forwards only canonical intent', async () => {
    const sessionSpawnNew = vi.fn(async () => ({
      type: 'pending' as const,
      retryWithSameCreationKey: true as const,
      outcome: 'accepted' as const,
    }));
    const executor = createActionExecutor({ sessionSpawnNew } as unknown as ActionExecutorDeps);

    const context = {
      surface: 'plugin',
      actionCaller: {
        kind: 'plugin',
        pluginId: 'plugin.example',
        contributionLocalId: 'feature-a',
      },
      actionRequestId: 'attempt-1',
    } as const;
    const result = await executor.execute('session.spawn_new', canonicalInput, context);

    expect(result).toEqual({
      ok: true,
      result: {
        type: 'pending',
        retryWithSameCreationKey: true,
        outcome: 'accepted',
      },
    });
    expect(sessionSpawnNew).toHaveBeenCalledWith({
      ...canonicalInput,
      creationKey: 'plugin-operation-7',
      sessionCreationTag: deriveSessionCreationTagV1({
        callerCreationNamespace: 'plugin:plugin.example',
        creationKey: 'plugin-operation-7',
      }),
      callerSurface: 'plugin',
      context,
      actionCaller: {
        kind: 'plugin',
        pluginId: 'plugin.example',
        contributionLocalId: 'feature-a',
      },
      actionRequestId: 'attempt-1',
    });
  });

  it('uses the host-stamped Automation Run namespace without exposing it in Action input', async () => {
    const sessionSpawnNew = vi.fn(async () => ({
      type: 'pending' as const,
      retryWithSameCreationKey: true as const,
      outcome: 'accepted' as const,
    }));
    const executor = createActionExecutor({ sessionSpawnNew } as unknown as ActionExecutorDeps);

    await executor.execute('session.spawn_new', {
      ...canonicalInput,
      creationKey: 'automation-run:run-42',
    }, {
      surface: 'cli',
      actionCaller: {
        kind: 'automationRun',
        automationId: 'automation-7',
        runId: 'run-42',
        cause: { kind: 'manual', invokedAt: 1 },
      },
    });

    expect(sessionSpawnNew).toHaveBeenCalledWith(expect.objectContaining({
      creationKey: 'automation-run:run-42',
      sessionCreationTag: deriveSessionCreationTagV1({
        callerCreationNamespace: 'automation:automation-7',
        creationKey: 'automation-run:run-42',
      }),
      actionCaller: {
        kind: 'automationRun',
        automationId: 'automation-7',
        runId: 'run-42',
        cause: { kind: 'manual', invokedAt: 1 },
      },
    }));
  });

  it('rejects an Automation Run caller whose V2 creation key is not that Run', async () => {
    const sessionSpawnNew = vi.fn(async () => ({
      type: 'pending' as const,
      retryWithSameCreationKey: true as const,
      outcome: 'accepted' as const,
    }));
    const executor = createActionExecutor({ sessionSpawnNew } as unknown as ActionExecutorDeps);

    const result = await executor.execute('session.spawn_new', {
      ...canonicalInput,
      creationKey: 'automation-run:other-run',
    }, {
      surface: 'cli',
      actionCaller: {
        kind: 'automationRun',
        automationId: 'automation-7',
        runId: 'run-42',
        cause: { kind: 'manual', invokedAt: 1 },
      },
    });

    expect(result).toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
    });
    expect(sessionSpawnNew).not.toHaveBeenCalled();
  });

  it('derives a stable user creation key only from durable Action request identity', async () => {
    const sessionSpawnNew = vi.fn(async () => ({
      type: 'pending' as const,
      retryWithSameCreationKey: true as const,
      outcome: 'unknown' as const,
    }));
    const executor = createActionExecutor({ sessionSpawnNew } as unknown as ActionExecutorDeps);
    const { creationKey: _creationKey, ...withoutCreationKey } = canonicalInput;

    await executor.execute('session.spawn_new', withoutCreationKey, {
      surface: 'cli',
      authority: 'present_user',
      actionRequestId: 'request-9',
    });

    expect(sessionSpawnNew).toHaveBeenCalledWith(expect.objectContaining({
      creationKey: 'action-request:request-9',
      actionCaller: { kind: 'host' },
      sessionCreationTag: deriveSessionCreationTagV1({
        callerCreationNamespace: 'user',
        creationKey: 'action-request:request-9',
      }),
    }));
  });

  it('preserves a typed method-unavailable Session-spawn transport error', async () => {
    const sessionSpawnNew = vi.fn(async () => {
      throw new RpcError('RPC method not available', RPC_ERROR_CODES.METHOD_NOT_AVAILABLE);
    });
    const executor = createActionExecutor({ sessionSpawnNew } as unknown as ActionExecutorDeps);

    const result = await executor.execute('session.spawn_new', canonicalInput, {
      surface: 'voice',
      authority: 'present_user',
    });

    expect(result).toEqual({
      ok: false,
      errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
      error: 'RPC method not available',
    });
  });

  it('rejects a live V2/legacy hybrid before invoking spawn', async () => {
    const sessionSpawnNew = vi.fn(async () => ({
      type: 'pending' as const,
      retryWithSameCreationKey: true as const,
      outcome: 'accepted' as const,
    }));
    const executor = createActionExecutor({ sessionSpawnNew } as unknown as ActionExecutorDeps);
    const { creationKey: _creationKey, ...inputWithoutCreationKey } = canonicalInput;

    const result = await executor.execute('session.spawn_new', {
      ...inputWithoutCreationKey,
      // `tag` is accepted only while replaying a provenance-bounded predecessor
      // approval artifact. It is never a live public Action field.
      tag: '  predecessor metadata label  ',
    }, {
      surface: 'cli',
      authority: 'present_user',
      actionRequestId: 'legacy-request-7',
    });

    expect(result).toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
    });
    expect(sessionSpawnNew).not.toHaveBeenCalled();
  });

  it('reads but never replays a provenance-pinned predecessor approval', async () => {
    const sessionSpawnNew = vi.fn(async () => ({
      type: 'pending' as const,
      retryWithSameCreationKey: true as const,
      outcome: 'accepted' as const,
    }));
    const predecessorActionArgs = {
      // Pinned predecessor artifact vocabulary: remote-dev@1649b084249241dd68806d5150f498e944632442.
      tag: 'predecessor metadata label',
      agentId: 'codex',
      modelId: 'gpt-5',
      directory: '/workspace/project',
      machineId: 'machine-1',
      prompt: 'Inspect this repository.',
    } as const;
    let persistedApproval: Record<string, unknown> = {
      v: 1,
      status: 'open',
      createdAtMs: 100,
      updatedAtMs: 100,
      createdBy: { surface: 'cli' },
      requestedSurface: 'cli',
      actionId: 'session.spawn_new',
      actionArgs: predecessorActionArgs,
      summary: 'Create session',
      serverId: 'server-1',
    };
    const approvalsGet = vi.fn(async () => persistedApproval);
    const approvalsUpdate = vi.fn(async ({ request }: { request: Record<string, unknown> }) => {
      persistedApproval = request;
      return { ok: true as const };
    });
    const executor = createActionExecutor({
      sessionSpawnNew,
      approvalsGet,
      approvalsUpdate,
      isApprovalExecutionOriginCurrent: async () => true,
    } as unknown as ActionExecutorDeps);

    const decisionResult = await executor.execute('approval.request.decide', {
      artifactId: 'approval-remote-dev-1',
      decision: 'approve',
    }, { surface: 'cli', authority: 'present_user' });

    expect(decisionResult.ok).toBe(true);
    expect(sessionSpawnNew).not.toHaveBeenCalled();
    expect(persistedApproval).toMatchObject({
      status: 'failed',
      execution: { ok: false, errorCode: 'approval_stale' },
    });
  });

  it('executes a live canonical Action without a legacy approval compatibility path', async () => {
    const sessionSpawnNew = vi.fn(async () => ({
      type: 'pending' as const,
      retryWithSameCreationKey: true as const,
      outcome: 'accepted' as const,
    }));
    const executor = createActionExecutor({
      sessionSpawnNew,
    } as unknown as ActionExecutorDeps);

    const result = await executor.execute('session.spawn_new', {
      ...canonicalInput,
    }, {
      surface: 'plugin',
      actionCaller: {
        kind: 'plugin',
        pluginId: 'plugin.example',
        contributionLocalId: 'feature-a',
      },
    });

    expect(result.ok).toBe(true);
  });

  it('does not expose an unsupported legacy approval artifact to Session-spawn observers', async () => {
    const sessionSpawnNew = vi.fn(async () => ({
      type: 'pending' as const,
      retryWithSameCreationKey: true as const,
      outcome: 'accepted' as const,
    }));
    const observeActionExecution = vi.fn(async () => undefined);
    const predecessorActionArgs = {
      agentId: 'codex',
      directory: '/workspace/project',
      machineId: 'machine-1',
      environmentVariables: { TOKEN: 'must-not-reach-observation' },
    } as const;
    let persistedApproval: Record<string, unknown> = {
      v: 1,
      status: 'open',
      createdAtMs: 100,
      updatedAtMs: 100,
      createdBy: { surface: 'cli' },
      requestedSurface: 'cli',
      actionId: 'session.spawn_new',
      actionArgs: predecessorActionArgs,
      summary: 'Create session',
      serverId: 'server-1',
    };
    const approvalsGet = vi.fn(async () => persistedApproval);
    const approvalsUpdate = vi.fn(async ({ request }: { request: Record<string, unknown> }) => {
      persistedApproval = request;
      return { ok: true as const };
    });
    const executor = createActionExecutor({
      sessionSpawnNew,
      approvalsGet,
      approvalsUpdate,
      observeActionExecution,
    } as unknown as ActionExecutorDeps);

    const result = await executor.execute('approval.request.decide', {
      artifactId: 'approval-remote-dev-env-1',
      decision: 'approve',
    }, { surface: 'cli', authority: 'present_user' });

    expect(result.ok).toBe(true);
    expect(sessionSpawnNew).not.toHaveBeenCalled();
    expect(observeActionExecution).not.toHaveBeenCalledWith(expect.objectContaining({
      actionId: 'session.spawn_new',
      input: expect.objectContaining({ environmentVariables: predecessorActionArgs.environmentVariables }),
    }));
    expect(persistedApproval).toMatchObject({
      status: 'failed',
      execution: { ok: false, errorCode: 'approval_stale' },
    });
  });

  it('requires a target-owned directory approval before spawning and carries that exact proof into replay', async () => {
    const directoryApproval = {
      v: 1 as const,
      executionTarget: canonicalInput.executionTarget,
      directory: canonicalInput.directory.path,
    };
    const sessionSpawnNew = vi.fn(async () => ({
      type: 'pending' as const,
      retryWithSameCreationKey: true as const,
      outcome: 'accepted' as const,
    }));
    const sessionSpawnNewDirectoryApprovalPreflight = vi.fn(async () => ({
      type: 'approval_required' as const,
      approval: directoryApproval,
    }));
    let persistedApproval: Record<string, unknown> | null = null;
    const approvalsCreate = vi.fn(async ({ request }: { request: Record<string, unknown> }) => {
      persistedApproval = request;
      return { artifactId: 'approval-directory-1' };
    });
    const approvalsGet = vi.fn(async () => persistedApproval);
    const approvalsUpdate = vi.fn(async ({ request }: { request: Record<string, unknown> }) => {
      persistedApproval = request;
      return { ok: true as const };
    });
    const executor = createActionExecutor({
      sessionSpawnNew,
      sessionSpawnNewDirectoryApprovalPreflight,
      approvalsCreate,
      approvalsGet,
      approvalsUpdate,
      isApprovalExecutionOriginCurrent: async () => true,
    } as unknown as ActionExecutorDeps);

    await expect(executor.execute('session.spawn_new', canonicalInput, {
      surface: 'cli',
      authority: 'present_user',
    })).resolves.toEqual({
      ok: true,
      result: {
        kind: 'approval_request_created',
        artifactId: 'approval-directory-1',
        actionId: 'session.spawn_new',
      },
    });

    expect(sessionSpawnNew).not.toHaveBeenCalled();
    expect(persistedApproval).toMatchObject({
      actionId: 'session.spawn_new',
      approval: { flow: 'deferred', result: 'required' },
      sessionCreationDirectoryApproval: directoryApproval,
    });

    await expect(executor.execute('approval.request.decide', {
      artifactId: 'approval-directory-1',
      decision: 'approve',
    }, { surface: 'cli', authority: 'present_user' })).resolves.toMatchObject({ ok: true });

    expect(sessionSpawnNewDirectoryApprovalPreflight).toHaveBeenCalledTimes(2);
    expect(sessionSpawnNew).toHaveBeenCalledWith(expect.objectContaining({
      sessionCreationDirectoryApproval: directoryApproval,
    }));
  });

  it('does not forward a legacy V1 directory approval to the target Action owner', async () => {
    const directoryApproval = {
      v: 1 as const,
      executionTarget: canonicalInput.executionTarget,
      directory: canonicalInput.directory.path,
    };
    const sessionSpawnNew = vi.fn(async () => {
      throw new Error('ui_must_not_forward_directory_approval_as_spawn_input');
    });
    let persistedApproval: Record<string, unknown> = {
      v: 1,
      status: 'open',
      createdAtMs: 1,
      updatedAtMs: 1,
      createdBy: { surface: 'mcp' },
      requestedSurface: 'mcp',
      actionId: 'session.spawn_new',
      actionArgs: canonicalInput,
      summary: 'Create session',
      serverId: canonicalInput.executionTarget.serverId,
      sessionCreationDirectoryApproval: directoryApproval,
    };
    const approvalsGet = vi.fn(async () => persistedApproval);
    const approvalsUpdate = vi.fn(async ({ request }: Readonly<{ request: Record<string, unknown> }>) => {
      persistedApproval = request;
      return { ok: true as const };
    });
    const executor = createActionExecutor({
      sessionSpawnNew,
      approvalsGet,
      approvalsUpdate,
    } as unknown as ActionExecutorDeps);
    const controller = new AbortController();

    await expect(executor.execute('approval.request.decide', {
      artifactId: 'approval-directory-target-1',
      decision: 'approve',
    }, {
      surface: 'ui',
      authority: 'present_user',
      serverId: canonicalInput.executionTarget.serverId,
      signal: controller.signal,
    })).resolves.toMatchObject({
      ok: true,
      result: { status: 'failed', execution: { ok: false, errorCode: 'approval_stale' } },
    });

    expect(sessionSpawnNew).not.toHaveBeenCalled();
    expect(approvalsUpdate).toHaveBeenCalledTimes(2);
    expect(persistedApproval).toMatchObject({
      status: 'failed',
      execution: { ok: false, errorCode: 'approval_stale' },
    });
  });

  it('lets the canonical target-action approval owner claim a decision before generic Artifact handling', async () => {
    const targetActionApprovalReplay = vi.fn(async () => ({
      ok: true as const,
      result: { ok: true, status: 'executed' },
    }));
    const approvalsGet = vi.fn(async () => {
      throw new Error('generic_approval_store_must_not_read_target_action_artifact');
    });
    const executor = createActionExecutor({
      targetActionApprovalReplay,
      approvalsGet,
    } as unknown as ActionExecutorDeps);
    const controller = new AbortController();

    await expect(executor.execute('approval.request.decide', {
      artifactId: 'target-action-approval-1',
      decision: 'approve',
    }, {
      surface: 'ui',
      authority: 'present_user',
      signal: controller.signal,
    })).resolves.toEqual({ ok: true, result: { ok: true, status: 'executed' } });

    expect(targetActionApprovalReplay).toHaveBeenCalledExactlyOnceWith({
      artifactId: 'target-action-approval-1',
      decision: 'approve',
      signal: controller.signal,
    });
    expect(approvalsGet).not.toHaveBeenCalled();
  });

  it('rejects creation without either caller key or durable Action request identity', async () => {
    const sessionSpawnNew = vi.fn();
    const executor = createActionExecutor({ sessionSpawnNew } as unknown as ActionExecutorDeps);
    const { creationKey: _creationKey, ...withoutCreationKey } = canonicalInput;

    const result = await executor.execute('session.spawn_new', withoutCreationKey, {
      surface: 'plugin',
      actionCaller: { kind: 'plugin', pluginId: 'plugin.example' },
    });

    expect(result).toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
    });
    expect(sessionSpawnNew).not.toHaveBeenCalled();
  });
});
