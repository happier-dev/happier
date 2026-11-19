import { expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { DEFAULT_PROVIDER_SETTINGS_V1 } from '@happier-dev/protocol';
import { DaemonProviderModelProjectionRequestV1Schema } from '@happier-dev/protocol/rpc/providers';
import { TeamCredentialResourceCatalogEntryV1Schema, TeamCredentialSourceBindingV1Schema } from '@happier-dev/protocol/teams';
import { projectTeamCredentialCatalogModels } from '../../../../server/sources/app/teams/credentials/catalogModels';
import type { TeamCredentialCatalogReadinessProjection } from '../../../../server/sources/app/teams/credentials/brokerReadiness';
import { normalizeSessionTeamCredentialLaunch } from '@/session/services/sessionTeamCredentialLaunch';
import { createMuseCatalog } from '../../../../../packages/plugins/muse/src/agent/catalog';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { resolveMergedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { createConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { selectSessionTeamCredentialProviderModel } from '@/providers/broker/sessionTeamCredentialProviderBinding';
import { projectConnectedAccountCatalog } from './connectedAccountCatalog';
import { createConnectedAccountModelObserver } from './connectedAccountModelObservation';
import { createRuntimeProviderModelManagementServices } from './runtimeServices';

it.each(['pi', 'opencode', 'codex'])('admits the custodian Muse catalog through Home, member %s compatibility and launch without recipient observation', async agentId => {
  const fixture = await createAuthoredAdmittedPluginRuntimeFixture({ coldStart: true,
    plugins: [{ manifest: { schemaVersion: 2, id: 'acme.brokered-muse-test', version: '1.0.0', displayName: 'Catalog fixture',
      engines: { happier: '^0.3.0' }, runtime: { apiVersion: 1 }, entrypoints: { daemon: './daemon.mjs' },
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
    const application = broker.groups[0]?.rows[0]?.application;
    if (!application) throw new Error('Expected source application');
    const source = TeamCredentialSourceBindingV1Schema.parse({ v: 1, kind: 'connected_account',
      credentialIncarnation: 'custodian-incarnation', target: { kind: 'account', account } });
    // Start from an entitled resource; Home supplies its model rows from A.
    const resource = TeamCredentialResourceCatalogEntryV1Schema.parse({
      id: 'shared-muse', teamId: 'team', displayName: { content: { t: 'plain', v: 'Team Muse' }, recipientEnvelope: null }, resourceRevision: 1,
      readiness: { kind: 'available' }, recoveryAction: null, mayBroker: true, mayReceiveDirect: false,
      directMaterialState: 'never_delivered', sessionUsePolicy: 'personal_allowed', connectedServiceSelections: [],
      sourcePresentation: { kind: 'connected_service', service: account.service }, deliveryPolicy: { preferredAllowedModes: ['brokered'] }, allowedRoutes: ['brokered'],
      providerModels: [],
    });
    const custodian = createRuntimeProviderModelManagementServices({ machineId: 'custodian',
      featureGate: { isEnabled: () => true }, acquireRuntimeLease: async () => fixture.lease,
      getAccountSettingsSnapshot: unexpected,
      resolveManagedPurposeBindingIntentSelection: purposes.resolveBindingIntentSelection,
      invokeConnectedAccountNativeModels: async () => ({ ok: true,
        result: { agentId: 'muse', source: 'dynamic', supportsFreeform: false, availableModels: models } }),
      modelSettingsMutation: unexpected,
    });
    const read: TeamCredentialCatalogReadinessProjection = { ok: true,
      page: { resources: [resource], nextCursor: null }, brokerReadinessRequests: [],
      projectionRequests: [{ resourceId: resource.id, teamId: resource.teamId, resourceRevision: resource.resourceRevision,
        custodianAccountId: 'owner-A', brokerMachineId: 'custodian', brokerPoolId: null, source,
        allowedModelIds: null, deliveryMode: 'brokered', directMaterialReferences: [] }],
      brokerReadiness: { unavailable: new Map(), poolSnapshots: new Map(), presenceByAccount: new Map() },
    };
    // Home and worker policy are real. Substitute only Machine RPC delivery;
    // source requests go to A, while the worker below runs for member B on C.
    const home = await projectTeamCredentialCatalogModels({ forwardRpcForUser: async request => {
      expect(request.userId).toBe('owner-A');
      return { ok: true, result: await custodian.projectModels(DaemonProviderModelProjectionRequestV1Schema.parse(request.params)) };
    } }, read, application);
    expect(home.resources[0]?.readiness).toEqual({ kind: 'available' });
    const worker = createRuntimeProviderModelManagementServices({ machineId: 'recipient',
      featureGate: { isEnabled: () => true }, acquireRuntimeLease: async () => fixture.lease,
      getAccountSettingsSnapshot: unexpected, resolveManagedPurposeBindingIntentSelection: unexpected,
      invokeConnectedAccountNativeModels: unexpected, observeConnectedAccountSourceModels: unexpected,
      modelSettingsMutation: unexpected,
    });
    const projected = await worker.projectModels({ machineId: 'recipient', agentTargetKey, teamCredentialResources: home.resources }, undefined, {
      signal: new AbortController().signal, machineAdmission: { actorAccountId: 'member-B', custodianAccountId: 'worker-C',
        machineId: 'recipient', installationId: 'worker-installation', role: 'use', encryptionMode: 'plain' },
    });
    if (projected.status !== 'success') throw new Error(projected.error.code);
    const offered = projected.teamCredentialResources?.[0];
    expect(offered?.providerModels.length).toBeGreaterThan(0);
    expect(offered?.providerModels.every(row => row.availability === 'available')).toBe(true);
    expect(offered?.providerModels.some(row => row.descriptor.id.endsWith('-contributor'))).toBe(false);
    if (!offered) throw new Error('Missing Team resource');
    expect(selectSessionTeamCredentialProviderModel({ resource: offered, agentTargetKey, modelId: 'muse-spark-1.2' }))
      .toMatchObject({ availability: 'available', confidence: 'probe', selection: { deliveryMode: 'brokered' } });
    expect(selectSessionTeamCredentialProviderModel({ resource: offered, agentTargetKey, modelId: 'muse-spark-1.2-contributor' })).toBeNull();
    const launch = (modelId: string) => normalizeSessionTeamCredentialLaunch({ agentId, agentTargetKey,
      contributions: registry, applications: [application], readCatalog: async () => [offered],
      options: { directory: '/tmp/member-models',
        modelSelection: { v: 1, updatedAt: 1, ref: { agentTargetKey, providerConnectionId: null, modelId } },
        teamCredentialBindings: [{ v: 1, slot: { kind: 'provider_model' }, resourceId: offered.id,
          teamId: offered.teamId, expectedResourceRevision: offered.resourceRevision, deliveryMode: 'brokered' }],
      },
    });
    await expect(launch('muse-spark-1.2')).resolves.toMatchObject({ teamModelRow: { availability: 'available' } });
    await expect(launch('muse-spark-1.2-contributor')).rejects.toMatchObject({ code: 'provider_model_not_found' });
  } finally { await fixture.dispose(); }
});
