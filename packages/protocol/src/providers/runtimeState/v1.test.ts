import { describe, expect, it } from 'vitest';

import {
  createEmptyProviderRuntimeStateFileV1,
  deriveProviderConnectionSummaryHealthV1,
  normalizeProviderRuntimeStateFileForStartupV1,
  parseProviderRuntimeStateFileV1,
  ProviderCatalogRuntimeStateKeyV1Schema,
  ProviderCatalogRuntimeStateRecordV1Schema,
  ProviderEndpointRuntimeStateKeyV1Schema,
  ProviderEndpointRuntimeStateRecordV1Schema,
  ProviderEndpointRuntimeStateV1Schema,
  ProviderRuntimeStateFileV1Schema,
  serializeProviderCatalogRuntimeStateKeyV1,
  serializeProviderEndpointRuntimeStateKeyV1,
  serializeProviderModelLoadRuntimeStateKeyV1,
} from './v1.js';

const endpointKey = {
  machineId: 'machine_a', connectionId: 'pc_a', endpointTemplateId: 'responses',
  endpointFingerprint: 'endpoint-observation:v1:a',
  observationAuthorizationFingerprint: 'observation-authorization:v1:a',
} as const;

const catalogKey = {
  machineId: 'machine_a', connectionId: 'pc_a', catalogFingerprint: 'catalog:v1:a',
  observationAuthorizationFingerprint: 'observation-authorization:v1:a',
} as const;

function validFile() {
  return {
    v: 1,
    machineId: 'machine_a',
    endpointHealth: [{
      key: endpointKey,
      state: { status: 'available', activity: 'checking', observedAt: 10 },
      lastAccessedAt: 11,
    }],
    catalogs: [{
      key: catalogKey,
      state: {
        catalogObservationId: 'observation_a',
        snapshot: { models: [{ id: 'model-a', name: 'A' }], observedAt: 10, stale: false },
        staleProbeModels: [],
      },
      lastAccessedAt: 11,
    }],
    modelLoadStates: [{
      key: {
        machineId: 'machine_a', connectionId: 'pc_a',
        catalogObservationId: 'observation_a', modelId: 'model-a',
      },
      loadState: 'loaded',
      observedAt: 10,
      lastAccessedAt: 11,
    }],
  } as const;
}

