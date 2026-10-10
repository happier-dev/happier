import { describe, expect, it } from 'vitest';
import { DEEPSEEK_PROVIDER_CONTRIBUTION } from '../../../../plugins/deepseek/src/provider/contribution.js';
import { ProviderContributionV1Schema } from '../contributions/v1.js';
import { ProviderConnectionV1Schema } from '../connections/v1.js';
import { DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 } from '../connections/connectionRowsV1.js';
import type { AgentProviderRequirementsV1 } from '../compatibility/v1.js';
import { projectAccountProviderModelsV1 } from './accountModelProjectionV1.js';
import { DaemonProviderModelProjectionResponseV1Schema } from '../../rpc/providers.js';
import { resolveProviderBindingCompatibilityWithFingerprintV1 } from '../compatibility/resolve.js';

const agentTargetKey = 'agent:happier.agent.claude/claude';
const agent: AgentProviderRequirementsV1 = {
  acceptsProtocols: ['anthropic'], required: { streaming: true, toolRoundTrips: true },
  credentialSupport: { supportsNoAuth: true, apiKeyTransports: [{ protocol: 'anthropic',
    destination: { kind: 'httpHeader', names: ['x-api-key'], formats: ['raw'] } }] },
  authIsolation: { suppressConnectedServiceIds: ['claude-subscription'], ownedEnvKeys: [] },
  materialization: 'spawnEnv', applyPolicy: 'live', supportsFreeformModelIds: true,
};
const connection = ProviderConnectionV1Schema.parse({ v: 1, id: 'pc_deepseek',
  source: { kind: 'contribution', contributionKey: 'happier.provider.deepseek/deepseek' },
  role: 'named', displayName: 'Work', displayNameMode: 'custom', revision: 3, createdAt: 1, updatedAt: 2 });
const definitions = [{ contributionKey: 'happier.provider.deepseek/deepseek',
  definition: ProviderContributionV1Schema.parse(DEEPSEEK_PROVIDER_CONTRIBUTION), provenance: 'first_party' as const }];
const catalog = { ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, connections: [connection],
  manualModelsByConnectionId: { pc_deepseek: [{ id: 'private-model', name: 'Private', addedAt: 2 }] } };
const request = { agentTargetKey, mode: 'management' as const };

