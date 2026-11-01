import { describe, expect, it } from 'vitest';
import { createActionExecutor, evaluatePluginActionPolicy, getActionSpec, formatQualifiedPluginActionId, PluginActionContributionV2Schema, PluginActionPresentUserAuthorizationFactsSchema, UiContributedActionExecuteRequestV1Schema } from '@happier-dev/protocol';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { createCommittedContributedActionInvoker, createCommittedContributedActionDefinitionLister, createCommittedContributedActionSchemaReader } from '@/plugins/runtime/invocation/actions/createCommittedContributedActionDeps';
import { tryAcquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { createClientActionMachineRpcExecutor } from '@/plugins/runtime/invocation/actions/clientActionMachineRpc';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { PLUGIN_MANIFEST } from '../../../../../../packages/plugins/triage/src/manifest.js';
import { TRIAGE_RUN_CONFIGURED_ACTION_LOCAL_ID_V1, TriageRunConfiguredActionInputV1Schema } from '../../../../../../packages/plugins/triage/src/actions/configuredActionRunProtocol.js';

describe('Triage configured-run client placement', () => {
  // An isolated authored owner exercises the actual Action declaration without
  // installing a second copy of the already bundled first-party plugin.
  const fixturePluginId = 'example.triage-relay';
  it('discovers a cold daemon declaration and activates it only for invocation', async () => {
    const pluginId = 'example.cold-actions';
    const action = PluginActionContributionV2Schema.parse({ id: 'read', title: 'Read', description: 'Read current state',
      scopes: ['global'], surfaces: ['cli'], execution: { target: 'daemon' },
      placementBindings: ['commandPalette'], dangerLevel: 'safe',
      inputSchema: { type: 'object', additionalProperties: false },
      resultSchema: { type: 'object', properties: { active: { type: 'boolean' } }, required: ['active'], additionalProperties: false },
    });
    const fixture = await createAuthoredAdmittedPluginRuntimeFixture({ coldStart: true,
      plugins: [{ manifest: createPluginManifestV2Fixture({ id: pluginId, contributes: { actions: [action] } }),
        files: { 'daemon.mjs': "export function activate(api) { api.actions.register('read', async () => ({ active: true })); }" } }],
    });
    try {
      const list = createCommittedContributedActionDefinitionLister({
        tryAcquireRuntimeRegistryLease: () => tryAcquireAuthoritativePluginRuntimeRegistryLease({ controller: fixture.controller }),
      });
      const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), listContributedActionDefinitions: list,
        readContributedActionSchemas: createCommittedContributedActionSchemaReader(list),
        invokeContributedAction: createCommittedContributedActionInvoker({ acquireRuntimeRegistryLease: () => fixture.controller.acquireRuntimeRegistry() }),
      });
      const id = formatQualifiedPluginActionId({ pluginId, localId: 'read' });
      expect(fixture.registry.activatedPluginIds.has(pluginId)).toBe(false);
      const coldPolicy = fixture.registry.resolveActionPresentUserGatePolicy?.(pluginId, 'read');
      if (!coldPolicy) throw new Error('Expected policy from the real cold runtime producer');
      const executionFacts = PluginActionPresentUserAuthorizationFactsSchema.parse(coldPolicy.authorization);
      expect(executionFacts.generation.appliedGeneration).toBeNull();
      expect(evaluatePluginActionPolicy({ ...executionFacts, confirmation: 'notRequired' }))
        .toMatchObject({ outcome: 'unavailable', code: 'plugin_action_generation_not_applied' });
      const get = await executor.execute('action.spec.get', { id }, { surface: 'cli' });
      expect(get).toMatchObject({ ok: true, result: { actionSpec: { id } } });
      const getOutputSchema = getActionSpec('action.spec.get').outputSchema;
      if (!getOutputSchema) throw new Error('Expected Action detail output schema');
      if (get.ok) getOutputSchema.parse(get.result);
      expect(fixture.registry.activatedPluginIds.has(pluginId)).toBe(false);
      expect(await executor.execute('action.invoke', { action: { pluginId, localId: 'read' }, input: {} }, { surface: 'cli' }))
        .toMatchObject({ ok: true, result: { active: true } });
      expect(fixture.registry.activatedPluginIds.has(pluginId)).toBe(true);
    } finally { await fixture.dispose(); }
  });
  it.each(['agent', 'mcp', 'cli'] as const)('discovers the actual configured-run declaration and delivers the real %s surface to the answering client', async (surface) => {
    const declared = PLUGIN_MANIFEST.contributes.actions?.find(action => action.id === TRIAGE_RUN_CONFIGURED_ACTION_LOCAL_ID_V1);
    if (!declared) throw new Error('Configured-run declaration missing');
    const action = PluginActionContributionV2Schema.parse(declared);
    const input = TriageRunConfiguredActionInputV1Schema.parse({ v: 1, actionId: 'ask', destination: 'single', entries: [{
      entryRef: { source: { pluginId: 'example.source', localId: 'issues' }, kindId: 'issue', collisionScope: 'repository', entryId: '42' },
      sourceInstanceId: '11111111-1111-4111-8111-111111111111',
    }] });
    const requests: unknown[] = [];
    const result = { v: 1, status: 'cancelled' } as const;
    const fixture = await createAuthoredAdmittedPluginRuntimeFixture({
      coldStart: true,
      plugins: [{ manifest: createPluginManifestV2Fixture({ id: fixturePluginId, contributes: { actions: [action] } }),
        files: { 'daemon.mjs': 'export function activate() {}' } }],
      runtimeOptions: { executeClientAction: createClientActionMachineRpcExecutor(() => ({
        hasConnectedClientRpcHandler: () => true,
        // Only the connected-client RPC is substituted. Public meta Action,
        // actual declaration, admission, committed runtime and relay remain real.
        callConnectedClientRpc: async (_method, payload, options) => {
          requests.push(UiContributedActionExecuteRequestV1Schema.parse(payload));
          options.onIssued();
          return { ok: true, result: { ok: true, result } };
        },
      })) },
    });
    try {
      expect(fixture.registry.activatedPluginIds.has(fixturePluginId)).toBe(false);
      const listContributedActionDefinitions = createCommittedContributedActionDefinitionLister({
        tryAcquireRuntimeRegistryLease: () => tryAcquireAuthoritativePluginRuntimeRegistryLease({ controller: fixture.controller }),
      });
      const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
        listContributedActionDefinitions,
        readContributedActionSchemas: createCommittedContributedActionSchemaReader(listContributedActionDefinitions),
        invokeContributedAction: createCommittedContributedActionInvoker({
          acquireRuntimeRegistryLease: () => fixture.controller.acquireRuntimeRegistry(),
        }),
      });
      const request = { action: { pluginId: fixturePluginId, localId: action.id }, input };
      const id = formatQualifiedPluginActionId(request.action);
      const search = await executor.execute('action.spec.search', { query: id }, { surface });
      expect(search).toMatchObject({ ok: true, result: { actionSpecs: expect.arrayContaining([expect.objectContaining({ id })]) } });
      const searchOutputSchema = getActionSpec('action.spec.search').outputSchema;
      if (!searchOutputSchema) throw new Error('Expected Action search output schema');
      if (search.ok) searchOutputSchema.parse(search.result);
      const get = await executor.execute('action.spec.get', { id }, { surface });
      expect(get).toMatchObject({ ok: true, result: { actionSpec: { id } } });
      const getOutputSchema = getActionSpec('action.spec.get').outputSchema;
      if (!getOutputSchema) throw new Error('Expected Action detail output schema');
      if (get.ok) getOutputSchema.parse(get.result);
      expect(fixture.registry.activatedPluginIds.has(fixturePluginId)).toBe(false);
      // Client placement delegates present-user approval to the answering
      // client's canonical dispatcher; it must not ask independently here.
      expect(await executor.execute('action.invoke', request, { surface })).toEqual({ ok: true, result });
      expect(requests).toEqual([{ v: 1, ...request, surface,
        expectedContributorOccurrenceId: fixture.registry.readPluginOccurrenceId?.(fixturePluginId) }]);
    } finally { await fixture.dispose(); }
  });
});
