import { describe, expect, it } from 'vitest';
import { DEEPSEEK_PROVIDER_CONTRIBUTION } from '../../../../plugins/deepseek/src/provider/contribution.js';
import { OLLAMA_PROVIDER_CONTRIBUTION } from '../../../../plugins/ollama/src/provider/contribution.js';
import { CLIPROXYAPI_PROVIDER_CONTRIBUTION } from '../../../../plugins/cliproxyapi/src/provider/contribution.js';
import { ProviderContributionV1Schema } from '../contributions/v1.js';
import { PROVIDER_ACTION_INPUT_SCHEMAS_V1, parseProviderActionRequestV1 } from '../providerActionsV1.js';
import { ProviderConnectionV1Schema } from './v1.js';
import { CustomProviderTemplateV1Schema } from './customTemplateV1.js';
import { createAccountProviderActionExecuteV1, type AccountProviderDeclarationV1 } from './accountProviderActionV1.js';
import { DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, type ProviderConnectionsCatalogV1 } from './connectionRowsV1.js';
import { serializeModelVisibilityRefV1 } from '../selection/v1.js';
import { getProviderExperimentalConfirmationCatalogSourceKeyV1, parseProviderSettingsV1Narrow } from '../settings/v1.js';
import { createActionExecutor, type ActionExecutorDeps } from '../../actions/actionExecutor.js';
import { createProviderActionExecuteV1 } from '../executeProviderActionV1.js';

import { prepareApprovalRequest } from '../../actions/executor/approvalPreparation.js';

const fixtureSource = new URL('../../../../tests/src/testkit/actionExecutorBoundary.ts', import.meta.url).href;
const { createActionExecutorBoundaryFixture }: {
  createActionExecutorBoundaryFixture(overrides: Partial<ActionExecutorDeps>): ActionExecutorDeps;
} = await import(fixtureSource);

// An in-memory Account-row transport boundary; all domain operations and output admission are real.
function accountRow(catalog: ProviderConnectionsCatalogV1 = DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1) {
  let current = catalog;
  let revision = 1;
  let writes = 0;
  let reads = 0;
  let outcome: 'updated' | 'conflict' | 'outcome_unknown' = 'updated';
  let beforeWrite: (() => void) | null = null;
  let definitions: readonly AccountProviderDeclarationV1[] = [{ contributionKey: 'happier.provider.deepseek/deepseek',
    definition: ProviderContributionV1Schema.parse(DEEPSEEK_PROVIDER_CONTRIBUTION), provenance: 'first_party' as const }];
  const execute = createAccountProviderActionExecuteV1({ assertCurrent() {}, now: () => 10,
    readCatalog: async () => { reads++; return { status: 'ready', revision, catalog: current }; },
    readDefinitions: async () => definitions,
    writeCatalog: async input => {
      expect(input.expectedRevision).toBe(revision);
      const callback = beforeWrite;
      beforeWrite = null;
      callback?.();
      writes++;
      if (outcome === 'conflict') return { status: outcome };
      current = input.catalog; revision++;
      if (outcome === 'outcome_unknown') throw Object.assign(new Error('Lost receipt'), { code: outcome });
      return { status: outcome };
    },
  });
  return { execute, get catalog() { return current; }, get revision() { return revision; }, get writes() { return writes; }, get reads() { return reads; },
    beforeNextWrite(callback: () => void) { beforeWrite = callback; },
    setOutcome(value: typeof outcome) { outcome = value; }, clearDefinitions() { definitions = []; },
    setDefinitions(value: readonly AccountProviderDeclarationV1[]) { definitions = value; } };
}

