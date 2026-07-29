import {
  ProviderAgentTargetKeySchema,
  type CustomProviderTemplateV1,
  ProviderEndpointRuntimeStateV1Schema,
  mergeProviderCatalogV1,
  readOwnRecordValue,
  serializeProviderCatalogRuntimeStateKeyV1,
  type ProviderCatalogDeclarationV1,
  type ProviderCatalogTransitionStateV1,
  type ProviderCatalogRuntimeStateRecordV1,
  type ProviderMergedCatalogRowV1,
  type ProviderModelLoadRuntimeStateRecordV1,
} from '@happier-dev/protocol';

import type {
  AssembleProviderConnectionCatalogInput,
  ProviderCatalogObservationPresentation,
  ProviderCatalogRowPresentation,
  ProviderConnectionCatalog,
  ProviderConnectionCatalogRow,
} from './types';

const EMPTY_PROBE_STATE: ProviderCatalogTransitionStateV1 = {
  snapshot: null,
  staleProbeModels: [],
};

function catalogDeclaration(
  connection: AssembleProviderConnectionCatalogInput['connection'],
): ProviderCatalogDeclarationV1 | CustomProviderTemplateV1['catalog'] {
  return connection.source.kind === 'contribution'
    ? connection.source.definition.catalog
    : connection.source.template.catalog;
}

function staticModels(catalog: ReturnType<typeof catalogDeclaration>) {
  return 'staticModels' in catalog ? catalog.staticModels : [];
}

function providerName(connection: AssembleProviderConnectionCatalogInput['connection']): string {
  return connection.source.kind === 'contribution'
    ? connection.source.definition.name
    : connection.source.template.name;
}

function exactCatalogRecord(
  input: AssembleProviderConnectionCatalogInput,
): ProviderCatalogRuntimeStateRecordV1 | null {
  if (input.runtimeState.machineId !== input.connection.machineId) {
    throw new TypeError('Provider catalog runtime state belongs to another machine');
  }
  if (input.catalogRuntimeKey === null) return null;
  if (input.catalogRuntimeKey.machineId !== input.connection.machineId
    || input.catalogRuntimeKey.connectionId !== input.connection.connectionId) {
    throw new TypeError('Provider catalog runtime key does not belong to the resolved connection');
  }
  const key = serializeProviderCatalogRuntimeStateKeyV1(input.catalogRuntimeKey);
  const matches = input.runtimeState.catalogs.filter(
    (record) => serializeProviderCatalogRuntimeStateKeyV1(record.key) === key,
  );
  if (matches.length > 1) {
    throw new TypeError('Provider runtime state contains duplicate exact catalog keys');
  }
  return matches[0] ?? null;
}

function loadStatesForActiveGeneration(input: Readonly<{
  connectionId: string;
  machineId: string;
  record: ProviderCatalogRuntimeStateRecordV1 | null;
  loadRecords: readonly ProviderModelLoadRuntimeStateRecordV1[];
}>): ReadonlyMap<string, ProviderModelLoadRuntimeStateRecordV1['loadState']> {
  if (!input.record || !('catalogObservationId' in input.record.state)) return new Map();
  const observationId = input.record.state.catalogObservationId;
  const result = new Map<string, ProviderModelLoadRuntimeStateRecordV1['loadState']>();
  for (const record of input.loadRecords) {
    if (record.key.machineId !== input.machineId
      || record.key.connectionId !== input.connectionId
      || record.key.catalogObservationId !== observationId) continue;
    if (result.has(record.key.modelId)) {
      throw new TypeError('Provider runtime state contains duplicate model-load evidence');
    }
    result.set(record.key.modelId, record.loadState);
  }
  return result;
}

function catalogPresentation(
  record: ProviderCatalogRuntimeStateRecordV1 | null,
  staleRow: boolean,
): ProviderCatalogObservationPresentation {
  const snapshot = record?.state.snapshot ?? null;
  if (staleRow) return { stale: true };
  if (!snapshot) return { stale: false };
  return snapshot.stale
    ? { stale: true, observedAt: snapshot.observedAt, staleAt: snapshot.staleAt }
    : { stale: false, observedAt: snapshot.observedAt };
}

type ProviderCatalogMergeInput = Parameters<typeof mergeProviderCatalogV1>[0];

export type ProjectedProviderCatalogPresentationRow = Readonly<{
  row: ProviderMergedCatalogRowV1;
  catalog: ProviderCatalogObservationPresentation;
  loadState: ProviderModelLoadRuntimeStateRecordV1['loadState'];
}>;

/**
 * Canonical host presentation over the protocol-owned catalog merge. It owns
 * active-generation load evidence and stale-row presentation, while callers
 * remain free to project their distinct RPC or Agent-facing row shapes.
 */
export function projectProviderCatalogPresentation(input: Readonly<{
  staticModels: ProviderCatalogMergeInput['staticModels'];
  manualModels: ProviderCatalogMergeInput['manualModels'];
  probeState: ProviderCatalogMergeInput['probeState'];
  connectionId: string;
  machineId: string;
  catalogRecord: ProviderCatalogRuntimeStateRecordV1 | null;
  loadRecords: readonly ProviderModelLoadRuntimeStateRecordV1[];
  probeConfidence?: 'probe' | 'account_unverified';
}>): Readonly<{
  rows: readonly ProjectedProviderCatalogPresentationRow[];
  staleRows: readonly ProjectedProviderCatalogPresentationRow[];
}> {
  const merged = mergeProviderCatalogV1({
    staticModels: input.staticModels,
    manualModels: input.manualModels,
    probeState: input.probeState,
    ...(input.probeConfidence ? { probeConfidence: input.probeConfidence } : {}),
  });
  const loadStates = loadStatesForActiveGeneration({
    connectionId: input.connectionId,
    machineId: input.machineId,
    record: input.catalogRecord,
    loadRecords: input.loadRecords,
  });
  const loadEvidenceIsCurrent =
    input.catalogRecord?.state.snapshot?.stale === false;
  const bind = (
    row: ProviderMergedCatalogRowV1,
    staleRow: boolean,
  ): ProjectedProviderCatalogPresentationRow => ({
    row,
    catalog: catalogPresentation(input.catalogRecord, staleRow),
    loadState: staleRow || !loadEvidenceIsCurrent
      ? 'unknown'
      : loadStates.get(row.descriptor.id) ?? 'unknown',
  });
  return {
    rows: merged.rows.map((row) => bind(row, false)),
    staleRows: merged.staleRows.map((row) => bind(row, true)),
  };
}

