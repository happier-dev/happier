import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PROVIDER_SETTINGS_V1,
  ProviderBoundModelRefSchema,
  ProviderCatalogRuntimeStateKeyV1Schema,
  ProviderCatalogRuntimeStateRecordV1Schema,
  ProviderConnectionIdSchema,
  ProviderContributionV1Schema,
  ProviderRuntimeStateFileV1Schema,
  ProviderSettingsV1Schema,
  serializeModelVisibilityRefV1,
  type ProviderCatalogRuntimeStateKeyV1,
  type ProviderCatalogRuntimeStateRecordV1,
  type ProviderEndpointRuntimeStateV1,
  type ProviderManualModelV1,
  type ProviderRuntimeStateFileV1,
  type ProviderSettingsV1,
} from '@happier-dev/protocol';

import type { ResolvedProviderConnectionRecord } from '../registry/types';
import type { ProviderCatalogCompatibilityPresentation } from './types';
import {
  assembleProviderConnectionCatalog,
  projectProviderCatalogPresentation,
  projectProviderCatalogForPicker,
  resolveProviderCatalogModelRef,
} from './index';

const currentCatalogKey: ProviderCatalogRuntimeStateKeyV1 = ProviderCatalogRuntimeStateKeyV1Schema.parse({
  machineId: 'machine_a',
  connectionId: 'pc_a',
  catalogFingerprint: 'catalog:v1:current',
  observationAuthorizationFingerprint: 'observation-authorization:v1:current',
});

function contribution(
  name = 'Gateway',
  membershipPolicy?: 'augment' | 'probe-authoritative',
) {
  return ProviderContributionV1Schema.parse({
    v: 1,
    id: 'gateway',
    name,
    kind: 'cloud',
    endpointTemplates: [{
      id: 'responses',
      protocol: 'openai-responses',
      baseUrl: 'https://gateway.example/v1',
      capabilities: {
        streaming: 'supported',
        toolRoundTrips: 'unknown',
        statefulResponses: 'supported',
        reasoningControls: 'unknown',
      },
    }],
    catalog: {
      source: 'static+probe',
      manualModelPolicy: 'allowed',
      ...(membershipPolicy ? { membershipPolicy } : {}),
      staticModels: [
        { id: 'default', name: 'Literal Default' },
        { id: 'Case', name: 'Static Case' },
      ],
      probes: [{ endpointTemplateId: 'responses', path: '/models', parser: 'openai-models' }],
    },
  });
}

function resolvedConnection(input: Readonly<{
  connectionId?: string;
  providerName?: string;
  connectionName?: string;
  membershipPolicy?: 'augment' | 'probe-authoritative';
}> = {}): ResolvedProviderConnectionRecord {
  const connectionId = ProviderConnectionIdSchema.parse(input.connectionId ?? 'pc_a');
  const definition = contribution(input.providerName, input.membershipPolicy);
  return {
    v: 1,
    connectionId,
    machineId: 'machine_a',
    connection: {
      v: 1,
      id: connectionId,
      source: { kind: 'contribution', contributionKey: 'acme.gateway/gateway' },
      role: 'default',
      displayName: input.connectionName ?? definition.name,
      displayNameMode: input.connectionName ? 'custom' : 'automatic',
      deployment: { kind: 'external' },
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
    },
    displayName: input.connectionName ?? definition.name,
    source: {
      kind: 'contribution',
      contributionKey: 'acme.gateway/gateway',
      pluginId: 'acme.gateway',
      provenance: 'external',
      definition,
    },
    deployment: { kind: 'external' },
    endpoints: [{
      endpointTemplateId: 'responses',
      protocol: 'openai-responses',
      publicHeaders: {},
      source: 'contribution',
      machineOverrideApplied: false,
      normalizedUrl: 'https://gateway.example/v1',
      locality: 'public',
      endpointScope: 'account',
      resolvedAddresses: [],
      nonPublicAddresses: [],
    }],
    scope: 'account',
    connectionSecurityFingerprint: 'connection-security:v1:a',
    endpointSetFingerprint: 'endpoint-set:v1:a',
    authorization: {
      authorized: true,
      grantKind: 'account',
      grantFingerprint: 'account-grant:v1:a',
      grantConfirmedAt: 1,
    },
  };
}

