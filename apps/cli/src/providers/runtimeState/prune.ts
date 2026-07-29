import {
  PROVIDER_RUNTIME_STATE_LIMITS_V1,
  ProviderCatalogRuntimeStateRecordV1Schema,
  ProviderEndpointRuntimeStateRecordV1Schema,
  ProviderInstallationRuntimeStateRecordV1Schema,
  ProviderModelLoadRuntimeStateRecordV1Schema,
  ProviderRuntimeStateFileV1Schema,
  serializeProviderCatalogRuntimeStateKeyV1,
  serializeProviderEndpointRuntimeStateKeyV1,
  serializeProviderInstallationRuntimeStateKeyV1,
  serializeProviderModelLoadRuntimeStateKeyV1,
  type ProviderCatalogRuntimeStateKeyV1,
  type ProviderRuntimeStateFileV1,
} from '@happier-dev/protocol';

export type ProviderCatalogObservationReferenceV1 = Readonly<{
  machineId: string;
  connectionId: string;
  catalogObservationId: string;
}>;

export type ProviderRuntimeStatePruneBudget = Readonly<{
  maxEndpointRecords: number;
  maxCatalogRecords: number;
  maxInstallationRecords: number;
  maxCatalogModelIdentities: number;
  maxModelLoadRecords: number;
  maxEncodedBytes: number;
}>;

export type ProviderRuntimeStatePruneContext = Readonly<{
  currentCatalogKeys?: readonly ProviderCatalogRuntimeStateKeyV1[];
  grantedConnectionIds?: readonly string[];
  referencedCatalogObservations?: readonly ProviderCatalogObservationReferenceV1[];
  budget?: ProviderRuntimeStatePruneBudget;
}>;

export class ProviderRuntimeStatePruneError extends Error {
  readonly code = 'provider_runtime_state_limit_exceeded';
  constructor(message: string) {
    super(message);
    this.name = 'ProviderRuntimeStatePruneError';
  }
}

const DEFAULT_BUDGET: ProviderRuntimeStatePruneBudget = {
  maxEndpointRecords: PROVIDER_RUNTIME_STATE_LIMITS_V1.maxEndpointRecords,
  maxCatalogRecords: PROVIDER_RUNTIME_STATE_LIMITS_V1.maxCatalogRecords,
  maxInstallationRecords: PROVIDER_RUNTIME_STATE_LIMITS_V1.maxInstallationRecords,
  maxCatalogModelIdentities: PROVIDER_RUNTIME_STATE_LIMITS_V1.maxCatalogModelIdentities,
  maxModelLoadRecords: PROVIDER_RUNTIME_STATE_LIMITS_V1.maxModelLoadRecords,
  maxEncodedBytes: PROVIDER_RUNTIME_STATE_LIMITS_V1.maxEncodedBytes,
};

function observationKey(input: ProviderCatalogObservationReferenceV1): string {
  return JSON.stringify([input.machineId, input.connectionId, input.catalogObservationId]);
}

function catalogObservationKey(record: ProviderRuntimeStateFileV1['catalogs'][number]): string | null {
  if (!('catalogObservationId' in record.state)) return null;
  return observationKey({
    machineId: record.key.machineId,
    connectionId: record.key.connectionId,
    catalogObservationId: record.state.catalogObservationId,
  });
}

function observedAt(record: ProviderRuntimeStateFileV1['catalogs'][number]): number {
  return record.state.snapshot?.observedAt ?? 0;
}

function encodedBytes(value: unknown): number {
  // Keep this byte owner identical to `writeJsonAtomic`, which persists
  // human-readable JSON with two-space indentation. Measuring compact JSON
  // can otherwise admit a state that the next startup rejects from stat.
  return Buffer.byteLength(JSON.stringify(value, null, 2), 'utf8');
}

function compareCanonicalStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareEndpointLru(
  left: ProviderRuntimeStateFileV1['endpointHealth'][number],
  right: ProviderRuntimeStateFileV1['endpointHealth'][number],
): number {
  return left.lastAccessedAt - right.lastAccessedAt
    || ('observedAt' in left.state ? left.state.observedAt : 0)
      - ('observedAt' in right.state ? right.state.observedAt : 0)
    || compareCanonicalStrings(
      serializeProviderEndpointRuntimeStateKeyV1(left.key),
      serializeProviderEndpointRuntimeStateKeyV1(right.key),
    );
}

function compareInstallationLru(
  left: ProviderRuntimeStateFileV1['installationChecks'][number],
  right: ProviderRuntimeStateFileV1['installationChecks'][number],
): number {
  return left.lastAccessedAt - right.lastAccessedAt
    || left.state.observedAt - right.state.observedAt
    || compareCanonicalStrings(
      serializeProviderInstallationRuntimeStateKeyV1(left.key),
      serializeProviderInstallationRuntimeStateKeyV1(right.key),
    );
}

