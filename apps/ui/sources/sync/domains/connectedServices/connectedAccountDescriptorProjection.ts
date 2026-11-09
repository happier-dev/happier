import {
  ConnectedAccountUiProjectionEntryV1Schema,
  projectConnectedAccountDescriptorV1,
  type ConnectedAccountUiProjectionEntryV1,
} from '@happier-dev/protocol/connect/connectedAccountUiProjectionV1';
import type { DaemonContributionRegistryProjection } from '@/sync/api/daemon/daemonContributionRegistryProjectionProtocol';
import { BUNDLED_ACCOUNT_CONNECTED_SERVICE_DECLARATIONS } from '@/agents/registry/generatedBundledPluginEntries';
import { resolveFleetReadState, resolveFleetSupplyAgreement } from '@/sync/domains/machines/administration/fleetUnion';

export type ConnectedAccountDescriptorProjectionErrorReason =
  | 'unsupported'
  | 'malformed'
  | 'transport'
  | 'partial_machine_failure';

export type ConnectedAccountDescriptorMachineProjection =
  | Readonly<{ kind: 'loading' }>
  | Readonly<{
      kind: 'ready';
      descriptors: readonly ConnectedAccountUiProjectionEntryV1[];
      /** Static declarations remain visible when Administration withdraws execution. */
      executionUnavailablePluginIds?: readonly string[];
    }>
  | Readonly<{ kind: 'error'; reason: ConnectedAccountDescriptorProjectionErrorReason }>;

export type ConnectedAccountDescriptorProjectionConflict =
  | Readonly<{
      kind: 'identity_divergence';
      descriptorIdentity: string;
      serviceIds: readonly ConnectedAccountUiProjectionEntryV1['serviceId'][];
    }>
  /**
   * Compatibility input for a projection produced before Connected Account
   * services were qualified. A local id is no longer an ownership key, so the
   * UI registry deliberately does not use this fact to disable either owner.
   */
  | Readonly<{
      kind: 'service_ownership';
      serviceId: ConnectedAccountUiProjectionEntryV1['serviceId'];
      descriptorIdentities: readonly string[];
    }>;

export type ConnectedAccountDescriptorProjectionResolution =
  | Readonly<{
      kind: 'loading' | 'ready' | 'conflict';
      descriptors: readonly ConnectedAccountUiProjectionEntryV1[];
      conflicts: readonly ConnectedAccountDescriptorProjectionConflict[];
    }>
  | Readonly<{
      kind: 'error';
      reason: ConnectedAccountDescriptorProjectionErrorReason;
      /**
       * Facts the machines that DID answer reported. A degraded read is not
       * authoritative for absence: refresh answered identities while retaining
       * unanswered services for display.
       */
      descriptors?: readonly ConnectedAccountUiProjectionEntryV1[];
      conflicts?: readonly ConnectedAccountDescriptorProjectionConflict[];
    }>;

export type ConnectedAccountDescriptorProjectionState = Readonly<{
  scopeKey: string;
  status: 'loading' | 'ready' | 'stale' | 'error' | 'conflict';
  descriptors: readonly ConnectedAccountUiProjectionEntryV1[];
  /**
   * Current answering identities, distinct from retained display descriptors.
   * Complete ready/conflict snapshots may omit this fact: every descriptor is answered.
   */
  answeredDescriptorIdentities?: readonly string[];
  conflicts: readonly ConnectedAccountDescriptorProjectionConflict[];
  errorReason: ConnectedAccountDescriptorProjectionErrorReason | null;
}>;

// Only this reader's owned snapshots may reuse prepared declaration content.
// Object.freeze on an arbitrary caller's root does not prove nested immutability.
const ownedDescriptorRevision = Symbol('connectedAccountDescriptorRevision');

