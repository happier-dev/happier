import { describe, expect, it } from 'vitest';

import { ProviderCatalogDeclarationV1Schema } from './catalog/descriptorV1.js';
import { applyProviderCatalogRefreshV1, mergeProviderCatalogV1 } from './catalog/merge.js';
import { DEFAULT_PROVIDER_SETTINGS_V1, assertProviderSettingsV1WithinLimits, parseProviderSettingsV1Narrow } from './settings/v1.js';
import { splitProviderSettingsV1, sealProviderConnectionsContentV1, openProviderConnectionsContentV1 } from './connections/connectionRowsV1.js';
import { createProviderCatalogFingerprintV1, createProviderProbeRequestFingerprintV1 } from './securityFingerprintsV1.js';
import { normalizeProviderEndpointUrlSyntax, normalizeProviderOriginRelativePathSyntax } from './safety/url.js';
import { normalizeProviderPublicHeaders } from './safety/headers.js';
import { createProviderErrorV1, ProviderErrorV1Schema } from './errors.js';
import { serializeSessionModelSelectionV1, deserializeSessionModelSelectionV1 } from './selection/v1.js';
import { ProviderModelDescriptorV1Schema } from '../models/descriptor.js';

describe('Provider values are admitted by semantics and their real transport owner', () => {
  it('preserves complete Provider-authored aliases and model controls beyond retired collection counts', () => {
    const descriptor = { id: 'model', name: 'Model', description: 'd'.repeat(1_025),
      aliases: Array.from({ length: 65 }, (_, index) => `alias-${index}`),
      modelOptions: Array.from({ length: 65 }, (_, index) => ({ id: `option-${index}`, name: 'Control', type: 'select', currentValue: 'value' })) };
    expect(ProviderModelDescriptorV1Schema.parse(descriptor)).toEqual(descriptor);
  });
  it('round-trips a long admitted model identity through the child-process selection transport', () => {
    const selection = { v: 1 as const, ref: { agentTargetKey: 'agent:example', providerConnectionId: 'pc_example', modelId: 'm'.repeat(8_193) }, updatedAt: 1 };
    expect(deserializeSessionModelSelectionV1(serializeSessionModelSelectionV1(selection))).toEqual(selection);
  });
  it('keeps every declared probe in catalog identity beyond the retired three-probe cap', () => {
    const probes = Array.from({ length: 4 }, (_, index) => ({ endpointTemplateId: 'api', path: `/models/${index}`, parser: 'openai-models' }));
    const catalog = ProviderCatalogDeclarationV1Schema.parse({ source: 'probe', manualModelPolicy: 'allowed', probes });
    expect(catalog).toMatchObject({ probes });
    const fingerprints = probes.map(probe => createProviderProbeRequestFingerprintV1({ ...probe, method: 'GET', endpointUrl: 'https://example.test', publicHeaders: {} }));
    expect(createProviderCatalogFingerprintV1({ probeRequestFingerprints: fingerprints })).not.toBe(
      createProviderCatalogFingerprintV1({ probeRequestFingerprints: fingerprints.slice(0, 3) }),
    );
    expect(() => createProviderCatalogFingerprintV1({ probeRequestFingerprints: [] })).toThrow();
  });

  it('refreshes and merges a complete large catalog without dropping long canonical model identities', () => {
    const models = Array.from({ length: 5_001 }, (_, index) => ({ id: `model-${index}-${'x'.repeat(513)}`, name: 'N'.repeat(257) }));
    const state = applyProviderCatalogRefreshV1({ snapshot: null, staleProbeModels: [] }, { status: 'success', observedAt: 1, models });
    const merged = mergeProviderCatalogV1({ staticModels: [], manualModels: [], probeState: state });
    expect(merged.rows.map(row => row.descriptor.id).sort()).toEqual(models.map(model => model.id).sort());
    expect(merged.rows).toHaveLength(models.length);
    expect(() => applyProviderCatalogRefreshV1(state, { status: 'success', observedAt: 2, models: [{ id: 'duplicate' }, { id: 'duplicate' }] })).toThrow();
  });

  it('round-trips the full catalog through authoring, retained reads and plain storage above stale settings limits', () => {
    const connection = { v: 1 as const, id: 'pc_large', source: { kind: 'contribution' as const, contributionKey: 'acme.provider/api' }, role: 'named' as const,
      displayName: 'Large', displayNameMode: 'custom' as const, deployment: { kind: 'external' as const }, revision: 0, createdAt: 1, updatedAt: 1 };
    const models = Array.from({ length: 5_001 }, (_, index) => ({ id: `model-${index}-${'x'.repeat(80)}`, addedAt: 1 }));
    const input = { ...DEFAULT_PROVIDER_SETTINGS_V1, connections: [connection], manualModelsByConnectionId: { pc_large: models },
      connectionTombstones: Array.from({ length: 257 }, (_, index) => ({ v: 1 as const, id: `deleted-${index}`, contributionKey: null, lastDisplayName: 'Deleted', deletedAt: 1 })) };
    const settings = assertProviderSettingsV1WithinLimits(input);
    expect(parseProviderSettingsV1Narrow(input)).toEqual({ settings, diagnostics: [] });
    const { catalog } = splitProviderSettingsV1(settings);
    const content = sealProviderConnectionsContentV1({ catalog, mode: 'plain', material: null });
    expect(openProviderConnectionsContentV1({ content, mode: 'plain', material: null })).toEqual({ status: 'opened', catalog });
    expect(() => assertProviderSettingsV1WithinLimits({ ...input, manualModelsByConnectionId: { missing: models } })).toThrow();
  });

  it('accepts long benign URLs and header collections while preserving URL and header safety', () => {
    const path = `/${'p'.repeat(8_193)}?cursor=${'v'.repeat(2_049)}`;
    expect(normalizeProviderOriginRelativePathSyntax(path, { allowQuery: true })).toBe(path);
    expect(normalizeProviderEndpointUrlSyntax(`https://example.test${path}`).normalizedUrl).toBe(`https://example.test${path}`);
    const headers = Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`x-${index}-${'n'.repeat(129)}`, 'v'.repeat(4_097)]));
    expect(Object.keys(normalizeProviderPublicHeaders(headers))).toHaveLength(65);
    expect(() => normalizeProviderPublicHeaders({ authorization: 'secret' })).toThrow();
    expect(() => normalizeProviderPublicHeaders({ 'x-value': 'bad\r\nheader' })).toThrow();
    expect(() => normalizeProviderEndpointUrlSyntax('https://user:secret@example.test')).toThrow();
  });

  it('preserves an upstream retry hint beyond one day without admitting invalid delay or recovery metadata', () => {
    const error = createProviderErrorV1('provider_endpoint_rate_limited', { retryAfterMs: 86_400_001 });
    expect(ProviderErrorV1Schema.parse(error).retryAfterMs).toBe(86_400_001);
    for (const retryAfterMs of [-1, Infinity, NaN]) expect(ProviderErrorV1Schema.safeParse({ ...error, retryAfterMs }).success).toBe(false);
  });
});
