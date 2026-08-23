import { describe, expect, it, vi } from 'vitest';

import {
  PROVIDER_RUNTIME_STATE_LIMITS_V1,
  ProviderCatalogRuntimeStateRecordV1Schema,
  ProviderEndpointRuntimeStateRecordV1Schema,
  ProviderInstallationRuntimeStateRecordV1Schema,
  ProviderModelLoadRuntimeStateRecordV1Schema,
} from '@happier-dev/protocol';

import { pruneProviderRuntimeStateV1 } from './prune';

const catalog = (params: Readonly<{
  connectionId: string;
  fingerprint: string;
  observationId: string;
  lastAccessedAt: number;
  modelId: string;
}>) => ProviderCatalogRuntimeStateRecordV1Schema.parse({
  key: {
    machineId: 'machine_a', connectionId: params.connectionId,
    catalogFingerprint: `catalog:v1:${params.fingerprint}`,
    observationAuthorizationFingerprint: 'observation-authorization:v1:a',
  },
  state: {
    catalogObservationId: params.observationId,
    snapshot: { models: [{ id: params.modelId }], observedAt: params.lastAccessedAt, stale: false as const },
    staleProbeModels: [],
  },
  lastAccessedAt: params.lastAccessedAt,
});

const load = (connectionId: string, observationId: string, modelId: string, lastAccessedAt: number) => ProviderModelLoadRuntimeStateRecordV1Schema.parse({
  key: { machineId: 'machine_a', connectionId, catalogObservationId: observationId, modelId },
  loadState: 'loaded' as const,
  observedAt: lastAccessedAt,
  lastAccessedAt,
});

