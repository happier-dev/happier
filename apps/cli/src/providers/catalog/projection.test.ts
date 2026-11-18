import { describe, expect, it } from 'vitest';
import { projectProviderCatalogForPicker } from './projection';
import type { ProviderConnectionCatalog } from './types';
import { serializeModelVisibilityRefV1 } from '@happier-dev/protocol/providers/model-selection';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol';
import { DEFAULT_PROVIDER_SETTINGS_V1, createEmptyProviderRuntimeStateFileV1 } from '@happier-dev/protocol';
import { normalizeCustomProviderTemplateV1 } from '@happier-dev/protocol/providers/connections/normalizeCustomTemplateV1';
import { createAccountProviderActionExecuteV1 } from '@happier-dev/protocol/providers/connections/accountProviderActionV1';
import { composeProviderSettingsV1, splitProviderSettingsV1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { parseProviderActionRequestV1 } from '@happier-dev/protocol/providers/providerActionsV1';
import { resolveProviderBindingDeclarationCompatibilityV1 } from '@happier-dev/protocol/providers/compatibility/resolve';
import type { AgentProviderRequirementsV1 } from '@happier-dev/protocol/providers/compatibility/v1';
import { resolveProviderConnectionForMachine } from '../registry/resolve';
import { assembleProviderConnectionCatalog } from './assemble';
import { setProviderConnectionGrant } from '../connections/service/grants';

const connectionId = ProviderConnectionIdSchema.parse('pc_a');
const ref = (modelId: string) => ({ agentTargetKey: 'agent:codex', providerConnectionId: connectionId, modelId });
const catalog: ProviderConnectionCatalog = {
  agentTargetKey: 'agent:codex', connectionId, authorization: { authorized: true },
  providerName: 'Source', connectionName: 'Work', connectionRole: 'named', connectionDisplayNameMode: 'custom',
  manualModelPolicy: 'allowed', sourceKind: 'aggregator', staleRows: [],
  rows: ['current', 'favorite', 'default', 'new'].map(modelId => ({
    ref: ref(modelId), descriptor: { id: modelId, name: 'Same name' },
    sources: { manual: false, static: true, probe: false }, confidence: 'verified_static',
    presentation: { compatibility: { result: { status: 'verified', selectedProtocol: 'openai-responses', evidence: { sourceUrls: ['https://example.com'], verifiedAt: '2026-10-09' } }, compatibilityFingerprint: 'compatibility:v1:test' },
      endpointHealth: null, catalog: { stale: false }, loadState: 'unknown' },
  })),
};

describe('Provider source discovery', () => {
  it('preserves the Machine refusal for a no-auth Responses Provider created after the picker loaded, then offers its saved model after the exact Machine grant', async () => {
    const agentTargetKey = 'agent:happier.agent.codex/codex';
    const machineId = '6a37defb-c9fd-46bd-8b59-5a341cf630a9';
    const connectionId = 'pc_ca67d5e0-7dda-481e-a394-a5351ae770b9';
    const template = normalizeCustomProviderTemplateV1({ name: 'Custom Responses', protocol: 'openai-responses',
      baseUrl: 'http://100.64.35.88:35951/v1', catalog: 'probe', modelsPath: '/models' });
    // Codex's published requirements: Responses, no-auth supported, unknown capabilities need confirmation.
    const agent: AgentProviderRequirementsV1 = { acceptsProtocols: ['openai-responses'],
      required: { streaming: true, toolRoundTrips: true }, credentialSupport: { supportsNoAuth: true, apiKeyTransports: [] },
      authIsolation: { suppressConnectedServiceIds: [], ownedEnvKeys: [] }, materialization: 'engineConfig',
      applyPolicy: 'restart_session', supportsFreeformModelIds: true };
    expect(projectProviderCatalogForPicker({ catalogs: [catalog], modelVisibilityByRef: {},
      modelPickerVisibilityByConnectionId: { pc_a: true } }).groups.map(group => group.connectionId)).toEqual(['pc_a']);
    // The persistence boundary keeps the real Account action used by UI Save/Approve.
    let savedCatalog = splitProviderSettingsV1(DEFAULT_PROVIDER_SETTINGS_V1).catalog;
    const execute = createAccountProviderActionExecuteV1({ assertCurrent() {}, now: () => 1,
      readCatalog: async () => ({ status: 'ready', revision: 1, catalog: savedCatalog }), readDefinitions: async () => [],
      writeCatalog: async value => { savedCatalog = value.catalog; return { status: 'updated' }; },
    });
    expect(await execute(parseProviderActionRequestV1('providers.connections.create_custom', {
      action: 'createCustom', connectionId, machineId, template, savedSecretId: null,
      manualModels: [{ id: 'qa-f-ui-tool' }], enable: true,
    }), { surface: 'ui' })).toMatchObject({ ok: true });
    const accountEnabled = composeProviderSettingsV1(savedCatalog, {});
    expect(accountEnabled.accountGrants).toHaveLength(1);
    expect(accountEnabled.machineGrants).toEqual([]);
    const resolve = (providerSettings: typeof accountEnabled) => {
      const result = resolveProviderConnectionForMachine({ connectionId, machineId, providerSettings,
        registry: { providersByContributionKey: new Map() },
        dnsEvidenceByEndpointUrl: new Map([['http://100.64.35.88:35951/v1', ['100.64.35.88']]]) });
      if (result.status !== 'resolved') throw new Error(`Expected resolved custom Provider: ${result.status}`);
      return result.record;
    };
    const initial = resolve(accountEnabled);
    const project = (settings: typeof accountEnabled, scoped = true) => {
      const record = resolve(settings);
      const compatibility = resolveProviderBindingDeclarationCompatibilityV1({ agentTargetKey, agent,
        endpoints: template.endpointTemplates, model: { id: 'qa-f-ui-tool', name: 'qa-f-ui-tool' } });
      expect(compatibility.result.status).toBe('experimental');
      const assembled = assembleProviderConnectionCatalog({ agentTargetKey, connection: record,
        providerSettings: settings, runtimeState: createEmptyProviderRuntimeStateFileV1(machineId), catalogRuntimeKey: null,
        compatibilityByModelId: new Map([['qa-f-ui-tool', compatibility]]) });
      expect(assembled.rows.map(row => row.ref.modelId)).toEqual(['qa-f-ui-tool']);
      return projectProviderCatalogForPicker({ catalogs: [catalog, assembled], modelVisibilityByRef: {},
        modelPickerVisibilityByConnectionId: { pc_a: true, [connectionId]: true },
        ...(scoped ? { sourceConnectionId: connectionId } : {}) });
    };
    // A fresh projection contains the new saved catalog, yet ordinary browse still shows only the older source.
    expect(project(accountEnabled, false).groups.map(group => group.connectionId)).toEqual(['pc_a']);
    expect(project(accountEnabled).groups).toMatchObject([{ connectionId,
      authorization: { authorized: false, errorCode: 'provider_not_enabled_on_machine' }, rows: [] }]);
    const machineEnabled = setProviderConnectionGrant({ settings: accountEnabled, connectionId, machineId,
      scope: 'machine', enabled: true, connectionSecurityFingerprint: initial.connectionSecurityFingerprint,
      endpointSetFingerprint: initial.endpointSetFingerprint, now: 3 });
    expect(project(machineEnabled).groups[0]?.rows.map(row => row.ref.modelId)).toEqual(['qa-f-ui-tool']);
  });
  it('exposes compatible declared models for Account management without asserting runtime authorization', () => {
    const unavailable = { ...catalog, authorization: { authorized: false as const,
      errorCode: 'provider_machine_unavailable' as const } };
    const projection = projectProviderCatalogForPicker({ catalogs: [unavailable], modelVisibilityByRef: {},
      mode: 'management', observationScope: 'account' });
    expect(projection.groups[0]?.rows).toHaveLength(4);
    expect(projection.groups[0]?.authorization).toEqual(unavailable.authorization);
    expect(projectProviderCatalogForPicker({ catalogs: [unavailable], modelVisibilityByRef: {},
      mode: 'management' }).groups).toEqual([]);
  });
  it('keeps new models out of an off source while preserving exact current/default/favorite refs', () => {
    const input = { catalogs: [catalog], modelVisibilityByRef: {}, modelPickerVisibilityByConnectionId: { pc_a: false } };
    expect(projectProviderCatalogForPicker(input).groups).toEqual([]);
    expect(projectProviderCatalogForPicker({ ...input, currentSelection: ref('current'),
      defaultSelection: ref('default'), favoriteSelections: [ref('favorite')] }).groups[0]?.rows.map(row => row.ref.modelId))
      .toEqual(['current', 'favorite', 'default']);
    expect(projectProviderCatalogForPicker({ ...input, sourceConnectionId: 'pc_a' }).groups[0]?.rows).toHaveLength(4);
    expect(projectProviderCatalogForPicker({ ...input, mode: 'management' }).groups[0]?.rows).toHaveLength(4);
  });
  it('does not unhide a per-model favorite when its source is explicitly browsed', () => {
    const modelVisibilityByRef = { [serializeModelVisibilityRefV1({ scope: 'allAgents', providerConnectionId: connectionId, modelId: 'favorite' })]: 'hidden' as const };
    const projection = projectProviderCatalogForPicker({ catalogs: [catalog], sourceConnectionId: 'pc_a',
      modelVisibilityByRef, favoriteSelections: [ref('favorite')], currentSelection: ref('current') });
    expect(projection.groups[0]?.rows.map(row => row.ref.modelId)).toEqual(['current', 'default', 'new']);
  });
  it('names an off source that withholds browsable models, and only in ordinary browse', () => {
    const input = { catalogs: [catalog], modelVisibilityByRef: {}, modelPickerVisibilityByConnectionId: { pc_a: false } };
    expect(projectProviderCatalogForPicker({ ...input, favoriteSelections: [ref('favorite')] }).hiddenSources)
      .toEqual([{ connectionId: 'pc_a', providerName: 'Source', connectionName: 'Work', modelCount: 3 }]);
    expect(projectProviderCatalogForPicker({ ...input, sourceConnectionId: 'pc_a' }).hiddenSources).toEqual([]);
    expect(projectProviderCatalogForPicker({ ...input, mode: 'management' }).hiddenSources).toEqual([]);
    expect(projectProviderCatalogForPicker({ catalogs: [catalog], modelVisibilityByRef: {} }).hiddenSources)
      .toEqual([{ connectionId: 'pc_a', providerName: 'Source', connectionName: 'Work', modelCount: 4 }]);
    const everyModelHidden = Object.fromEntries(['current', 'favorite', 'default', 'new'].map(modelId => [
      serializeModelVisibilityRefV1({ scope: 'allAgents', providerConnectionId: connectionId, modelId }), 'hidden' as const]));
    expect(projectProviderCatalogForPicker({ ...input, modelVisibilityByRef: everyModelHidden }).hiddenSources).toEqual([]);
  });
  it('reports exact withheld model identities only for an authorized machine source', () => {
    const upstreamRef = { vendor: 'anthropic', vendorModelId: 'claude-sonnet' };
    const rows = catalog.rows.map(row => ({ ...row, descriptor: { ...row.descriptor, upstreamRef } }));
    const input = { modelVisibilityByRef: {}, modelPickerVisibilityByConnectionId: { pc_a: false } };
    expect(projectProviderCatalogForPicker({ ...input, catalogs: [{ ...catalog, rows }] }).hiddenSources)
      .toMatchObject([{ upstreamModels: [{ upstreamRef, endpointHealth: 'not_checked' }] }]);
    expect(projectProviderCatalogForPicker({ ...input, observationScope: 'account', catalogs: [{ ...catalog, rows,
      authorization: { authorized: false, errorCode: 'provider_machine_unavailable' } }] }).hiddenSources[0])
      .not.toHaveProperty('upstreamModels');
  });
  it('reports credential recovery for a withheld exact match whose endpoint rejects its key', () => {
    const upstreamRef = { vendor: 'anthropic', vendorModelId: 'claude-sonnet' };
    const rows = catalog.rows.map(row => ({ ...row, descriptor: { ...row.descriptor, upstreamRef },
      presentation: { ...row.presentation, endpointHealth: {
        status: 'unauthorized' as const, activity: 'idle' as const, errorCode: 'provider_endpoint_unauthorized' as const,
        observedAt: 1,
      } } }));
    expect(projectProviderCatalogForPicker({ catalogs: [{ ...catalog, rows }], modelVisibilityByRef: {},
      modelPickerVisibilityByConnectionId: { pc_a: false } }).hiddenSources)
      .toMatchObject([{ upstreamModels: [{ upstreamRef, endpointHealth: 'unauthorized' }] }]);
  });
});
