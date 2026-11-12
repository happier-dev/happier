import { afterEach, expect, it, vi } from 'vitest';
import { definePlugin, PluginError } from '@happier-dev/plugin-sdk';
import { createActionExecutor } from '@happier-dev/protocol/actions';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { loadInstalledPlugins } from '@/plugins/discovery/load/installed';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createPluginInvocationActionsService } from '../services/actions';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';
import { createCommittedContributedActionInvoker, listRuntimeContributedActionDefinitions } from './createCommittedContributedActionDeps';

// Login storage is an external persistence boundary. Admission, activation,
// invocation, published error projection and public Action normalization stay real.
vi.mock('@/persistence', async original => ({ ...await original<typeof import('@/persistence')>(), readStoredCredentials: async () => null }));
afterEach(() => vi.unstubAllEnvs());

it('preserves only the canonical published PluginError envelope across committed Action normalization', async () => {
  vi.stubEnv('HAPPIER_ACCOUNT_SETTINGS_MODE', 'never');
  vi.stubEnv('HAPPIER_ACTIONS_SETTINGS_V1', '');
  const closed = { type: 'object', properties: {}, additionalProperties: false } as const;
  const shared = { title: 'Fail', dangerLevel: 'safe', scopes: ['global'], surfaces: ['cli'], inputSchema: closed } as const;
  const authored = definePlugin({ id: 'example.committed-failure', version: '1.0.0', entrypoints: { daemon: './daemon.mjs' },
    actions: {
      published: { ...shared, run: async () => { throw new PluginError({ code: 'provider_request_failed', retryable: false,
        details: { phase: 'send' }, remediation: { kind: 'openSettings', path: 'accounts/provider' } }); } },
      unpublished: { ...shared, run: async () => { throw Object.assign(new Error('unpublished transport failure'), {
        data: { name: 'PluginError', code: 'provider_request_failed', details: { phase: 'send', rawPayload: 'unpublished' } },
      }); } },
    } });
  const fixture = await createAuthoredAdmittedPluginRuntimeFixture({ plugins: [{ manifest: authored.manifest,
    files: { 'daemon.mjs': 'export function activate() {}' }, instantiateCommittedModule: () => ({ activate: authored.activate }) }],
    resolveContributes: async happyHomeDir => createResolvedContributionRegistry(projectLoadedPluginContributes({
      loadResult: await loadInstalledPlugins({ happyHomeDir }), provenance: 'external' })),
  });
  try {
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
      invokeContributedAction: createCommittedContributedActionInvoker({ acquireRuntimeRegistryLease: () => fixture.controller.acquireRuntimeRegistry() }) });
    const published = await executor.execute('action.invoke', { action: { pluginId: authored.manifest.id, localId: 'published' }, input: {} }, { surface: 'cli' });
    expect(ActionExecuteFailureSchema.parse(published)).toMatchObject({ ok: false, errorCode: 'provider_request_failed',
      details: { name: 'PluginError', code: 'provider_request_failed', retryable: false,
        details: { phase: 'send' }, remediation: { kind: 'openSettings', path: 'accounts/provider' } } });
    const unpublished = await executor.execute('action.invoke', { action: { pluginId: authored.manifest.id, localId: 'unpublished' }, input: {} }, { surface: 'cli' });
    expect(ActionExecuteFailureSchema.parse(unpublished)).toMatchObject({ ok: false, errorCode: 'plugin_action_execution_failed' });
    expect(unpublished).not.toHaveProperty('details.details.rawPayload');
    expect(unpublished).not.toHaveProperty('details.details.phase');
  } finally { await fixture.dispose(); }
});


it('captures a nested SDK with-origin call through the committed CLI executor and rejects mismatched routing', async () => {
  let effects = 0;
  const pluginId = 'example.committed-origin';
  const machineId = 'origin-machine';
  const serverIdentityId = 'srv_committed_origin';
  const authored = definePlugin({ id: pluginId, version: '1.0.0', entrypoints: { daemon: './daemon.mjs' },
    actions: { read: { title: 'Read', dangerLevel: 'safe', surfaces: ['plugin'],
      inputSchema: { type: 'object', additionalProperties: false },
      run() { effects++; return { received: true }; },
    } } });
  const fixture = await createAuthoredAdmittedPluginRuntimeFixture({ plugins: [{ manifest: authored.manifest,
    files: { 'daemon.mjs': 'export function activate() {}' }, instantiateCommittedModule: () => ({ activate: authored.activate }) }],
    resolveContributes: async happyHomeDir => createResolvedContributionRegistry(projectLoadedPluginContributes({
      loadResult: await loadInstalledPlugins({ happyHomeDir }), provenance: 'external' })),
    runtimeOptions: { resolveCurrentMachineId: () => machineId,
      resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId, machineId }) },
  });
  try {
    const service = createPluginInvocationActionsService({
      invokeContributedAction: async () => { throw new Error('Targeted operations are outside this ordinary-ref test'); },
      seed: { plugin: { id: pluginId, version: '1.0.0' }, contribution: { id: 'read', qualifiedId: `${pluginId}/actions/read` },
        occurrenceId: fixture.registry.readPluginOccurrenceId!(pluginId)!,
        sourceCustody: fixture.registry.readPluginSourceCustody!(pluginId)!,
        surface: 'cli', signal: new AbortController().signal, isOccurrenceCurrent: () => true },
      actionExecutor: createCliActionExecutor({ token: 'fixture-token', sessionId: 'cli-global', mode: 'plain', ctx: null,
        pluginActionExecutionOwner: 'current_process',
        listContributedActionDefinitions: selection => listRuntimeContributedActionDefinitions(fixture.registry, selection),
        invokeContributedAction: createCommittedContributedActionInvoker({ acquireRuntimeRegistryLease: () => fixture.controller.acquireRuntimeRegistry() }) }),
    });
    const action = { pluginId, localId: 'read' };
    const routing = { serverIdentityId, machineId, pluginId };
    await expect(service.executeWithExecutionOrigin(action, {}, { expectedExecutionRouting: routing }))
      .resolves.toMatchObject({ result: { received: true }, executionOrigin: { serverIdentityId } });
    expect(effects).toBe(1);
    await expect(service.executeWithExecutionOrigin(action, {}, { expectedExecutionRouting: { ...routing, machineId: 'other-machine' } }))
      .rejects.toMatchObject({ code: 'plugin_action_execution_origin_mismatch' });
    expect(effects).toBe(1);
  } finally { await fixture.dispose(); }
});
