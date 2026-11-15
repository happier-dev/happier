import * as React from 'react';
import { BrowserExtensionsListResultV1Schema, type BrowserExtensionsListResultV1, type BrowserProfileExtensionV1,
  type BrowserExtensionActionResultV1, type BROWSER_EXTENSION_ACTION_INPUT_SCHEMAS } from '@happier-dev/protocol/actions';
import type { z } from 'zod/mini';
import { BrowserExtensionIdV1Schema } from '@happier-dev/protocol/browser/profile/extensionsV1';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { serverAccountScopedResourceKey, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { useInstalledMachines } from './storeInstalled';
import { useMachinePresenceNowMs } from '@/hooks/machine/useMachinePresenceNowMs';
import { resolveMachineReachability } from '@/sync/domains/machines/reachability/machineReachability';
import type { InstalledScopeAdmission } from './storeAccountAdmission';
import type { InstalledFamilyResult, StoreDemand, StoreInstalledInput } from './storeKinds';
import { retainDeep, retainKeyedRows } from '@/sync/domains/state/structuralSharing';

const WEB_STORE_HOSTS = new Set([
  'chromewebstore.google.com',
  'chrome.google.com',
]);

/** A pasted Chrome Web Store link (either host) or a bare ID names one extension; anything else names none. */
export function readWebStoreExtensionId(text: string): string | null {
  const trimmed = text.trim();
  if (BrowserExtensionIdV1Schema.safeParse(trimmed).success) return trimmed;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (!WEB_STORE_HOSTS.has(url.hostname)) return null;
  const id = url.pathname
    .split('/')
    .reverse()
    .find((segment) => BrowserExtensionIdV1Schema.safeParse(segment).success);
  return id ?? null;
}

/** An extension in a saved profile, or a saved profile that holds none yet (its page is reached through this row). */
export type InstalledBrowserExtensionRow = Readonly<{
  kind: 'browserExtension'; key: string; scope: ServerAccountScope; machineId: string;
}> & (Readonly<{ subject: 'extension'; native: BrowserProfileExtensionV1 }>
  | Readonly<{ subject: 'profile'; native: Readonly<{ profileId: string; displayName?: string }> }>);
export type InstalledBrowserExtensionEntryRow = Extract<InstalledBrowserExtensionRow, Readonly<{ subject: 'extension' }>>;
export type BrowserExtensionInventoryFailure = Readonly<{ machineId: string; reason:
  | Readonly<{ kind: 'browser'; value: Extract<BrowserExtensionsListResultV1, { status: 'unavailable' }> }>
  | Readonly<{ kind: 'action'; code: string }>
  | Readonly<{ kind: 'invalid_response' | 'transport' }>;
}>;
type NativeInventory = InstalledFamilyResult<InstalledBrowserExtensionRow, readonly BrowserExtensionInventoryFailure[], () => void>;
const EMPTY_ROWS: readonly InstalledBrowserExtensionRow[] = Object.freeze([]);

/** Supplied by the mounted browser surface's platform owner, including its existing managed-browser opener. */
export type BrowserExtensionSurfaceAvailability =
  | Readonly<{ kind: 'managed_browser'; machineId: string; profileId: string; browserSessionId: string; viewId: string }>
  | Readonly<{ kind: 'managed_browser_required'; openInManagedBrowser: () => void | Promise<void> }>;

/** Preserve the service's permission review and restart decision; presentation never re-decides either fact. */
export type BrowserExtensionMutationPresentation = Extract<BrowserExtensionActionResultV1,
  { status: 'updated' | 'removed' | 'needs_review' | 'needs_restart_confirmation' | 'unavailable' }>;
type BrowserExtensionMutationAction = Exclude<keyof typeof BROWSER_EXTENSION_ACTION_INPUT_SCHEMAS, 'browser.extensions.list'>;
/** Popup/options carry the mounted view and caller's command identity from the same browser Action owner. */
export type BrowserExtensionActionIntent = { [Action in BrowserExtensionMutationAction]: Readonly<{
  actionId: Action; input: z.infer<(typeof BROWSER_EXTENSION_ACTION_INPUT_SCHEMAS)[Action]>;
}> }[BrowserExtensionMutationAction];

/** One finite, explicitly refreshed Action list shared by Store and persistent-profile presentation. */
export function useBrowserExtensionsInventory(input: Readonly<{
  scope: ServerAccountScope | null; machineIds: readonly string[]; profileId?: string; presented: boolean;
}>) {
  const execution = useMountedActionExecution(input.scope);
  const [refreshKey, refresh] = React.useReducer((value: number) => value + 1, 0);
  const machineKey = JSON.stringify([...new Set(input.machineIds)].sort());
  const machineIds = React.useMemo<readonly string[]>(() => [...new Set(input.machineIds)].sort(), [machineKey]);
  const scope = input.scope;
  // One open lists each held Machine once. The held set grows as Installed learns its Machines, so a new
  // Machine adds one request; only a different Account, profile, refresh or close starts the list over.
  const basis = JSON.stringify([scope?.serverId, scope?.accountId, input.profileId]);
  const openKey = JSON.stringify([basis, refreshKey, input.presented && execution.ready]);
  type Answer = readonly InstalledBrowserExtensionRow[] | BrowserExtensionInventoryFailure;
  const open = React.useRef<{ key: string; answers: Map<string, Answer>; pending: Map<string, AbortController>; published: string | null } | null>(null);
  const [snapshot, setSnapshot] = React.useState<Readonly<{ basis: string; result: NativeInventory }> | null>(null);
  const latest = React.useRef(snapshot);
  latest.current = snapshot;
  const machinesRef = React.useRef(machineIds);
  machinesRef.current = machineIds;
  const publish = React.useCallback((answers: ReadonlyMap<string, Answer>) => {
    const held = machinesRef.current;
    // Until a Machine answers in this open, its last settled rows stay (a refresh never flashes empty).
    const previous = latest.current?.basis === basis ? latest.current.result.rows : EMPTY_ROWS;
    const rows = held.flatMap(machineId => {
      const answer = answers.get(machineId);
      return answer === undefined ? previous.filter(row => row.machineId === machineId) : Array.isArray(answer) ? answer : [];
    });
    const failures = held.flatMap(machineId => {
      const answer = answers.get(machineId);
      return answer === undefined || Array.isArray(answer) ? [] : [answer as BrowserExtensionInventoryFailure];
    });
    const coverage: NativeInventory['coverage'] = held.some(machineId => !answers.has(machineId)) ? 'loading'
      : failures.length === 0 ? 'available' : failures.length === held.length ? { unavailable: failures } : { partial: failures };
    setSnapshot(previous => {
      if (previous?.basis !== basis) return { basis, result: { rows, coverage, continuation: refresh } };
      return retainDeep(previous, { basis, result: {
        rows: retainKeyedRows(previous.result.rows, rows, row => row.key), coverage, continuation: refresh,
      } });
    });
  }, [basis]);
  // A different basis, a refresh or a close ends the open: its pending Machine reads stop.
  React.useEffect(() => () => {
    for (const controller of open.current?.pending.values() ?? []) controller.abort();
    open.current = null;
  }, [openKey]);
  React.useEffect(() => {
    if (!input.presented || !scope || !execution.ready) return;
    if (open.current?.key !== openKey) open.current = { key: openKey, answers: new Map(), pending: new Map(), published: null };
    const current = open.current;
    for (const [machineId, controller] of current.pending) {
      if (!machineIds.includes(machineId)) { controller.abort(); current.pending.delete(machineId); }
    }
    const missing = machineIds.filter(machineId => !current.answers.has(machineId) && !current.pending.has(machineId));
    if (missing.length === 0) {
      // Only a changed held set (a Machine left) has something new to show.
      if (current.pending.size === 0 && current.published !== machineKey) { current.published = machineKey; publish(current.answers); }
      return;
    }
    for (const machineId of missing) {
      const controller = new AbortController();
      current.pending.set(machineId, controller);
      void (async (): Promise<Answer> => {
        try {
          const response = await execution.execute('browser.extensions.list', { machineId,
            ...(input.profileId === undefined ? {} : { profileId: input.profileId }) },
          { signal: controller.signal, externalActionTarget: { kind: 'machine', machineId } });
          // A refusing Machine (offline, not reachable) settles as its own typed failure; nothing retries it.
          if (!response.ok) return { machineId, reason: { kind: 'action' as const, code: response.errorCode } };
          const parsed = BrowserExtensionsListResultV1Schema.safeParse(response.result);
          if (!parsed.success) return { machineId, reason: { kind: 'invalid_response' as const } };
          // A Machine whose managed browser isn't available stays a typed failure (REVIEW-2 R4): its persisted
          // profiles may hold extensions the read could not reach, so it is never an empty inventory.
          if (parsed.data.status === 'unavailable') return { machineId, reason: { kind: 'browser' as const, value: parsed.data } };
          const extensions = parsed.data.entries.map((native): InstalledBrowserExtensionRow => ({ kind: 'browserExtension', subject: 'extension',
            key: serverAccountScopedResourceKey(scope, 'browserExtension', machineId, native.profileId, native.extension.id), scope, machineId, native }));
          // One profile's own list needs no profile rows; the whole list names each saved profile that has no extension yet.
          if (input.profileId !== undefined) return extensions;
          const holding = new Set(parsed.data.entries.map(entry => entry.profileId));
          const profiles = (parsed.data.profiles ?? []).filter(profile => !holding.has(profile.profileId))
            .map((native): InstalledBrowserExtensionRow => ({ kind: 'browserExtension', subject: 'profile',
              key: serverAccountScopedResourceKey(scope, 'browserProfile', machineId, native.profileId), scope, machineId, native }));
          return [...extensions, ...profiles];
        } catch { return { machineId, reason: { kind: 'transport' as const } }; }
      })().then(answer => {
        if (open.current !== current || controller.signal.aborted) return;
        current.pending.delete(machineId);
        current.answers.set(machineId, answer);
        // The first answer of a refresh keeps the others' last rows; publish once something is known.
        const previous = latest.current?.basis === basis ? latest.current.result.rows : EMPTY_ROWS;
        if (current.pending.size === 0) current.published = machineKey;
        if (current.pending.size === 0 || Array.isArray(answer) && answer.length > 0 || previous.length === 0) publish(current.answers);
      });
    }
  }, [openKey, machineKey, input.presented, scope, execution.ready, execution.execute, machineIds, input.profileId, basis, publish]);
  // A refresh of the same list keeps its last settled rows on screen until the new answer lands.
  const result: NativeInventory = input.presented && scope && snapshot?.basis === basis
    ? snapshot.result : { rows: EMPTY_ROWS, coverage: 'loading', continuation: refresh };
  return { ...result, refresh, execution };
}

type InstalledReason = NonNullable<InstalledScopeAdmission['failure']>
  | NonNullable<ReturnType<typeof useInstalledMachines>['failure']>
  | NonNullable<ReturnType<typeof useInstalledMachines>['snapshot']>
  | readonly BrowserExtensionInventoryFailure[];
export type InstalledBrowserExtensionsResult = InstalledFamilyResult<InstalledBrowserExtensionRow, InstalledReason, () => void>;

/** Extensions belong to persistent profiles on held Machines, with no Project membership claim. */
export function useInstalledBrowserExtensions(input: StoreInstalledInput, demand: StoreDemand,
  admitted: InstalledScopeAdmission): InstalledBrowserExtensionsResult {
  const held = useInstalledMachines(input, demand, admitted.scope);
  const presented = demand.presented && !input.projectKey && held.snapshot?.kind === 'resolved' && !held.failure;
  // Reads match need: only Machines the presence owner reports reachable are asked. The rest settle at once as the
  // refusal the Home would send, and a Machine that comes online (presence push) joins with one read of its own.
  const presenceNowMs = useMachinePresenceNowMs(held.machines);
  const reachability = React.useMemo(() => {
    const reachable: string[] = [];
    const offline: BrowserExtensionInventoryFailure[] = [];
    for (const machine of held.machines) {
      if (resolveMachineReachability(admitted.scope, machine, presenceNowMs) === 'unreachable') {
        offline.push({ machineId: machine.id, reason: { kind: 'action', code: 'target_unavailable' } });
      } else reachable.push(machine.id);
    }
    return { reachable, offline };
  }, [admitted.scope, held.machines, presenceNowMs]);
  const native = useBrowserExtensionsInventory({ scope: admitted.scope, presented, machineIds: reachability.reachable });
  if (!admitted.scope) return { rows: EMPTY_ROWS, coverage: admitted.coverage };
  if (!demand.presented) return { rows: EMPTY_ROWS, coverage: 'loading' };
  if (input.projectKey) return { rows: EMPTY_ROWS, coverage: 'available' };
  if (held.failure) return { rows: EMPTY_ROWS, coverage: { unavailable: held.failure } };
  if (!held.snapshot) return { rows: EMPTY_ROWS, coverage: 'loading' };
  if (held.snapshot.kind !== 'resolved') return { rows: EMPTY_ROWS, coverage: { unavailable: held.snapshot } };
  if (native.coverage === 'loading') return native;
  const answered = typeof native.coverage === 'object' ? 'partial' in native.coverage ? native.coverage.partial
    : 'unavailable' in native.coverage ? native.coverage.unavailable : [] : [];
  const failures: readonly BrowserExtensionInventoryFailure[] = [...answered as readonly BrowserExtensionInventoryFailure[], ...reachability.offline];
  const coverage: InstalledBrowserExtensionsResult['coverage'] = failures.length === 0 ? 'available'
    : failures.length === held.machines.length ? { unavailable: failures } : { partial: failures };
  if (coverage === 'available' && (held.snapshot.settled !== true || held.snapshot.observation !== 'live')) {
    return { rows: native.rows, coverage: { partial: held.snapshot }, continuation: native.refresh };
  }
  return { ...native, coverage };
}
