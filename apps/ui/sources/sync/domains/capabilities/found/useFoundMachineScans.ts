import * as React from 'react';

import {
  loadFoundWarmCacheEntry,
  subscribeFoundWarmCacheEntry,
  type FoundCacheEntryV1,
} from '@/sync/domains/state/warmCachePersistence';
import { readRpcFailureCode } from '@/sync/ops/actions/rpcFailureCode';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

export type FoundKind = FoundCacheEntryV1['kind'];
type FoundResults = Readonly<{ [Entry in FoundCacheEntryV1 as Entry['kind']]: Entry['result'] }>;
export type FoundResultOf<K extends FoundKind> = FoundResults[K];
export type FoundMachineFailure = 'failed' | 'older_machine';
/** What a scan reports: nothing (it worked), a failure, or a failure with the typed cause the Action returned. */
export type FoundMachineScanOutcome = FoundMachineFailure | Readonly<{ failure: FoundMachineFailure; cause: string | null }> | null;

/** One machine's Found list as a page shows it: the last known result, and what is happening now. */
export type FoundMachineScanOf<R> = Readonly<{
  machineId: string;
  /** The last result for this machine from the device-local warm cache (metadata, never bytes). */
  result: R | null;
  scanning: boolean;
  /** The latest scan failed. The last known result stays. */
  failure: FoundMachineFailure | null;
  /** The typed cause of that failure (`RPC_TRANSPORT_UNAVAILABLE`), for the section's Details; null when none was returned. */
  cause?: string | null;
}>;

type Entries<R> = Readonly<Record<string, R | null>>;
const EMPTY_ENTRIES: Entries<never> = Object.freeze({});

/**
 * The last known Found result of one kind per machine from the device-local warm cache, kept current as any
 * reader writes it (a page's scan, the composer's, the Action ingress). It never reads a machine.
 */
export function useFoundCacheEntries<K extends FoundKind>(
  kind: K,
  machineIds: readonly string[],
  requestedScope?: ServerAccountScope | null,
): Entries<FoundResultOf<K>> {
  const activeScope = useAccountSettingsScope();
  const scope = requestedScope === undefined ? activeScope : requestedScope;
  const idsKey = machineIds.join('\u0000');
  const accountId = scope?.accountId;
  const serverId = scope?.serverId;
  const key = JSON.stringify([kind, serverId, accountId, idsKey]);
  const [entries, setEntries] = React.useState<Readonly<{ key: string; value: Entries<FoundResultOf<K>> }>>({ key, value: EMPTY_ENTRIES });
  React.useLayoutEffect(() => {
    const ids = idsKey ? idsKey.split('\u0000') : [];
    const read = (machineId: string): FoundResultOf<K> | null => {
      const entry = loadFoundWarmCacheEntry(serverId, accountId, kind, machineId);
      // `loadFoundWarmCacheEntry` returns only an entry of the requested kind.
      return entry ? (entry.result as FoundResultOf<K>) : null;
    };
    setEntries({ key, value: Object.fromEntries(ids.map((id) => [id, read(id)])) });
    const unsubscribers = ids.map((machineId) =>
      subscribeFoundWarmCacheEntry(serverId, accountId, kind, machineId, () =>
        setEntries((prev) => prev.key === key ? { key, value: { ...prev.value, [machineId]: read(machineId) } } : prev),
      ),
    );
    return () => unsubscribers.forEach((off) => off());
  }, [accountId, idsKey, kind, serverId, key]);
  return entries.key === key ? entries.value : EMPTY_ENTRIES;
}

/**
 * Per-machine Found scans of one kind: each machine's last known result from the warm cache, whether it is being
 * read now, and whether its latest read failed. `scanOne` reads one machine and reports its failure (the
 * caller's Action ingress writes the cache); one machine's failure never touches another's state.
 */
export function useFoundMachineScans<K extends FoundKind>(
  kind: K,
  machineIds: readonly string[],
  scanOne: (machineId: string) => Promise<FoundMachineScanOutcome>,
): Readonly<{ scans: readonly FoundMachineScanOf<FoundResultOf<K>>[]; scan: (machineId: string) => Promise<void> }> {
  const idsKey = machineIds.join('\u0000');
  const entries = useFoundCacheEntries(kind, machineIds);
  const [busy, setBusy] = React.useState<ReadonlySet<string>>(() => new Set());
  const [failures, setFailures] = React.useState<Readonly<Record<string, Readonly<{ failure: FoundMachineFailure; cause: string | null }>>>>({});

  const scan = React.useCallback(
    async (machineId: string) => {
      setBusy((prev) => new Set(prev).add(machineId));
      let failure: Readonly<{ failure: FoundMachineFailure; cause: string | null }> | null = null;
      try {
        const outcome = await scanOne(machineId);
        failure = outcome === null ? null : typeof outcome === 'string' ? { failure: outcome, cause: null } : outcome;
      } catch (error) {
        // The same typed code the Action refusal path carries (`readRpcFailureCode` owns the projection).
        failure = { failure: 'failed', cause: readRpcFailureCode(error) ?? null };
      } finally {
        setBusy((prev) => {
          const next = new Set(prev);
          next.delete(machineId);
          return next;
        });
        setFailures((prev) => {
          if (failure === null) {
            if (!(machineId in prev)) return prev;
            const { [machineId]: _cleared, ...rest } = prev;
            return rest;
          }
          return { ...prev, [machineId]: failure };
        });
      }
    },
    [scanOne],
  );

  const scans = React.useMemo(
    () =>
      (idsKey ? idsKey.split('\u0000') : []).map((machineId) => ({
        machineId,
        result: entries[machineId] ?? null,
        scanning: busy.has(machineId),
        failure: failures[machineId]?.failure ?? null,
        cause: failures[machineId]?.cause ?? null,
      })),
    [busy, entries, failures, idsKey],
  );
  return { scans, scan };
}