function catalogIdentityCount(state: ProviderRuntimeStateFileV1): number {
  return state.catalogs.reduce((total, record) => {
    if (!record.state.snapshot) return total;
    return total + new Set([
      ...record.state.snapshot.models.map((model) => model.id),
      ...record.state.staleProbeModels.map((model) => model.id),
    ]).size;
  }, 0);
}

function assertPositiveBudget(budget: ProviderRuntimeStatePruneBudget): void {
  for (const [name, value] of Object.entries(budget)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`Invalid provider runtime-state prune budget: ${name}`);
    }
  }
}

function assertPrunableState(input: ProviderRuntimeStateFileV1): void {
  const rawArrayLimits = [
    ['endpointHealth', input.endpointHealth, PROVIDER_RUNTIME_STATE_LIMITS_V1.maxEndpointRecords],
    ['catalogs', input.catalogs, PROVIDER_RUNTIME_STATE_LIMITS_V1.maxCatalogRecords],
    ['installationChecks', input.installationChecks, PROVIDER_RUNTIME_STATE_LIMITS_V1.maxInstallationRecords],
    ['modelLoadStates', input.modelLoadStates, PROVIDER_RUNTIME_STATE_LIMITS_V1.maxModelLoadRecords],
  ] as const;
  for (const [name, records, limit] of rawArrayLimits) {
    if (!Array.isArray(records) || records.length > limit) {
      throw new TypeError(`Provider runtime-state ${name} exceeds its raw record limit`);
    }
  }
  input.endpointHealth.forEach((record) => ProviderEndpointRuntimeStateRecordV1Schema.parse(record));
  input.catalogs.forEach((record) => ProviderCatalogRuntimeStateRecordV1Schema.parse(record));
  input.installationChecks.forEach((record) => ProviderInstallationRuntimeStateRecordV1Schema.parse(record));
  input.modelLoadStates.forEach((record) => ProviderModelLoadRuntimeStateRecordV1Schema.parse(record));
  const machineIds = [
    ...input.endpointHealth.map((record) => record.key.machineId),
    ...input.catalogs.map((record) => record.key.machineId),
    ...input.installationChecks.map((record) => record.key.machineId),
    ...input.modelLoadStates.map((record) => record.key.machineId),
  ];
  if (machineIds.some((machineId) => machineId !== input.machineId)) {
    throw new TypeError('Provider runtime-state pruning cannot repair cross-machine state');
  }
  const families = [
    input.endpointHealth.map((record) => serializeProviderEndpointRuntimeStateKeyV1(record.key)),
    input.catalogs.map((record) => serializeProviderCatalogRuntimeStateKeyV1(record.key)),
    input.installationChecks.map((record) => serializeProviderInstallationRuntimeStateKeyV1(record.key)),
    input.modelLoadStates.map((record) => serializeProviderModelLoadRuntimeStateKeyV1(record.key)),
  ];
  if (families.some((keys) => new Set(keys).size !== keys.length)) {
    throw new TypeError('Provider runtime-state pruning cannot repair duplicate semantic keys');
  }
  const generations = input.catalogs.flatMap((record) => {
    const key = catalogObservationKey(record);
    return key === null ? [] : [key];
  });
  if (new Set(generations).size !== generations.length) {
    throw new TypeError('Provider runtime-state pruning cannot repair ambiguous catalog generations');
  }
}

function removeOrphanLoads(state: ProviderRuntimeStateFileV1): ProviderRuntimeStateFileV1 {
  const modelsByGeneration = new Map<string, ReadonlySet<string>>();
  state.catalogs.forEach((record) => {
    const key = catalogObservationKey(record);
    if (key === null || !record.state.snapshot) return;
    modelsByGeneration.set(key, new Set(record.state.snapshot.models.map((model) => model.id)));
  });
  return {
    ...state,
    modelLoadStates: state.modelLoadStates.filter((record) => {
      const key = observationKey(record.key);
      return modelsByGeneration.get(key)?.has(record.key.modelId) === true;
    }),
  };
}

function removeCatalogs(
  state: ProviderRuntimeStateFileV1,
  removeKeys: ReadonlySet<string>,
): ProviderRuntimeStateFileV1 {
  if (removeKeys.size === 0) return state;
  const catalogs = state.catalogs.filter((record) =>
    !removeKeys.has(serializeProviderCatalogRuntimeStateKeyV1(record.key)));
  return removeOrphanLoads({ ...state, catalogs });
}

function catalogStructuralBudgetExceeded(
  state: ProviderRuntimeStateFileV1,
  budget: ProviderRuntimeStatePruneBudget,
): boolean {
  return state.catalogs.length > budget.maxCatalogRecords
    || catalogIdentityCount(state) > budget.maxCatalogModelIdentities
    || state.modelLoadStates.length > budget.maxModelLoadRecords;
}