function managedResolvedConnection(): ResolvedProviderConnectionRecord {
  const external = resolvedConnection();
  return {
    ...external,
    connection: {
      ...external.connection,
      deployment: { kind: 'managedLocal' },
      purposeBindingDefaults: {
        upstream: {
          kind: 'account',
          account: {
            service: {
              pluginId: 'happier.connected-account.example',
              localId: 'example',
            },
            accountId: 'account-a',
          },
        },
      },
    },
    source: {
      kind: 'contribution',
      contributionKey: 'acme.gateway/gateway',
      pluginId: 'acme.gateway',
      provenance: 'first_party',
      definition: contribution(),
    },
    deployment: {
      kind: 'managedLocal',
      implementationIdentity: {
        pluginId: 'acme.gateway',
        localId: 'gateway',
      },
      managedRuntime: {
        kind: 'managed',
        dependencies: [],
        connectedAccounts: [{
          purpose: 'upstream',
          service: {
            pluginId: 'happier.connected-account.example',
            localId: 'example',
          },
          required: true,
          materializationKinds: ['httpHeaders'],
        }],
        requestAuthUses: [{
          purpose: 'upstream',
          materialization: {
            kind: 'httpHeaders',
            origin: 'https://api.example.test',
            headerNames: ['authorization'],
          },
        }],
        endpointTemplateIds: ['responses'],
      },
      purposeBindingIntents: {
        v: 1,
        bindings: [{
          purpose: {
            consumer: {
              pluginId: 'acme.gateway',
              localId: 'gateway',
            },
            purpose: 'upstream',
          },
          target: {
            kind: 'account',
            account: {
              service: {
                pluginId: 'happier.connected-account.example',
                localId: 'example',
              },
              accountId: 'account-a',
            },
          },
        }],
      },
    },
    endpoints: [],
    scope: 'machine',
  };
}

function catalogRecord(input: Readonly<{
  key?: ProviderCatalogRuntimeStateKeyV1;
  observationId?: string;
  models?: readonly Readonly<{ id: string; name?: string }>[];
  stale?: boolean;
  staleModels?: readonly Readonly<{ id: string; name?: string }>[];
}> = {}): ProviderCatalogRuntimeStateRecordV1 {
  const stale = input.stale ?? false;
  return ProviderCatalogRuntimeStateRecordV1Schema.parse({
    key: input.key ?? currentCatalogKey,
    state: {
      catalogObservationId: input.observationId ?? 'observation_current',
      snapshot: stale
        ? { models: [...(input.models ?? [])], observedAt: 10, stale: true, staleAt: 20 }
        : { models: [...(input.models ?? [])], observedAt: 10, stale: false },
      staleProbeModels: [...(input.staleModels ?? [])],
    },
    lastAccessedAt: 20,
  });
}

function runtimeState(input: Readonly<{
  catalogs?: readonly unknown[];
  loads?: readonly unknown[];
}> = {}): ProviderRuntimeStateFileV1 {
  return ProviderRuntimeStateFileV1Schema.parse({
    v: 1,
    machineId: 'machine_a',
    endpointHealth: [],
    catalogs: [...(input.catalogs ?? [])],
    installationChecks: [],
    modelLoadStates: [...(input.loads ?? [])],
  });
}

function settings(
  connection = resolvedConnection(),
  manualModels: readonly ProviderManualModelV1[] = [],
): ProviderSettingsV1 {
  return ProviderSettingsV1Schema.parse({
    ...DEFAULT_PROVIDER_SETTINGS_V1,
    connections: [connection.connection],
    manualModelsByConnectionId: manualModels.length === 0
      ? {}
      : { [connection.connectionId]: manualModels },
  });
}

const availableHealth: ProviderEndpointRuntimeStateV1 = {
  status: 'available',
  activity: 'idle',
  observedAt: 10,
};

