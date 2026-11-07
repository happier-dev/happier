import { afterEach, expect, it, vi } from 'vitest';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { formatQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { loadInstalledPlugins } from '@/plugins/discovery/load/installed';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { tryAcquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { createCommittedContributedActionDefinitionLister, createCommittedContributedActionInvoker,
  createCommittedContributedActionSchemaReader } from '@/plugins/runtime/invocation/actions/createCommittedContributedActionDeps';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { handleActionsCommand } from './actions';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); process.exitCode = undefined; });

it('executes reversible plugin edits from CLI ingress and preserves declared and saved Ask', async () => {
  vi.stubEnv('HAPPIER_ACCOUNT_SETTINGS_MODE', 'never');
  vi.stubEnv('HAPPIER_ACTIONS_SETTINGS_V1', '');
  const action = { pluginId: 'example.cli-approval', localId: 'edit' };
  const actionId = formatQualifiedPluginActionId(action);
  const declaredAskActionId = formatQualifiedPluginActionId({ ...action, localId: 'consequential-edit' });
  const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'cli-approval-owner' })).toString('base64url')}.fixture`,
    encryption: null, credentialProvenance: 'stored_session' as const };
  let value = 'before';
  let consequentialValue = 'before';
  let prompts = 0;
  const plugin = definePlugin({ id: action.pluginId, version: '1.0.0', entrypoints: { daemon: './daemon.mjs' },
    actions: { edit: { title: 'Edit local value', scopes: ['global'], surfaces: ['cli', 'agent', 'mcp'],
      dangerLevel: 'writesLocal', confirmation: { title: 'Edit value?' },
      inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false },
      resultSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false },
      // The real input-schema boundary validates this authored fixture value.
      run: async input => { value = (input as { value: string }).value; return { value }; },
    }, 'consequential-edit': { title: 'Edit consequential local value', scopes: ['global'], surfaces: ['cli', 'agent', 'mcp'],
      dangerLevel: 'writesLocal', confirmation: { title: 'Edit consequential value?' },
      confirmationWhen: { presentUserUi: false, cli: true },
      inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false },
      resultSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false },
      // The real input-schema boundary validates this authored fixture value.
      run: async input => { consequentialValue = (input as { value: string }).value; return { value: consequentialValue }; },
    } },
  });
  const fixture = await createAuthoredAdmittedPluginRuntimeFixture({ plugins: [{ manifest: plugin.manifest,
    files: { 'daemon.mjs': 'export function activate() {}' }, instantiateCommittedModule: () => ({ activate: plugin.activate }) }],
    resolveContributes: async happyHomeDir => createResolvedContributionRegistry(projectLoadedPluginContributes({
      loadResult: await loadInstalledPlugins({ happyHomeDir }), provenance: 'external' })),
    runtimeOptions: { scopedActionRuntime: { credentials, actionsSettingsProvider: createActionSettingsProvider() },
      resolveCurrentMachineId: () => 'machine',
      resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: 'srv_home', machineId: 'machine' }) },
  });
  try {
    const list = createCommittedContributedActionDefinitionLister({ tryAcquireRuntimeRegistryLease: () =>
      tryAcquireAuthoritativePluginRuntimeRegistryLease({ controller: fixture.controller }) });
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), listContributedActionDefinitions: list,
      readContributedActionSchemas: createCommittedContributedActionSchemaReader(list),
      invokeContributedAction: createCommittedContributedActionInvoker({ acquireRuntimeRegistryLease: () => fixture.controller.acquireRuntimeRegistry(),
        // The terminal's current-intent prompt is the boundary. Source admission,
        // activation, discovery, parsing, policy, and the plugin effect remain real.
        requestCurrentIntent: async () => { prompts++; return { status: 'rejected', code: 'plugin_action_current_intent_rejected' }; } }),
    });
    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk, ...args) => {
      output += String(chunk);
      const callback = args.find(argument => typeof argument === 'function');
      if (typeof callback === 'function') callback();
      return true;
    });
    const invoke = async (next: string, requestedActionId = actionId) => {
      output = '';
      await handleActionsCommand(['invoke', requestedActionId, '--value', next, '--json'], {
        readCredentialsFn: async () => credentials,
        createExecutorFn: () => ({ ...executor, resolveSessionTarget: async () => { throw new Error('Unexpected Session lookup'); } }),
      });
      return JSON.parse(output);
    };
    const initial = await invoke('after');
    const admission = JSON.stringify({ ok: initial.ok, errorCode: initial.error?.code, prompts });
    expect(initial, admission).toMatchObject({ ok: true, data: { value: 'after' } });
    expect(value).toBe('after');
    expect(prompts).toBe(0);
    expect(await invoke('unapproved', declaredAskActionId))
      .toMatchObject({ ok: false, error: { code: 'plugin_action_current_intent_rejected' } });
    expect(consequentialValue).toBe('before');
    expect(prompts).toBe(1);
    vi.stubEnv('HAPPIER_ACTIONS_SETTINGS_V1', JSON.stringify({ v: 1,
      actions: { [actionId]: { approvalRequiredSurfaces: ['cli'] } } }));
    expect(await invoke('unapproved')).toMatchObject({ ok: false, error: { code: 'plugin_action_current_intent_rejected' } });
    expect(value).toBe('after');
    expect(prompts).toBe(2);
  } finally { await fixture.dispose(); }
});
