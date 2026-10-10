import { describe, expect, it } from 'vitest';
import { DEEPSEEK_PROVIDER_CONTRIBUTION } from '../../../../plugins/deepseek/src/provider/contribution.js';
import { OLLAMA_PROVIDER_CONTRIBUTION } from '../../../../plugins/ollama/src/provider/contribution.js';
import { ProviderContributionV1Schema } from '../contributions/v1.js';
import { parseProviderActionRequestV1 } from '../providerActionsV1.js';
import { ProviderConnectionV1Schema } from './v1.js';
import { CustomProviderTemplateV1Schema } from './customTemplateV1.js';
import { createAccountProviderActionExecuteV1, type AccountProviderDeclarationV1 } from './accountProviderActionV1.js';
import { DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, type ProviderConnectionsCatalogV1 } from './connectionRowsV1.js';

// An in-memory Account-row transport boundary; all domain operations and output admission are real.
function accountRow(catalog: ProviderConnectionsCatalogV1 = DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1) {
  let current = catalog;
  let revision = 1;
  let writes = 0;
  let outcome: 'updated' | 'conflict' | 'outcome_unknown' = 'updated';
  let definitions: readonly AccountProviderDeclarationV1[] = [{ contributionKey: 'happier.provider.deepseek/deepseek',
    definition: ProviderContributionV1Schema.parse(DEEPSEEK_PROVIDER_CONTRIBUTION), provenance: 'first_party' as const }];
  const execute = createAccountProviderActionExecuteV1({ assertCurrent() {}, now: () => 10,
    readCatalog: async () => ({ status: 'ready', revision, catalog: current }),
    readDefinitions: async () => definitions,
    writeCatalog: async input => {
      expect(input.expectedRevision).toBe(revision);
      writes++;
      if (outcome === 'conflict') return { status: outcome };
      current = input.catalog; revision++;
      if (outcome === 'outcome_unknown') throw Object.assign(new Error('Lost receipt'), { code: outcome });
      return { status: outcome };
    },
  });
  return { execute, get catalog() { return current; }, get writes() { return writes; },
    setOutcome(value: typeof outcome) { outcome = value; }, clearDefinitions() { definitions = []; },
    setDefinitions(value: readonly AccountProviderDeclarationV1[]) { definitions = value; } };
}

