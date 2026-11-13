import { describe, expect, it } from 'vitest';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { PUBLIC_ACTION_OUTPUT_SCHEMAS } from '@happier-dev/protocol/actions/actionSpecs';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { createCliActionDeps } from '../createCliActionDeps';
import { createCliActionInventoryDeps } from './createCliActionInventoryDeps';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { AgentModelsProbeObservationSchema, AgentConfigOptionsProbeObservationSchema } from '@happier-dev/protocol/capabilities';
import { createCliCapabilitiesService } from '@/rpc/handlers/capabilities';
import { z } from 'zod/mini';
import { configuration } from '@/configuration';
import { RpcError } from '@happier-dev/protocol/rpcErrors';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';

describe('native Action configuration discovery', () => {
  it('keeps complete Machine model discovery and honors a deliberate 201-row projection', async () => {
    const agentId = 'acme.discovery/assistant';
    const inventory = createCliActionInventoryDeps({ token: 'fixture-token', sessionId: '', mode: 'plain', ctx: null,
      // The selected Machine RPC is the boundary; schema admission and projection remain real.
      callMachineAction: async () => ({ ok: true, result: AgentModelsProbeObservationSchema.parse({
        agentId, availableModels: Array.from({ length: 202 }, (_, index) => ({ id: `model-${index}`, name: `Model ${index}` })),
        supportsFreeform: false, source: 'dynamic',
      }) }),
    });
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...inventory });
    for (const [limit, count] of [[undefined, 202], [201, 201], [2, 2]] as const) {
      const result = await executor.execute('agents.models.list', { agentId, machineId: 'worker',
        ...(limit === undefined ? {} : { limit }) }, { surface: 'cli', authority: 'present_user' });
      expect(result).toMatchObject({ ok: true, result: { source: 'dynamic' } });
      if (!result.ok) throw new Error('Model inventory refused');
      const parsed = PUBLIC_ACTION_OUTPUT_SCHEMAS['agents.models.list'].parse(result.result);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Expected model inventory object');
      expect(parsed.items).toContainEqual({ id: 'model-0', label: 'Model 0' });
      expect(parsed.items).toHaveLength(count);
    }
  });

  it.each([
    ['filesystem_identity_custody_unavailable', false],
    ['agent_isolation_unavailable', false],
    ['provider_endpoint_unreachable', true],
    ['connected_service_credential_reconnect_required', false],
  ] as const)('retains thrown %s and retryability through inventory and the public Action', async (errorCode, retryable) => {
    // The selected Machine RPC is the boundary; inventory and Action admission run unchanged.
    const inventory = createCliActionInventoryDeps({ token: 'fixture-token', sessionId: '', mode: 'plain', ctx: null,
      callMachineAction: async () => { throw Object.assign(new RpcError('private transport diagnostic', errorCode), {
        details: { retryable },
      }); },
    });
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...inventory });
    for (const actionId of ['agents.models.list', 'agents.config_options.list'] as const) {
      const result = await executor.execute(actionId, { agentId: 'codex', machineId: 'worker', probe: { cwd: '/repo' } },
        { surface: 'cli', authority: 'present_user' });
      expect(result).toMatchObject({ ok: false, errorCode, details: { retryable } });
      expect(JSON.stringify(result)).not.toContain('private transport diagnostic');
    }
  });

  it('uses the selected Machine producer for ordinary model and config reads and preserves its failures', async () => {
    const agentId = 'acme.discovery/assistant';
    const backendTargetKey = `agent:${agentId}`;
    let unavailable = false;
    let mismatch = false;
    const inventory = createCliActionInventoryDeps({ token: 'fixture-token', sessionId: '', mode: 'plain', ctx: null,
      rawSession: { machineId: 'mcp-host' },
      callMachineAction: async input => {
        expect(input.machineId).toBe('worker');
        expect(input.method).toBe(RPC_METHODS.CAPABILITIES_INVOKE);
        if (unavailable) return { ok: false, error: { code: 'connected-service-preflight-failed' } };
        const request = input.request as { id: string; method: string };
        expect(request.id).toBe(`cli.${agentId}`);
        const observedAgentId = mismatch ? 'other.agent/assistant' : agentId;
        if (request.method === 'probeModels') return { ok: true, result: AgentModelsProbeObservationSchema.parse({
          agentId: observedAgentId, availableModels: [{ id: 'small', name: 'Small', modelOptions: [{ id: 'reasoning_effort',
            name: 'Thinking', type: 'select', currentValue: 'private-current', options: [{ value: 'low', name: 'Low' }] }] }],
          supportsFreeform: false, source: 'dynamic' }) };
        expect(request.method).toBe('probeConfigOptions');
        return { ok: true, result: AgentConfigOptionsProbeObservationSchema.parse({ agentId: observedAgentId, configOptions: [], source: 'dynamic' }) };
      },
    });
    const args = { agentId, backendTargetKey, machineId: 'worker', modelId: 'small' };
    expect(await inventory.agentsModelsList(args)).toMatchObject({ items: [{ id: 'small' }], source: 'dynamic' });
    const config = await inventory.agentsConfigOptionsList!(args);
    expect(config).toMatchObject({ items: [{ id: 'reasoning_effort', options: [{ value: 'low' }] }], source: 'dynamic' });
    expect(JSON.stringify(config)).not.toContain('private-current');
    expect(await inventory.agentsConfigOptionsList!({ ...args, modelId: 'other' })).toMatchObject({ items: [] });
    mismatch = true;
    expect(await inventory.agentsConfigOptionsList!(args)).toMatchObject({ items: [], source: 'unavailable' });
    mismatch = false;
    unavailable = true;
    for (const read of [inventory.agentsModelsList, inventory.agentsConfigOptionsList!]) {
      expect(await read(args)).toMatchObject({ ok: false, errorCode: 'connected-service-preflight-failed' });
    }
  });

  it('discovers selected-model and session-wide declarations for an external Agent through the real catalog', async () => {
    const pluginId = 'acme.discovery';
    const identity = { pluginId, localId: 'assistant' };
    const agentId = buildQualifiedPluginContributionKey(identity);
    // This physically admitted external plugin is the native observation boundary.
    // Action admission, catalog activation, preflight probes and projection are real.
    const fixture = await createAuthoredAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
      happyHomeDir: configuration.happyHomeDir, plugins: [{
      manifest: createPluginManifestV2Fixture({ id: pluginId, contributes: { agents: [{ id: identity.localId,
        title: 'Discovery Assistant', runtime: { kind: 'custom' }, primary: 'sessions',
        capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
      }] } }),
      files: { 'runtime.mjs': `export async function createRuntime() { return { sessions: {
        open: async () => ({ send: async () => ({ status: 'admitted' }), cancel: async () => ({ status: 'requested' }), watch: () => ({ dispose() {} }), dispose() {} })
      } }; }`, 'daemon.mjs': `
        import { createRuntime } from './runtime.mjs';
        const effort = values => ({ id: 'reasoning_effort', name: 'Thinking', type: 'select', currentValue: 'private-current',
          options: values.map(value => ({ value, name: value })) });
        let modelProbes = 0;
        let configProbes = 0;
        export function activate(api) {
          api.agents.register('assistant', createRuntime, {
            sessionRunnerFactory: { module: './runtime.mjs', export: 'createRuntime', runtimeApiVersion: 1 },
            preflightSessionControls: {
            probeModels: async () => {
              const observation = ++modelProbes;
              await Promise.resolve();
              return [
              { id: 'small', name: 'Small', description: 'model-probe-' + observation, modelOptions: [effort(['low', 'high'])] },
              { id: 'large', name: 'Large', modelOptions: [effort(['medium', 'ultra'])] }
            ]; },
            probeConfigOptions: async () => {
              const observation = ++configProbes;
              await Promise.resolve();
              return [effort(['session-only']),
              { id: 'format', name: 'Format', description: 'config-probe-' + observation, type: 'select', currentValue: 'private-format', options: [{ value: 'text', name: 'Text' }] }]; }
          } });
        }
      ` },
    }] });
    try {
      const activation = await fixture.registry.activateContributionsOnDemand([{ pluginId, family: 'agents', localId: identity.localId }]);
      expect(fixture.registry.agentRuntimesByAgentId.has(agentId), JSON.stringify(activation)).toBe(true);
      const capabilities = await createCliCapabilitiesService();
      const inventory = createCliActionDeps({ token: 'fixture-token', sessionId: 'fixture-session', mode: 'plain', ctx: null,
        serverId: 'home', serverHttpBaseUrl: 'https://discovery.test',
        rawSession: { machineId: 'machine', host: 'host', path: fixture.happyHomeDir },
        machineActionDirectTargetTransport: { machineId: 'machine', invoke: async (method, request, options) => {
          expect(method).toBe(RPC_METHODS.CAPABILITIES_INVOKE);
          const input = z.object({ id: z.string(), method: z.string(), params: z.optional(z.record(z.string(), z.unknown())) }).parse(request);
          expect(input.id).toBe(`cli.${agentId}`);
          return capabilities.invoke({ id: `cli.${agentId}`, method: input.method,
            params: { ...input.params, cwd: fixture.happyHomeDir } }, { signal: options?.signal });
        } },
      });
      const executor = createActionExecutor(inventory);
      const context = { surface: 'agent' as const, authority: 'account_automation' as const, serverId: 'home' };
      const backendTargetKey = `agent:${agentId}`;
      const readDefinitions = () => executor.execute('agents.config_options.list', { agentId, backendTargetKey, modelId: 'small', machineId: 'machine' }, context);
      const [definitions, concurrentDefinitions] = await Promise.all([readDefinitions(), readDefinitions()]);
      expect(concurrentDefinitions).toEqual(definitions);
      expect(definitions, JSON.stringify(definitions)).toMatchObject({ ok: true, result: { items: [
        { id: 'reasoning_effort', type: 'select', options: [{ value: 'low' }, { value: 'high' }] },
        { id: 'format', description: 'config-probe-1', options: [{ value: 'text' }] },
      ] } });
      if (!definitions.ok) throw new Error('Config inventory refused');
      expect(PUBLIC_ACTION_OUTPUT_SCHEMAS['agents.config_options.list'].safeParse(definitions.result).success).toBe(true);
      expect(JSON.stringify(definitions.result)).not.toContain('private-');
      for (const [actionId, fieldPath, draftInput] of [
        ['session.spawn_new', 'configuration', { agentTarget: { kind: 'agent', identity },
          executionTarget: { kind: 'machine', machineId: 'machine' },
          modelSelection: { v: 1, ref: { agentTargetKey: backendTargetKey, modelId: 'small', providerConnectionId: null }, updatedAt: 1 } }],
        ['execution.run.start', 'configOptions', { agentId, backendTargetKey, modelId: 'small', machineId: 'machine' }],
      ] as const) {
        const result = await executor.execute('action.options.resolve', { actionId, fieldPath, draftInput }, context);
        expect(result).toMatchObject({ ok: true, result: { options: [
          { value: 'reasoning_effort', label: 'Thinking' }, { value: 'format', label: 'Format' },
        ] } });
        if (result.ok) expect(PUBLIC_ACTION_OUTPUT_SCHEMAS['action.options.resolve'].safeParse(result.result).success).toBe(true);
      }
      const otherModel = await inventory.agentsConfigOptionsList!({ agentId, backendTargetKey, modelId: 'large', machineId: 'machine' });
      expect(otherModel).toMatchObject({ items: [{ id: 'reasoning_effort', options: [{ value: 'medium' }, { value: 'ultra' }] }, { id: 'format' }] });
      const unselected = await inventory.agentsConfigOptionsList!({ agentId, backendTargetKey, machineId: 'machine' });
      expect(unselected).toMatchObject({ items: [{ id: 'reasoning_effort', options: [{ value: 'session-only' }] },
        { id: 'format', description: 'config-probe-1' }] });
      // Observe the actual native hook's serial through its catalog. Concurrent
      // and warm direct/options reads must reuse the existing probe owner.
      expect(await inventory.agentsModelsList({ agentId, backendTargetKey, machineId: 'machine' }))
        .toMatchObject({ items: expect.arrayContaining([
          expect.objectContaining({ id: 'small', description: 'model-probe-1' }),
        ]) });
      const unavailable = await inventory.agentsConfigOptionsList!({ agentId, backendTargetKey, modelId: 'small', machineId: 'other-machine' });
      expect(unavailable).toMatchObject({ ok: false, errorCode: 'agent_inventory_probe_failed' });
      const foreignHome = await inventory.agentsConfigOptionsList!({ agentId, backendTargetKey, modelId: 'small',
        machineId: 'machine', serverId: 'other-home' });
      expect(foreignHome).toMatchObject({ ok: false, errorCode: 'agent_inventory_probe_failed' });
    } finally { await fixture.dispose(); }
  });
});