function snapshotDescriptorValue<T>(value: T): T {
  if (Array.isArray(value)) return Object.freeze(value.map(snapshotDescriptorValue)) as T;
  if (value !== null && typeof value === 'object') {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, child]) => [key, snapshotDescriptorValue(child)]))) as T;
  }
  return value;
}

function snapshotDescriptor(entry: ConnectedAccountUiProjectionEntryV1): ConnectedAccountUiProjectionEntryV1 {
  const snapshot = Object.fromEntries(Object.entries(entry).map(([key, value]) => [key, snapshotDescriptorValue(value)])) as ConnectedAccountUiProjectionEntryV1;
  Object.defineProperty(snapshot, ownedDescriptorRevision, { value: true });
  return Object.freeze(snapshot);
}

function isOwnedDescriptorRevision(entry: ConnectedAccountUiProjectionEntryV1): boolean {
  return Object.getOwnPropertyDescriptor(entry, ownedDescriptorRevision)?.value === true;
}

export function readConnectedAccountDescriptorProjection(
  projection: DaemonContributionRegistryProjection | null,
): ConnectedAccountDescriptorMachineProjection {
  if (!projection) return { kind: 'error', reason: 'unsupported' };
  const family = projection.familiesById.connectedAccounts;
  if (!family) return { kind: 'ready', descriptors: [] };

  const descriptors: ConnectedAccountUiProjectionEntryV1[] = [];
  for (const entry of Object.values(family.entriesById)) {
    const parsed = ConnectedAccountUiProjectionEntryV1Schema.safeParse(entry);
    if (!parsed.success) return { kind: 'error', reason: 'malformed' };
    descriptors.push(snapshotDescriptor(parsed.data));
  }
  return Object.freeze({ kind: 'ready', descriptors: Object.freeze(descriptors) });
}

function connectedAccountDescriptorIdentity(entry: ConnectedAccountUiProjectionEntryV1): string {
  return `${entry.pluginId ?? 'first_party'}\u0000${entry.id}`;
}

type PreparedDescriptor = Readonly<{
  descriptor: ConnectedAccountUiProjectionEntryV1;
  declaration: Omit<ConnectedAccountUiProjectionEntryV1, 'diagnostics'>;
}>;
type PreparedDescriptorVariants = { admitted?: PreparedDescriptor; descriptive?: PreparedDescriptor };
type PrepareDescriptor = (entry: ConnectedAccountUiProjectionEntryV1, descriptiveOnly: boolean) => PreparedDescriptor;

function prepareDescriptor(entry: ConnectedAccountUiProjectionEntryV1, descriptiveOnly: boolean): PreparedDescriptor {
  const bundled = entry.provenance === 'first_party' && entry.sourceKind === 'bundled' && entry.pluginId
    ? BUNDLED_ACCOUNT_CONNECTED_SERVICE_DECLARATIONS[`${entry.pluginId}/${entry.id}`]?.descriptor
    : undefined;
  // The admitted manifest owns bundled declarations. Machines only supply
  // availability, diagnostics and occurrence facts, including across builds.
  if (bundled) entry = {
    ...projectConnectedAccountDescriptorV1({ descriptor: bundled,
      serviceId: bundled.id, pluginId: entry.pluginId,
      provenance: entry.provenance, sourceKind: entry.sourceKind,
      availability: entry.availability, diagnostics: entry.diagnostics }),
    ...(entry.occurrenceId === undefined ? {} : { occurrenceId: entry.occurrenceId }),
  };
  // Runtime occurrences never participate in Account declaration agreement.
  const { occurrenceId, ...declaration } = entry;
  const descriptor = descriptiveOnly && entry.availability.state === 'available'
    ? { ...declaration, availability: { state: 'blocked' as const, reason: 'execution_origin_unavailable' } }
    : occurrenceId === undefined ? entry : declaration;
  // Diagnostics describe one machine's runtime, not the Account declaration.
  const { diagnostics, ...content } = descriptor;
  return { descriptor, declaration: content };
}