describe('shared Provider Account Action producer', () => {
  const customTemplate = CustomProviderTemplateV1Schema.parse({ v: 1, name: 'Custom',
    endpointTemplates: [{ id: 'chat', protocol: 'openai-chat', baseUrl: 'https://custom.example/v1',
      capabilities: { streaming: 'unknown', toolRoundTrips: 'unknown', statefulResponses: 'unknown', reasoningControls: 'unknown' } }],
    credential: { kind: 'apiKey', required: true, transports: [{ id: 'key', protocols: ['openai-chat'],
      uses: ['probe', 'runtime'], destination: { kind: 'httpHeader', name: 'Authorization', format: 'bearer' } }] },
    catalog: { source: 'manual', manualModelPolicy: 'allowed' } });

  it('replaces a custom template at its captured revision without losing bindings or manual models, invalidating changed grants', async () => {
    const row = accountRow();
    expect(await row.execute(parseProviderActionRequestV1('providers.connections.create_custom', {
      action: 'createCustom', connectionId: 'pc_custom', template: customTemplate, savedSecretId: 'ss_retained',
      manualModels: [{ id: 'manual-model', name: 'Retained model' }], enable: true,
    }), {})).toMatchObject({ ok: true });
    const original = row.catalog;
    const replacement = CustomProviderTemplateV1Schema.parse({ ...customTemplate,
      endpointTemplates: [{ ...customTemplate.endpointTemplates[0], baseUrl: 'https://corrected.example/v1' }],
      credential: { ...customTemplate.credential, transports: [{ ...customTemplate.credential!.transports[0],
        destination: { kind: 'httpHeader', name: 'X-Api-Key', format: 'raw' } }] },
      catalog: { source: 'probe', manualModelPolicy: 'allowed', probes: [{ endpointTemplateId: 'chat', path: '/models', parser: 'openai-models' }] } });
    expect(await row.execute(parseProviderActionRequestV1('providers.connections.update', { action: 'update',
      connectionId: 'pc_custom', expectedRevision: 0, template: replacement }), {}))
      .toMatchObject({ ok: true, result: { connection: { revision: 1, probeCapability: 'catalog',
        endpoints: [{ baseUrl: 'https://corrected.example/v1' }], grants: { accountState: 'absent' } } } });
    expect(row.catalog.connections[0]?.source).toEqual({ kind: 'custom', template: replacement });
    expect(row.catalog.connections[0]).toMatchObject({ createdAt: 10, updatedAt: 10 });
    expect(row.catalog.secretBindingsByConnectionId).toEqual(original.secretBindingsByConnectionId);
    expect(row.catalog.manualModelsByConnectionId).toEqual(original.manualModelsByConnectionId);
    expect(row.catalog.accountGrants).toEqual([]);
  });

  it('rejects stale custom edits and template replacement on built-in connections before catalog writes', async () => {
    const custom = ProviderConnectionV1Schema.parse({ v: 1, id: 'pc_custom', source: { kind: 'custom', template: customTemplate },
      role: 'named', displayName: 'Custom', displayNameMode: 'custom', revision: 2, createdAt: 1, updatedAt: 1 });
    const builtIn = ProviderConnectionV1Schema.parse({ ...custom, id: 'pc_builtin',
      source: { kind: 'contribution', contributionKey: 'happier.provider.deepseek/deepseek' } });
    const row = accountRow({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, connections: [custom, builtIn] });
    expect(await row.execute(parseProviderActionRequestV1('providers.connections.update', { action: 'update',
      connectionId: custom.id, expectedRevision: 1, template: customTemplate }), {}))
      .toMatchObject({ ok: false, errorCode: 'provider_connection_changed' });
    expect(await row.execute(parseProviderActionRequestV1('providers.connections.update', { action: 'update',
      connectionId: builtIn.id, expectedRevision: 2, template: customTemplate }), {}))
      .toMatchObject({ ok: false, errorCode: 'provider_connection_invalid' });
    expect(row.writes).toBe(0);
    expect(row.catalog.connections).toEqual([custom, builtIn]);
  });

  it('keeps grants for a custom template name-only edit and preserves catalog CAS refusal', async () => {
    const row = accountRow();
    expect(await row.execute(parseProviderActionRequestV1('providers.connections.create_custom', {
      action: 'createCustom', connectionId: 'pc_custom', template: customTemplate, savedSecretId: null,
      manualModels: [], enable: true,
    }), {})).toMatchObject({ ok: true });
    const grants = row.catalog.accountGrants;
    const request = parseProviderActionRequestV1('providers.connections.update', { action: 'update', connectionId: 'pc_custom',
      expectedRevision: 0, template: { ...customTemplate, name: 'Corrected name' } });
    row.setOutcome('conflict');
    expect(await row.execute(request, {})).toMatchObject({ ok: false, errorCode: 'provider_catalog_conflict' });
    expect(row.catalog.connections[0]?.revision).toBe(0);
    row.setOutcome('updated');
    expect(await row.execute(request, {})).toMatchObject({ ok: true, result: { connection: { revision: 1, grants: { accountState: 'valid' } } } });
    expect(row.catalog.accountGrants).toEqual(grants);
    expect(row.catalog.connections[0]?.source).toEqual({ kind: 'custom', template: { ...customTemplate, name: 'Corrected name' } });
  });

  it('retains overrides and grants for unchanged machine endpoints while withdrawing grants whose effective endpoint changed', async () => {
    const connection = ProviderConnectionV1Schema.parse({ v: 1, id: 'pc_custom', source: { kind: 'custom', template: customTemplate },
      role: 'named', displayName: 'Custom', displayNameMode: 'custom', revision: 2, createdAt: 1, updatedAt: 1,
      endpointOverridesByMachineId: { machine_fixed: [{ endpointTemplateId: 'chat', baseUrl: 'https://fixed.example/v1' }] } });
    const grant = { v: 1 as const, connectionId: connection.id, endpointSetFingerprint: 'retained-endpoint',
      connectionSecurityFingerprint: 'retained-security', confirmedAt: 1 };
    const row = accountRow({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, connections: [connection],
      machineGrants: [{ ...grant, machineId: 'machine_fixed' }, { ...grant, machineId: 'machine_inherits' }] });
    expect(await row.execute(parseProviderActionRequestV1('providers.connections.update', { action: 'update', connectionId: connection.id,
      expectedRevision: 2, template: { ...customTemplate,
        endpointTemplates: [{ ...customTemplate.endpointTemplates[0], baseUrl: 'https://corrected.example/v1' }] } }), {}))
      .toMatchObject({ ok: true });
    expect(row.catalog.connections[0]?.endpointOverridesByMachineId).toEqual(connection.endpointOverridesByMachineId);
    expect(row.catalog.machineGrants).toEqual([{ ...grant, machineId: 'machine_fixed' }]);
    expect(await row.execute(parseProviderActionRequestV1('providers.connections.update', { action: 'update', connectionId: connection.id,
      expectedRevision: 3, template: { ...customTemplate,
        endpointTemplates: [{ ...customTemplate.endpointTemplates[0], id: 'renamed' }] } }), {})).toMatchObject({ ok: true });
    expect(row.catalog.connections[0]?.endpointOverridesByMachineId?.machine_fixed).toEqual([]);
    expect(row.catalog.machineGrants).toEqual([]);
  });
  it('saves a built-in connection, reloads its Account description and static/manual models without a machine', async () => {
    const row = accountRow();
    const created = await row.execute(parseProviderActionRequestV1('providers.connections.create_contribution', {
      action: 'createContribution', connectionId: 'pc_work', contributionKey: 'happier.provider.deepseek/deepseek',
      displayName: 'Work', savedSecretId: null, enable: true,
    }), {});
    expect(created).toMatchObject({ ok: true, result: { status: 'success', action: 'createContribution',
      connection: { grants: { accountEnabled: true }, authorized: false, runtime: { health: 'not_checked' } } } });
    expect(await row.execute(parseProviderActionRequestV1('providers.connections.describe', {}), {}))
      .toMatchObject({ ok: true, result: { status: 'success', available: [{ kind: 'frontier' }], connections: [{ displayName: 'Work' }] } });
    expect(await row.execute(parseProviderActionRequestV1('providers.models.list', { connectionId: 'pc_work' }), {}))
      .toMatchObject({ ok: true, result: { status: 'success', connectionRevision: 0, modelLoadAction: 'machine_required',
        models: [{ source: 'static' }, { source: 'static' }] } });
  });

  it('allows Account rename and deletion of a retained connection when its declaration is unavailable', async () => {
    const connection = ProviderConnectionV1Schema.parse({ v: 1, id: 'pc_missing',
      source: { kind: 'contribution', contributionKey: 'missing.provider/source' }, role: 'named',
      displayName: 'Retained', displayNameMode: 'custom', revision: 2, createdAt: 1, updatedAt: 1 });
    const row = accountRow({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, connections: [connection] }); row.clearDefinitions();
    expect(await row.execute(parseProviderActionRequestV1('providers.connections.update', { action: 'update',
      connectionId: connection.id, expectedRevision: 2, displayName: 'Renamed' }), {}))
      .toMatchObject({ ok: true, result: { connection: { displayName: 'Renamed', sourceStatus: 'unavailable' } } });
    expect(await row.execute(parseProviderActionRequestV1('providers.connections.delete', { action: 'delete', connectionId: connection.id }), {}))
      .toMatchObject({ ok: true, result: { deletedConnectionId: connection.id } });
    expect(row.catalog.connections).toEqual([]);
  });

  it('preserves the catalog on CAS conflict and reads current state after an uncertain receipt without replay', async () => {
    const row = accountRow(); row.setOutcome('conflict');
    const request = parseProviderActionRequestV1('providers.connections.create_contribution', {
      action: 'createContribution', connectionId: 'pc_work', contributionKey: 'happier.provider.deepseek/deepseek',
      displayName: 'Draft', savedSecretId: null, enable: false,
    });
    expect(await row.execute(request, {})).toMatchObject({ ok: false, errorCode: 'provider_catalog_conflict' });
    expect(row.catalog.connections).toEqual([]);
    row.setOutcome('outcome_unknown');
    expect(await row.execute(request, {})).toMatchObject({ ok: false, errorCode: 'provider_catalog_outcome_unknown' });
    expect(await row.execute(parseProviderActionRequestV1('providers.connections.describe', { connectionId: 'pc_work' }), {}))
      .toMatchObject({ ok: true, result: { connections: [{ displayName: 'Draft' }] } });
    expect(row.writes).toBe(2);
  });

  it('refuses an undeclared Gateway purpose before committing Account mode configuration', async () => {
    const connection = ProviderConnectionV1Schema.parse({ v: 1, id: 'pc_gateway',
      source: { kind: 'contribution', contributionKey: 'example.gateway/source' }, role: 'named',
      displayName: 'Gateway', displayNameMode: 'custom', revision: 2, createdAt: 1, updatedAt: 1 });
    const definition = ProviderContributionV1Schema.parse({ ...DEEPSEEK_PROVIDER_CONTRIBUTION,
      catalog: { ...DEEPSEEK_PROVIDER_CONTRIBUTION.catalog, sourceRegistryVersion: 'account-gateway/v1' },
      managedRuntime: { kind: 'managed', endpointTemplateIds: DEEPSEEK_PROVIDER_CONTRIBUTION.endpointTemplates.map(endpoint => endpoint.id),
        connectedAccounts: [{ purpose: 'upstream', service: { pluginId: 'example.auth', localId: 'account' }, required: false }] } });
    const row = accountRow({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, connections: [connection] });
    row.setDefinitions([{ contributionKey: 'example.gateway/source', definition, provenance: 'external' }]);
    const managedConnection = { ...connection, deployment: { kind: 'managedLocal' as const } };
    const managedRow = accountRow({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, connections: [managedConnection] });
    managedRow.setDefinitions([{ contributionKey: 'example.gateway/source', definition, provenance: 'external' }]);
    expect(await managedRow.execute(parseProviderActionRequestV1('providers.connections.describe', { connectionId: connection.id }), {}))
      .toMatchObject({ ok: true, result: { connections: [{ runtime: { gateway: { status: 'not_checked', reachability: 'not_checked' } } }] } });
    expect(await row.execute(parseProviderActionRequestV1('providers.connections.update', { action: 'update', connectionId: connection.id,
      expectedRevision: 2, deployment: { kind: 'managedLocal', purposeBindingDefaults: {
        foreign: { kind: 'group', service: { pluginId: 'example.auth', localId: 'account' }, groupId: 'pool' },
      } } }), {})).toMatchObject({ ok: false, errorCode: 'provider_connection_invalid' });
    expect(row.writes).toBe(0);
    expect(row.catalog.connections[0]?.deployment.kind).toBe('external');
  });

  it('refuses credentials on managed deployment while allowing stale Account bindings to be cleared', async () => {
    const connection = ProviderConnectionV1Schema.parse({ v: 1, id: 'pc_gateway',
      source: { kind: 'contribution', contributionKey: 'example.gateway/source' }, role: 'named',
      displayName: 'Gateway', displayNameMode: 'custom', deployment: { kind: 'managedLocal' }, revision: 2, createdAt: 1, updatedAt: 1 });
    const definition = ProviderContributionV1Schema.parse({ ...DEEPSEEK_PROVIDER_CONTRIBUTION,
      catalog: { ...DEEPSEEK_PROVIDER_CONTRIBUTION.catalog, sourceRegistryVersion: 'account-gateway/v1' },
      managedRuntime: { kind: 'managed', endpointTemplateIds: DEEPSEEK_PROVIDER_CONTRIBUTION.endpointTemplates.map(endpoint => endpoint.id) } });
    const row = accountRow({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, connections: [connection],
      secretBindingsByConnectionId: { [connection.id]: { account: { apiKey: 'ss_old' } } } });
    row.setDefinitions([{ contributionKey: 'example.gateway/source', definition, provenance: 'external' }]);
    const bind = (savedSecretId: string | null) => row.execute(parseProviderActionRequestV1('providers.connections.secrets.bind', {
      action: 'bindSecret', connectionId: connection.id, credentialSlotId: 'apiKey', savedSecretId, scope: 'account',
    }), {});
    expect(await bind('ss_new')).toMatchObject({ ok: false, errorCode: 'provider_connection_invalid' });
    expect(row.writes).toBe(0);
    row.clearDefinitions();
    expect(await bind(null)).toMatchObject({ ok: true });
    expect(row.catalog.secretBindingsByConnectionId[connection.id]?.account?.apiKey).toBeUndefined();
  });

  it('reuses an existing default without rebinding credentials or changing its Account grant', async () => {
    const row = accountRow();
    const create = (connectionId: string, savedSecretId: string, enable: boolean) => row.execute(
      parseProviderActionRequestV1('providers.connections.create_contribution', { action: 'createContribution', connectionId,
        contributionKey: 'happier.provider.deepseek/deepseek', displayName: null, savedSecretId, enable }), {});
    expect(await create('pc_default', 'ss_original', false)).toMatchObject({ ok: true, result: { created: true } });
    const previous = row.catalog;
    expect(await create('pc_unused', 'ss_replacement', true)).toMatchObject({ ok: true, result: { created: false } });
    expect(row.catalog).toBe(previous);
    expect(row.writes).toBe(1);
  });

  it('refuses a secret when the declared Provider has no credential requirement', async () => {
    const row = accountRow();
    row.setDefinitions([{ contributionKey: 'example.provider/open', provenance: 'external',
      definition: ProviderContributionV1Schema.parse({ ...DEEPSEEK_PROVIDER_CONTRIBUTION, credential: undefined, legacyProfileMigrations: [] }) }]);
    expect(await row.execute(parseProviderActionRequestV1('providers.connections.create_contribution', {
      action: 'createContribution', connectionId: 'pc_open', contributionKey: 'example.provider/open',
      displayName: 'Open', savedSecretId: 'ss_unexpected', enable: false,
    }), {})).toMatchObject({ ok: false, errorCode: 'provider_credential_transport_unavailable' });
    expect(row.writes).toBe(0);
  });

  it('saves unresolved local declarations without inventing endpoints or a valid Account grant', async () => {
    const row = accountRow();
    row.setDefinitions([{ contributionKey: 'happier.provider.ollama/ollama', provenance: 'first_party',
      definition: ProviderContributionV1Schema.parse(OLLAMA_PROVIDER_CONTRIBUTION) }]);
    expect(await row.execute(parseProviderActionRequestV1('providers.connections.create_contribution', {
      action: 'createContribution', connectionId: 'pc_local', contributionKey: 'happier.provider.ollama/ollama',
      displayName: 'Local', savedSecretId: null, enable: false,
    }), {})).toMatchObject({ ok: true, result: { connection: { endpoints: [], grants: { accountState: 'absent' } } } });
    expect(await row.execute(parseProviderActionRequestV1('providers.connections.enabled.set', {
      action: 'setEnabled', connectionId: 'pc_local', enabled: true, scope: 'account',
    }), {})).toMatchObject({ ok: false, errorCode: 'provider_connection_invalid' });
    expect(row.writes).toBe(1);
  });

  it('stores endpoint overrides in canonical identity order independent of edit order', async () => {
    const connection = ProviderConnectionV1Schema.parse({ v: 1, id: 'pc_local',
      source: { kind: 'contribution', contributionKey: 'happier.provider.ollama/ollama' }, role: 'named',
      displayName: 'Local', displayNameMode: 'custom', revision: 0, createdAt: 1, updatedAt: 1 });
    const row = accountRow({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, connections: [connection] });
    row.setDefinitions([{ contributionKey: 'happier.provider.ollama/ollama', provenance: 'first_party',
      definition: ProviderContributionV1Schema.parse(OLLAMA_PROVIDER_CONTRIBUTION) }]);
    for (const [revision, endpointTemplateId] of ['ollama-openai-responses', 'ollama-native'].entries()) {
      expect(await row.execute(parseProviderActionRequestV1('providers.connections.endpoint.set', { action: 'setEndpointOverride',
        connectionId: connection.id, expectedRevision: revision, endpointTemplateId, baseUrl: 'http://localhost:11434', scope: 'account',
      }), {})).toMatchObject({ ok: true });
    }
    expect(row.catalog.connections[0]?.endpointOverrides?.map(endpoint => endpoint.endpointTemplateId))
      .toEqual(['ollama-native', 'ollama-openai-responses']);
  });
});
