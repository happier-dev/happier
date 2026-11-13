import { expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { createMuseCatalog } from '../../../../../packages/plugins/muse/src/agent/catalog';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { resolveMergedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { createConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { projectConnectedAccountCatalog, readConnectedAccountModelCatalog } from './connectedAccountCatalog';
import { DEFAULT_PROVIDER_SETTINGS_V1 } from '@happier-dev/protocol';
import { createConnectedAccountModelObserver } from './connectedAccountModelObservation';

it('observes native Muse models through its published managed account declaration', async () => {
  const fixture = await createAuthoredAdmittedPluginRuntimeFixture({ coldStart: true,
    // The authored fixture needs an installed source generation to activate bundled contributions.
    plugins: [{ manifest: { schemaVersion: 2, id: 'acme.muse-catalog-test', version: '1.0.0', displayName: 'Catalog fixture',
      engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 }, entrypoints: { daemon: './daemon.mjs' },
      contributes: {} }, files: { 'daemon.mjs': 'export function activate() {}' } }],
    resolveContributes: happyHomeDir => resolveMergedContributionRegistry({ happyHomeDir }),
  });
  try {
    const registry = fixture.registry.contributes;
    const service = { pluginId: 'happier.agent.muse', localId: 'muse-account' };
    const account = { service, accountId: 'selected' };
    const unexpected = async (): Promise<never> => { throw new Error('Unexpected credential effect during catalog reading'); };
    // Account metadata storage and native model invocation are IO boundaries.
    const purposes = createConnectedAccountPurposeBindingOwner({
      store: { read: async () => ({ v: 1, bindings: [] }), update: unexpected, subscribe: () => ({ dispose() {} }) },
      selectTarget: unexpected, materializeAccount: unexpected, projectTargetAccounts: unexpected,
      assertTargetAccountMaterializable: unexpected,
      resolveTarget: async target => target.kind === 'account' ? { account: target.account, displayName: 'Selected' } : null,
    });
    let availableModels = (await createMuseCatalog({ request: async () => {
      const recording = JSON.parse(await readFile(new URL('../../../../../packages/plugins/muse/src/agent/testkit/fixtures/login-smoke.json', import.meta.url), 'utf8'));
      return recording.rows.find((row: { message?: { result?: { models?: unknown } } }) => row.message?.result?.models)?.message.result;
    } }).refresh()).models;
    let source = 'static';
    let reads = 0;
    const observeModels = createConnectedAccountModelObserver({ registry, invoke: async request => {
      reads++;
      expect(request.id).toBe('cli.muse');
      expect(request.params).toMatchObject({ connectedServices: { v: 2, bindingsByServiceId: {
        'happier.agent.muse/muse-account': { source: 'connected', profileId: account.accountId },
      } } });
      return { ok: true, result: { agentId: 'muse', source, supportsFreeform: false, availableModels } };
    } });
    const agentTargetKey = 'agent:happier.agent.pi/pi';
    const read = () => readConnectedAccountModelCatalog({ registry, observeModels,
      resolveSelection: purposes.resolveBindingIntentSelection,
      request: { machineId: 'machine', agentTargetKey, connectedAccountTarget: { kind: 'account', account } },
    });
    const absent = await read();
    expect.soft(absent.groups.length).toBe(0);
    expect.soft(absent.error?.code).toBe('provider_catalog_unavailable');
    expect(reads).toBe(1);
    source = 'dynamic';
    const result = await read();
    expect(result.groups).toHaveLength(3);
    expect(result.groups.every(group => group.rows.some(row => row.descriptor.id === 'muse-spark-1.2'))).toBe(true);
    expect(result.groups.every(group => group.rows.every(row => !row.descriptor.id.endsWith('-contributor')))).toBe(true);
    expect(reads).toBe(2);
    const selection = { agentTargetKey: 'agent:happier.agent.pi/pi', providerConnectionId: result.groups[0]!.connectionId,
      modelId: 'muse-spark-1.2-contributor' };
    const project = (modelId: string) => projectConnectedAccountCatalog({ registry, observeModels,
      resolveSelection: purposes.resolveBindingIntentSelection, providerSettings: DEFAULT_PROVIDER_SETTINGS_V1,
      request: { machineId: 'machine', agentTargetKey: selection.agentTargetKey, sourceCatalog: true,
        currentSelection: { ...selection, modelId }, connectedAccountTarget: { kind: 'account', account } } });
    const refused = await project(selection.modelId);
    expect.soft(refused.error?.code).toBe('provider_model_not_found');
    const plain = await project('muse-spark-1.2');
    expect(plain.error).toBeUndefined();
    expect(plain.groups.some(group => group.rows.some(row => row.ref.modelId === 'muse-spark-1.2'))).toBe(true);
    const launchCatalog = await readConnectedAccountModelCatalog({ registry,
      resolveSelection: purposes.resolveBindingIntentSelection,
      request: { machineId: 'machine', agentTargetKey, connectedAccountTarget: { kind: 'account', account } },
      readModelProjection: async request => {
        const projection = await projectConnectedAccountCatalog({ registry, observeModels,
          resolveSelection: purposes.resolveBindingIntentSelection, providerSettings: DEFAULT_PROVIDER_SETTINGS_V1, request });
        return projection.error ? { status: 'error', error: projection.error }
          : { status: 'success', agentTargetKey: request.agentTargetKey, groups: projection.groups };
      },
    });
    expect.soft(launchCatalog.groups.map(group => group.rows.map(row => row.descriptor.id)))
      .toEqual(result.groups.map(group => group.rows.map(row => row.descriptor.id)));
    availableModels = (await createMuseCatalog({ request: async () => {
      const recording = JSON.parse(await readFile(new URL('../../../../../packages/plugins/muse/src/agent/testkit/fixtures/key-only.json', import.meta.url), 'utf8'));
      return recording.rows.find((row: { message?: { result?: { models?: unknown } } }) => row.message?.result?.models)?.message.result;
    } }).refresh()).models;
    const key = await read();
    expect(key.groups.every(group => group.rows.some(row => row.descriptor.id === 'muse-spark-1.2-contributor'))).toBe(true);
    expect.soft(reads).toBe(6);
  } finally { await fixture.dispose(); }
});