describe('Account Provider model projection', () => {
  it('shows real compatible static/manual models without machine, grant, probe, or runtime confirmation', () => {
    const result = projectAccountProviderModelsV1({ catalog, definitions, agent, request });
    expect(result.status).toBe('success');
    if (result.status !== 'success') return;
    expect(DaemonProviderModelProjectionResponseV1Schema.safeParse(result).success).toBe(true);
    expect(result.groups[0]?.rows.map(row => row.ref.modelId)).toEqual(['deepseek-v4-flash', 'deepseek-v4-pro', 'private-model']);
    expect(result.groups[0]?.authorization.authorized).toBe(false);
    for (const row of result.groups[0]!.rows) {
      expect(row.compatibility.result.status).toBe('experimental');
      expect(row.compatibility.confirmed).toBe(false);
      const runtimeCompatibility = resolveProviderBindingCompatibilityWithFingerprintV1({ agentTargetKey,
        endpoints: definitions[0]!.definition.endpointTemplates, credential: definitions[0]!.definition.credential,
        agent, model: row.descriptor, adapterVersion: 1 });
      expect(row.compatibility.compatibilityFingerprint).not.toBe(runtimeCompatibility.compatibilityFingerprint);
      expect(row.endpointHealth).toBe('not_checked');
      expect(row.loadState).toBe('unknown');
      expect(row.sources.probe).toBe(false);
      expect(row.confidence).toBe('account_unverified');
    }
  });
  it('keeps incompatible and unavailable Agent declarations out, using actual protocol requirements', () => {
    const incompatible: AgentProviderRequirementsV1 = { ...agent, acceptsProtocols: ['openai-responses'] };
    const result = projectAccountProviderModelsV1({ catalog, definitions, agent: incompatible, request });
    expect(result).toMatchObject({ status: 'success', groups: [] });
    expect(projectAccountProviderModelsV1({ catalog, definitions, agent: null, request }))
      .toMatchObject({ status: 'error', error: { code: 'provider_agent_runtime_unsupported' } });
  });
  it('shares source and per-model visibility while retaining the exact current hidden ref', () => {
    const hiddenCatalog = { ...catalog, modelPickerVisibilityByConnectionId: { pc_deepseek: false } };
    const input = { catalog: hiddenCatalog, definitions, agent, request: { agentTargetKey } };
    expect(projectAccountProviderModelsV1(input)).toMatchObject({ status: 'success', groups: [], hiddenSources: [{ modelCount: 3 }] });
    expect(projectAccountProviderModelsV1({ ...input, request: { agentTargetKey,
      currentSelection: { agentTargetKey, providerConnectionId: connection.id, modelId: 'private-model' } } }))
      .toMatchObject({ status: 'success', groups: [{ rows: [{ ref: { modelId: 'private-model' } }] }] });
  });
  it('retains a two-sided freeform selection and reports missing source intent without native fallback', () => {
    const currentSelection = { agentTargetKey, providerConnectionId: connection.id, modelId: 'unlisted-model' };
    const input = { catalog, definitions, agent, request: { agentTargetKey, currentSelection } };
    const result = projectAccountProviderModelsV1(input);
    expect(result).toMatchObject({ status: 'success', currentSelectionRecovery: null,
      groups: [{ rows: expect.arrayContaining([{ ref: currentSelection,
        descriptor: { id: 'unlisted-model', name: 'unlisted-model' },
        sources: { manual: false, static: false, probe: false }, confidence: 'account_unverified',
        compatibility: expect.any(Object), endpointHealth: 'not_checked', catalog: { stale: true },
        loadState: 'unknown', visibility: 'visible' }]) }] });
    expect(projectAccountProviderModelsV1({ ...input, definitions: [] })).toMatchObject({ status: 'success',
      currentSelectionRecovery: { kind: 'contribution_unavailable', ref: currentSelection,
        error: { code: 'provider_contribution_unavailable', connectionId: connection.id } } });
    expect(projectAccountProviderModelsV1({ ...input, catalog: { ...catalog, connections: [] } })).toMatchObject({ status: 'success',
      currentSelectionRecovery: { kind: 'connection_missing', ref: currentSelection,
        error: { code: 'provider_connection_not_found', connectionId: connection.id } } });
    expect(projectAccountProviderModelsV1({ ...input, agent: { ...agent, supportsFreeformModelIds: false } })).toMatchObject({ status: 'success',
      currentSelectionRecovery: { kind: 'model_not_found', ref: currentSelection,
        error: { code: 'provider_model_not_found', connectionId: connection.id } } });
  });
  it('preserves source-off when every model is retained as a favorite, default or current selection', () => {
    const refs = ['deepseek-v4-flash', 'deepseek-v4-pro', 'private-model'].map(modelId => ({
      agentTargetKey, providerConnectionId: connection.id, modelId,
    }));
    const input = { catalog: { ...catalog, modelPickerVisibilityByConnectionId: { pc_deepseek: false } },
      definitions, agent, defaultsByAgentTargetKey: { [agentTargetKey]: { v: 1 as const, ref: refs[1]!, updatedAt: 1 } },
      request: { agentTargetKey, currentSelection: refs[0], favoriteSelections: [refs[2]!] } };
    const result = projectAccountProviderModelsV1(input);
    expect(result).toMatchObject({ status: 'success', groups: [{ rows: expect.any(Array) }],
      hiddenSources: [{ connectionId: connection.id, modelCount: 0 }] });
    expect(DaemonProviderModelProjectionResponseV1Schema.safeParse(result).success).toBe(true);
    if (result.status === 'success') expect(result.groups[0]?.rows).toHaveLength(3);
    expect(projectAccountProviderModelsV1({ ...input,
      catalog: { ...input.catalog, modelPickerVisibilityByConnectionId: { pc_deepseek: true } } }))
      .toMatchObject({ status: 'success', hiddenSources: [] });
  });
});