/** Current descriptive source publications only; execution admission remains with its live owner. */
export function createConnectedAccountDescriptorProjectionPublication(): Readonly<{
  publish: (projections: readonly ConnectedAccountDescriptorMachineProjection[]) => ConnectedAccountDescriptorProjectionResolution;
  getSnapshot: () => ConnectedAccountDescriptorProjectionResolution;
}> {
  let inputs: readonly ConnectedAccountDescriptorMachineProjection[] = [];
  let prepared = new Map<ConnectedAccountUiProjectionEntryV1, PreparedDescriptorVariants>();
  let snapshot = mergeConnectedAccountDescriptorProjections([]);
  return {
    getSnapshot: () => snapshot,
    publish: (projections) => {
      const unchanged = inputs.length === projections.length && projections.every((input, index) => {
        const previous = inputs[index]!;
        if (input.kind !== previous.kind) return false;
        if (input.kind === 'error') return previous.kind === 'error' && input.reason === previous.reason;
        if (input.kind === 'loading') return true;
        return previous.kind === 'ready'
          && input.descriptors.every(isOwnedDescriptorRevision)
          && equalReferences(input.descriptors, previous.descriptors)
          && equalFacts(input.executionUnavailablePluginIds ?? [], previous.executionUnavailablePluginIds ?? []);
      });
      if (unchanged) return snapshot;

      const nextPrepared = new Map<ConnectedAccountUiProjectionEntryV1, PreparedDescriptorVariants>();
      for (const input of projections) {
        if (input.kind !== 'ready') continue;
        for (const entry of input.descriptors) {
          const retained = isOwnedDescriptorRevision(entry) ? prepared.get(entry) : undefined;
          if (retained) nextPrepared.set(entry, retained);
        }
      }
      const next = resolveConnectedAccountDescriptorProjections(projections, (entry, descriptiveOnly) => {
        let variants = nextPrepared.get(entry);
        if (!variants) {
          variants = isOwnedDescriptorRevision(entry) ? prepared.get(entry) ?? {} : {};
          nextPrepared.set(entry, variants);
        }
        const key = descriptiveOnly && entry.availability.state === 'available' ? 'descriptive' : 'admitted';
        return variants[key] ??= prepareDescriptor(isOwnedDescriptorRevision(entry) ? entry : snapshotDescriptor(entry), descriptiveOnly);
      });
      inputs = projections.map((input) => input.kind === 'ready' ? {
        ...input, descriptors: [...input.descriptors],
        executionUnavailablePluginIds: input.executionUnavailablePluginIds ? [...input.executionUnavailablePluginIds] : undefined,
      } : { ...input });
      prepared = nextPrepared;
      snapshot = reconcileDescriptorResolution(snapshot, next);
      return snapshot;
    },
  };
}

function equalReferences<T>(left: readonly T[], right: readonly T[]): boolean {
  return left === right || left.length === right.length && left.every((value, index) => value === right[index]);
}

