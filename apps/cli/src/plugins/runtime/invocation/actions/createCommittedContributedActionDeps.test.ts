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
import { createDaemonPluginActionExecutor } from '@/session/actions/createDaemonPluginActionExecutor';
import { createDaemonExternalActionContributedInvoker } from '@/daemon/externalActions/createDaemonExternalActionContributedInvoker';
import { createCommittedContributedActionInvoker, listRuntimeContributedActionDefinitions } from './createCommittedContributedActionDeps';

// Login storage is an external persistence boundary. Admission, activation,
// invocation, published error projection and public Action normalization stay real.
vi.mock('@/persistence', async original => ({ ...await original<typeof import('@/persistence')>(), readStoredCredentials: async () => null }));
afterEach(() => vi.unstubAllEnvs());

it.each(['provider_request_failed', 'plugin_disabled', 'authentication_required', 'present_user_required',
  'admission_unavailable', 'approval_execution_outcome_unknown'])(
  'preserves only the canonical published PluginError envelope across committed Action normalization (%s)', async code => {
  vi.stubEnv('HAPPIER_ACCOUNT_SETTINGS_MODE', 'never');
  vi.stubEnv('HAPPIER_ACTIONS_SETTINGS_V1', '');
  const causeCode = code === 'approval_execution_outcome_unknown' ? 'present_user_required' : code;
  const closed = { type: 'object', properties: {}, additionalProperties: false } as const;
  const shared = { title: 'Fail', dangerLevel: 'safe', scopes: ['global'], surfaces: ['cli'], inputSchema: closed } as const;
  const authored = definePlugin({ id: 'example.committed-failure', version: '1.0.0', entrypoints: { daemon: './daemon.mjs' },
    actions: {
      published: { ...shared, run: async () => { throw new PluginError({ code, retryable: false,
        failureCause: { phase: 'send', errorClass: 'Error', errorCode: causeCode, httpStatus: null },
        details: { phase: 'send', requestId: 'adapter-authored-request' }, remediation: { kind: 'openSettings', path: 'accounts/provider' } }); } },
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
    expect(ActionExecuteFailureSchema.parse(published)).toMatchObject({ ok: false, errorCode: code,
      failureCause: { errorCode: causeCode },
      details: { name: 'PluginError', code, retryable: false,
        details: { phase: 'send', requestId: 'adapter-authored-request' }, remediation: { kind: 'openSettings', path: 'accounts/provider' } } });
    const unpublished = await executor.execute('action.invoke', { action: { pluginId: authored.manifest.id, localId: 'unpublished' }, input: {} }, { surface: 'cli' });
    expect(ActionExecuteFailureSchema.parse(unpublished)).toMatchObject({ ok: false, errorCode: 'plugin_action_execution_failed' });
    expect(unpublished).not.toHaveProperty('details.details.rawPayload');
    expect(unpublished).not.toHaveProperty('details.details.phase');
  } finally { await fixture.dispose(); }
});


it.each(['committed CLI', 'daemon external', 'daemon current-process'] as const)(
    'captures a nested SDK with-origin call through %s and rejects mismatched routing', async path => {
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
    const acquireRuntimeRegistryLease = () => fixture.controller.acquireRuntimeRegistry();
    const invoke = path === 'daemon external'
      ? createDaemonExternalActionContributedInvoker({ acquireRuntimeRegistryLease })
      : createCommittedContributedActionInvoker({ acquireRuntimeRegistryLease });
    const localExecutor = createCliActionExecutor({ token: 'fixture-token', sessionId: 'cli-global', mode: 'plain', ctx: null,
      pluginActionExecutionOwner: 'current_process',
      listContributedActionDefinitions: selection => listRuntimeContributedActionDefinitions(fixture.registry, selection),
      invokeContributedAction: invoke });
    const actionExecutor = path === 'daemon current-process'
      ? createDaemonPluginActionExecutor({ base: localExecutor,
          executeInCurrentProcess: async (actionId, input, context) => {
            if (actionId !== 'action.invoke') throw new Error('Expected contributed Action dispatch');
            return { matched: true, result: await localExecutor.execute(actionId, input, context) };
          },
          requestPluginActionExecution: async () => { throw new Error('A bound plugin invocation must remain local'); } })
      : localExecutor;
    const service = createPluginInvocationActionsService({
      invokeContributedAction: async () => { throw new Error('Targeted operations are outside this ordinary-ref test'); },
      seed: { plugin: { id: pluginId, version: '1.0.0' }, contribution: { id: 'read', qualifiedId: `${pluginId}/actions/read` },
        occurrenceId: fixture.registry.readPluginOccurrenceId!(pluginId)!,
        sourceCustody: fixture.registry.readPluginSourceCustody!(pluginId)!,
        surface: 'cli', signal: new AbortController().signal, isOccurrenceCurrent: () => true },
      actionExecutor,
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