function endpointHealthForRow(
  input: AssembleProviderConnectionCatalogInput,
  modelId: string,
) {
  if (input.connection.deployment.kind === 'managedLocal') return null;
  const compatibility = input.compatibilityByModelId?.get(modelId) ?? null;
  if (!compatibility) return null;
  const result = compatibility.result;
  if (result.status === 'incompatible') return null;
  const endpoint = input.connection.endpoints.find(
    (candidate) => candidate.protocol === result.selectedProtocol,
  );
  if (!endpoint) {
    throw new TypeError('Compatibility selected a protocol absent from the resolved connection');
  }
  const state = input.currentEndpointHealthByTemplateId?.get(endpoint.endpointTemplateId);
  return state === undefined ? null : ProviderEndpointRuntimeStateV1Schema.parse(state);
}

function bindRow(input: Readonly<{
  hostInput: AssembleProviderConnectionCatalogInput;
  agentTargetKey: string;
  merged: ProviderMergedCatalogRowV1;
  catalog: ProviderCatalogObservationPresentation;
  loadState: ProviderModelLoadRuntimeStateRecordV1['loadState'];
}>): ProviderConnectionCatalogRow {
  const modelId = input.merged.descriptor.id;
  const compatibility = input.hostInput.compatibilityByModelId?.get(modelId) ?? null;
  const presentation: ProviderCatalogRowPresentation = {
    compatibility,
    endpointHealth: endpointHealthForRow(input.hostInput, modelId),
    catalog: input.catalog,
    loadState: input.loadState,
  };
  return {
    ref: {
      agentTargetKey: input.agentTargetKey,
      providerConnectionId: input.hostInput.connection.connectionId,
      modelId,
    },
    descriptor: input.merged.descriptor,
    sources: input.merged.sources,
    confidence: input.merged.confidence,
    presentation,
  };
}

export function assembleProviderConnectionCatalog(
  input: AssembleProviderConnectionCatalogInput,
): ProviderConnectionCatalog {
  const catalog = catalogDeclaration(input.connection);
  const agentTargetKey = ProviderAgentTargetKeySchema.parse(input.agentTargetKey);
  const catalogRecord = exactCatalogRecord(input);
  const manualModels = readOwnRecordValue(
    input.providerSettings.manualModelsByConnectionId,
    input.connection.connectionId,
  ) ?? [];
  const probeState = catalogRecord === null
    ? EMPTY_PROBE_STATE
    : {
      snapshot: catalogRecord.state.snapshot,
      staleProbeModels: catalogRecord.state.staleProbeModels,
    };

  const projected = projectProviderCatalogPresentation({
    staticModels: staticModels(catalog),
    manualModels,
    probeState,
    connectionId: input.connection.connectionId,
    machineId: input.connection.machineId,
    catalogRecord,
    loadRecords: input.runtimeState.modelLoadStates,
    probeConfidence: input.connection.deployment.kind === 'managedLocal'
      ? 'account_unverified'
      : 'probe',
  });
  const bind = (row: ProjectedProviderCatalogPresentationRow) => bindRow({
    hostInput: input,
    agentTargetKey,
    merged: row.row,
    catalog: row.catalog,
    loadState: row.loadState,
  });
  const currentSelection = input.currentSelectionForRecovery;
  const retainProbeSelection = !input.connection.authorization.authorized
    && 'probes' in catalog
    && currentSelection?.agentTargetKey === agentTargetKey
    && currentSelection.providerConnectionId === input.connection.connectionId
    && !projected.rows.some((row) => row.row.descriptor.id === currentSelection.modelId)
    && !projected.staleRows.some((row) => row.row.descriptor.id === currentSelection.modelId);
  const recoveryRows: readonly ProjectedProviderCatalogPresentationRow[] = retainProbeSelection
    ? [{
        row: {
          descriptor: { id: currentSelection.modelId, name: currentSelection.modelId },
          sources: { manual: false, static: false, probe: true },
          confidence: input.connection.deployment.kind === 'managedLocal'
            ? 'account_unverified'
            : 'probe',
          catalogStale: true,
          stale: true,
        },
        catalog: { stale: true },
        loadState: 'unknown',
      }]
    : [];

  return {
    agentTargetKey,
    connectionId: input.connection.connectionId,
    authorization: input.connection.authorization.authorized
      ? { authorized: true }
      : input.connection.authorization,
    providerName: providerName(input.connection),
    connectionName: input.connection.displayName,
    connectionRole: input.connection.connection.role,
    connectionDisplayNameMode: input.connection.connection.displayNameMode,
    manualModelPolicy: catalog.manualModelPolicy,
    rows: projected.rows.map(bind),
    staleRows: [...projected.staleRows, ...recoveryRows].map(bind),
  };
}