function reconcileDescriptorResolution(
  previous: ConnectedAccountDescriptorProjectionResolution,
  next: ConnectedAccountDescriptorProjectionResolution,
): ConnectedAccountDescriptorProjectionResolution {
  const previousByIdentity = new Map<string, ConnectedAccountUiProjectionEntryV1[]>();
  for (const entry of previous.descriptors ?? []) {
    const identity = connectedAccountDescriptorIdentity(entry);
    const candidates = previousByIdentity.get(identity) ?? [];
    candidates.push(entry);
    previousByIdentity.set(identity, candidates);
  }
  const descriptors = next.descriptors?.map((entry) => {
    const candidates = previousByIdentity.get(connectedAccountDescriptorIdentity(entry)) ?? [];
    const unchanged = candidates.find((candidate) => equalFact(candidate, entry));
    if (unchanged) return unchanged;
    const previousDiagnostics = candidates.find((candidate) => equalFacts(candidate.diagnostics, entry.diagnostics))?.diagnostics;
    return previousDiagnostics ? { ...entry, diagnostics: previousDiagnostics } : entry;
  });
  const conflicts = next.conflicts?.map((conflict) => previous.conflicts?.find((candidate) => equalFact(candidate, conflict)) ?? conflict);
  const sharedDescriptors = descriptors && previous.descriptors && equalReferences(descriptors, previous.descriptors) ? previous.descriptors : descriptors;
  const sharedConflicts = conflicts && previous.conflicts && equalReferences(conflicts, previous.conflicts) ? previous.conflicts : conflicts;
  if (previous.kind === next.kind && previous.descriptors === sharedDescriptors && previous.conflicts === sharedConflicts
    && (previous.kind !== 'error' || next.kind === 'error' && previous.reason === next.reason)) return previous;
  return next.kind === 'error'
    ? { kind: 'error', reason: next.reason, ...(sharedDescriptors ? { descriptors: sharedDescriptors } : {}), ...(sharedConflicts ? { conflicts: sharedConflicts } : {}) }
    : { kind: next.kind, descriptors: sharedDescriptors!, conflicts: sharedConflicts! };
}

/**
 * Deterministic fail-closed union for the account-wide settings surface. Equal facts collapse.
 * Divergent candidates are retained with explicit conflict facts so the registry can keep every
 * affected service visible without making any candidate executable.
 */
export function mergeConnectedAccountDescriptorProjections(
  projections: readonly ConnectedAccountDescriptorMachineProjection[],
): ConnectedAccountDescriptorProjectionResolution {
  const prepared = new Map<ConnectedAccountUiProjectionEntryV1, PreparedDescriptorVariants>();
  return resolveConnectedAccountDescriptorProjections(projections, (entry, descriptiveOnly) => {
    const variants = prepared.get(entry) ?? {};
    prepared.set(entry, variants);
    const key = descriptiveOnly && entry.availability.state === 'available' ? 'descriptive' : 'admitted';
    return variants[key] ??= prepareDescriptor(entry, descriptiveOnly);
  });
}

function resolveConnectedAccountDescriptorProjections(
  projections: readonly ConnectedAccountDescriptorMachineProjection[],
  prepare: PrepareDescriptor,
): ConnectedAccountDescriptorProjectionResolution {
  const answering = projections.filter((projection) => projection.kind === 'ready');
  // A pending or unavailable source cannot hold Account settings at loading
  // after another machine answered. Partial coverage retains unanswered display
  // facts without admitting them; the per-machine reader still owns recovery.
  const readState = resolveFleetReadState(projections.map((projection) => projection.kind === 'ready' ? 'current'
    : projection.kind === 'loading' ? 'resolving' : projection.reason === 'transport' ? 'transportFailure' : 'failed'));
  if (readState === 'resolving' && answering.length === 0) {
    return { ...unionReadyConnectedAccountDescriptorProjections(answering, prepare), kind: 'loading' };
  }
  if (readState !== 'current') {
    if (answering.length === 0) {
      return {
        kind: 'error',
        reason: projections.find((projection) => projection.kind === 'error')?.reason ?? 'transport',
      };
    }
    // The union of the machines that answered is still a fact. Carry it so a
    // cold read that hits one failing machine degrades to `stale` with real
    // descriptors instead of collapsing to "no Connected Account exists".
    const partial = unionReadyConnectedAccountDescriptorProjections(answering, prepare);
    return {
      kind: 'error',
      reason: 'partial_machine_failure',
      descriptors: partial.descriptors,
      conflicts: partial.conflicts,
    };
  }

  return unionReadyConnectedAccountDescriptorProjections(projections, prepare);
}

