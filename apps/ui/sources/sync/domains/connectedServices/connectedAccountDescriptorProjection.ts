import {
  ConnectedAccountUiProjectionEntryV1Schema,
  type ConnectedAccountUiProjectionEntryV1,
} from '@happier-dev/protocol';
import type { DaemonContributionRegistryProjection } from '@/sync/api/daemon/daemonContributionRegistryProjectionProtocol';

export type ConnectedAccountDescriptorProjectionErrorReason =
  | 'unsupported'
  | 'malformed'
  | 'transport'
  | 'partial_machine_failure';

export type ConnectedAccountDescriptorMachineProjection =
  | Readonly<{ kind: 'ready'; descriptors: readonly ConnectedAccountUiProjectionEntryV1[] }>
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
      kind: 'ready' | 'conflict';
      descriptors: readonly ConnectedAccountUiProjectionEntryV1[];
      conflicts: readonly ConnectedAccountDescriptorProjectionConflict[];
    }>
  | Readonly<{
      kind: 'error';
      reason: ConnectedAccountDescriptorProjectionErrorReason;
      /**
       * Facts the machines that DID answer reported. A degraded read is not
       * authoritative for absence, so these are adopted only when there is no
       * last-known-good state to retain: one unrelated machine must never turn
       * every working Connected Account into "no descriptor".
       */
      descriptors?: readonly ConnectedAccountUiProjectionEntryV1[];
      conflicts?: readonly ConnectedAccountDescriptorProjectionConflict[];
    }>;

export type ConnectedAccountDescriptorProjectionState = Readonly<{
  scopeKey: string;
  status: 'loading' | 'ready' | 'stale' | 'error' | 'conflict';
  descriptors: readonly ConnectedAccountUiProjectionEntryV1[];
  conflicts: readonly ConnectedAccountDescriptorProjectionConflict[];
  errorReason: ConnectedAccountDescriptorProjectionErrorReason | null;
}>;

export function readConnectedAccountDescriptorProjection(
  projection: DaemonContributionRegistryProjection | null,
): ConnectedAccountDescriptorMachineProjection {
  if (!projection || projection.v !== 2) return { kind: 'error', reason: 'unsupported' };
  const family = projection.familiesById.connectedAccounts;
  if (!family) return { kind: 'ready', descriptors: [] };

  const descriptors: ConnectedAccountUiProjectionEntryV1[] = [];
  for (const entry of Object.values(family.entriesById)) {
    const parsed = ConnectedAccountUiProjectionEntryV1Schema.safeParse(entry);
    if (!parsed.success) return { kind: 'error', reason: 'malformed' };
    descriptors.push(parsed.data);
  }
  return { kind: 'ready', descriptors };
}

function connectedAccountDescriptorIdentity(entry: ConnectedAccountUiProjectionEntryV1): string {
  return `${entry.pluginId ?? 'first_party'}\u0000${entry.id}`;
}

function descriptorFingerprint(entry: ConnectedAccountUiProjectionEntryV1): string {
  return JSON.stringify(entry);
}

/**
 * Deterministic fail-closed union for the account-wide settings surface. Equal facts collapse.
 * Divergent candidates are retained with explicit conflict facts so the registry can keep every
 * affected service visible without making any candidate executable.
 */
export function mergeConnectedAccountDescriptorProjections(
  projections: readonly ConnectedAccountDescriptorMachineProjection[],
): ConnectedAccountDescriptorProjectionResolution {
  if (projections.some((projection) => projection.kind === 'error')) {
    const answering = projections.filter((projection) => projection.kind === 'ready');
    if (answering.length === 0) {
      return {
        kind: 'error',
        reason: projections.find((projection) => projection.kind === 'error')?.reason ?? 'transport',
      };
    }
    // The union of the machines that answered is still a fact. Carry it so a
    // cold read that hits one failing machine degrades to `stale` with real
    // descriptors instead of collapsing to "no Connected Account exists".
    const partial = unionReadyConnectedAccountDescriptorProjections(answering);
    return {
      kind: 'error',
      reason: 'partial_machine_failure',
      descriptors: partial.descriptors,
      conflicts: partial.conflicts,
    };
  }

  return unionReadyConnectedAccountDescriptorProjections(projections);
}

function unionReadyConnectedAccountDescriptorProjections(
  projections: readonly ConnectedAccountDescriptorMachineProjection[],
): Extract<ConnectedAccountDescriptorProjectionResolution, { kind: 'ready' | 'conflict' }> {
  const variantsByIdentity = new Map<string, Map<string, ConnectedAccountUiProjectionEntryV1>>();
  for (const projection of projections) {
    if (projection.kind !== 'ready') continue;
    for (const entry of projection.descriptors) {
      const identity = connectedAccountDescriptorIdentity(entry);
      const variants = variantsByIdentity.get(identity) ?? new Map<string, ConnectedAccountUiProjectionEntryV1>();
      const fingerprint = descriptorFingerprint(entry);
      if (!variants.has(fingerprint)) variants.set(fingerprint, entry);
      variantsByIdentity.set(identity, variants);
    }
  }

  const descriptors = [...variantsByIdentity.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([, variants]) => [...variants.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, entry]) => entry));

  const conflicts: ConnectedAccountDescriptorProjectionConflict[] = [];
  for (const [identity, variants] of [...variantsByIdentity.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    if (variants.size <= 1) continue;
    const serviceIds = [...new Set([...variants.values()].map((entry) => entry.serviceId))]
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
  return { scopeKey, status: 'loading', descriptors: [], conflicts: [], errorReason: null };
}

function equalFacts(left: readonly unknown[], right: readonly unknown[]): boolean {
  return left === right || JSON.stringify(left) === JSON.stringify(right);
}

export function advanceConnectedAccountDescriptorProjectionState(
  previous: ConnectedAccountDescriptorProjectionState,
  resolution: ConnectedAccountDescriptorProjectionResolution,
): ConnectedAccountDescriptorProjectionState {
  if (resolution.kind === 'error') {
    // A degraded read may supply knowledge but must never retract it.
    const retained = previous.descriptors.length > 0;
    const descriptors = retained ? previous.descriptors : resolution.descriptors ?? [];
    const conflicts = retained ? previous.conflicts : resolution.conflicts ?? [];
    return {
      ...previous,
      status: descriptors.length > 0 ? 'stale' : 'error',
      descriptors,
      conflicts,
      errorReason: resolution.reason,
    };
  }

  const descriptors = equalFacts(previous.descriptors, resolution.descriptors)
    ? previous.descriptors
    : resolution.descriptors;
  const conflicts = equalFacts(previous.conflicts, resolution.conflicts)
    ? previous.conflicts
    : resolution.conflicts;
  const status = resolution.kind === 'conflict' ? 'conflict' : 'ready';
  if (
    previous.status === status
    && previous.errorReason === null
    && previous.descriptors === descriptors
    && previous.conflicts === conflicts
  ) {
    return previous;
  }
  return { ...previous, status, descriptors, conflicts, errorReason: null };
}
