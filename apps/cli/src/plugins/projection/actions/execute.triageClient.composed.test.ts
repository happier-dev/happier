import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fastify from 'fastify';
import { createActionExecutor, evaluatePluginActionPolicy, getActionSpec, formatQualifiedPluginActionId, PluginActionContributionV2Schema, PluginActionPresentUserAuthorizationFactsSchema } from '@happier-dev/protocol';
import { createAdmittedPluginRuntimeFixture, createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { createCommittedContributedActionInvoker, createCommittedContributedActionDefinitionLister, createCommittedContributedActionSchemaReader } from '@/plugins/runtime/invocation/actions/createCommittedContributedActionDeps';
import { tryAcquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { registerAuthoredAccountActionRelease } from '@/plugins/runtime/accountPluginActions.testkit';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { PLUGIN_MANIFEST } from '../../../../../../packages/plugins/triage/src/manifest.js';
import { TRIAGE_RUN_CONFIGURED_ACTION_LOCAL_ID_V1, TriageRunConfiguredActionInputV1Schema, TriageRunConfiguredActionResultV1Schema } from '../../../../../../packages/plugins/triage/src/actions/configuredActionRunProtocol.js';

describe('Triage configured-run Account placement', () => {
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
  it.each(['agent', 'mcp', 'cli'] as const)('discovers the actual configured-run declaration and delivers the real %s surface to the Account handler', async (surface) => {
    const declared = PLUGIN_MANIFEST.contributes.actions?.find(action => action.id === TRIAGE_RUN_CONFIGURED_ACTION_LOCAL_ID_V1);
    if (!declared) throw new Error('Configured-run declaration missing');
    const declaredAction = PluginActionContributionV2Schema.parse(declared);
    expect(declaredAction.execution.target).toBe('account');
    // The canonical authored Account harness owns its physical fixture slot.
    // Keep the real declaration/schema/policy; only bind that slot's export.
    const action = PluginActionContributionV2Schema.parse({ ...declared,
      execution: { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activateAccount' } },
    });
    const entry = {
      entryRef: { source: { pluginId: 'example.source', localId: 'issues' }, kindId: 'issue', collisionScope: 'repository', entryId: '42' },
      sourceInstanceId: '11111111-1111-4111-8111-111111111111',
    };
    const input = TriageRunConfiguredActionInputV1Schema.parse({ v: 1, handoff: {
      task: 'fix', configuredActionId: 'ask', context: { kind: 'entry', entry }, evidence: [{ kind: 'entry', entry }],
      sessionChoice: { kind: 'configured' }, agentChoice: { kind: 'configured' }, delivery: 'configured',
    } });
    const result = TriageRunConfiguredActionResultV1Schema.parse({ v: 1, handoff: { kind: 'cancelled' }, reason: surface });
    const directory = await mkdtemp(join(tmpdir(), 'triage-account-action-'));
    const app = fastify();
    const origin = 'http://triage-account-action.test';
    const accountId = 'triage-action-owner';
    const manifest = createPluginManifestV2Fixture({ id: fixturePluginId, entrypoints: {}, contributes: { actions: [action] } });
    const entryPath = join(directory, 'index.mjs');
    await writeFile(join(directory, 'package.json'), JSON.stringify({ name: '@example/triage-relay', type: 'module',
      exports: { './happier-plugin-ui/account-runtime': './index.mjs' } }), 'utf8');
    // Authored fixture behavior, not an internal mock: the compiled Account
    // handler exposes its host-stamped surface through an admitted result field.
    await writeFile(entryPath, `export const manifest = ${JSON.stringify(manifest)};
      export function activateAccount(api) {
        api.actions.register(${JSON.stringify(action.id)}, async (_input, context) =>
          ({ v: 1, handoff: { kind: 'cancelled' }, reason: context.surface }));
      }
      export function activate() {}`, 'utf8');
    await registerAuthoredAccountActionRelease(app, accountId, { primary: { manifest, projectRoot: directory, entryPath } });
    app.get('/v1/account/encryption', async () => ({ mode: 'plain', updatedAt: 1 }));
    app.get('/v1/account/encryption/currentness', async () => ({ mode: 'plain', version: 1,
      settingsVersion: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }));
    app.get('/v2/account/settings', async () => ({ content: { t: 'plain', v: {} }, version: 1 }));
    await app.ready();
    const restore = installAxiosFastifyAdapter({ app, origin });
    const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`, encryption: null };
    const fixture = await createAdmittedPluginRuntimeFixture({
      runtimeOptions: { accountExecution: { credentials, serverUrl: origin, isCurrent: () => true } },
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
          // Only the present-user decision boundary is substituted. Admission,
          // fingerprint currentness and the Account handler stay real.
          requestCurrentIntent: async ({ fingerprint }) => ({ status: 'approved', fingerprint }),
        }),
      });
      const request = { action: { pluginId: fixturePluginId, localId: action.id }, input };
      const id = formatQualifiedPluginActionId(request.action);
      const search = await executor.execute('action.spec.search', { query: id }, { surface });
      expect(search, JSON.stringify(search)).toMatchObject({ ok: true, result: { actionSpecs: expect.arrayContaining([expect.objectContaining({ id })]) } });
      const searchOutputSchema = getActionSpec('action.spec.search').outputSchema;
      if (!searchOutputSchema) throw new Error('Expected Action search output schema');
      if (search.ok) searchOutputSchema.parse(search.result);
      const get = await executor.execute('action.spec.get', { id }, { surface });
      expect(get).toMatchObject({ ok: true, result: { actionSpec: { id } } });
      const getOutputSchema = getActionSpec('action.spec.get').outputSchema;
      if (!getOutputSchema) throw new Error('Expected Action detail output schema');
      if (get.ok) getOutputSchema.parse(get.result);
      expect(fixture.registry.activatedPluginIds.has(fixturePluginId)).toBe(false);
      expect(await executor.execute('action.invoke', request, { surface })).toEqual({ ok: true, result });
      expect(fixture.registry.activatedPluginIds.has(fixturePluginId)).toBe(true);
    } finally {
      try { await fixture.dispose(); } finally { restore(); await app.close(); await rm(directory, { recursive: true, force: true }); }
    }
  });
});