function unionReadyConnectedAccountDescriptorProjections(
  projections: readonly ConnectedAccountDescriptorMachineProjection[],
  prepare: PrepareDescriptor,
): Extract<ConnectedAccountDescriptorProjectionResolution, { descriptors: readonly ConnectedAccountUiProjectionEntryV1[] }> {
  const supplies = projections.flatMap((projection) => projection.kind !== 'ready' ? [] : projection.descriptors.map((entry) => {
      return { value: entry, selectable: !entry.pluginId
        || !projection.executionUnavailablePluginIds?.includes(entry.pluginId) };
  }));
  const executableIdentities = new Set(supplies.filter(supply => supply.selectable)
    .map(supply => connectedAccountDescriptorIdentity(supply.value)));
  // Prefer admitted declarations for execution/conflict decisions. With no
  // admitted supply, retain descriptive identity through the same union, but
  // never let that declaration make the registry executable.
  const visibleSupplies = supplies.flatMap(supply => {
    const descriptiveOnly = !supply.selectable && !executableIdentities.has(connectedAccountDescriptorIdentity(supply.value));
    return descriptiveOnly || supply.selectable ? [{ selectable: true, value: prepare(supply.value, descriptiveOnly) }] : [];
  });
  const { variantsByIdentity, conflictingIdentities } = resolveFleetSupplyAgreement({ supplies: visibleSupplies,
    identity: value => connectedAccountDescriptorIdentity(value.descriptor),
    sameContent: (left, right) => equalFact(left.declaration, right.declaration) });

  // Preserve every answering supplier's diagnostics without making them a
  // competing declaration. Excluded execution supplies cannot alter this view.
  const diagnosticsByVariant = new Map<PreparedDescriptor, Set<string>>();
  for (const supply of visibleSupplies) {
    if (!supply.selectable) continue;
    if (supply.value.descriptor.diagnostics.length === 0) continue;
    const variants = variantsByIdentity.get(connectedAccountDescriptorIdentity(supply.value.descriptor))!;
    const variant = [...variants.values()].find(value => equalFact(value.declaration, supply.value.declaration))!;
    const diagnostics = diagnosticsByVariant.get(variant) ?? new Set<string>();
    for (const diagnostic of supply.value.descriptor.diagnostics) diagnostics.add(diagnostic);
    diagnosticsByVariant.set(variant, diagnostics);
  }

  const descriptors = [...variantsByIdentity.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([, variants]) => [...variants.values()]
      .sort((left, right) => compareFact(left.declaration, right.declaration))
      .map((prepared) => {
        const entry = prepared.descriptor;
        const diagnostics = [...diagnosticsByVariant.get(prepared) ?? []].sort();
        return equalFacts(entry.diagnostics, diagnostics) ? entry : { ...entry, diagnostics };
      }));

  const conflicts: ConnectedAccountDescriptorProjectionConflict[] = [];
  for (const identity of [...conflictingIdentities].sort((left, right) => left.localeCompare(right))) {
    const variants = variantsByIdentity.get(identity)!;
    const serviceIds = [...new Set([...variants.values()].map((entry) => entry.descriptor.serviceId))]
      .sort((left, right) => left.localeCompare(right));
    conflicts.push({ kind: 'identity_divergence', descriptorIdentity: identity, serviceIds });
  }

  return {
    kind: conflicts.length > 0 ? 'conflict' : 'ready',
    descriptors,
    conflicts,
  };
}

export function createConnectedAccountDescriptorProjectionLoadingState(
  scopeKey: string,
): ConnectedAccountDescriptorProjectionState {
  return { scopeKey, status: 'loading', descriptors: [], answeredDescriptorIdentities: [], conflicts: [], errorReason: null };
}

function equalFacts(left: readonly unknown[], right: readonly unknown[]): boolean {
  return equalFact(left, right);
}

