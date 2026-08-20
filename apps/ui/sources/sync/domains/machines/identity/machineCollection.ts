/**
 * Machine identity resolution only ever needs **lookup by machine id** — walking a replacement
 * chain, confirming a replacement target exists, checking whether a target machine is still
 * routable. It never needs an ordered list.
 *
 * The store already owns that index: `machines` and `machineDisplayById` are `Record<string, T>`
 * keyed by `machine.id` (see `applyMachines` in `sync/store/domains/machines.ts`). Accepting only
 * an array forced every caller to destroy that index with `Object.values(...)` and forced the
 * resolver to rebuild it with `new Map(machines.map(...))` — per session, inside store-write
 * loops. Accepting the record instead makes the lookup O(1) with no allocation at all.
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