describe('shared Provider Account Action producer', () => {
  it('round-trips manual reasoning declarations through Action registration, Account writer and catalog admission', async () => {
    const row = accountRow();
    // Exercise the registered Action after the host's existing approval flow.
    const context = { surface: 'ui' as const, bypassApprovals: true };
    const executor = createActionExecutor({ providerActionExecute: createProviderActionExecuteV1({
      assertCurrent() {}, async rpc() { throw new Error('Account manual models must not use machine RPC'); },
      async setDefault() { throw new Error('Manual models must not change defaults'); },
      account: row.execute,
    }) });
    const created = await executor.execute('providers.connections.create_custom', {
      action: 'createCustom', connectionId: 'pc_effort', template: customTemplate, savedSecretId: null,
      manualModels: [{ id: 'opaque', reasoningEffortLevels: ['low', 'high'] }], enable: false,
    }, context);
    expect(created.ok ? null : created).toBeNull();
    expect(row.catalog.manualModelsByConnectionId.pc_effort).toEqual([{ id: 'opaque', addedAt: 10, reasoningEffortLevels: ['low', 'high'] }]);
    const update = (models: unknown) => executor.execute('providers.models.manual.add', {
      action: 'manualAdd', connectionId: 'pc_effort', expectedConnectionRevision: 0, models,
    }, context);
    expect(await update([{ id: 'opaque', name: 'Renamed', reasoningEffortLevels: ['medium', 'max'] }])).toMatchObject({ ok: true });
    expect(row.catalog.manualModelsByConnectionId.pc_effort).toEqual([{ id: 'opaque', name: 'Renamed', addedAt: 10, reasoningEffortLevels: ['medium', 'max'] }]);
    expect(parseProviderSettingsV1Narrow(row.catalog).settings.manualModelsByConnectionId.pc_effort).toEqual(row.catalog.manualModelsByConnectionId.pc_effort);
    const writes = row.writes;
    expect(await update([{ id: 'opaque', reasoningEffortLevels: ['unsupported-tier'] }])).toMatchObject({ ok: false });
    expect(row.writes).toBe(writes);
    expect(await update([{ id: 'opaque' }])).toMatchObject({ ok: true });
    expect(row.catalog.manualModelsByConnectionId.pc_effort).toEqual([{ id: 'opaque', addedAt: 10 }]);
  });
  it('requires explicit gateway contribution choice and never creates or reads a saved connection to choose', async () => {
    const row = accountRow();
    const definition = ProviderContributionV1Schema.parse(CLIPROXYAPI_PROVIDER_CONTRIBUTION);
    const declarations = ['com.acme.gateway/local', 'com.example.gateway/local'].map(contributionKey => ({
      contributionKey, definition, provenance: 'external' as const,
    }));
    row.setDefinitions(declarations);
    const executor = createActionExecutor({ providerActionExecute: createProviderActionExecuteV1({
      assertCurrent() {}, async rpc() { throw new Error('gateway_choice_must_not_execute'); },
      async setDefault() { throw new Error('gateway_choice_must_not_write'); },
      account: row.execute,
    }) });
    const request = parseProviderActionRequestV1('providers.gateways.choose', {});
    expect(request).toMatchObject({ actionId: 'providers.gateways.choose', input: {} });
    const choose = (input: unknown) => executor.execute('providers.gateways.choose', input, { surface: 'agent' });
    const result = await choose({});
    expect(result).toMatchObject({ ok: true, result: { status: 'choice_required', choices: declarations.map(({ contributionKey }) => ({ contributionKey })) } });
    expect(await choose({ contributionKey: declarations[1]!.contributionKey }))
      .toMatchObject({ ok: true, result: { status: 'selected', contribution: { contributionKey: declarations[1]!.contributionKey } } });
    expect(await choose({ contributionKey: 'unknown.gateway/local' }))
      .toMatchObject({ ok: true, result: { status: 'unavailable', choices: expect.any(Array) } });
    expect(await choose({ service: { pluginId: 'wrong.vendor', localId: 'account' } }))
      .toMatchObject({ ok: true, result: { status: 'unavailable', choices: [] } });
    expect(await choose({ contributionKey: 'local' })).toMatchObject({ ok: false });
    expect(row.reads).toBe(0);
    expect(row.writes).toBe(0);
    expect(row.catalog.connections).toEqual([]);
  });

  it('records recipient consent for an opaque Team source without a saved connection or private source target', async () => {
    const row = accountRow();
    const result = await row.execute(parseProviderActionRequestV1('providers.models.experimental.confirm', {
      action: 'confirmExperimental', connectionId: 'connected-source:opaque', catalogSourceKey: 'a'.repeat(43),
      expectedConnectionRevision: 0, agentTargetKey: 'agent:acme.worker/agent', modelId: null,
      compatibilityFingerprint: 'compatibility:v1:worker',
    }), {});
    expect(result).toMatchObject({ ok: true, result: { status: 'success' } });
    expect(row.catalog.connections).toEqual([]);
    expect(row.catalog.experimentalBindingConfirmations).toEqual([expect.objectContaining({
      connectionId: 'connected-source:opaque', catalogSourceKey: 'a'.repeat(43),
      agentTargetKey: 'agent:acme.worker/agent', compatibilityFingerprint: 'compatibility:v1:worker',
    })]);
  });
  it('retains Team source consent when the recipient also owns the saved source connection', async () => {
    const connection = ProviderConnectionV1Schema.parse({ v: 1, id: 'pc_own_team_source',
      source: { kind: 'contribution', contributionKey: 'happier.provider.deepseek/deepseek' },
      role: 'named', displayName: 'DeepSeek', displayNameMode: 'custom', revision: 3, createdAt: 1, updatedAt: 1 });
    const row = accountRow({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, connections: [connection] });
    const input = { action: 'confirmExperimental', connectionId: connection.id,
      catalogSourceKey: getProviderExperimentalConfirmationCatalogSourceKeyV1({ connectionId: connection.id }),
      expectedConnectionRevision: 0, agentTargetKey: 'agent:acme.worker/agent', modelId: 'model-a',
      compatibilityFingerprint: 'compatibility:v1:worker' };
    expect(await row.execute(parseProviderActionRequestV1('providers.models.experimental.confirm', input), {}))
      .toMatchObject({ ok: true, result: { status: 'success' } });
    expect(row.catalog.connections).toEqual([connection]);
    expect(row.catalog.experimentalBindingConfirmations).toEqual([expect.objectContaining({
      connectionId: connection.id, catalogSourceKey: input.catalogSourceKey,
      compatibilityFingerprint: input.compatibilityFingerprint,
    })]);
    expect(parseProviderSettingsV1Narrow(row.catalog).settings.experimentalBindingConfirmations)
      .toEqual(row.catalog.experimentalBindingConfirmations);
  });
  it.each(['account', 'group'] as const)('confirms an exact Connected Account source without creating a connection: %s', async kind => {
    const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
    const connectedAccountTarget = kind === 'account'
      ? { kind, account: { service, accountId: 'account-a' } }
      : { kind, service, groupId: 'pool-a' };
    const row = accountRow();
    const input = { action: 'confirmExperimental', connectionId: 'connected-source:catalog-a',
      expectedConnectionRevision: 0, connectedAccountTarget,
      agentTargetKey: 'agent:happier.agent.codex/codex', modelId: 'gpt-5.5',
      compatibilityFingerprint: 'compatibility:v1:source-a' };
    const result = await row.execute(parseProviderActionRequestV1('providers.models.experimental.confirm', input), {});
    expect(result).toMatchObject({ ok: true, result: { status: 'success', action: 'confirmExperimental' } });
    expect(row.catalog.connections).toEqual([]);
    expect(row.catalog.experimentalBindingConfirmations).toEqual([{ v: 1, connectionId: input.connectionId,
      connectedAccountTarget, agentTargetKey: input.agentTargetKey, modelId: input.modelId,
      compatibilityFingerprint: input.compatibilityFingerprint, confirmedAt: 10 }]);
    expect(row.writes).toBe(1);
  });
  it('captures declaration facts when enabling Account access without machine observation', async () => {
    const row = accountRow();
    expect(await row.execute(parseProviderActionRequestV1('providers.connections.create_contribution', {
      action: 'createContribution', connectionId: 'pc_enable', contributionKey: 'happier.provider.deepseek/deepseek',
      displayName: null, savedSecretId: 'ss_api', enable: false,
    }), {})).toMatchObject({ ok: true });
    row.beforeNextWrite(() => row.setDefinitions([{ contributionKey: 'happier.provider.deepseek/deepseek',
      definition: ProviderContributionV1Schema.parse({ ...DEEPSEEK_PROVIDER_CONTRIBUTION, name: 'Replacement DeepSeek' }),
      provenance: 'first_party' }]));
    expect(await row.execute(parseProviderActionRequestV1('providers.connections.enabled.set', {
      action: 'setEnabled', connectionId: 'pc_enable', enabled: true, scope: 'account',
    }), {})).toMatchObject({ ok: true, result: { status: 'success', connection: { providerName: 'DeepSeek' } } });
    expect(row.catalog.accountGrants).toEqual([expect.objectContaining({ connectionId: 'pc_enable' })]);
    expect(await row.execute(parseProviderActionRequestV1('providers.connections.describe', {}), {}))
      .toMatchObject({ ok: true, result: { connections: [expect.objectContaining({ providerName: 'Replacement DeepSeek' })] } });
  });
  it('persists only the confirmation record from a revision-checked experimental Action', async () => {
    const connection = ProviderConnectionV1Schema.parse({ v: 1, id: 'pc_experimental',
      source: { kind: 'contribution', contributionKey: 'happier.provider.deepseek/deepseek' },
      role: 'named', displayName: 'DeepSeek', displayNameMode: 'custom', revision: 3, createdAt: 1, updatedAt: 1 });
    const row = accountRow({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, connections: [connection] });
    const input = { action: 'confirmExperimental', connectionId: connection.id, expectedConnectionRevision: 3,
      machineId: 'machine-a', agentTargetKey: 'agent:happier.agent.claude/claude', modelId: 'deepseek-v4-flash',
      compatibilityFingerprint: 'compatibility:v1:experimental' };
    expect(await row.execute(parseProviderActionRequestV1('providers.models.experimental.confirm', {
      ...input, expectedConnectionRevision: 2,
    }), {})).toMatchObject({ ok: false, errorCode: 'provider_connection_changed' });
    expect(row.writes).toBe(0);
    expect(await row.execute(parseProviderActionRequestV1('providers.models.experimental.confirm', input), {}))
      .toMatchObject({ ok: true, result: { status: 'success', action: 'confirmExperimental' } });
    expect(row.catalog.experimentalBindingConfirmations).toEqual([{ v: 1, connectionId: connection.id,
      agentTargetKey: input.agentTargetKey, modelId: input.modelId, compatibilityFingerprint: input.compatibilityFingerprint,
      confirmedAt: 10 }]);
    expect(row.writes).toBe(1);
    expect(row.catalog.connections).toEqual([connection]);
  });
  it('creates and enables a gateway with its unavailable pool in one catalog mutation and repairs an interrupted create', async () => {
    const half = ProviderConnectionV1Schema.parse({ v: 1, id: 'pc_half', source: { kind: 'contribution',
      contributionKey: 'happier.provider.cliproxyapi/cliproxyapi' }, role: 'named', displayName: 'Main gateway',
      displayNameMode: 'custom', revision: 0, createdAt: 1, updatedAt: 1 });
    const pool = { kind: 'group', service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, groupId: 'missing-pool' };
    for (const connections of [[], [half]]) {
      const row = accountRow({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, connections });
      row.setDefinitions([{ contributionKey: half.source.kind === 'contribution' ? half.source.contributionKey : '',
        definition: ProviderContributionV1Schema.parse(CLIPROXYAPI_PROVIDER_CONTRIBUTION), provenance: 'first_party' }]);
      const input = { action: 'createContribution', connectionId: 'pc_new', contributionKey: 'happier.provider.cliproxyapi/cliproxyapi',
        displayName: 'Main gateway', savedSecretId: null, enable: true,
        deployment: { kind: 'managedLocal', purposeBindingDefaults: { 'openai-upstream': pool } } };
      expect(PROVIDER_ACTION_INPUT_SCHEMAS_V1['providers.connections.create_contribution'].safeParse(input).success).toBe(true);
      const result = await row.execute(parseProviderActionRequestV1('providers.connections.create_contribution', input), {});
      expect(result).toMatchObject({ ok: true, result: { connection: { deployment: { kind: 'managedLocal' }, grants: { accountEnabled: true } } } });
      expect(row.writes).toBe(1);
      expect(row.catalog.connections).toEqual([expect.objectContaining({ id: connections.length ? half.id : 'pc_new',
        deployment: { kind: 'managedLocal' }, purposeBindingDefaults: { 'openai-upstream': pool } })]);
      expect(row.catalog.accountGrants.map(grant => grant.connectionId)).toEqual([row.catalog.connections[0]!.id]);
      const retry = { ...input, connectionId: row.catalog.connections[0]!.id };
      expect(await row.execute(parseProviderActionRequestV1('providers.connections.create_contribution', retry), {})).toMatchObject({ ok: true });
      expect(row.catalog.connections).toHaveLength(1);
    }
  });
  it('does not convert an existing default external connection during managed creation', async () => {
    const existing = ProviderConnectionV1Schema.parse({ v: 1, id: 'pc_default', source: { kind: 'contribution',
      contributionKey: 'happier.provider.cliproxyapi/cliproxyapi' }, role: 'default', displayName: 'CLIProxyAPI',
      displayNameMode: 'automatic', revision: 0, createdAt: 1, updatedAt: 1 });
    const row = accountRow({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, connections: [existing] });
    row.setDefinitions([{ contributionKey: 'happier.provider.cliproxyapi/cliproxyapi',
      definition: ProviderContributionV1Schema.parse(CLIPROXYAPI_PROVIDER_CONTRIBUTION), provenance: 'first_party' }]);
    const result = await row.execute(parseProviderActionRequestV1('providers.connections.create_contribution', {
      action: 'createContribution', connectionId: 'pc_new', contributionKey: 'happier.provider.cliproxyapi/cliproxyapi',
      displayName: null, savedSecretId: null, enable: true, deployment: { kind: 'managedLocal', purposeBindingDefaults: {} },
    }), {});
    expect(result).toMatchObject({ ok: false, errorCode: 'provider_connection_changed' });
    expect(row.writes).toBe(0);
    expect(row.catalog.connections).toEqual([existing]);
  });
  it('never persists a partial gateway when slot admission or the catalog CAS refuses creation', async () => {
    for (const conflict of [false, true]) {
      const row = accountRow();
      row.setDefinitions([{ contributionKey: 'happier.provider.cliproxyapi/cliproxyapi',
        definition: ProviderContributionV1Schema.parse(CLIPROXYAPI_PROVIDER_CONTRIBUTION), provenance: 'first_party' }]);
      if (conflict) row.setOutcome('conflict');
      const result = await row.execute(parseProviderActionRequestV1('providers.connections.create_contribution', {
        action: 'createContribution', connectionId: 'pc_new', contributionKey: 'happier.provider.cliproxyapi/cliproxyapi',
        displayName: 'Main gateway', savedSecretId: null, enable: true,
        deployment: { kind: 'managedLocal', purposeBindingDefaults: conflict ? {} : {
          'undeclared-slot': { kind: 'group', service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, groupId: 'pool' },
        } },
      }), {});
      expect(result).toMatchObject({ ok: false, errorCode: conflict ? 'provider_catalog_conflict' : 'provider_connection_invalid' });
      expect(row.writes).toBe(conflict ? 1 : 0);
      expect(row.catalog.connections).toEqual([]);
      expect(row.catalog.accountGrants).toEqual([]);
    }
  });
  const customTemplate = CustomProviderTemplateV1Schema.parse({ v: 1, name: 'Custom',
    endpointTemplates: [{ id: 'chat', protocol: 'openai-chat', baseUrl: 'https://custom.example/v1',
      capabilities: { streaming: 'unknown', toolRoundTrips: 'unknown', statefulResponses: 'unknown', reasoningControls: 'unknown' } }],
    credential: { kind: 'apiKey', required: true, transports: [{ id: 'key', protocols: ['openai-chat'],
      uses: ['probe', 'runtime'], destination: { kind: 'httpHeader', name: 'Authorization', format: 'bearer' } }] },
    catalog: { source: 'manual', manualModelPolicy: 'allowed' } });

  it('persists only canonical experimental confirmation fields through the captured Account catalog revision', async () => {
    const connection = ProviderConnectionV1Schema.parse({ v: 1, id: 'pc_experimental',
      source: { kind: 'custom', template: { ...customTemplate, credential: undefined,
        endpointTemplates: [{ ...customTemplate.endpointTemplates[0], protocol: 'openai-responses' }] } },
      role: 'named', displayName: 'Experimental', displayNameMode: 'custom', revision: 3, createdAt: 1, updatedAt: 1 });
    const previous = { v: 1 as const, connectionId: connection.id, agentTargetKey: 'agent:happier.agent.codex/codex',
      modelId: 'experimental-model', compatibilityFingerprint: 'compatibility:v1:previous', confirmedAt: 1 };
    const neighbor = { ...previous, modelId: 'another-model' };
    const row = accountRow({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, connections: [connection],
      manualModelsByConnectionId: { [connection.id]: [{ id: 'experimental-model', addedAt: 1 }] },
      experimentalBindingConfirmations: [previous, neighbor] });
    const input = { action: 'confirmExperimental', connectionId: connection.id,
      expectedConnectionRevision: 3, machineId: 'machine_optional', agentTargetKey: previous.agentTargetKey,
      modelId: previous.modelId, compatibilityFingerprint: 'compatibility:v1:experimental' } as const;
    const captured = row.catalog;
    expect(await row.execute(parseProviderActionRequestV1('providers.models.experimental.confirm', {
      ...input, expectedConnectionRevision: 2,
    }), {})).toMatchObject({ ok: false, errorCode: 'provider_connection_changed' });
    expect(row.catalog).toBe(captured);
    expect(row.writes).toBe(0);
    expect(await row.execute(parseProviderActionRequestV1('providers.models.experimental.confirm', input), {}))
      .toEqual({ ok: true, result: { status: 'success', action: 'confirmExperimental' } });
    expect(row.revision).toBe(2);
    expect(row.catalog.connections).toEqual([connection]);
    expect(row.catalog.experimentalBindingConfirmations).toEqual([neighbor, {
      v: 1, connectionId: connection.id, agentTargetKey: input.agentTargetKey, modelId: input.modelId,
      compatibilityFingerprint: input.compatibilityFingerprint, confirmedAt: 10,
    }]);
  });

  it.each([
    ['providers.models.source_visibility.set', { action: 'setConnectionVisibility', connectionId: 'pc_target', shown: false }],
    ['providers.models.visibility.set', { action: 'setVisibility',
      ref: { scope: 'allAgents', providerConnectionId: 'pc_target', modelId: 'model' }, hidden: true }],
    ['providers.models.visibility.reset', { action: 'resetVisibility', scope: { kind: 'connection', connectionId: 'pc_target' } }],
    ['providers.models.visibility.bulk', { action: 'bulkVisibility', changes: [
      { ref: { scope: 'agent', agentTargetKey: 'backend:codex', providerConnectionId: null, modelId: 'native' }, hidden: true },
      { ref: { scope: 'allAgents', providerConnectionId: 'pc_live', modelId: 'live' }, hidden: true },
      { ref: { scope: 'agent', agentTargetKey: 'backend:codex', providerConnectionId: 'pc_target', modelId: 'model' }, hidden: true },
    ] }],
  ] as const)('refuses %s for missing or deleted connections without committing any visibility change', async (actionId, input) => {
    const connection = ProviderConnectionV1Schema.parse({ v: 1, id: 'pc_live',
      source: { kind: 'contribution', contributionKey: 'happier.provider.deepseek/deepseek' }, role: 'named',
      displayName: 'Live', displayNameMode: 'custom', revision: 0, createdAt: 1, updatedAt: 1 });
    for (const deleted of [false, true]) {
      const row = accountRow({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
        connections: deleted ? [connection, { ...connection, id: 'pc_target' }] : [connection] });
      if (deleted) expect(await row.execute(parseProviderActionRequestV1('providers.connections.delete', {
        action: 'delete', connectionId: 'pc_target',
      }), {})).toMatchObject({ ok: true });
      const previous = row.catalog;
      const writes = row.writes;
      expect(await row.execute(parseProviderActionRequestV1(actionId, input), {}))
        .toMatchObject({ ok: false, errorCode: 'provider_connection_not_found',
          details: { code: 'provider_connection_not_found', connectionId: 'pc_target' } });
      expect(row.catalog).toBe(previous);
      expect(row.writes).toBe(writes);
    }
  });

  it('preserves native and connection visibility scopes through successful Account mutations', async () => {
    const connection = ProviderConnectionV1Schema.parse({ v: 1, id: 'pc_live',
      source: { kind: 'contribution', contributionKey: 'happier.provider.deepseek/deepseek' }, role: 'named',
      displayName: 'Live', displayNameMode: 'custom', revision: 0, createdAt: 1, updatedAt: 1 });
    const row = accountRow({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, connections: [connection] });
    const native = { scope: 'agent', agentTargetKey: 'backend:codex', providerConnectionId: null, modelId: 'native' } as const;
    const provider = { scope: 'allAgents', providerConnectionId: connection.id, modelId: 'provider' } as const;
    expect(await row.execute(parseProviderActionRequestV1('providers.models.source_visibility.set', {
      action: 'setConnectionVisibility', connectionId: connection.id, shown: false,
    }), {})).toMatchObject({ ok: true, result: { status: 'updated' } });
    expect(row.catalog.modelPickerVisibilityByConnectionId).toEqual({ [connection.id]: false });
    expect(await row.execute(parseProviderActionRequestV1('providers.models.source_visibility.set', {
      action: 'setConnectionVisibility', connectionId: connection.id, shown: null,
    }), {})).toMatchObject({ ok: true });
    expect(row.catalog.modelPickerVisibilityByConnectionId).toBeUndefined();
    expect(await row.execute(parseProviderActionRequestV1('providers.models.visibility.set', {
      action: 'setVisibility', ref: native, hidden: true,
    }), {})).toMatchObject({ ok: true });
    expect(await row.execute(parseProviderActionRequestV1('providers.models.visibility.bulk', {
      action: 'bulkVisibility', changes: [{ ref: native, hidden: false }, { ref: provider, hidden: true }],
    }), {})).toMatchObject({ ok: true });
    expect(row.catalog.modelVisibilityByRef).toEqual({ [serializeModelVisibilityRefV1(provider)]: 'hidden' });
    expect(await row.execute(parseProviderActionRequestV1('providers.models.visibility.set', {
      action: 'setVisibility', ref: native, hidden: true,
    }), {})).toMatchObject({ ok: true });
    expect(await row.execute(parseProviderActionRequestV1('providers.models.visibility.reset', {
      action: 'resetVisibility', scope: { kind: 'connection', connectionId: connection.id },
    }), {})).toMatchObject({ ok: true });
    expect(row.catalog.modelVisibilityByRef).toEqual({ [serializeModelVisibilityRefV1(native)]: 'hidden' });
    expect(await row.execute(parseProviderActionRequestV1('providers.models.visibility.reset', {
      action: 'resetVisibility', scope: { kind: 'agent', agentTargetKey: native.agentTargetKey },
    }), {})).toMatchObject({ ok: true });
    expect(row.catalog.modelVisibilityByRef).toEqual({});
  });

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
    expect(await row.execute(parseProviderActionRequestV1('providers.connections.describe', {}), {}))
      .toMatchObject({ ok: true, result: { status: 'success', available: [{ kind: 'frontier' }], connections: [] } });
    const created = await row.execute(parseProviderActionRequestV1('providers.connections.create_contribution', {
      action: 'createContribution', connectionId: 'pc_work', contributionKey: 'happier.provider.deepseek/deepseek',
      displayName: 'Work', savedSecretId: null, enable: true,
    }), {});
    expect(created).toMatchObject({ ok: true, result: { status: 'success', action: 'createContribution',
      connection: { grants: { accountEnabled: true }, authorized: false, runtime: { health: 'not_checked' } } } });
    expect(await row.execute(parseProviderActionRequestV1('providers.connections.describe', {}), {}))
      .toMatchObject({ ok: true, result: { status: 'success', available: [], connections: [{ displayName: 'Work' }] } });
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

describe('Provider endpoint policy Action', () => {
  it('custom-copy preserves effective overrides when the source is already custom', async () => {
    const endpointTemplateId = customTemplate.endpointTemplates[0]!.id;
    const connection = ProviderConnectionV1Schema.parse({ v: 1, id: 'pc_copy_policy', source: { kind: 'custom', template: customTemplate },
      role: 'named', displayName: 'Custom', displayNameMode: 'custom', revision: 0, createdAt: 1, updatedAt: 1,
      endpointOverrides: [{ endpointTemplateId, baseUrl: 'https://selected.example/v1', publicHeaders: { 'x-policy': 'account' } }] });
    const row = accountRow({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, connections: [connection] });
    expect(await row.execute(parseProviderActionRequestV1('providers.connections.duplicate', {
      action: 'duplicate', connectionId: connection.id, newConnectionId: 'pc_copy_result', displayName: 'Copy', mode: 'asCustom',
    }), {})).toMatchObject({ ok: true });
    const copied = row.catalog.connections.find(value => value.id === 'pc_copy_result');
    expect(copied?.source).toMatchObject({ kind: 'custom', template: { endpointTemplates: [expect.objectContaining({
      baseUrl: 'https://selected.example/v1', publicHeaders: { 'x-policy': 'account' },
    })] } });
  });

  it('a normalized unchanged policy patch writes no catalog revision while a real change still publishes', async () => {
    const endpointTemplateId = customTemplate.endpointTemplates[0]!.id;
    const connection = ProviderConnectionV1Schema.parse({ v: 1, id: 'pc_noop_policy', source: { kind: 'custom', template: customTemplate },
      role: 'named', displayName: 'Custom', displayNameMode: 'custom', revision: 0, createdAt: 1, updatedAt: 1,
      endpointOverrides: [{ endpointTemplateId, publicHeaders: { 'x-policy': 'account' } }] });
    const row = accountRow({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, connections: [connection] });
    const change = (value: string) => row.execute(parseProviderActionRequestV1('providers.connections.endpoint.set', {
      action: 'setEndpointOverride', connectionId: connection.id, expectedRevision: 0, endpointTemplateId, scope: 'account',
      publicHeaders: { 'X-Policy': value },
    }), {});
    expect(await change('account')).toMatchObject({ ok: true });
    expect(row.writes).toBe(0);
    expect(row.catalog.connections[0]?.revision).toBe(0);
    expect(await change('changed')).toMatchObject({ ok: true });
    expect(row.writes).toBe(1);
  });

  it('person confirmation receives authoritative policy and a denied or cancelled review writes nothing', async () => {
    const endpointTemplateId = customTemplate.endpointTemplates[0]!.id;
    const connection = ProviderConnectionV1Schema.parse({ v: 1, id: 'pc_ui_review', source: { kind: 'custom', template: customTemplate },
      role: 'named', displayName: 'Custom', displayNameMode: 'custom', revision: 0, createdAt: 1, updatedAt: 1,
      endpointOverrides: [{ endpointTemplateId, publicHeaders: { 'x-policy': 'account' } }] });
    const row = accountRow({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, connections: [connection] });
    for (const cancel of [false, true]) {
      const abort = new AbortController();
      const executor = createActionExecutor(createActionExecutorBoundaryFixture({ providerActionExecute: row.execute,
        presentUserActionConfirmation: async args => {
          expect(args).toMatchObject({ preview: { providerEndpointPolicyReview: {
            before: { publicHeaders: { 'x-policy': 'account' } }, after: { publicHeaders: { 'x-policy': 'changed' } },
          } } });
          if (cancel) abort.abort();
          return cancel;
        } }));
      const result = await executor.execute('providers.connections.endpoint.set', { action: 'setEndpointOverride', connectionId: connection.id,
        expectedRevision: 0, endpointTemplateId, scope: 'account', publicHeaders: { 'x-policy': 'changed' } },
        { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, serverId: 'home', signal: abort.signal });
      expect(result).toMatchObject({ ok: false, errorCode: cancel ? 'cancelled' : 'approval_canceled' });
      expect(row.writes).toBe(0);
    }
    const executor = createActionExecutor(createActionExecutorBoundaryFixture({ providerActionExecute: row.execute, presentUserActionConfirmation: async () => true }));
    expect(await executor.execute('providers.connections.endpoint.set', { action: 'setEndpointOverride', connectionId: connection.id,
      expectedRevision: 0, endpointTemplateId, scope: 'account', publicHeaders: { 'x-policy': 'changed' } },
      { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, serverId: 'home' })).toMatchObject({ ok: true });
    expect(row.writes).toBe(1);
    expect(await executor.execute('providers.connections.describe', { connectionId: connection.id },
      { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, serverId: 'home' }))
      .toMatchObject({ ok: true, result: { connections: [{ endpoints: [{ publicHeaders: { 'x-policy': 'changed' } }] }] } });
  });
  it.each(['headers', 'hints'] as const)('keeps readable policy approval across changed template %s and refuses a stale connection revision', async changed => {
    const row = accountRow();
    await row.execute(parseProviderActionRequestV1('providers.connections.create_contribution', {
      action: 'createContribution', connectionId: 'pc_review', contributionKey: 'happier.provider.deepseek/deepseek',
      displayName: null, savedSecretId: null, enable: false,
    }), {});
    const request = parseProviderActionRequestV1('providers.connections.endpoint.set', {
      action: 'setEndpointOverride', connectionId: 'pc_review', scope: 'account', expectedRevision: 0,
      endpointTemplateId: DEEPSEEK_PROVIDER_CONTRIBUTION.endpointTemplates[0]!.id, publicHeaders: { 'x-billing': 'byok' },
    });
    if (request.actionId !== 'providers.connections.endpoint.set') throw new Error('Expected endpoint policy request');
    const input = request.input;
    const writes = row.writes;
    const prepared = await prepareApprovalRequest({ deps: createActionExecutorBoundaryFixture({ providerActionExecute: row.execute }),
      actionId: 'providers.connections.endpoint.set', input, actionArgs: input, context: {} });
    expect(prepared).toMatchObject({ preview: { providerEndpointPolicyReview: { before: { publicHeaders: {} },
        after: { publicHeaders: { 'x-billing': 'byok' } }, scope: 'account' } } });
    expect(row.writes).toBe(writes);
    expect(row.catalog.connections[0]?.endpointOverrides).toBeUndefined();
    if (!prepared || 'ok' in prepared) throw new Error('Expected authoritative policy review');
    row.setDefinitions([{ contributionKey: 'happier.provider.deepseek/deepseek', provenance: 'first_party',
      definition: ProviderContributionV1Schema.parse({ ...DEEPSEEK_PROVIDER_CONTRIBUTION,
        endpointTemplates: DEEPSEEK_PROVIDER_CONTRIBUTION.endpointTemplates.map(endpoint => ({ ...endpoint,
          ...(changed === 'headers' ? { publicHeaders: { 'x-new-default': 'new' } }
            : { publicHeaderHints: { 'x-billing': 'This policy changes billing authority.' } }) })) }) }]);
    expect(await row.execute(parseProviderActionRequestV1('providers.connections.endpoint.set', prepared.actionArgs), {}))
      .toMatchObject({ ok: true });
    expect(row.writes).toBe(writes + 1);
    expect(row.catalog.connections[0]?.endpointOverrides).toEqual([{ endpointTemplateId: input.endpointTemplateId,
      publicHeaders: { 'x-billing': 'byok' } }]);
    expect(await row.execute(parseProviderActionRequestV1('providers.connections.endpoint.set', prepared.actionArgs), {}))
      .toMatchObject({ ok: false, errorCode: 'provider_connection_changed' });
    expect(row.writes).toBe(writes + 1);
  });
  it('keeps addresses independent of policy patches and restores template policy on reset after reload', async () => {
    const row = accountRow();
    const key = 'happier.provider.deepseek/deepseek';
    await row.execute(parseProviderActionRequestV1('providers.connections.create_contribution', {
      action: 'createContribution', connectionId: 'pc_policy', contributionKey: key,
      displayName: null, savedSecretId: null, enable: false,
    }), {});
    const endpointTemplateId = DEEPSEEK_PROVIDER_CONTRIBUTION.endpointTemplates[0]!.id;
    const change = (patch: Record<string, unknown>) => row.execute(parseProviderActionRequestV1('providers.connections.endpoint.set', {
      action: 'setEndpointOverride', connectionId: 'pc_policy', expectedRevision: row.catalog.connections[0]!.revision,
      endpointTemplateId, scope: 'account', ...patch,
    }), {});
    expect(await change({ baseUrl: 'https://custom.example/v1' })).toMatchObject({ ok: true });
    expect(await change({ publicHeaders: { 'X-Billing': 'byok' } })).toMatchObject({ ok: true });
    expect(row.catalog.connections[0]?.endpointOverrides).toEqual([{ endpointTemplateId, baseUrl: 'https://custom.example/v1', publicHeaders: { 'x-billing': 'byok' } }]);
    const read = await row.execute(parseProviderActionRequestV1('providers.connections.describe', { connectionId: 'pc_policy' }), {});
    expect(read).toMatchObject({ ok: true, result: { connections: [{ endpoints: expect.arrayContaining([expect.objectContaining({ baseUrl: 'https://custom.example/v1',
      publicHeaders: { 'x-billing': 'byok' }, accountOverridePublicHeaders: { 'x-billing': 'byok' }, publicHeaderSources: { 'x-billing': 'accountOverride' } })]) }] } });
    expect(await change({ baseUrl: null })).toMatchObject({ ok: true });
    expect(row.catalog.connections[0]?.endpointOverrides).toEqual([{ endpointTemplateId, publicHeaders: { 'x-billing': 'byok' } }]);
    expect(await change({ publicHeaders: null })).toMatchObject({ ok: true });
    expect(row.catalog.connections[0]?.endpointOverrides).toEqual([]);
    const writes = row.writes;
    for (const publicHeaders of [{ Authorization: 'secret' }, { 'x-policy': 'bad\nvalue' }, { 'cf-aig-metadata-payload': 'value' }]) {
      expect(() => parseProviderActionRequestV1('providers.connections.endpoint.set', { action: 'setEndpointOverride', connectionId: 'pc_policy',
        expectedRevision: row.catalog.connections[0]!.revision, endpointTemplateId, scope: 'account', publicHeaders })).toThrow();
    }
    expect(row.writes).toBe(writes);
  });
});
