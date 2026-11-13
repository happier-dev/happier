import { expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { DEFAULT_PROVIDER_SETTINGS_V1 } from '@happier-dev/protocol';
import { admitTeamCredentialSourceModelRowsV1 } from '@happier-dev/protocol/rpc/providers';
import { TeamCredentialResourceCatalogEntryV1Schema } from '@happier-dev/protocol/teams';
import { createMuseCatalog } from '../../../../../packages/plugins/muse/src/agent/catalog';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { resolveMergedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { createConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { selectSessionTeamCredentialProviderModel } from '@/providers/broker/sessionTeamCredentialProviderBinding';
import { projectConnectedAccountCatalog } from './connectedAccountCatalog';
import { createConnectedAccountModelObserver } from './connectedAccountModelObservation';
import { createRuntimeProviderModelManagementServices } from './runtimeServices';

it.each(['pi', 'opencode', 'codex'])('uses the broker Muse catalog for %s without a recipient account observation', async agentId => {
  const fixture = await createAuthoredAdmittedPluginRuntimeFixture({ coldStart: true,
    plugins: [{ manifest: { schemaVersion: 2, id: 'acme.brokered-muse-test', version: '1.0.0', displayName: 'Catalog fixture',
      engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 }, entrypoints: { daemon: './daemon.mjs' },
      contributes: {} }, files: { 'daemon.mjs': 'export function activate() {}' } }],
    resolveContributes: happyHomeDir => resolveMergedContributionRegistry({ happyHomeDir }),
  });
  try {
    const registry = fixture.registry.contributes;
    const account = { service: { pluginId: 'happier.agent.muse', localId: 'muse-account' }, accountId: 'custodian-muse' };
    const unexpected = async (): Promise<never> => { throw new Error('Recipient must not read a personal catalog, probe or materialize a credential'); };
    const purposes = createConnectedAccountPurposeBindingOwner({
      store: { read: async () => ({ v: 1, bindings: [] }), update: unexpected, subscribe: () => ({ dispose() {} }) },
      selectTarget: unexpected, materializeAccount: unexpected, projectTargetAccounts: unexpected,
      assertTargetAccountMaterializable: unexpected,
      resolveTarget: async target => target.kind === 'account' ? { account: target.account, displayName: 'Custodian' } : null,
    });
    // Recorded vendor model frames are the only native transport boundary.
    const models = (await createMuseCatalog({ request: async () => {
      const recording = JSON.parse(await readFile(new URL('../../../../../packages/plugins/muse/src/agent/testkit/fixtures/login-smoke.json', import.meta.url), 'utf8'));
      return recording.rows.find((row: { message?: { result?: { models?: unknown } } }) => row.message?.result?.models)?.message.result;
    } }).refresh()).models;
    const agentTargetKey = `agent:happier.agent.${agentId}/${agentId}`;
    const broker = await projectConnectedAccountCatalog({ registry, providerSettings: DEFAULT_PROVIDER_SETTINGS_V1,
      request: { machineId: 'custodian', agentTargetKey, sourceCatalog: true, connectedAccountTarget: { kind: 'account', account } },
      resolveSelection: purposes.resolveBindingIntentSelection,
      observeModels: createConnectedAccountModelObserver({ registry, invoke: async () => ({ ok: true,
        result: { agentId: 'muse', source: 'dynamic', supportsFreeform: false, availableModels: models } }) }),
    });
    expect(broker.error).toBeUndefined();
    const admitted = admitTeamCredentialSourceModelRowsV1({ status: 'success', agentTargetKey, groups: broker.groups });
    if (admitted.status !== 'success') throw new Error(admitted.reason);
    // Home is an IO boundary: schema-validated entitled rows retain the actual
    // custodian projection's descriptors, confidence, source facts and revision.
    const resource = TeamCredentialResourceCatalogEntryV1Schema.parse({
      id: 'shared-muse', teamId: 'team', displayName: 'Team Muse', resourceRevision: 1,
      readiness: { kind: 'available' }, recoveryAction: null, mayBroker: true, mayReceiveDirect: false,
      directMaterialState: 'never_delivered', sessionUsePolicy: 'personal_allowed', connectedServiceSelections: [],
      sourcePresentation: null, deliveryPolicy: { preferredAllowedModes: ['brokered'] }, allowedRoutes: ['brokered'],
      providerModels: admitted.rows.map(({ row, sourceRevision }) => ({
        selection: { kind: 'team_credential_provider_model', resourceId: 'shared-muse', teamId: 'team',
          expectedResourceRevision: 1, deliveryMode: 'brokered', agentTargetKey, modelId: row.descriptor.id },
        descriptor: row.descriptor, application: row.application, sourceFacts: row.sourceFacts,
        sources: row.sources, confidence: row.confidence, sourceRevision, availability: 'available',
      })),
    });
    const worker = createRuntimeProviderModelManagementServices({ machineId: 'recipient',
      featureGate: { isEnabled: () => true }, acquireRuntimeLease: async () => fixture.lease,
      getAccountSettingsSnapshot: unexpected, resolveManagedPurposeBindingIntentSelection: unexpected,
      invokeConnectedAccountNativeModels: unexpected, observeConnectedAccountSourceModels: unexpected,
      modelSettingsMutation: unexpected,
    });
    const projected = await worker.projectModels({ machineId: 'recipient', agentTargetKey, teamCredentialResources: [resource] });
    if (projected.status !== 'success') throw new Error(projected.error.code);
    const offered = projected.teamCredentialResources?.[0];
    expect(offered?.providerModels.length).toBeGreaterThan(0);
    expect(offered?.providerModels.every(row => row.availability === 'available')).toBe(true);
    expect(offered?.providerModels.some(row => row.descriptor.id.endsWith('-contributor'))).toBe(false);
    if (!offered) throw new Error('Missing Team resource');
    expect(selectSessionTeamCredentialProviderModel({ resource: offered, agentTargetKey, modelId: 'muse-spark-1.2' }))
      .toMatchObject({ availability: 'available', confidence: 'probe', selection: { deliveryMode: 'brokered' } });
    expect(selectSessionTeamCredentialProviderModel({ resource: offered, agentTargetKey, modelId: 'muse-spark-1.2-contributor' })).toBeNull();
  } finally { await fixture.dispose(); }
});
