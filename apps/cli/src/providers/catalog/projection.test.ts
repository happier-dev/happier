import { describe, expect, it } from 'vitest';
import { projectProviderCatalogForPicker } from './projection';
import type { ProviderConnectionCatalog } from './types';
import { serializeModelVisibilityRefV1 } from '@happier-dev/protocol/providers/model-selection';

const ref = (modelId: string) => ({ agentTargetKey: 'agent:codex', providerConnectionId: 'pc_a', modelId });
const catalog: ProviderConnectionCatalog = {
  agentTargetKey: 'agent:codex', connectionId: 'pc_a', authorization: { authorized: true },
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
    const modelVisibilityByRef = { [serializeModelVisibilityRefV1({ scope: 'allAgents', providerConnectionId: 'pc_a', modelId: 'favorite' })]: 'hidden' as const };
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
      serializeModelVisibilityRefV1({ scope: 'allAgents', providerConnectionId: 'pc_a', modelId }), 'hidden' as const]));
    expect(projectProviderCatalogForPicker({ ...input, modelVisibilityByRef: everyModelHidden }).hiddenSources).toEqual([]);
  });
});