function removeSmallestCatalogPrefixToFitBytes(
  state: ProviderRuntimeStateFileV1,
  removalOrder: readonly ProviderRuntimeStateFileV1['catalogs'][number][],
  maxEncodedBytes: number,
): ProviderRuntimeStateFileV1 {
  if (encodedBytes(state) <= maxEncodedBytes || removalOrder.length === 0) return state;
  let low = 1;
  let high = removalOrder.length;
  let best = removalOrder.length;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = removeCatalogs(state, new Set(removalOrder.slice(0, middle)
      .map((record) => serializeProviderCatalogRuntimeStateKeyV1(record.key))));
    if (encodedBytes(candidate) <= maxEncodedBytes) {
      best = middle;
      high = middle - 1;
    } else {
      low = middle + 1;
    }
  }
  return removeCatalogs(state, new Set(removalOrder.slice(0, best)
    .map((record) => serializeProviderCatalogRuntimeStateKeyV1(record.key))));
}

function removeSmallestEndpointPrefixToFitBytes(
  state: ProviderRuntimeStateFileV1,
  removalOrder: readonly ProviderRuntimeStateFileV1['endpointHealth'][number][],
  maxEncodedBytes: number,
): ProviderRuntimeStateFileV1 {
  if (encodedBytes(state) <= maxEncodedBytes || removalOrder.length === 0) return state;
  let low = 1;
  let high = removalOrder.length;
  let best = removalOrder.length;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const remove = new Set(removalOrder.slice(0, middle)
      .map((record) => serializeProviderEndpointRuntimeStateKeyV1(record.key)));
    const candidate = {
      ...state,
      endpointHealth: state.endpointHealth.filter((record) =>
        !remove.has(serializeProviderEndpointRuntimeStateKeyV1(record.key))),
    };
    if (encodedBytes(candidate) <= maxEncodedBytes) {
      best = middle;
      high = middle - 1;
    } else {
      low = middle + 1;
    }
  }
  const remove = new Set(removalOrder.slice(0, best)
    .map((record) => serializeProviderEndpointRuntimeStateKeyV1(record.key)));
  return {
    ...state,
    endpointHealth: state.endpointHealth.filter((record) =>
      !remove.has(serializeProviderEndpointRuntimeStateKeyV1(record.key))),
  };
}

function removeSmallestInstallationPrefixToFitBytes(
  state: ProviderRuntimeStateFileV1,
  removalOrder: readonly ProviderRuntimeStateFileV1['installationChecks'][number][],
  maxEncodedBytes: number,
): ProviderRuntimeStateFileV1 {
  if (encodedBytes(state) <= maxEncodedBytes || removalOrder.length === 0) return state;
  let low = 1;
  let high = removalOrder.length;
  let best = removalOrder.length;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const remove = new Set(removalOrder.slice(0, middle)
      .map((record) => serializeProviderInstallationRuntimeStateKeyV1(record.key)));
    const candidate = {
      ...state,
      installationChecks: state.installationChecks.filter((record) =>
        !remove.has(serializeProviderInstallationRuntimeStateKeyV1(record.key))),
    };
    if (encodedBytes(candidate) <= maxEncodedBytes) {
      best = middle;
      high = middle - 1;
    } else {
      low = middle + 1;
    }
  }
  const remove = new Set(removalOrder.slice(0, best)
    .map((record) => serializeProviderInstallationRuntimeStateKeyV1(record.key)));
  return {
    ...state,
    installationChecks: state.installationChecks.filter((record) =>
      !remove.has(serializeProviderInstallationRuntimeStateKeyV1(record.key))),
  };
}

