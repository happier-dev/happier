import { afterEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { DaemonContributionRegistryProjectionDescribeResponseSchema, resolveRoleSelectionV1, materializeWorkflowAcceptedSnapshotV1, admitAgentStartV1, DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1 } from '@happier-dev/protocol';
import { createCredentialedWorkflowMaterializationHostV1, createWorkflowMaterializationHostV1, type WorkflowMaterializationHostDeps } from './workflowMaterializationHost';
import { resetInMemoryAccountSettingsContextForTests } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';

const credentials = { token: 'workflow-session-admission', encryption: null } as const;
const sessionId = 'c123456789012345678901234';

function sessionAdmissionHost(machineId: string, readHostActionContract?: WorkflowMaterializationHostDeps['readHostActionContract']) {
  // Only authenticated HTTP and daemon RPC are replaced; Session resolution,
  // owner-metadata opening, Machine authority and the materializer stay real.
  vi.spyOn(axios, 'get').mockImplementation(async (url) => {
    expect(String(url).startsWith('http://127.0.0.1:41371/')).toBe(true);
    if (String(url).endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
      mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
    } };
    if (String(url).endsWith(`/v2/sessions/${sessionId}`)) return { status: 200, data: { session: {
      id: sessionId, seq: 0, createdAt: 0, updatedAt: 0, active: true, activeAt: 0,
      metadataVersion: 0, agentStateVersion: 0, agentState: null, dataEncryptionKey: null,
      encryptionMode: 'plain', metadata: JSON.stringify({ machineId, path: '/repo' }),
    } } };
    throw new Error(`unexpected_session_read:${url}`);
  });
  return createWorkflowMaterializationHostV1({
    credentials, serverHttpBaseUrl: 'http://127.0.0.1:41371',
    readRoleSelection: async () => ({}), readLaunchProfile: async () => null,
    readWorkflowDefinition: async () => null,
    readHostActionContract: readHostActionContract ?? (async () => ({ inputSchema: { type: 'object' }, outputSchema: {} })),
    callMachineAction: async ({ method }) => {
      if (method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) return {
        protocolVersion: 1, projection: { v: 2, generation: 1, agentsById: { installed: {
          id: 'installed', identity: { pluginId: 'test.agent', localId: 'agent' },
          capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
        } } },
      };
      if (method === RPC_METHODS.CAPABILITIES_DETECT) return { protocolVersion: 1, results: {
        'cli.installed': { ok: true, data: { installed: true, version: '1', latestVersion: null,
          update: { supported: false, command: null }, signIn: { status: 'unknown', loginSupport: 'unsupported' },
          platform: { supported: true }, install: { available: false, mode: 'none', sizeBytes: null, guideUrl: null }, dependencies: [] } },
      } };
      throw new Error('unexpected_machine_method');
    },
  });
}