function equalFact(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => equalFact(value, right[index]));
  }
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object'
    || Array.isArray(left) || Array.isArray(right)) return false;
  const leftEntries = Object.entries(left).filter(([, value]) => value !== undefined);
  const rightEntries = Object.entries(right).filter(([, value]) => value !== undefined);
  return leftEntries.length === rightEntries.length && leftEntries.every(([key, value]) => (
    Object.prototype.hasOwnProperty.call(right, key) && equalFact(value, (right as Record<string, unknown>)[key])
  ));
}

/** Deterministic presentation order for divergent declarations, without serialized identities. */
function compareFact(left: unknown, right: unknown): number {
  if (equalFact(left, right)) return 0;
  if (Array.isArray(left) && Array.isArray(right)) {
    for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
      const difference = compareFact(left[index], right[index]);
      if (difference !== 0) return difference;
    }
    return left.length - right.length;
  }
  if (Array.isArray(left) !== Array.isArray(right)) return Array.isArray(left) ? -1 : 1;
  if (left !== null && right !== null && typeof left === 'object' && typeof right === 'object') {
    const entries = (value: object) => Object.entries(value).filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => compareFact(a, b));
    const leftEntries = entries(left);
    const rightEntries = entries(right);
    for (let index = 0; index < Math.min(leftEntries.length, rightEntries.length); index += 1) {
      const [key, value] = leftEntries[index]!;
      const [otherKey, otherValue] = rightEntries[index]!;
      const difference = compareFact(key, otherKey) || compareFact(value, otherValue);
      if (difference !== 0) return difference;
    }
    return leftEntries.length - rightEntries.length;
  }
  if (typeof left !== typeof right) return typeof left < typeof right ? -1 : 1;
  return String(left) < String(right) ? -1 : 1;
}

export function advanceConnectedAccountDescriptorProjectionState(
  previous: ConnectedAccountDescriptorProjectionState,
  resolution: ConnectedAccountDescriptorProjectionResolution,
): ConnectedAccountDescriptorProjectionState {
  // Incomplete coverage refreshes answered facts but cannot prove another
  // service disappeared. Retained presentation never supplies admission.
  const answeredDescriptors = resolution.descriptors ?? [];
  const answeredIdentities = new Set(answeredDescriptors.map(connectedAccountDescriptorIdentity));
  const nextAnsweredDescriptorIdentities = [...answeredIdentities];
  const answeredDescriptorIdentities = equalFacts(previous.answeredDescriptorIdentities ?? [], nextAnsweredDescriptorIdentities)
    ? previous.answeredDescriptorIdentities ?? nextAnsweredDescriptorIdentities
    : nextAnsweredDescriptorIdentities;
  const incomplete = resolution.kind === 'loading' || resolution.kind === 'error';
  const nextDescriptors = incomplete
    ? [...answeredDescriptors, ...previous.descriptors.filter((descriptor) => (
      !answeredIdentities.has(connectedAccountDescriptorIdentity(descriptor))
    ))]
    : answeredDescriptors;
  const nextConflicts = incomplete
    ? [...(resolution.conflicts ?? []), ...previous.conflicts.filter((conflict) => (
      conflict.kind !== 'identity_divergence' || !answeredIdentities.has(conflict.descriptorIdentity)
    ))]
    : resolution.conflicts;
  const descriptors = equalFacts(previous.descriptors, nextDescriptors)
    ? previous.descriptors
    : nextDescriptors;
  const conflicts = equalFacts(previous.conflicts, nextConflicts)
    ? previous.conflicts
    : nextConflicts;
  const status = resolution.kind === 'error'
    ? descriptors.length > 0 ? 'stale' : 'error'
    : resolution.kind;
  const errorReason = resolution.kind === 'error' ? resolution.reason : null;
  if (
    previous.status === status
    && previous.errorReason === errorReason
    && previous.descriptors === descriptors
    && previous.conflicts === conflicts
    && previous.answeredDescriptorIdentities === answeredDescriptorIdentities
  ) {
    return previous;
  }
  return { ...previous, status, descriptors, answeredDescriptorIdentities, conflicts, errorReason };
}
