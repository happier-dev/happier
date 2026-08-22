/**
 * Machine REPLACEMENT chain resolution — the single answer to "which machine is
 * machine X now?".
 *
 * A replaced machine keeps its row and gains a forward pointer
 * (`Machine.replacedByMachineId`); nothing re-homes the rows that named it, so a
 * Session, a recent path or an RPC target recorded before the replacement still
 * names the PREDECESSOR. Every consumer that wants to reach the machine such a
 * record refers to must therefore walk the chain, and they must all walk it the
 * same way: the client picks its RPC target with this walk, and the daemon
 * decides whether it hosts a Session with it. Two walks would let a client
 * address a successor the daemon then refuses as foreign.
 *
 * It lives here rather than in either app because both sides of that exchange
 * need it and neither owns the other.
 */

const MAX_REPLACEMENT_CHAIN_LENGTH = 16;

export type MachineIdentityRecord = Readonly<{ id?: string | null }>;

/**
 * Resolution only ever needs **lookup by machine id**. Callers that already hold
 * an id-keyed record must not have to destroy that index with `Object.values`,
 * and callers that genuinely hold a list (a server-scoped machine list, an RPC
 * response) must not have to build one. Both shapes are accepted; the walk is
 * bounded, so the list branch's scan costs no more than the index build it
 * replaces and allocates nothing.
 */
export type MachineCollection<TMachine extends MachineIdentityRecord> =
  | ReadonlyArray<TMachine>
  | Readonly<Record<string, TMachine>>
  | ReadonlyMap<string, TMachine>;

export type MachineReplacementRecord = Readonly<{
  /** Optional so an already-indexed machine collection can be handed over without a cast. */
  id?: string | null;
  replacedByMachineId?: string | null;
  replacedAt?: unknown;
}>;

export type CanonicalMachineResolution = Readonly<{
  machineId: string;
  reason: 'direct' | 'replacement' | 'missingReplacementTarget';
  chain: readonly string[];
}>;

export function normalizeMachineIdentityString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function isMachineReplaced(
  machine: Readonly<{ replacedByMachineId?: string | null; replacedAt?: unknown }> | null | undefined,
): boolean {
  return Boolean(normalizeMachineIdentityString(machine?.replacedByMachineId));
}

/**
 * Find the machine registered under `machineId`, in either shape.
 *
 * The record and map branches accept an entry only when its own `id` matches the
 * key it is filed under, so a machine resolves by its identity rather than by
 * whatever key it was stored under — which also keeps a normalised key answering
 * exactly as the list built from the same machines does — and an inherited
 * property (`constructor`, `__proto__`) can never be mistaken for a machine. The
 * list branch resolves the LAST matching
 * entry, matching the id-keyed index this replaced; every production list is
 * produced from an id-keyed record, so at most one entry per id exists and the
 * direction is unobservable.
 */
export function findMachineInCollection<TMachine extends MachineIdentityRecord>(
  machines: MachineCollection<TMachine> | null | undefined,
  machineId: string,
): TMachine | null {
  if (!machines) return null;

  if (machines instanceof Map) {
    const mapped = machines.get(machineId);
    return mapped && mapped.id === machineId ? mapped : null;
  }

  if (Array.isArray(machines)) {
    for (let index = machines.length - 1; index >= 0; index -= 1) {
      const machine = machines[index];
      if (machine && machine.id === machineId) return machine;
    }
    return null;
  }

  const machine = (machines as Readonly<Record<string, TMachine>>)[machineId];
  return machine && machine.id === machineId ? machine : null;
}

export function resolveCanonicalMachineId(
  machineIdInput: string | null | undefined,
  machines: MachineCollection<MachineReplacementRecord>,
): CanonicalMachineResolution | null {
  const machineId = normalizeMachineIdentityString(machineIdInput);
  if (!machineId) return null;
  if (machineId.startsWith('host:')) return null;

  const chain: string[] = [];
  const visited = new Set<string>();
  let currentMachineId = machineId;

  for (let depth = 0; depth < MAX_REPLACEMENT_CHAIN_LENGTH; depth += 1) {
    if (visited.has(currentMachineId)) return null;
    visited.add(currentMachineId);
    chain.push(currentMachineId);

    const machine = findMachineInCollection(machines, currentMachineId);
    if (!machine || !isMachineReplaced(machine)) {
      return {
        machineId: currentMachineId,
        reason: currentMachineId === machineId ? 'direct' : 'replacement',
        chain,
      };
    }

    const replacementMachineId = normalizeMachineIdentityString(machine.replacedByMachineId);
    if (!replacementMachineId || replacementMachineId === currentMachineId) return null;
    if (!findMachineInCollection(machines, replacementMachineId)) {
      return {
        machineId: currentMachineId,
        reason: 'missingReplacementTarget',
        chain,
      };
    }
    currentMachineId = replacementMachineId;
  }

  return null;
}