const experimentalCompatibility: ProviderCatalogCompatibilityPresentation = {
  result: {
    status: 'experimental',
    selectedProtocol: 'openai-responses',
    reasons: ['compatibility_evidence_missing'],
    confirmationScope: { kind: 'connection' },
  },
  compatibilityFingerprint: 'compatibility:v1:a',
};

function compatibilityMap(modelIds: readonly string[]) {
  return new Map(modelIds.map((modelId) => [modelId, experimentalCompatibility] as const));
}

describe('provider catalog host assembly', () => {
  it('rejects duplicate load evidence while projecting the exact active catalog generation', () => {
    const record = catalogRecord({ models: [{ id: 'probe-current' }] });
    const duplicateLoad = {
      key: {
        machineId: 'machine_a',
        connectionId: ProviderConnectionIdSchema.parse('pc_a'),
        catalogObservationId: 'observation_current',
        modelId: 'probe-current',
      },
      loadState: 'loaded' as const,
      observedAt: 10,
      lastAccessedAt: 10,
    };

    expect(() => projectProviderCatalogPresentation({
      staticModels: [],
      manualModels: [],
      probeState: {
        snapshot: record.state.snapshot,
        staleProbeModels: record.state.staleProbeModels,
      },
      connectionId: 'pc_a',
      machineId: 'machine_a',
      catalogRecord: record,
      loadRecords: [duplicateLoad, duplicateLoad],
    })).toThrow('duplicate model-load evidence');
  });

  it('delegates precedence and ordering to the protocol owner while preserving exact model identity', () => {
    const connection = resolvedConnection();
    const assembled = assembleProviderConnectionCatalog({
      agentTargetKey: 'codex',
      connection,
      providerSettings: settings(connection, [
        { id: 'Case', name: 'Manual Case', addedAt: 2 },
        { id: 'org/model', name: 'Slash', addedAt: 1 },
      ]),
      runtimeState: runtimeState({
        catalogs: [catalogRecord({
          models: [
            { id: 'Case', name: 'Probe Case' },
            { id: 'case', name: 'Lower case' },
            { id: 'probe-only', name: 'Probe only' },
          ],
        })],
      }),
      catalogRuntimeKey: currentCatalogKey,
      compatibilityByModelId: new Map([['default', experimentalCompatibility]]),
      currentEndpointHealthByTemplateId: new Map([['responses', availableHealth]]),
    });

    expect(assembled.rows.map((row) => row.ref)).toEqual([
      { agentTargetKey: 'codex', providerConnectionId: 'pc_a', modelId: 'default' },
      { agentTargetKey: 'codex', providerConnectionId: 'pc_a', modelId: 'Case' },
      { agentTargetKey: 'codex', providerConnectionId: 'pc_a', modelId: 'org/model' },
      { agentTargetKey: 'codex', providerConnectionId: 'pc_a', modelId: 'case' },
      { agentTargetKey: 'codex', providerConnectionId: 'pc_a', modelId: 'probe-only' },
    ]);
    expect(assembled.rows[1]?.descriptor.name).toBe('Manual Case');
    expect(assembled.rows[1]?.sources).toEqual({ manual: true, static: true, probe: true });
    expect(assembled.rows[0]?.presentation).toEqual({
      compatibility: {
        result: expect.objectContaining({ status: 'experimental' }),
        compatibilityFingerprint: 'compatibility:v1:a',
      },
      endpointHealth: availableHealth,
      catalog: { stale: false, observedAt: 10 },
      loadState: 'unknown',
    });
  });

  it('forwards authoritative contribution membership into host catalog assembly', () => {
    const connection = resolvedConnection({ membershipPolicy: 'probe-authoritative' });
    const assembled = assembleProviderConnectionCatalog({
      agentTargetKey: 'codex',
      connection,
      providerSettings: settings(connection),
      runtimeState: runtimeState({
        catalogs: [catalogRecord({
          models: [{ id: 'Case', name: 'API Case' }],
        })],
      }),
      catalogRuntimeKey: currentCatalogKey,
    });

    expect(assembled.rows.map((row) => row.ref.modelId)).toEqual(['Case']);
    expect(assembled.rows[0]).toMatchObject({
      descriptor: { id: 'Case', name: 'Static Case' },
      sources: { manual: false, static: true, probe: true },
      confidence: 'probe',
    });
  });

  it('projects compatible managed rows without inventing endpoint health', () => {
    const connection = managedResolvedConnection();
    const assembled = assembleProviderConnectionCatalog({
      agentTargetKey: 'codex',
      connection,
      providerSettings: settings(connection),
      runtimeState: runtimeState(),
      catalogRuntimeKey: null,
      compatibilityByModelId: compatibilityMap(['default']),
      currentEndpointHealthByTemplateId: new Map(),
    });

    expect(
      assembled.rows.find((row) => row.ref.modelId === 'default')
        ?.presentation.endpointHealth,
    ).toBeNull();
  });

  it('selects only the exact authorization-bound catalog key and binds load state to its active generation', () => {
    const oldKey: ProviderCatalogRuntimeStateKeyV1 = ProviderCatalogRuntimeStateKeyV1Schema.parse({
      ...currentCatalogKey,
      observationAuthorizationFingerprint: 'observation-authorization:v1:old',
    });
    const connection = resolvedConnection();
    const assembled = assembleProviderConnectionCatalog({
      agentTargetKey: 'codex',
      connection,
      providerSettings: settings(connection),
      runtimeState: runtimeState({
        catalogs: [
          catalogRecord({
            key: oldKey,
            observationId: 'observation_old',
            models: [{ id: 'old-only' }, { id: 'current-only' }],
          }),
          catalogRecord({ models: [{ id: 'current-only' }], staleModels: [{ id: 'gone' }] }),
        ],
        loads: [
          {
            key: { machineId: 'machine_a', connectionId: 'pc_a', catalogObservationId: 'observation_old', modelId: 'current-only' },
            loadState: 'loaded', observedAt: 10, lastAccessedAt: 10,
          },
          {
            key: { machineId: 'machine_a', connectionId: 'pc_a', catalogObservationId: 'observation_current', modelId: 'current-only' },
            loadState: 'unloaded', observedAt: 10, lastAccessedAt: 10,
          },
        ],
      }),
      catalogRuntimeKey: currentCatalogKey,
    });

    expect(assembled.rows.some((row) => row.ref.modelId === 'old-only')).toBe(false);
    expect(assembled.rows.find((row) => row.ref.modelId === 'current-only')?.presentation.loadState).toBe('unloaded');
    expect(assembled.staleRows.find((row) => row.ref.modelId === 'gone')?.presentation.loadState).toBe('unknown');
  });

  it('does not resurrect an obsolete probe snapshot when there is no current authorized catalog key', () => {
    const connection = resolvedConnection();
    const assembled = assembleProviderConnectionCatalog({
      agentTargetKey: 'codex',
      connection,
      providerSettings: settings(connection),
      runtimeState: runtimeState({
        catalogs: [catalogRecord({ models: [{ id: 'obsolete-probe-row' }] })],
      }),
      catalogRuntimeKey: null,
    });

    expect(assembled.rows.map((row) => row.ref.modelId)).toEqual(['default', 'Case']);
  });

  it('projects every row from a stale active snapshot with unknown load state', () => {
    const connection = resolvedConnection();
    const assembled = assembleProviderConnectionCatalog({
      agentTargetKey: 'codex',
      connection,
      providerSettings: settings(connection),
      runtimeState: runtimeState({
        catalogs: [catalogRecord({ stale: true, models: [{ id: 'probe-stale' }] })],
        loads: [{
          key: {
            machineId: 'machine_a',
            connectionId: 'pc_a',
            catalogObservationId: 'observation_current',
            modelId: 'probe-stale',
          },
          loadState: 'unloaded',
          observedAt: 10,
          lastAccessedAt: 10,
        }],
      }),
      catalogRuntimeKey: currentCatalogKey,
      compatibilityByModelId: new Map([['probe-stale', experimentalCompatibility]]),
      currentEndpointHealthByTemplateId: new Map([['responses', availableHealth]]),
    });

    const row = assembled.rows.find((candidate) => candidate.ref.modelId === 'probe-stale');
    expect(row?.presentation.endpointHealth?.status).toBe('available');
    expect(row?.presentation.catalog).toEqual({ stale: true, observedAt: 10, staleAt: 20 });
    expect(assembled.rows.every(
      (candidate) => candidate.presentation.loadState === 'unknown',
    )).toBe(true);
  });

  it('keeps the same exact model id in two connections as two distinct refs', () => {
    const first = resolvedConnection({ connectionId: 'pc_a', connectionName: 'Work' });
    const second = resolvedConnection({ connectionId: 'pc_b', connectionName: 'Personal' });
    const firstCatalog = assembleProviderConnectionCatalog({
      agentTargetKey: 'codex', connection: first, providerSettings: settings(first),
      runtimeState: runtimeState({ catalogs: [catalogRecord({ models: [{ id: 'same' }] })] }),
      catalogRuntimeKey: currentCatalogKey,
      compatibilityByModelId: compatibilityMap(['default', 'Case', 'same']),
    });
    const secondKey = ProviderCatalogRuntimeStateKeyV1Schema.parse({
      ...currentCatalogKey,
      connectionId: 'pc_b',
    });
    const secondCatalog = assembleProviderConnectionCatalog({
      agentTargetKey: 'codex', connection: second, providerSettings: settings(second),
      runtimeState: {
        ...runtimeState({ catalogs: [catalogRecord({ key: secondKey, models: [{ id: 'same' }] })] }),
      },
      catalogRuntimeKey: secondKey,
      compatibilityByModelId: compatibilityMap(['default', 'Case', 'same']),
    });

    const projected = projectProviderCatalogForPicker({
      catalogs: [firstCatalog, secondCatalog],
      modelVisibilityByRef: {},
    });
    expect(projected.groups.flatMap((group) => group.rows).filter((row) => row.ref.modelId === 'same').map((row) => row.ref.providerConnectionId)).toEqual([
      'pc_b',
      'pc_a',
    ]);
  });

  it('honors the protocol maximum without adding a second host bound or sort', () => {
    const connection = resolvedConnection();
    const models = Array.from({ length: 4_998 }, (_, index) => ({ id: `model-${index}` }));
    const assembled = assembleProviderConnectionCatalog({
      agentTargetKey: 'codex', connection, providerSettings: settings(connection),
      runtimeState: runtimeState({ catalogs: [catalogRecord({ models })] }),
      catalogRuntimeKey: currentCatalogKey,
    });
    expect(assembled.rows).toHaveLength(5_000);

    const overLimitModels = Array.from({ length: 4_999 }, (_, index) => ({ id: `over-${index}` }));
    expect(() => assembleProviderConnectionCatalog({
      agentTargetKey: 'codex', connection, providerSettings: settings(connection),
      runtimeState: runtimeState({ catalogs: [catalogRecord({ models: overLimitModels })] }),
      catalogRuntimeKey: currentCatalogKey,
    })).toThrowError('Merged provider catalog exceeds the per-connection model limit');
  });
});

