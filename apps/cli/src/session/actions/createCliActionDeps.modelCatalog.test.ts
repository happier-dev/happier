import { describe, expect, it } from 'vitest';
import { createActionExecutor, createProviderErrorV1, getActionSpec } from '@happier-dev/protocol';
import { DaemonProviderModelProjectionResponseV1Schema, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { AgentModelsProbeObservationSchema } from '@happier-dev/protocol/capabilities';

import { createCliActionDeps } from './createCliActionDeps';

const agentTarget = { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } as const;
const agentTargetKey = 'agent:happier.agent.codex/codex';
const projection = DaemonProviderModelProjectionResponseV1Schema.parse({
  status: 'success', agentTargetKey,
  groups: [{
    connectionId: 'pc_work', providerName: 'Gateway', connectionName: 'Work',
    connectionRole: 'named', connectionDisplayNameMode: 'custom', connectionRevision: 1,
    modelLoadAction: 'descriptor_absent', authorization: { authorized: true },
    manualModelPolicy: 'allowed', supportsFreeformModelIds: false, suppressedConnectedServiceIds: [],
    rows: [{
      ref: { agentTargetKey, providerConnectionId: 'pc_work', modelId: 'native-model' },
      descriptor: { id: 'native-model', name: 'Provider model' },
      sources: { manual: false, static: true, probe: false }, confidence: 'verified_static',
      compatibility: {
        result: { status: 'experimental', selectedProtocol: 'openai-responses',
          reasons: ['compatibility_evidence_missing'], confirmationScope: { kind: 'model', modelId: 'native-model' } },
        compatibilityFingerprint: 'compatibility:v1:catalog-test', confirmed: false,
      },
      endpointHealth: 'not_checked', catalog: { stale: false }, loadState: 'unknown', visibility: 'hidden_agent',
    }],
  }],
});

const nativeProbe = AgentModelsProbeObservationSchema.parse({
  agentId: 'codex', source: 'dynamic', supportsFreeform: false,
  availableModels: [{ id: 'default', name: 'Default' }, { id: 'native-model', name: 'Native model' }],
});

function host(invokeProviderProjection: (method: string, request: unknown) => Promise<unknown>, nativeRequests: unknown[] = []) {
  return createActionExecutor(createCliActionDeps({
    token: 'account-token', sessionId: 'session-1', mode: 'plain', ctx: null,
    rawSession: { machineId: 'session-machine', metadata: {} },
    // Machine transport is the system boundary. Inventory, Agent resolution,
    // Action admission, normalization and output validation remain real. Native
    // probing is independent of the Provider projection failures exercised here.
    machineActionDirectTargetTransport: { machineId: 'machine-1', invoke: async (method, request) => {
      if (method === RPC_METHODS.CAPABILITIES_INVOKE) {
        nativeRequests.push(request);
        return { ok: true, result: nativeProbe };
      }
      if (method !== RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION) throw new Error(`unexpected_machine_method:${method}`);
      return await invokeProviderProjection(method, request);
    } },
  }));
}

const request = {
  actionId: 'session.spawn_new', fieldPath: 'modelSelection',
  draftInput: { agentTarget, executionTarget: { machineId: 'machine-1' } },
};
const nativeModels = [{ value: 'default', label: 'Default' }, { value: 'native-model', label: 'Native model' }];

describe('CLI admitted spawn model catalog', () => {
  it('preserves exact Provider refs and native choices through the existing Action and Machine transport', async () => {
    const requests: Array<{ method: string; request: unknown }> = [];
    const executor = host(async (method, input) => { requests.push({ method, request: input }); return projection; });
    const result = await executor.execute('action.options.resolve', request, { surface: 'cli' });
    expect(result).toMatchObject({ ok: true, result: {
      actionId: 'session.spawn_new', fieldPath: 'modelSelection', options: nativeModels,
      modelCatalog: { nativeModels, providerProjection: projection },
    } });
    expect(requests).toEqual([{ method: RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION,
      request: { machineId: 'machine-1', agentTargetKey, mode: 'picker' } }]);
    if (!result.ok) throw new Error('Expected admitted model catalog');
    const outputSchema = getActionSpec('action.options.resolve').outputSchema;
    if (!outputSchema) throw new Error('Expected canonical options output schema');
    expect(outputSchema.safeParse(result.result).success).toBe(true);
    expect(outputSchema.safeParse({ ...result.result as object,
      fieldPath: 'permissionMode' }).success).toBe(false);
  });

  it.each(['transport', 'typed_provider_failure', 'malformed_projection'] as const)(
    'keeps native choices and exposes null Provider projection after %s failure', async (failure) => {
      const executor = host(async () => {
        if (failure === 'transport') throw new Error('Machine disconnected');
        if (failure === 'typed_provider_failure') return { status: 'error',
          error: createProviderErrorV1('provider_settings_invalid') };
        return { ...projection, secret: 'must-not-cross' };
      });
      await expect(executor.execute('action.options.resolve', request, { surface: 'cli' })).resolves.toMatchObject({
        ok: true, result: { options: nativeModels, modelCatalog: { nativeModels, providerProjection: null } },
      });
    },
  );

  it('does not add the spawn catalog to another model option source', async () => {
    const requests: string[] = [];
    const executor = host(async (method) => { requests.push(method); return projection; });
    const result = await executor.execute('action.options.resolve', {
      actionId: 'session.model.set', fieldPath: 'modelId', optionsSourceId: 'agents.models.available',
      draftInput: { agentId: 'codex', backendTargetKey: agentTargetKey, machineId: 'machine-1' },
    }, { surface: 'cli', defaultSessionId: 'session-1' });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error('Expected model options');
    expect(result.result).not.toHaveProperty('modelCatalog');
    expect(requests).toEqual([]);
  });

  it('requires the owning spawn Action grant before resolving its Provider catalog', async () => {
    const requests: string[] = [];
    const nativeRequests: unknown[] = [];
    const executor = host(async (method) => { requests.push(method); return projection; }, nativeRequests);
    const context = { surface: 'api' as const, authority: 'account_automation' as const,
      defaultSessionId: 'session-1', externalActionTarget: { kind: 'machine' as const, machineId: 'machine-1' },
      externalActionCredential: { accountId: 'account-1', principalId: 'token-1', credentialId: 'token-1', grant: {
        v: 1 as const, actions: { families: [], ids: ['session.title.set'] },
        targets: { sessions: ['session-1'], machines: ['machine-1'] }, approve: false,
        origins: [], models: null, permissionModes: null, create: null,
      } },
    };
    await expect(executor.execute('action.options.resolve', request, context)).resolves.toMatchObject({
      ok: false, errorCode: 'credential_scope_denied',
    });
    expect(requests).toEqual([]);
    expect(nativeRequests).toEqual([]);
    context.externalActionCredential.grant.actions.ids = ['session.spawn_new'];
    await expect(executor.execute('action.options.resolve', request, context)).resolves.toMatchObject({
      // A raw discovery grant is not opened execution authority for a native
      // Machine probe. Do not disguise that refusal as an empty native catalog.
      ok: false, errorCode: 'agent_inventory_probe_failed',
    });
    expect(requests).toEqual([]);
    expect(nativeRequests).toEqual([]);
  });
});
