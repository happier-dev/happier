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
export type MachineIdentityRecord = Readonly<{ id?: string | null }>;

export type MachineCollection<TMachine extends MachineIdentityRecord> =
    | ReadonlyArray<TMachine>
    | Readonly<Record<string, TMachine>>
    | ReadonlyMap<string, TMachine>;

/**
 * Find the machine registered under `machineId`, in either shape.
 *
 * The record and map branches accept an entry only when its own `id` matches the key it is filed
 * under. Every shape therefore resolves a machine by its identity rather than by whatever key it
 * was stored under — which also keeps a normalised key (`machineById`, whose keys are trimmed)
 * answering exactly as the list built from the same machines does — and an inherited property
 * (`constructor`, `__proto__`) can never be mistaken for a machine.
 *
 * The list branch resolves the **last** matching entry, matching the `new Map(machines.map(...))`
 * index this replaced. Every production list is produced from an id-keyed record, so at most one
 * entry per id exists and the direction is unobservable; the parity tests assert both shapes agree.
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