describe('provider catalog exact-reference and picker projection', () => {
  it('keeps visibility out of exact resolution while hiding normal rows and retaining the hidden current selection', () => {
    const connection = resolvedConnection();
    const assembled = assembleProviderConnectionCatalog({
      agentTargetKey: 'codex', connection, providerSettings: settings(connection),
      runtimeState: runtimeState({ catalogs: [catalogRecord({ models: [{ id: 'visible' }] })] }),
      catalogRuntimeKey: currentCatalogKey,
      compatibilityByModelId: compatibilityMap(['default', 'Case', 'visible']),
    });
    const hiddenConnectionId = ProviderConnectionIdSchema.parse('pc_a');
    const hiddenRef = ProviderBoundModelRefSchema.parse({
      agentTargetKey: 'codex', providerConnectionId: hiddenConnectionId, modelId: 'default',
    });
    const visibility = serializeModelVisibilityRefV1({
      scope: 'allAgents', providerConnectionId: hiddenConnectionId, modelId: 'default',
    });

    expect(resolveProviderCatalogModelRef({
      catalog: assembled,
      ref: hiddenRef,
      agentSupportsFreeformModelIds: false,
    }).status).toBe('listed');
    expect(projectProviderCatalogForPicker({
      catalogs: [assembled],
      modelVisibilityByRef: { [visibility]: 'hidden' },
    }).groups[0]?.rows.some((row) => row.ref.modelId === 'default')).toBe(false);
    const withCurrent = projectProviderCatalogForPicker({
      catalogs: [assembled],
      modelVisibilityByRef: { [visibility]: 'hidden' },
      currentSelection: hiddenRef,
    });
    expect(withCurrent.groups[0]?.rows.find((row) => row.ref.modelId === 'default')?.visibility).toBe('hidden_current_selection');
    const management = projectProviderCatalogForPicker({
      catalogs: [assembled],
      modelVisibilityByRef: { [visibility]: 'hidden' },
      mode: 'management',
    });
    expect(management.groups[0]?.rows.find((row) => row.ref.modelId === 'default')?.visibility).toBe('hidden_all_agents');
  });

  it('fails closed on unavailable picker bindings while retaining only the exact current row for recovery', () => {
    const connection = resolvedConnection();
    const assembled = assembleProviderConnectionCatalog({
      agentTargetKey: 'codex', connection, providerSettings: settings(connection),
      runtimeState: runtimeState(), catalogRuntimeKey: null,
      compatibilityByModelId: compatibilityMap(['default', 'Case']),
    });
    const unavailable: typeof assembled = {
      ...assembled,
      authorization: { authorized: false, errorCode: 'provider_connection_disabled' },
    };
    expect(projectProviderCatalogForPicker({
      catalogs: [unavailable], modelVisibilityByRef: {},
    }).groups).toEqual([]);

    const incompatible: typeof assembled = {
      ...assembled,
      rows: assembled.rows.map((row) => ({
        ...row,
        presentation: {
          ...row.presentation,
          compatibility: {
            result: { status: 'incompatible', reasons: ['no_compatible_protocol'] },
            compatibilityFingerprint: 'compatibility:v1:incompatible',
          },
        },
      })),
    };
    expect(projectProviderCatalogForPicker({
      catalogs: [incompatible], modelVisibilityByRef: {},
    }).groups).toEqual([]);

    const currentSelection = assembled.rows[0]!.ref;
    const recovery = projectProviderCatalogForPicker({
      catalogs: [unavailable], modelVisibilityByRef: {}, currentSelection,
    });
    expect(recovery.groups[0]?.rows.map((row) => row.ref)).toEqual([currentSelection]);
    expect(recovery.groups[0]?.authorization).toEqual({
      authorized: false,
      errorCode: 'provider_connection_disabled',
    });
  });

  it('retains an authorized freeform current selection the catalog never listed', () => {
    const connection = resolvedConnection();
    const freeformRef = ProviderBoundModelRefSchema.parse({
      agentTargetKey: 'codex', providerConnectionId: 'pc_a', modelId: 'vendor/never-listed',
    });
    const assemble = (agentSupportsFreeformModelIds: boolean) => assembleProviderConnectionCatalog({
      agentTargetKey: 'codex', connection, providerSettings: settings(connection),
      runtimeState: runtimeState({ catalogs: [catalogRecord({ models: [{ id: 'probe-current' }] })] }),
      catalogRuntimeKey: currentCatalogKey,
      compatibilityByModelId: compatibilityMap(['default', 'Case', 'probe-current', 'vendor/never-listed']),
      currentSelectionForRecovery: freeformRef,
      agentSupportsFreeformModelIds,
    });

    // The canonical reference resolver, not catalog membership, decides whether a
    // Provider model id is real when both sides permit freeform ids.
    const withoutRecovery = assembleProviderConnectionCatalog({
      agentTargetKey: 'codex', connection, providerSettings: settings(connection),
      runtimeState: runtimeState({ catalogs: [catalogRecord({ models: [{ id: 'probe-current' }] })] }),
      catalogRuntimeKey: currentCatalogKey,
      compatibilityByModelId: compatibilityMap(['default', 'Case', 'probe-current']),
    });
    expect(resolveProviderCatalogModelRef({
      catalog: withoutRecovery, ref: freeformRef, agentSupportsFreeformModelIds: true,
    })).toMatchObject({ status: 'not_currently_listed', provenance: 'model_id' });
    expect(resolveProviderCatalogModelRef({
      catalog: withoutRecovery, ref: freeformRef, agentSupportsFreeformModelIds: false,
    })).toMatchObject({ status: 'not_found', errorCode: 'provider_model_not_found' });

    const permitted = assemble(true);
    expect(projectProviderCatalogForPicker({
      catalogs: [permitted], modelVisibilityByRef: {}, currentSelection: freeformRef,
    }).groups[0]?.rows.map((row) => row.ref.modelId)).toContain('vendor/never-listed');

    // Two-sided policy: an Agent that rejects freeform ids gets no phantom row.
    const refused = assemble(false);
    expect(projectProviderCatalogForPicker({
      catalogs: [refused], modelVisibilityByRef: {}, currentSelection: freeformRef,
    }).groups[0]?.rows.map((row) => row.ref.modelId)).not.toContain('vendor/never-listed');
  });

  it('renders stale and fully pruned refs only under the two-sided freeform policy', () => {
    const connection = resolvedConnection();
    const assembled = assembleProviderConnectionCatalog({
      agentTargetKey: 'codex', connection, providerSettings: settings(connection),
      runtimeState: runtimeState({ catalogs: [catalogRecord({ staleModels: [{ id: 'gone', name: 'Gone model' }] })] }),
      catalogRuntimeKey: currentCatalogKey,
    });
    const goneRef = ProviderBoundModelRefSchema.parse({
      agentTargetKey: 'codex', providerConnectionId: 'pc_a', modelId: 'gone',
    });
    const prunedRef = ProviderBoundModelRefSchema.parse({
      agentTargetKey: 'codex', providerConnectionId: 'pc_a', modelId: 'pruned/model',
    });

    expect(resolveProviderCatalogModelRef({
      catalog: assembled, ref: goneRef, agentSupportsFreeformModelIds: true,
    })).toMatchObject({ status: 'not_currently_listed', provenance: 'stale_catalog', descriptor: { name: 'Gone model' } });
    expect(resolveProviderCatalogModelRef({
      catalog: assembled, ref: prunedRef, agentSupportsFreeformModelIds: true,
      displaySnapshot: { name: 'Remembered name' },
    })).toMatchObject({ status: 'not_currently_listed', provenance: 'display_snapshot', descriptor: { name: 'Remembered name' } });
    expect(resolveProviderCatalogModelRef({
      catalog: assembled, ref: prunedRef, agentSupportsFreeformModelIds: false,
    })).toEqual({ status: 'not_found', ref: prunedRef, errorCode: 'provider_model_not_found' });

    const catalogOnly: typeof assembled = { ...assembled, manualModelPolicy: 'catalog-only' };
    expect(resolveProviderCatalogModelRef({
      catalog: catalogOnly, ref: prunedRef, agentSupportsFreeformModelIds: true,
    })).toEqual({ status: 'not_found', ref: prunedRef, errorCode: 'provider_model_not_found' });
  });

  it('preserves exact default, slash, and case-sensitive ids through projection and resolution', () => {
    const connection = resolvedConnection();
    const assembled = assembleProviderConnectionCatalog({
      agentTargetKey: 'codex', connection,
      providerSettings: settings(connection, [{ id: 'org/Model', addedAt: 1 }]),
      runtimeState: runtimeState(),
      catalogRuntimeKey: currentCatalogKey,
      compatibilityByModelId: compatibilityMap(['default', 'Case', 'org/Model']),
    });
    const ids = projectProviderCatalogForPicker({ catalogs: [assembled], modelVisibilityByRef: {} })
      .groups.flatMap((group) => group.rows.map((row) => row.ref.modelId));
    expect(ids).toEqual(['default', 'Case', 'org/Model']);
    expect(ids).not.toContain('org/model');
  });
});
