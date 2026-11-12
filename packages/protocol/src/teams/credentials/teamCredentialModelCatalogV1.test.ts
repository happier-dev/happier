import { expect, it } from 'vitest';
import { TeamCredentialResourceCatalogEntryV1Schema } from './resourceV1.js';
import { mergeTeamCredentialCatalogResourcesV1 } from './teamCredentialModelCatalogV1.js';

const generic = TeamCredentialResourceCatalogEntryV1Schema.parse({ id: 'shared', teamId: 'team', displayName: 'Shared',
  resourceRevision: 1, readiness: { kind: 'available' }, recoveryAction: null, mayBroker: true, mayReceiveDirect: false,
  directMaterialState: 'never_delivered', sessionUsePolicy: 'personal_allowed', providerModels: [], sourcePresentation: { kind: 'connected_service', service: { pluginId: 'happier.agent.muse', localId: 'muse-account' } },
});

it.each([false, true])('retains an application broker refusal beside generic discovery (reverse=%s)', reverse => {
  const unavailable = TeamCredentialResourceCatalogEntryV1Schema.parse({ ...generic,
    readiness: { kind: 'broker_unavailable', reason: 'projection_unavailable' }, recoveryAction: 'retry' });
  const pages = [[generic], [unavailable]];
  if (reverse) pages.reverse();
  expect(mergeTeamCredentialCatalogResourcesV1(pages, null).get('team:shared')).toMatchObject({
    readiness: unavailable.readiness, recoveryAction: 'retry' });
});


it('settles an empty model read without changing generic credential discovery', () => {
  expect(mergeTeamCredentialCatalogResourcesV1([[generic]], null).get('team:shared')?.readiness.kind).toBe('available');
  expect(mergeTeamCredentialCatalogResourcesV1([[generic]], null, { requireProviderModels: true }).get('team:shared')).toMatchObject({
    readiness: { kind: 'broker_unavailable', reason: 'catalog_empty' }, recoveryAction: 'retry' });
});


it.each([false, true])('keeps a usable application alternative selectable beside a refusal (reverse=%s)', reverse => {
  const application = { agentTargetKey: 'agent:happier.agent.pi/pi',
    implementationIdentity: { pluginId: 'happier.provider.cliproxyapi', localId: 'cliproxyapi' },
    endpointTemplateId: 'responses', protocol: 'openai-responses' };
  const model = { selection: { kind: 'team_credential_provider_model', teamId: generic.teamId, resourceId: generic.id,
    expectedResourceRevision: 1, deliveryMode: 'brokered', agentTargetKey: application.agentTargetKey, modelId: 'shared-model' },
    descriptor: { id: 'shared-model', name: 'Shared model' }, sourceRevision: 'source-1', availability: 'available', application };
  const available = TeamCredentialResourceCatalogEntryV1Schema.parse({ ...generic, providerModels: [model] });
  const refused = TeamCredentialResourceCatalogEntryV1Schema.parse({ ...generic,
    readiness: { kind: 'broker_unavailable', reason: 'incompatible' }, recoveryAction: 'source_owner_action',
    providerModels: [{ ...model, availability: 'policy_denied', application: { ...application, endpointTemplateId: 'other' } }] });
  const pages = [[refused], [available]];
  if (reverse) pages.reverse();
  const result = mergeTeamCredentialCatalogResourcesV1(pages, null, { requireProviderModels: true }).get('team:shared');
  expect(result?.readiness.kind).toBe('available');
  expect(result?.providerModels).toEqual(expect.arrayContaining(available.providerModels));
  expect(result?.providerModels).toHaveLength(2);
});


it('keeps an independently current Direct credential when no broker models were published', () => {
  const direct = TeamCredentialResourceCatalogEntryV1Schema.parse({ ...generic, mayReceiveDirect: true,
    directMaterialState: 'current' });
  expect(mergeTeamCredentialCatalogResourcesV1([[direct]], null, { requireProviderModels: true }).get('team:shared')?.readiness.kind)
    .toBe('available');
});