describe('provider endpoint runtime state', () => {
  it('reads settled observations from files containing retired installation checks without retaining that cache', () => {
    const parsed = parseProviderRuntimeStateFileV1({
      ...validFile(),
      installationChecks: [{
        key: { machineId: 'machine_a', contributionKey: 'plugin.a/local', checkId: 'installed' },
        state: { status: 'present', observedAt: 10 }, lastAccessedAt: 11,
      }],
    }, { expectedMachineId: 'machine_a' });
    expect(parsed.ok).toBe(true);
    expect(parsed.state.endpointHealth).toHaveLength(1);
    expect(parsed.state.catalogs).toHaveLength(1);
    expect(parsed.state).not.toHaveProperty('installationChecks');
  });

  it('retains stored observations with retired annotations while keeping authored files strict', () => {
    const expected = validFile();
    const row = expected.endpointHealth[0];
    const retained = { ...expected, retired: true, endpointHealth: [{ ...row, retired: true,
      key: { ...row.key, retired: true }, state: { ...row.state, retired: true } }] };
    expect(parseProviderRuntimeStateFileV1(retained, { expectedMachineId: 'machine_a' }))
      .toEqual({ ok: true, state: expected });
    expect(ProviderRuntimeStateFileV1Schema.safeParse(retained).success).toBe(false);
    expect(parseProviderRuntimeStateFileV1({ ...retained, endpointHealth: [{ ...row,
      state: { ...row.state, staleAt: 0 } }] }, { expectedMachineId: 'machine_a' }))
      .toMatchObject({ ok: false });
  });
  it('accepts only the exact error and timing shape owned by each settled status', () => {
    const valid = [
      { status: 'not_checked', activity: 'idle' },
      { status: 'available', activity: 'checking', observedAt: 10, staleAt: 20 },
      { status: 'unreachable', activity: 'idle', errorCode: 'provider_endpoint_unreachable', observedAt: 10, retryAt: 11 },
      { status: 'temporarily_unavailable', activity: 'idle', errorCode: 'provider_endpoint_unavailable', observedAt: 10 },
      { status: 'rate_limited', activity: 'idle', errorCode: 'provider_endpoint_rate_limited', observedAt: 10, retryAt: 20 },
      { status: 'unauthorized', activity: 'idle', errorCode: 'provider_endpoint_auth_required', observedAt: 10 },
      { status: 'unauthorized', activity: 'idle', errorCode: 'provider_endpoint_unauthorized', observedAt: 10 },
      { status: 'invalid_response', activity: 'idle', errorCode: 'provider_probe_response_invalid', observedAt: 10 },
    ];
    for (const state of valid) expect(ProviderEndpointRuntimeStateV1Schema.safeParse(state).success).toBe(true);
  });

  it.each([
    { status: 'not_checked', activity: 'idle', errorCode: 'provider_secret_missing' },
    { status: 'available', activity: 'idle', observedAt: 10, errorCode: 'provider_endpoint_unreachable' },
    { status: 'available', activity: 'idle' },
    { status: 'unreachable', activity: 'idle', errorCode: 'provider_endpoint_unavailable', observedAt: 10 },
    { status: 'temporarily_unavailable', activity: 'idle', errorCode: 'provider_endpoint_unavailable' },
    { status: 'unauthorized', activity: 'idle', errorCode: 'provider_endpoint_auth_required', observedAt: 10, retryAt: 20 },
    { status: 'invalid_response', activity: 'idle', errorCode: 'provider_probe_response_invalid', observedAt: 10, retryAt: 20 },
    { status: 'rate_limited', activity: 'idle', errorCode: 'provider_endpoint_rate_limited', observedAt: 10, retryAt: 9 },
    { status: 'available', activity: 'idle', observedAt: 10, staleAt: 9 },
  ])('rejects an illegal status/error/timing combination: $status', (state) => {
    expect(ProviderEndpointRuntimeStateV1Schema.safeParse(state).success).toBe(false);
  });

  it('preserves an endpoint Retry-After beyond the former local one-day policy', () => {
    expect(ProviderEndpointRuntimeStateV1Schema.safeParse({
      status: 'rate_limited', activity: 'idle', errorCode: 'provider_endpoint_rate_limited',
      observedAt: 10, retryAt: 10 + 24 * 60 * 60 * 1_000 + 1,
    }).success).toBe(true);
  });

  it('derives connection summaries from exact settled states while activity remains orthogonal', () => {
    const parse = (value: unknown) => ProviderEndpointRuntimeStateV1Schema.parse(value);
    const available = parse({ status: 'available', activity: 'checking', observedAt: 10 });
    const rateLimited = parse({
      status: 'rate_limited', activity: 'idle', errorCode: 'provider_endpoint_rate_limited', observedAt: 10, retryAt: 20,
    });
    const unreachable = parse({
      status: 'unreachable', activity: 'idle', errorCode: 'provider_endpoint_unreachable', observedAt: 10,
    });
    expect(deriveProviderConnectionSummaryHealthV1([])).toBe('not_checked');
    expect(deriveProviderConnectionSummaryHealthV1([available])).toBe('available');
    expect(deriveProviderConnectionSummaryHealthV1([available, unreachable])).toBe('partial');
    expect(deriveProviderConnectionSummaryHealthV1([rateLimited])).toBe('needs_attention');
    expect(deriveProviderConnectionSummaryHealthV1([unreachable])).toBe('unreachable');
    expect(deriveProviderConnectionSummaryHealthV1([parse({
      status: 'temporarily_unavailable', activity: 'idle',
      errorCode: 'provider_endpoint_unavailable', observedAt: 10,
    })])).toBe('needs_attention');
  });

  it('makes credential rebinding and rotation produce non-current endpoint and catalog cache identities', () => {
    const endpointBase = {
      machineId: 'machine_a', connectionId: 'pc_a', endpointTemplateId: 'responses',
      endpointFingerprint: 'endpoint-observation:v1:a',
    } as const;
    const catalogBase = {
      machineId: 'machine_a', connectionId: 'pc_a', catalogFingerprint: 'catalog:v1:a',
    } as const;
    const oldAuthorization = 'observation-authorization:v1:old';
    const rotatedAuthorization = 'observation-authorization:v1:rotated';
    const oldEndpoint = ProviderEndpointRuntimeStateKeyV1Schema.parse({
      ...endpointBase, observationAuthorizationFingerprint: oldAuthorization,
    });
    const rotatedEndpoint = ProviderEndpointRuntimeStateKeyV1Schema.parse({
      ...endpointBase, observationAuthorizationFingerprint: rotatedAuthorization,
    });
    const oldCatalog = ProviderCatalogRuntimeStateKeyV1Schema.parse({
      ...catalogBase, observationAuthorizationFingerprint: oldAuthorization,
    });
    const rotatedCatalog = ProviderCatalogRuntimeStateKeyV1Schema.parse({
      ...catalogBase, observationAuthorizationFingerprint: rotatedAuthorization,
    });
    expect(rotatedEndpoint).not.toEqual(oldEndpoint);
    expect(rotatedCatalog).not.toEqual(oldCatalog);
    expect(ProviderEndpointRuntimeStateKeyV1Schema.safeParse(endpointBase).success).toBe(false);
    expect(ProviderCatalogRuntimeStateKeyV1Schema.safeParse(catalogBase).success).toBe(false);
    expect(ProviderEndpointRuntimeStateKeyV1Schema.safeParse({
      ...endpointBase,
      observationAuthorizationFingerprint: ' observation-authorization:v1:old ',
    }).success).toBe(false);
    expect(ProviderCatalogRuntimeStateKeyV1Schema.safeParse({
      ...catalogBase,
      catalogFingerprint: ' catalog:v1:a ',
      observationAuthorizationFingerprint: oldAuthorization,
    }).success).toBe(false);
  });

  it('validates the exact array-based file envelope and attached catalog generation', () => {
    expect(ProviderRuntimeStateFileV1Schema.parse(validFile())).toEqual(validFile());
    expect(ProviderEndpointRuntimeStateRecordV1Schema.safeParse(validFile().endpointHealth[0]).success).toBe(true);
    expect(ProviderCatalogRuntimeStateRecordV1Schema.safeParse(validFile().catalogs[0]).success).toBe(true);

    const orphanLoad = structuredClone(validFile());
    orphanLoad.modelLoadStates[0]!.key.catalogObservationId = 'older_generation';
    expect(ProviderRuntimeStateFileV1Schema.safeParse(orphanLoad).success).toBe(false);

    const absentModel = structuredClone(validFile());
    absentModel.modelLoadStates[0]!.key.modelId = 'not-in-catalog';
    expect(ProviderRuntimeStateFileV1Schema.safeParse(absentModel).success).toBe(false);

    const nonCanonicalObservation = structuredClone(validFile());
    nonCanonicalObservation.catalogs[0]!.state.catalogObservationId = ' observation_a ';
    expect(ProviderRuntimeStateFileV1Schema.safeParse(nonCanonicalObservation).success).toBe(false);
  });

  it('does not carry model-load evidence onto a model retained only as a stale reference', () => {
    const file = structuredClone(validFile());
    file.catalogs[0]!.state.snapshot.models = [];
    file.catalogs[0]!.state.staleProbeModels = [{ id: 'model-a', name: 'A' }];
    expect(ProviderRuntimeStateFileV1Schema.safeParse(file).success).toBe(false);
    expect(parseProviderRuntimeStateFileV1(file, { expectedMachineId: 'machine_a' })).toMatchObject({
      ok: false,
      diagnostic: { reason: 'malformed' },
    });
  });

  it('fails the whole persisted cache on semantic duplicates or cross-machine children', () => {
    const duplicate = structuredClone(validFile());
    duplicate.endpointHealth.push(structuredClone(duplicate.endpointHealth[0]!));
    const duplicateResult = parseProviderRuntimeStateFileV1(duplicate, { expectedMachineId: 'machine_a' });
    expect(duplicateResult).toMatchObject({ ok: false, diagnostic: { reason: 'duplicate_key' } });
    expect(duplicateResult.state).toEqual(createEmptyProviderRuntimeStateFileV1('machine_a'));

    const crossMachine = structuredClone(validFile());
    crossMachine.catalogs[0]!.key.machineId = 'machine_b';
    const crossMachineResult = parseProviderRuntimeStateFileV1(crossMachine, { expectedMachineId: 'machine_a' });
    expect(crossMachineResult).toMatchObject({ ok: false, diagnostic: { reason: 'machine_mismatch' } });
    expect(crossMachineResult.state).toEqual(createEmptyProviderRuntimeStateFileV1('machine_a'));
  });

  it('fails future and malformed persisted data to an empty replaceable cache', () => {
    expect(parseProviderRuntimeStateFileV1({ ...validFile(), v: 2 }, {
      expectedMachineId: 'machine_a',
    })).toMatchObject({ ok: false, diagnostic: { reason: 'future_version' } });
    expect(parseProviderRuntimeStateFileV1({ nope: true }, {
      expectedMachineId: 'machine_a',
    })).toMatchObject({ ok: false, diagnostic: { reason: 'malformed' } });
  });

  it('resets only transient checking activity during startup normalization', () => {
    const normalized = normalizeProviderRuntimeStateFileForStartupV1(validFile());
    expect(normalized.endpointHealth[0]).toEqual({
      ...validFile().endpointHealth[0],
      state: { ...validFile().endpointHealth[0].state, activity: 'idle' },
    });
    expect(normalized.catalogs).toEqual(validFile().catalogs);
    expect(normalized.modelLoadStates).toEqual(validFile().modelLoadStates);
  });

  it('requires null catalog snapshots to have no generation, stale rows, or load observations', () => {
    const emptyCatalog = {
      key: catalogKey,
      state: { snapshot: null, staleProbeModels: [] },
      lastAccessedAt: 11,
    } as const;
    expect(ProviderCatalogRuntimeStateRecordV1Schema.safeParse(emptyCatalog).success).toBe(true);
    expect(ProviderCatalogRuntimeStateRecordV1Schema.safeParse({
      ...emptyCatalog,
      state: { ...emptyCatalog.state, catalogObservationId: 'must-not-exist' },
    }).success).toBe(false);

    const file = structuredClone(validFile());
    file.catalogs = [emptyCatalog] as typeof file.catalogs;
    expect(ProviderRuntimeStateFileV1Schema.safeParse(file).success).toBe(false);
  });

  it('rejects ambiguous catalog observation generations even when cache keys differ', () => {
    const file = structuredClone(validFile());
    file.modelLoadStates = [];
    file.catalogs.push({
      ...structuredClone(file.catalogs[0]!),
      key: { ...file.catalogs[0]!.key, catalogFingerprint: 'catalog:v1:b' },
    });
    expect(parseProviderRuntimeStateFileV1(file, {
      expectedMachineId: 'machine_a',
    })).toMatchObject({ ok: false, diagnostic: { reason: 'duplicate_key' } });
  });

  it('rejects duplicate exact model ids inside one catalog generation', () => {
    const file = structuredClone(validFile());
    file.modelLoadStates = [];
    file.catalogs[0]!.state.snapshot.models.push({ id: 'model-a', name: 'Duplicate A' });
    expect(parseProviderRuntimeStateFileV1(file, {
      expectedMachineId: 'machine_a',
    })).toMatchObject({ ok: false, diagnostic: { reason: 'malformed' } });
  });

  it('retains catalog identities and attached load observations beyond the former global caps', () => {
    const catalogs = Array.from({ length: 11 }, (_, catalogIndex) => {
      const remaining = 50_000 - catalogIndex * 5_000;
      const modelCount = Math.min(5_000, Math.max(0, remaining + (catalogIndex === 10 ? 1 : 0)));
      return {
        key: {
          ...catalogKey,
          catalogFingerprint: `catalog:v1:${catalogIndex}`,
        },
        state: {
          catalogObservationId: `observation_${catalogIndex}`,
          snapshot: {
            models: Array.from({ length: modelCount }, (_, modelIndex) => ({
              id: `model-${catalogIndex}-${modelIndex}`,
            })),
            observedAt: 10,
            stale: false,
          },
          staleProbeModels: [],
        },
        lastAccessedAt: 11,
      };
    });
    const modelLoadStates = catalogs.flatMap((record) => record.state.snapshot.models.map((model) => ({
      key: { machineId: record.key.machineId, connectionId: record.key.connectionId,
        catalogObservationId: record.state.catalogObservationId, modelId: model.id },
      loadState: 'loaded', observedAt: 10, lastAccessedAt: 11,
    })));
    const file = { ...validFile(), catalogs, modelLoadStates };
    expect(catalogs.reduce((total, record) => total + record.state.snapshot.models.length, 0))
      .toBe(50_001);
    const parsed = parseProviderRuntimeStateFileV1(file, { expectedMachineId: 'machine_a' });
    expect(parsed.ok).toBe(true);
    expect(parsed.state.catalogs).toHaveLength(catalogs.length);
    expect(parsed.state.modelLoadStates).toHaveLength(modelLoadStates.length);
  });

  it('retains independent catalog observations beyond the former catalog row cap', () => {
    const catalogs = Array.from({ length: 2_049 }, (_unused, index) => ({
      key: { ...catalogKey, connectionId: `pc_${index}` },
      state: { snapshot: null, staleProbeModels: [] },
      lastAccessedAt: 11,
    }));
    const parsed = parseProviderRuntimeStateFileV1({
      ...validFile(), catalogs, modelLoadStates: [],
    }, { expectedMachineId: 'machine_a' });
    expect(parsed.ok).toBe(true);
    expect(parsed.state.catalogs).toHaveLength(catalogs.length);
  });

  it('retains previous catalog model references beyond the former per-catalog cap', () => {
    const file = validFile();
    const staleProbeModels = Array.from({ length: 5_001 }, (_unused, index) => ({ id: `stale-${index}` }));
    const parsed = parseProviderRuntimeStateFileV1({
      ...file, modelLoadStates: [], catalogs: [{
        ...file.catalogs[0], state: { ...file.catalogs[0].state, staleProbeModels },
      }],
    }, { expectedMachineId: 'machine_a' });
    expect(parsed.ok).toBe(true);
    expect(parsed.state.catalogs[0]?.state.staleProbeModels).toHaveLength(staleProbeModels.length);
  });

  it('serializes every semantic key as a collision-safe fixed tuple', () => {
    expect(serializeProviderEndpointRuntimeStateKeyV1(endpointKey)).not.toBe(
      serializeProviderEndpointRuntimeStateKeyV1({
        ...endpointKey,
        connectionId: 'pc_a:responses',
        endpointTemplateId: 'responses',
      }),
    );
    expect(JSON.parse(serializeProviderCatalogRuntimeStateKeyV1(catalogKey))).toEqual([
      'machine_a', 'pc_a', 'catalog:v1:a', 'observation-authorization:v1:a',
    ]);
    expect(JSON.parse(serializeProviderModelLoadRuntimeStateKeyV1(
      validFile().modelLoadStates[0].key,
    ))).toEqual(['machine_a', 'pc_a', 'observation_a', 'model-a']);
  });

});
