import { expect, it } from 'vitest';
import { DEFAULT_PROVIDER_SETTINGS_V1, ProviderContributionV1Schema } from '@happier-dev/protocol';
import { TeamCredentialResourceCatalogEntryV1Schema, TeamCredentialSourceBindingV1Schema } from '@happier-dev/protocol/teams';

import { createBrokerProviderRegistry } from '../../../../apps/cli/src/providers/broker/providerBroker.testkit';
import { createConnectedAccountPurposeBindingOwner } from '../../../../apps/cli/src/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { projectConnectedAccountCatalog } from '../../../../apps/cli/src/providers/modelManagement/connectedAccountCatalog';
import { projectTeamCredentialProviderModels } from '../../../../apps/server/sources/app/teams/credentials/providerModelProjection';
import { buildSessionModelPickerSections } from '../../../../apps/ui/sources/components/sessions/modelPicker/buildSessionModelPickerSections';
import { t } from '../../../../apps/ui/sources/text';
import { AgentModelsProbeObservationSchema } from '@happier-dev/protocol/capabilities';
import type { DaemonProviderModelProjectionRequestV1 } from '@happier-dev/protocol/rpc/providers';
import { resolveTeamCredentialBrokerEligibility, resolveTeamCredentialResourceTestCandidate, resolveTeamCredentialSourceModelCatalog } from '../../../../apps/cli/src/providers/broker/resourceTestCandidate';
import { createTeamCredentialExternalModelCatalog } from '../../../../apps/cli/src/providers/broker/teamCredentialModelCatalog';
import { readConnectedAccountBrokerModelCatalog } from '../../../../apps/cli/src/providers/broker/connectedAccountModelCatalog';
import { readSessionTeamCredentialResourceCatalog } from '../../../../apps/cli/src/session/services/sessionTeamCredentialCatalog';

