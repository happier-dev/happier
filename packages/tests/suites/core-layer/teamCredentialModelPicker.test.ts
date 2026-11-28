import { expect, it, onTestFinished } from 'vitest';
import { DEFAULT_PROVIDER_SETTINGS_V1, ProviderContributionV1Schema } from '@happier-dev/protocol';
import { TeamCredentialResourceCatalogEntryV1Schema, TeamCredentialSourceBindingV1Schema } from '@happier-dev/protocol/teams';

import { createBrokerProviderRegistry } from '../../../../apps/cli/src/providers/broker/providerBroker.testkit';
import { resolveProviderConnectedAccountDeclarationsV1 } from '@happier-dev/protocol/providers/contributions';
import { projectPrivateLabelForRecipientV1, sealPrivateLabelV1 } from '@happier-dev/protocol';
import { createManagedRunLaunchFixture } from '../../../../apps/cli/src/providers/lifecycle/managedRunLaunch.testkit';
import { createConnectedAccountPurposeBindingOwner } from '../../../../apps/cli/src/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { projectConnectedAccountCatalog } from '../../../../apps/cli/src/providers/modelManagement/connectedAccountCatalog';
import { projectTeamCredentialProviderModels } from '../../../../apps/server/sources/app/teams/credentials/providerModelProjection';
import { buildSessionModelPickerSections } from '../../../../apps/ui/sources/components/sessions/modelPicker/buildSessionModelPickerSections';
import { t } from '../../../../apps/ui/sources/text';
import { createConnectedAccountModelObserver } from '../../../../apps/cli/src/providers/modelManagement/connectedAccountModelObservation';
import { createRuntimeProviderModelManagementServices } from '../../../../apps/cli/src/providers/modelManagement/runtimeServices';
import { resolveTeamCredentialBrokerEligibility, resolveTeamCredentialResourceTestCandidate, resolveTeamCredentialBrokerSourceCatalog } from '../../../../apps/cli/src/providers/broker/resourceTestCandidate';
import { createTeamCredentialExternalModelCatalog } from '../../../../apps/cli/src/providers/broker/teamCredentialModelCatalog';
import { readConnectedAccountBrokerModelCatalog } from '../../../../apps/cli/src/providers/broker/connectedAccountModelCatalog';
import { readSessionTeamCredentialResourceCatalog } from '../../../../apps/cli/src/session/services/sessionTeamCredentialCatalog';