describe('exact-machine workflow materialization effects', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); resetInMemoryAccountSettingsContextForTests(); });

  it('freezes one Action catalog observation per admission, but rechecks availability on replay', async () => {
    const contract = { inputSchema: { type: 'object' }, outputSchema: { type: 'string' } };
    let observed = false;
    // The executing machine's catalog transport yields one observation; a
    // redundant fetch would no longer be available. No domain logic is mocked.
    const host = sessionAdmissionHost('run-machine', async () => {
      if (observed) return null;
      observed = true;
      return contract;
    });
    const definition = { version: 1, defaults: {}, blocks: [
      { kind: 'action', id: 'first', actionId: 'notify_me', input: {} },
      { kind: 'action', id: 'second', actionId: 'notify_me', input: {} },
    ] };
    const context = { source: { kind: 'inline' as const }, inputs: {}, machineId: 'run-machine',
      executionTarget: { kind: 'session' as const },
      workspaceTarget: { project: { machineId: 'run-machine', directory: '/repo', checkoutRootPath: '/repo' } },
      authorization: { principal: { kind: 'host' as const } } };
    const accepted = await materializeWorkflowAcceptedSnapshotV1({ ...await host({ machineId: 'run-machine', directory: '/repo' }),
      definition, context, admission: { kind: 'user' } });
    expect(accepted).toMatchObject({ ok: true, snapshot: { materializedLeaves: [
      { actionContract: contract }, { actionContract: contract },
    ] } });
    if (!accepted.ok) throw new Error(JSON.stringify(accepted));

    const unavailableHost = sessionAdmissionHost('run-machine', async () => null);
    const replay = await materializeWorkflowAcceptedSnapshotV1({
      ...await unavailableHost({ machineId: 'run-machine', directory: '/repo' }),
      definition, context, replay: { snapshot: accepted.snapshot }, admission: { kind: 'user' },
    });
    expect(replay).toMatchObject({ ok: false, error: { code: 'target_unavailable' } });
  });

  it.each(['origin_session', 'existing_session', 'existing_session_with_agent', 'session_context', 'origin_session_id', 'condition', 'default_origin'] as const)
    ('refuses a cross-Machine %s before the accepted program can run its earlier Action', async (reference) => {
      const host = sessionAdmissionHost('other-machine');
      const agentTarget = { kind: 'agent' as const, identity: { pluginId: 'test.agent', localId: 'agent' } };
      const leaf = reference === 'origin_session_id' || reference === 'default_origin'
        ? { kind: 'action', id: 'bound', actionId: 'session.goal.set', input: reference === 'origin_session_id'
          ? { sessionId: { kind: 'origin_session_id' } } : {} }
        : reference === 'condition'
          ? { kind: 'if', id: 'condition', when: { kind: 'exists', value: { kind: 'session_context_field', field: 'goal.tokenBudget' } },
              then: [{ kind: 'wait', id: 'held', document: { text: 'Wait', references: [], attachments: [] } }], otherwise: [] }
          : { kind: 'step', id: 'bound', document: { text: 'Continue', references: [], attachments: [] }, input: reference === 'session_context'
              ? [{ kind: 'session_context', recentTurns: 0 }] : [],
            execution: { ...(reference === 'session_context' || reference === 'existing_session_with_agent' ? { agentTarget } : {}),
              ...(reference === 'session_context' ? {} : { conversation: reference === 'origin_session' ? { kind: 'origin_session' }
                : { kind: 'existing_session', sessionId, machineId: 'run-machine' } }) } };
      const effect = vi.fn();
      await runWithServerHttpBaseUrl('http://127.0.0.1:41371', async () => {
        const materialization = await host({ machineId: 'run-machine', directory: '/repo' });
        const accepted = await materializeWorkflowAcceptedSnapshotV1({ ...materialization,
          definition: { version: 1, inputs: [], defaults: {}, blocks: [
            { kind: 'action', id: 'earlier', actionId: 'notify_me', input: {} }, leaf,
          ] }, admission: { kind: 'user' }, context: { source: { kind: 'inline' }, inputs: {},
            machineId: 'run-machine', executionTarget: { kind: 'session' },
            workspaceTarget: { project: { machineId: 'run-machine', directory: '/repo', checkoutRootPath: '/repo' } },
            origin: { kind: 'direct', originSessionId: sessionId }, authorization: { principal: { kind: 'host' } } },
        });
        if (accepted.ok) effect();
        expect(accepted, JSON.stringify(accepted)).toMatchObject({ ok: false, error: { code: 'target_unavailable' } });
        expect(effect).not.toHaveBeenCalled();
      });
    });

  it.each([
    { source: 'direct', ownerMachine: 'run-machine', available: true },
    { source: 'trigger', ownerMachine: 'run-machine', available: true },
    { source: 'trigger', ownerMachine: 'other-machine', available: false },
  ] as const)('checks $source retained Session Machine authority: $available', async ({ source, ownerMachine, available }) => {
    const host = sessionAdmissionHost(ownerMachine);
    const context = await host({ machineId: 'run-machine', directory: '/repo' });
    const agentTarget = { kind: 'agent' as const, identity: { pluginId: 'uninstalled.agent', localId: 'agent' } };
    const admitted = await materializeWorkflowAcceptedSnapshotV1({ ...context,
      definition: { version: 1, defaults: {}, blocks: [{ kind: 'step', id: 'bound',
        document: { text: 'Continue', references: [], attachments: [] },
        execution: { agentTarget, conversation: { kind: 'existing_session', sessionId, machineId: 'run-machine' } },
      }] }, context: { source: source === 'direct' ? { kind: 'inline' } : { kind: 'automation', automationId: 'automation' },
        inputs: {}, machineId: 'run-machine', executionTarget: { kind: 'session' },
        workspaceTarget: { project: { machineId: 'run-machine', directory: '/repo', checkoutRootPath: '/repo' } },
        origin: { kind: 'direct', originSessionId: sessionId }, authorization: { principal: { kind: 'host' } } },
      admission: source === 'direct' ? { kind: 'user' } : { kind: 'trigger', workDepth: 0,
        admitLeaf: async (leaf) => admitAgentStartV1(DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1, { kind: 'workflow_run_leaf', leaf }, {
          caller: { kind: 'originless', runId: 'run', runDepth: 0, runOriginSessionId: sessionId },
          baseline: { machineId: 'run-machine', directory: '/repo', configuration: { agentTarget, permissionMode: 'default' } },
          callerPermissionCeiling: 'yolo', workDepthLimit: 8, roles: {}, ledSubtreeSessionIds: [],
        }) },
    });
    expect(admitted, JSON.stringify(admitted)).toMatchObject(available ? { ok: true } : { ok: false, error: { code: 'target_unavailable' } });
    const sessionReads = vi.mocked(axios.get).mock.calls.filter(([url]) => String(url).endsWith(`/v2/sessions/${sessionId}`));
    expect(sessionReads).toHaveLength(1);
  });

  it('checks the supplied Action default origin and preserves cancellation from the Session read', async () => {
    const host = sessionAdmissionHost('other-machine');
    const controller = new AbortController();
    const aborted = new Error('session_admission_aborted');
    vi.mocked(axios.get).mockImplementation(async () => { controller.abort(aborted); throw aborted; });
    const context = await host({ machineId: 'run-machine', directory: '/repo', signal: controller.signal });
    await expect(materializeWorkflowAcceptedSnapshotV1({ ...context,
      definition: { version: 1, defaults: {}, blocks: [{ kind: 'action', id: 'notify', actionId: 'notify_me', input: {} }] },
      context: { source: { kind: 'inline' }, inputs: {}, machineId: 'run-machine', executionTarget: { kind: 'session' },
        workspaceTarget: { project: { machineId: 'run-machine', directory: '/repo', checkoutRootPath: '/repo' } },
        origin: { kind: 'direct', originSessionId: sessionId }, authorization: { principal: { kind: 'host' } } },
      admission: { kind: 'user' },
    })).rejects.toBe(aborted);
  });

  it('does not admit with invented policy defaults when Account settings are unavailable', async () => {
    resetInMemoryAccountSettingsContextForTests();
    vi.stubEnv('HAPPIER_ACCOUNT_SETTINGS_MODE', 'never');
    // The HTTP transport is unavailable; the real settings owner must not be
    // replaced by the caller's environment opt-out or a factory-local policy.
    vi.spyOn(axios, 'get').mockRejectedValue(new Error('account_settings_network_unavailable'));
    const resolve = createCredentialedWorkflowMaterializationHostV1({
      credentials: { token: 'unavailable-workflow-account', encryption: null },
      serverHttpBaseUrl: 'http://127.0.0.1:41371',
      readWorkflowDefinition: async () => null, callMachineAction: async () => { throw new Error('must_not_probe_unadmitted_account'); },
    });
    await expect(resolve({ machineId: 'run-machine', directory: '/repo' })).rejects.toMatchObject({ code: 'source_unavailable' });
  });
  it.each([true, false])('uses the run machine readiness and detached capability: %s', async (detachedAvailable) => {
    const calls: string[] = [];
    const resolve = createWorkflowMaterializationHostV1({
      credentials,
      readRoleSelection: async () => ({}), readLaunchProfile: async () => null, readWorkflowDefinition: async () => null,
      callMachineAction: async ({ machineId, method }) => {
        expect(machineId).toBe('run-machine');
        calls.push(method);
        if (method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) return {
          protocolVersion: 1, projection: { v: 2, generation: 3, agentsById: { installed: {
            id: 'installed', identity: { pluginId: 'test.agent', localId: 'agent' }, catalogAgentId: 'installed',
            capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
          }, nativeOnly: {
            id: 'nativeOnly', identity: { pluginId: 'native.agent', localId: 'agent' }, catalogAgentId: 'nativeOnly',
            capabilities: { executionRuns: { open: ['create'], checkpoint: false, stop: true } },
          } } },
        };
        if (method === RPC_METHODS.CAPABILITIES_DETECT) return { protocolVersion: 1, results: {
          'cli.installed': { ok: true, data: { installed: true, version: '1', latestVersion: null,
            update: { supported: false, command: null }, signIn: { status: 'unknown', loginSupport: 'unsupported' },
            platform: { supported: true }, install: { available: false, mode: 'none', sizeBytes: null, guideUrl: null }, dependencies: [] } },
          'tool.executionRuns': { ok: true, data: { available: detachedAvailable, features: { detachedScope: true }, backends: { installed: { available: true }, nativeOnly: { available: true } } } },
        } };
        throw new Error('unexpected_machine_method');
      },
    });
    const context = await resolve({ machineId: 'run-machine', directory: '/repo', roleSelection: {
      defaultEngine: { agentTargetKey: 'agent:caller.agent/agent' },
    } });
    // Catalog effects occur in the materializer's availability phase, after policy.
    const secondOpinion = resolveRoleSelectionV1({ ...context.roleSelection, roleId: 'second_opinion' });
    expect(secondOpinion).toMatchObject({ ok: true, selection: { engine: { agentTargetKey: 'agent:test.agent/agent' } } });
    const leaf = { blockId: 'work', selection: { agentTarget: { kind: 'agent' as const, identity: { pluginId: 'test.agent', localId: 'agent' } } } };
    await expect(context.effects.resolveTargetAvailability({ ...leaf, executionTarget: { kind: 'session' } }, { sessionIds: [] })).resolves.toBe(true);
    await expect(context.effects.resolveTargetAvailability({ ...leaf, executionTarget: { kind: 'detached_run' } }, { sessionIds: [] })).resolves.toBe(detachedAvailable);
    const nativeLeaf = { ...leaf, selection: { agentTarget: { kind: 'agent' as const, identity: { pluginId: 'native.agent', localId: 'agent' } } } };
    await expect(context.effects.resolveTargetAvailability({ ...nativeLeaf, executionTarget: { kind: 'session' } }, { sessionIds: [] })).resolves.toBe(false);
    await expect(context.effects.resolveTargetAvailability({ ...nativeLeaf, executionTarget: { kind: 'detached_run' } }, { sessionIds: [] })).resolves.toBe(detachedAvailable);
    await expect(context.effects.resolveTargetAvailability({ ...leaf, selection: { agentTarget: { kind: 'agent', identity: { pluginId: 'relay.agent', localId: 'agent' } } }, executionTarget: { kind: 'session' } }, { sessionIds: [] })).resolves.toBe(false);
    // Projected Action starts are not retained-Session steps, even when their
    // ambient selection names a Session already checked by the materializer.
    await expect(context.effects.resolveTargetAvailability({ ...leaf, selection: {
      agentTarget: { kind: 'agent', identity: { pluginId: 'uninstalled.agent', localId: 'agent' } },
      conversation: { kind: 'existing_session', sessionId, machineId: 'run-machine' },
    }, executionTarget: { kind: 'session' } }, { sessionIds: [] })).resolves.toBe(false);
    expect(calls).toEqual([RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE, RPC_METHODS.CAPABILITIES_DETECT]);
  });

  it('fails unavailable machine observations closed at the leaf boundary', async () => {
    const resolve = createWorkflowMaterializationHostV1({
      credentials,
      readRoleSelection: async () => ({}), readLaunchProfile: async () => null, readWorkflowDefinition: async () => null,
      callMachineAction: async () => { throw new Error('machine_offline'); },
    });
    const context = await resolve({ machineId: 'offline-machine', directory: '/repo' });
    await expect(context.effects.resolveTargetAvailability({ blockId: 'work', selection: { agentTarget: { kind: 'agent', identity: { pluginId: 'test.agent', localId: 'agent' } } }, executionTarget: { kind: 'session' } }, { sessionIds: [] })).resolves.toBe(false);
  });

  it.each(['schema_rejected', 'schema_malformed', 'core_rejected', 'schema_aborted', 'core_aborted'])
    ('returns unavailable for a missing Action contract but preserves cancellation: %s', async (failure) => {
      const controller = new AbortController();
      const aborted = new Error('caller_aborted_action_schema_read');
      const actionId = failure.startsWith('core_') ? 'session.inspect' : 'test.action/check';
      const roster = DaemonContributionRegistryProjectionDescribeResponseSchema.parse({
        protocolVersion: 1, projection: { v: 2, generation: 1, actionsById: {
          'test.action/check': { id: 'test.action/check', pluginId: 'test.action', occurrenceId: 'action-occurrence',
            title: 'Check', scopes: ['machine'], surfaces: ['cli'], execution: { target: 'daemon' }, dangerLevel: 'safe' },
        } },
      });
      const unavailable = () => {
        if (failure.endsWith('aborted')) { controller.abort(aborted); throw aborted; }
        throw new Error('action_contract_transport_unavailable');
      };
      const resolve = createWorkflowMaterializationHostV1({
        credentials,
        readRoleSelection: async () => ({}), readLaunchProfile: async () => null, readWorkflowDefinition: async () => null,
        readHostActionContract: async () => unavailable(),
        callMachineAction: async ({ method }) => {
          if (method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) return roster;
          if (method === RPC_METHODS.CAPABILITIES_DETECT) return { protocolVersion: 1, results: {} };
          if (method === RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ) {
            return failure === 'schema_malformed' ? { ok: true, inputSchema: 'not_a_schema' } : unavailable();
          }
          throw new Error('unexpected_machine_method');
        },
      });
      const context = await resolve({ machineId: 'run-machine', directory: '/repo', signal: controller.signal });
      const result = context.effects.readActionContract!(actionId);
      if (failure.endsWith('aborted')) await expect(result).rejects.toBe(aborted);
      else await expect(result).resolves.toBeNull();
    });
});