export function pruneProviderRuntimeStateV1(
  input: ProviderRuntimeStateFileV1,
  context: ProviderRuntimeStatePruneContext = {},
): ProviderRuntimeStateFileV1 {
  assertPrunableState(input);
  const budget = context.budget ?? DEFAULT_BUDGET;
  assertPositiveBudget(budget);
  let state = removeOrphanLoads({
    ...input,
    endpointHealth: [...input.endpointHealth],
    catalogs: [...input.catalogs],
    installationChecks: [...input.installationChecks],
    modelLoadStates: [...input.modelLoadStates],
  });

  const currentCatalogKeys = new Set((context.currentCatalogKeys ?? [])
    .map((key) => serializeProviderCatalogRuntimeStateKeyV1(key)));
  const currentConnections = new Set((context.currentCatalogKeys ?? []).map((key) => key.connectionId));
  state = removeCatalogs(state, new Set(state.catalogs.flatMap((record) => {
    const key = serializeProviderCatalogRuntimeStateKeyV1(record.key);
    return currentConnections.has(record.key.connectionId) && !currentCatalogKeys.has(key) ? [key] : [];
  })));

  if (context.grantedConnectionIds !== undefined) {
    const granted = new Set(context.grantedConnectionIds);
    state = removeCatalogs(state, new Set(state.catalogs.flatMap((record) =>
      granted.has(record.key.connectionId) ? [] : [serializeProviderCatalogRuntimeStateKeyV1(record.key)])));
  }

  const referenced = new Set((context.referencedCatalogObservations ?? []).map(observationKey));
  const removalOrder = [...state.catalogs].sort((left, right) => {
    const leftReferenced = catalogObservationKey(left);
    const rightReferenced = catalogObservationKey(right);
    const referenceRank = Number(leftReferenced !== null && referenced.has(leftReferenced))
      - Number(rightReferenced !== null && referenced.has(rightReferenced));
    if (referenceRank !== 0) return referenceRank;
    return left.lastAccessedAt - right.lastAccessedAt
      || observedAt(left) - observedAt(right)
      || compareCanonicalStrings(
        serializeProviderCatalogRuntimeStateKeyV1(left.key),
        serializeProviderCatalogRuntimeStateKeyV1(right.key),
      );
  });
  if (catalogStructuralBudgetExceeded(state, budget)) {
    const loadCountByGeneration = new Map<string, number>();
    state.modelLoadStates.forEach((record) => {
      const key = observationKey(record.key);
      loadCountByGeneration.set(key, (loadCountByGeneration.get(key) ?? 0) + 1);
    });
    let catalogCount = state.catalogs.length;
    let identityCount = catalogIdentityCount(state);
    let loadCount = state.modelLoadStates.length;
    let removeCount = 0;
    for (const record of removalOrder) {
      if (catalogCount <= budget.maxCatalogRecords
        && identityCount <= budget.maxCatalogModelIdentities
        && loadCount <= budget.maxModelLoadRecords) break;
      catalogCount -= 1;
      if (record.state.snapshot) {
        identityCount -= new Set([
          ...record.state.snapshot.models.map((model) => model.id),
          ...record.state.staleProbeModels.map((model) => model.id),
        ]).size;
      }
      const generation = catalogObservationKey(record);
      if (generation !== null) loadCount -= loadCountByGeneration.get(generation) ?? 0;
      removeCount += 1;
    }
    state = removeCatalogs(state, new Set(removalOrder.slice(0, removeCount)
      .map((record) => serializeProviderCatalogRuntimeStateKeyV1(record.key))));
  }
  state = removeSmallestCatalogPrefixToFitBytes(
    state,
    removalOrder.filter((record) => state.catalogs.some((candidate) =>
      serializeProviderCatalogRuntimeStateKeyV1(candidate.key)
        === serializeProviderCatalogRuntimeStateKeyV1(record.key))),
    budget.maxEncodedBytes,
  );

  const endpointOrder = [...state.endpointHealth].sort(compareEndpointLru);
  const endpointRemoveCount = Math.max(0, state.endpointHealth.length - budget.maxEndpointRecords);
  const endpointRemove = new Set(endpointOrder.slice(0, endpointRemoveCount)
    .map((record) => serializeProviderEndpointRuntimeStateKeyV1(record.key)));
  state = {
    ...state,
    endpointHealth: state.endpointHealth.filter((record) =>
      !endpointRemove.has(serializeProviderEndpointRuntimeStateKeyV1(record.key))),
  };

  const installationOrder = [...state.installationChecks].sort(compareInstallationLru);
  const installationRemoveCount = Math.max(0, state.installationChecks.length - budget.maxInstallationRecords);
  const installationRemove = new Set(installationOrder.slice(0, installationRemoveCount)
    .map((record) => serializeProviderInstallationRuntimeStateKeyV1(record.key)));
  state = {
    ...state,
    installationChecks: state.installationChecks.filter((record) =>
      !installationRemove.has(serializeProviderInstallationRuntimeStateKeyV1(record.key))),
  };

  state = removeSmallestEndpointPrefixToFitBytes(
    state,
    [...state.endpointHealth].sort(compareEndpointLru),
    budget.maxEncodedBytes,
  );
  state = removeSmallestInstallationPrefixToFitBytes(
    state,
    [...state.installationChecks].sort(compareInstallationLru),
    budget.maxEncodedBytes,
  );
  if (catalogStructuralBudgetExceeded(state, budget)
    || state.endpointHealth.length > budget.maxEndpointRecords
    || state.installationChecks.length > budget.maxInstallationRecords
    || encodedBytes(state) > budget.maxEncodedBytes) {
    throw new ProviderRuntimeStatePruneError('Provider runtime state cannot fit the configured deterministic budget');
  }
  return ProviderRuntimeStateFileV1Schema.parse(state);
}
