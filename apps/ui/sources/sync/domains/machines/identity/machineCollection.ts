/**
 * Machine identity resolution only ever needs **lookup by machine id** — walking a replacement
 * chain, confirming a replacement target exists, checking whether a target machine is still
 * routable. It never needs an ordered list.
 *
 * The store already owns that index: `machines` is a `Record<string, Machine>` keyed by
 * `machine.id`. Accepting only an array forced every caller to destroy that index with
 * `Object.values(...)` and forced the resolver to rebuild it with `new Map(machines.map(...))` —
 * per session, inside store-write loops, which is O(sessions x machines) allocation on the
 * hottest write path in the app. Accepting the record instead makes the lookup O(1) with no
 * allocation at all.
 *
 * Lists stay supported for the callers that genuinely hold one (a server-scoped machine list, an
 * RPC input). Those scan instead of indexing: the walk is bounded at
 * `MAX_REPLACEMENT_CHAIN_LENGTH`, so a scan costs no more than the index build it replaced and
 * allocates nothing.
 */
export {
    findMachineInCollection,
    type MachineCollection,
    type MachineIdentityRecord,
} from '@happier-dev/protocol';

import type { MachineCollection, MachineIdentityRecord } from '@happier-dev/protocol';

/**
 * Materialise the collection for the few resolutions that genuinely have to *scan* — matching a
 * machine by host or by home-directory locality. Call these only after the caller's own guards
 * have decided the scan is needed, so the allocation stays off the id-lookup path.
 */
export function machineCollectionValues<TMachine extends MachineIdentityRecord>(
    machines: MachineCollection<TMachine> | null | undefined,
): ReadonlyArray<TMachine> {
    if (!machines) return [];
    if (machines instanceof Map) return Array.from(machines.values());
    return Array.isArray(machines) ? machines : Object.values(machines);
}