it.each(['static', 'dynamic'] as const)('shows the %s source catalog to recipients and admits only observed models', async source => {
  const service = { pluginId: 'acme.managed-run', localId: 'accounts' };
  const fixture = await createManagedRunLaunchFixture({ connectedAccounts: [{ purpose: 'source-models',
    service: service.localId, materializationKinds: ['httpHeaders'] }] });
  onTestFinished(() => fixture.cleanup());
  const contributes = fixture.lease.registry.contributes;
  const observer = contributes.agentDefinitionsById.get(fixture.agentId);
  if (!observer) throw new Error('The fixture must declare an installed source Agent');
  const base = createBrokerProviderRegistry();
  const registry = { ...contributes, providersByContributionKey: new Map([...base.providersByContributionKey].map(([key, provider]) => {
    const definition = ProviderContributionV1Schema.parse({ ...provider.definition, connectedAccounts: [{
      purpose: 'openai-upstream', service, endpointTemplateIds: ['cliproxyapi-openai-responses'],
      ...(source === 'dynamic' ? { catalogObservation: { agent: observer.identity } } : {}),
      staticModels: [{ id: 'gpt-5.5', name: 'GPT-5.5' }],
    }] });
    return [key, { ...provider, definition,
      connectedAccountDeclarations: resolveProviderConnectedAccountDeclarationsV1({ identity: provider.identity, definition }) }];
  })) };
  const target = { kind: 'account', account: { service, accountId: 'upstream' } } as const;
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
  const machineId = fixture.machineId;
  // The installed Machine's model probe is the IO boundary.
  const invoke = async () => ({ ok: true, result: { agentId: fixture.agentId, source: 'dynamic', observedAt: 1,
    supportsFreeform: false, availableModels: [{ id: 'gpt-6.1-sol', name: 'Sol' }] } });
  const { readSourceModelCatalogs } = createRuntimeProviderModelManagementServices({
    machineId, featureGate: { isEnabled: () => true },
    acquireRuntimeLease: async () => ({ ...fixture.lease, registry: { ...fixture.lease.registry, contributes: registry } }),
    resolveManagedPurposeBindingIntentSelection: purposes.resolveBindingIntentSelection,
    getAccountSettingsSnapshot: (): never => { throw new Error('Unexpected personal catalog access'); },
    invokeConnectedAccountNativeModels: invoke, modelSettingsMutation: unexpected,
  });
  const projection = await projectConnectedAccountCatalog({ registry, providerSettings: DEFAULT_PROVIDER_SETTINGS_V1,
    resolveSelection: purposes.resolveBindingIntentSelection,
    observeModels: createConnectedAccountModelObserver({ registry, invoke }),
    request: { machineId, agentTargetKey, sourceCatalog: true, connectedAccountTarget: target },
  });
  expect(projection.error).toBeUndefined();
  const sourceCatalog = { status: 'success' as const, agentTargetKey, groups: projection.groups };
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
  const brokerInput = { machineId, teamId: 'team', resourceId: 'resource', expectedResourceRevision: 1,
    source: { v: 1, kind: 'connected_account', target, credentialIncarnation: 'incarnation' } as const,
    application, readSourceModelCatalogs };
  const candidate = await resolveTeamCredentialResourceTestCandidate({ ...brokerInput, createRequestId: () => 'test' });
  const catalog = await resolveTeamCredentialBrokerSourceCatalog(brokerInput);
  if (source === 'dynamic') {
    expect(candidate).not.toBeNull();
    expect(JSON.parse(Buffer.from(candidate!.request.bodyBase64, 'base64').toString('utf8'))).toMatchObject({ model: modelId });
    expect(catalog?.resolveCanonicalModelId(modelId)).toBe(modelId);
    expect(catalog?.resolveCanonicalModelId('not-observed')).toBeNull();
    expect(createTeamCredentialExternalModelCatalog(catalog ? [catalog] : [])?.models.map(model => model.id)).toEqual([modelId]);
    expect(await resolveTeamCredentialBrokerEligibility({ ...brokerInput, modelId, sourceRevision: catalog!.sourceRevision })).toEqual({ status: 'eligible' });
    expect(await resolveTeamCredentialBrokerEligibility({ ...brokerInput, modelId: 'not-observed', sourceRevision: catalog!.sourceRevision }))
      .toEqual({ status: 'unavailable', reason: 'model_unavailable' });
  } else {
    expect(candidate).toBeNull();
    expect(catalog).toBeNull();
    expect(await resolveTeamCredentialBrokerEligibility({ ...brokerInput, modelId, sourceRevision: sourceCatalog.groups[0]!.sourceRevision! }))
      .toEqual({ status: 'unavailable', reason: 'application_unavailable' });
  }
  const resource = TeamCredentialResourceCatalogEntryV1Schema.parse({
    id: 'resource', teamId: 'team', displayName: projectPrivateLabelForRecipientV1({
      stored: sealPrivateLabelV1({ mode: 'plain', binding: { entity: 'team_credential_resource', field: 'displayName', id: 'resource' },
        value: 'Team models' }), recipientAccountId: 'recipient',
    }), resourceRevision: 1,
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
  const sourceRequest = { brokerMachineId: machineId, resourceId: 'resource', resourceRevision: 1,
    operation: { kind: 'session' as const, sessionId: 'session' }, application,
    source: brokerInput.source, modelId, sourceRevision: sourceCatalog.groups[0]!.sourceRevision!,
    signal: new AbortController().signal };
  const servingInput = { request: sourceRequest,
    purpose: { consumer: application.implementationIdentity, purpose: 'openai-upstream' },
    projectModels: readSourceModelCatalogs, signal: sourceRequest.signal };
  const serving = await readConnectedAccountBrokerModelCatalog(servingInput);
  if (source === 'dynamic') {
    expect(serving?.modelCatalogs).toEqual([{ purpose: servingInput.purpose,
      sourceRevision: catalog!.sourceRevision, models: [{ id: modelId, name: 'Sol' }] }]);
    expect(await readConnectedAccountBrokerModelCatalog({ ...servingInput,
      request: { ...sourceRequest, sourceRevision: 'retired-observation' } })).toBeNull();
    expect(await readConnectedAccountBrokerModelCatalog({ ...servingInput,
      request: { ...sourceRequest, modelId: 'not-observed' } })).toBeNull();
  } else {
    expect(serving).toBeNull();
  }
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