describe('pruneProviderRuntimeStateV1', () => {
  it('prunes a candidate that crosses the canonical installation cap instead of refusing it', () => {
    const installation = (index: number) => ProviderInstallationRuntimeStateRecordV1Schema.parse({
      key: { machineId: 'machine_a', contributionKey: `plugin.a/tool-${index}`, checkId: 'installed' },
      state: { status: 'present' as const, observedAt: index }, lastAccessedAt: index,
    });
    const installationChecks = Array.from(
      { length: PROVIDER_RUNTIME_STATE_LIMITS_V1.maxInstallationRecords + 1 },
      (_unused, index) => installation(index),
    );

    const pruned = pruneProviderRuntimeStateV1({
      v: 1, machineId: 'machine_a', endpointHealth: [],
      catalogs: [], installationChecks, modelLoadStates: [],
    });

    expect(pruned.installationChecks).toHaveLength(PROVIDER_RUNTIME_STATE_LIMITS_V1.maxInstallationRecords);
    expect(pruned.installationChecks.map((record) => record.key.contributionKey))
      .not.toContain('plugin.a/tool-0');
    expect(pruned.installationChecks.map((record) => record.key.contributionKey))
      .toContain(`plugin.a/tool-${PROVIDER_RUNTIME_STATE_LIMITS_V1.maxInstallationRecords}`);
  });

  it('still refuses a candidate whose duplicate semantic keys pruning cannot repair', () => {
    const installation = (index: number) => ProviderInstallationRuntimeStateRecordV1Schema.parse({
      key: { machineId: 'machine_a', contributionKey: 'plugin.a/tool', checkId: 'installed' },
      state: { status: 'present' as const, observedAt: index }, lastAccessedAt: index,
    });

    expect(() => pruneProviderRuntimeStateV1({
      v: 1, machineId: 'machine_a', endpointHealth: [], catalogs: [],
      installationChecks: [installation(1), installation(2)], modelLoadStates: [],
    })).toThrow(/duplicate semantic keys/u);
  });



  it('uses raw canonical tuple ordering rather than host locale collation', () => {
    const a = catalog({ connectionId: 'pc_a', fingerprint: 'a', observationId: 'obs_a', lastAccessedAt: 10, modelId: 'a' });
    const b = catalog({ connectionId: 'pc_b', fingerprint: 'b', observationId: 'obs_b', lastAccessedAt: 10, modelId: 'b' });
    const localeCompare = vi.spyOn(String.prototype, 'localeCompare').mockImplementation(() => {
      throw new Error('host locale collation must not own persisted pruning order');
    });
    try {
      expect(() => pruneProviderRuntimeStateV1({
        v: 1, machineId: 'machine_a', endpointHealth: [], catalogs: [b, a],
        installationChecks: [], modelLoadStates: [],
      }, {
        budget: {
          maxCatalogRecords: 1,
          maxCatalogModelIdentities: 50_000,
          maxModelLoadRecords: 50_000,
          maxEndpointRecords: 8_192,
          maxInstallationRecords: 4_096,
          maxEncodedBytes: 64 * 1024 * 1024,
        },
      })).not.toThrow();
    } finally {
      localeCompare.mockRestore();
    }
  });

  it('prunes orphan load rows and endpoint/install LRU deterministically', () => {
    const active = catalog({ connectionId: 'pc_a', fingerprint: 'a', observationId: 'obs_a', lastAccessedAt: 10, modelId: 'a' });
    const endpoint = (id: string, lastAccessedAt: number) => ProviderEndpointRuntimeStateRecordV1Schema.parse({
      key: {
        machineId: 'machine_a', connectionId: 'pc_a', endpointTemplateId: id,
        endpointFingerprint: `endpoint-observation:v1:${id}`,
        observationAuthorizationFingerprint: 'observation-authorization:v1:a',
      },
      state: { status: 'available' as const, activity: 'idle' as const, observedAt: lastAccessedAt },
      lastAccessedAt,
    });
    const installation = (id: string, lastAccessedAt: number) => ProviderInstallationRuntimeStateRecordV1Schema.parse({
      key: { machineId: 'machine_a', contributionKey: `plugin.a/${id}`, checkId: 'installed' },
      state: { status: 'present' as const, observedAt: lastAccessedAt }, lastAccessedAt,
    });
    const state = {
      v: 1 as const, machineId: 'machine_a', catalogs: [active],
      modelLoadStates: [load('pc_a', 'missing', 'a', 1), load('pc_a', 'obs_a', 'a', 10)],
      endpointHealth: [endpoint('b', 2), endpoint('a', 1)],
      installationChecks: [installation('b', 2), installation('a', 1)],
    };
    const pruned = pruneProviderRuntimeStateV1(state, {
      budget: {
        maxCatalogRecords: 2_048,
        maxCatalogModelIdentities: 50_000,
        maxModelLoadRecords: 50_000,
        maxEndpointRecords: 1,
        maxInstallationRecords: 1,
        maxEncodedBytes: 64 * 1024 * 1024,
      },
    });
    expect(pruned.modelLoadStates).toEqual([load('pc_a', 'obs_a', 'a', 10)]);
    expect(pruned.endpointHealth.map((record) => record.key.endpointTemplateId)).toEqual(['b']);
    expect(pruned.installationChecks.map((record) => record.key.contributionKey)).toEqual(['plugin.a/b']);
  });

  it('uses observation time before canonical tuple when byte pruning endpoint rows', () => {
    const endpoint = (id: string, observedAt: number) => ProviderEndpointRuntimeStateRecordV1Schema.parse({
      key: {
        machineId: 'machine_a', connectionId: 'pc_a', endpointTemplateId: id,
        endpointFingerprint: `endpoint-observation:v1:${id}`,
        observationAuthorizationFingerprint: 'observation-authorization:v1:a',
      },
      state: { status: 'available' as const, activity: 'idle' as const, observedAt },
      lastAccessedAt: 10,
    });
    const newerCanonicalFirst = endpoint('a', 2);
    const olderCanonicalLast = endpoint('b', 1);
    const oneRowState = {
      v: 1 as const, machineId: 'machine_a', endpointHealth: [newerCanonicalFirst],
      catalogs: [], installationChecks: [], modelLoadStates: [],
    };
    const budgetBytes = Buffer.byteLength(JSON.stringify(oneRowState, null, 2), 'utf8');
    const pruned = pruneProviderRuntimeStateV1({
      ...oneRowState,
      endpointHealth: [newerCanonicalFirst, olderCanonicalLast],
    }, {
      budget: {
        maxCatalogRecords: 2_048,
        maxCatalogModelIdentities: 50_000,
        maxModelLoadRecords: 50_000,
        maxEndpointRecords: 8_192,
        maxInstallationRecords: 4_096,
        maxEncodedBytes: budgetBytes,
      },
    });
    expect(pruned.endpointHealth.map((record) => record.key.endpointTemplateId)).toEqual(['a']);
  });

  it('measures the exact pretty JSON bytes emitted by the canonical atomic writer', () => {
    const endpoint = (id: string) => ProviderEndpointRuntimeStateRecordV1Schema.parse({
      key: {
        machineId: 'machine_a', connectionId: 'pc_a', endpointTemplateId: id,
        endpointFingerprint: `endpoint-observation:v1:${id}`,
        observationAuthorizationFingerprint: 'observation-authorization:v1:a',
      },
      state: { status: 'available' as const, activity: 'idle' as const, observedAt: 1 },
      lastAccessedAt: 1,
    });
    const oneRow = {
      v: 1 as const,
      machineId: 'machine_a',
      endpointHealth: [endpoint('a')],
      catalogs: [],
      installationChecks: [],
      modelLoadStates: [],
    };
    const twoRows = { ...oneRow, endpointHealth: [endpoint('a'), endpoint('b')] };
    const budgetBytes = Buffer.byteLength(JSON.stringify(twoRows), 'utf8');
    expect(Buffer.byteLength(JSON.stringify(oneRow, null, 2), 'utf8')).toBeLessThanOrEqual(budgetBytes);
    expect(Buffer.byteLength(JSON.stringify(twoRows, null, 2), 'utf8')).toBeGreaterThan(budgetBytes);

    const pruned = pruneProviderRuntimeStateV1(twoRows, {
      budget: {
        maxCatalogRecords: 2_048,
        maxCatalogModelIdentities: 50_000,
        maxModelLoadRecords: 50_000,
        maxEndpointRecords: 8_192,
        maxInstallationRecords: 4_096,
        maxEncodedBytes: budgetBytes,
      },
    });

    expect(pruned.endpointHealth).toHaveLength(1);
    expect(Buffer.byteLength(JSON.stringify(pruned, null, 2), 'utf8')).toBeLessThanOrEqual(budgetBytes);
  });
});
