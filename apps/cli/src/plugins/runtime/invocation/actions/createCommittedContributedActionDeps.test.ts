import { afterEach, expect, it, vi } from 'vitest';
import { definePlugin, PluginError } from '@happier-dev/plugin-sdk';
import { createActionExecutor } from '@happier-dev/protocol/actions';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { loadInstalledPlugins } from '@/plugins/discovery/load/installed';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createCommittedContributedActionInvoker } from './createCommittedContributedActionDeps';

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