it.each(['static', 'dynamic'] as const)('carries the real %s source catalog through Home, picker, Test and broker admission', async source => {
  const base = createBrokerProviderRegistry();
  const registry = { ...base, providersByContributionKey: new Map([...base.providersByContributionKey].map(([key, provider]) => [key, {
    ...provider, definition: ProviderContributionV1Schema.parse({ ...provider.definition, managedRuntime: {
      ...provider.definition.managedRuntime,
      connectedAccounts: [{ purpose: 'openai-upstream', service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
        endpointTemplateIds: ['cliproxyapi-openai-responses'], staticModels: [{ id: 'gpt-5.5', name: 'GPT-5.5' }] }],
    } }),
  }])) };
  const target = { kind: 'account', account: {
    service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'upstream',
  } } as const;
  const unexpected = async (): Promise<never> => { throw new Error('Catalog must not access or materialize credentials'); };
  // Storage and the upstream Account lookup are genuine system boundaries.
  // Purpose resolution, source projection, Home projection and picker are real.
  let accountReads = 0;
  const purposes = createConnectedAccountPurposeBindingOwner({
    store: { read: async () => ({ v: 1, bindings: [] }), update: unexpected, subscribe: () => ({ dispose() {} }) },
    selectTarget: unexpected, materializeAccount: unexpected, projectTargetAccounts: unexpected,
    assertTargetAccountMaterializable: unexpected,
    resolveTarget: async value => { accountReads++; return value.kind === 'account' ? { account: value.account, displayName: 'Work' } : null; },
  });
  const agentTargetKey = 'agent:happier.agent.codex/codex';
  const projectModels = async (request: DaemonProviderModelProjectionRequestV1) => {
    const projection = await projectConnectedAccountCatalog({ registry, providerSettings: DEFAULT_PROVIDER_SETTINGS_V1,
    resolveSelection: purposes.resolveBindingIntentSelection,
    ...(source === 'dynamic' ? { observeModels: async () => AgentModelsProbeObservationSchema.parse({
      agentId: 'codex', source: 'dynamic', observedAt: 1, supportsFreeform: false,
      availableModels: [{ id: 'gpt-6.1-sol', name: 'Sol' }],
    }) } : {}), request,
    });
    return { status: 'success' as const, agentTargetKey, groups: projection.groups };
  };
  const sourceCatalog = await projectModels({ machineId: 'broker', agentTargetKey, sourceCatalog: true, connectedAccountTarget: target });
  const application = sourceCatalog.groups[0]?.rows[0]?.application;
  if (!application) throw new Error('Source producer did not publish its application');
  const projected = projectTeamCredentialProviderModels({
    response: sourceCatalog,
    resourceId: 'resource', teamId: 'team', resourceRevision: 1, agentTargetKey, application,
    source: TeamCredentialSourceBindingV1Schema.parse({ v: 1, kind: 'connected_account', target, credentialIncarnation: 'incarnation' }),
    allowedModelIds: null, deliveryMode: 'brokered',
  });
  const modelId = source === 'dynamic' ? 'gpt-6.1-sol' : 'gpt-5.5';
  expect(projected).toMatchObject({ status: 'success', models: [{ descriptor: { id: modelId },
    confidence: source === 'dynamic' ? 'probe' : 'account_unverified',
    sources: { manual: false, static: source === 'static', probe: source === 'dynamic' }, availability: 'available' }] });
  const brokerInput = { machineId: 'broker', teamId: 'team', resourceId: 'resource', expectedResourceRevision: 1,
    resourceRevision: 1, source: TeamCredentialSourceBindingV1Schema.parse({ v: 1, kind: 'connected_account', target, credentialIncarnation: 'incarnation' }),
    application, projectModels };
  const candidate = await resolveTeamCredentialResourceTestCandidate({ ...brokerInput, agentTargetKeys: [agentTargetKey], createRequestId: () => 'test' });
  expect(JSON.parse(Buffer.from(candidate!.request.bodyBase64, 'base64').toString('utf8'))).toMatchObject({ model: modelId });
  const catalog = await resolveTeamCredentialSourceModelCatalog(brokerInput);
  expect(catalog?.resolveCanonicalModelId(modelId)).toBe(modelId);
  expect(catalog?.resolveCanonicalModelId('not-observed')).toBeNull();
  expect(createTeamCredentialExternalModelCatalog(catalog ? [catalog] : [])?.models.map(model => model.id)).toEqual([modelId]);
  expect(await resolveTeamCredentialBrokerEligibility({ ...brokerInput, modelId, sourceRevision: catalog!.sourceRevision })).toEqual({ status: 'eligible' });
  expect(await resolveTeamCredentialBrokerEligibility({ ...brokerInput, modelId: 'not-observed', sourceRevision: catalog!.sourceRevision }))
    .toMatchObject({ status: 'unavailable' });
  const resource = TeamCredentialResourceCatalogEntryV1Schema.parse({
    id: 'resource', teamId: 'team', displayName: 'Team models', resourceRevision: 1,
    readiness: { kind: 'available' }, recoveryAction: null, mayBroker: true, mayReceiveDirect: false,
    directMaterialState: 'never_delivered', sessionUsePolicy: 'personal_allowed',
    sourcePresentation: { kind: 'connected_service', service: target.account.service }, providerModels: projected.models,
  });
  const launch = await readSessionTeamCredentialResourceCatalog({ applications: [application], teamIds: ['team'],
    homeDomainAction: async request => {
      expect(request.input).toMatchObject({ teamId: 'team', application });
      return { resources: [resource], nextCursor: null };
    },
  });
  expect(launch[0]?.providerModels.map(row => row.descriptor.id)).toEqual([modelId]);
  if (brokerInput.source.kind !== 'connected_account') throw new Error('Expected the Connected Account producer');
  const sourceRequest = { brokerMachineId: 'broker', resourceId: 'resource', resourceRevision: 1,
    operation: { kind: 'session' as const, sessionId: 'session' }, application,
    source: brokerInput.source, modelId, sourceRevision: catalog!.sourceRevision, signal: new AbortController().signal };
  const servingInput = { request: sourceRequest,
    purpose: { consumer: application.implementationIdentity, purpose: 'openai-upstream' },
    projectModels, signal: sourceRequest.signal };
  const serving = await readConnectedAccountBrokerModelCatalog(servingInput);
  if (source === 'dynamic') expect(serving?.modelCatalogs).toEqual([{ purpose: servingInput.purpose,
    sourceRevision: catalog!.sourceRevision, models: [{ id: modelId, name: 'Sol' }] }]);
  else expect(serving?.modelCatalogs).toBeUndefined();
  expect(await readConnectedAccountBrokerModelCatalog({ ...servingInput,
    request: { ...sourceRequest, sourceRevision: 'retired-observation' } })).toBeNull();
  expect(await readConnectedAccountBrokerModelCatalog({ ...servingInput,
    request: { ...sourceRequest, modelId: 'not-observed' } })).toBeNull();
  const readsAfterProjection = accountReads;
  const options = buildSessionModelPickerSections({ declarationContext: { kind: 'account' }, agentTargetKey,
    nativeModels: [], providerGroups: [], hiddenNativeModelKeys: new Set(), providerProjectionAuthoritative: true,
    teamCredentialResources: [resource],
  }).flatMap(section => section.options);
  expect(options).toHaveLength(1);
  expect(options[0]?.disabled).toBe(false);
  if (source === 'static') expect(options[0]).toMatchObject({ description: expect.stringContaining(t('settingsProviders.status.notChecked')),
    accessibilityLabel: expect.stringContaining(t('settingsProviders.status.notChecked')) });
  // Presenting admitted evidence adds no source I/O or credential work.
  expect(accountReads - readsAfterProjection).toBe(0);
});
