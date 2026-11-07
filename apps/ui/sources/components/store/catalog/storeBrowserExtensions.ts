import * as React from 'react';
import { BrowserExtensionsListResultV1Schema, type BrowserExtensionsListResultV1, type BrowserProfileExtensionV1,
  type BrowserExtensionActionResultV1, type BROWSER_EXTENSION_ACTION_INPUT_SCHEMAS } from '@happier-dev/protocol/actions';
import type { z } from 'zod/mini';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { serverAccountScopedResourceKey, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { useInstalledMachines } from './storeInstalled';
import type { InstalledScopeAdmission } from './storeAccountAdmission';
import type { InstalledFamilyResult, StoreDemand, StoreInstalledInput } from './storeKinds';

export type InstalledBrowserExtensionRow = Readonly<{
  kind: 'browserExtension'; key: string; scope: ServerAccountScope; machineId: string; native: BrowserProfileExtensionV1;
}>;
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
  const key = JSON.stringify([scope?.serverId, scope?.accountId, machineKey, input.profileId, refreshKey]);
  const [snapshot, setSnapshot] = React.useState<Readonly<{ key: string; result: NativeInventory }> | null>(null);
  React.useEffect(() => {
    if (!input.presented || !scope || !execution.ready) return;
    const controller = new AbortController();
    let active = true;
    void Promise.all(machineIds.map(async machineId => {
      try {
        const response = await execution.execute('browser.extensions.list', { machineId,
          ...(input.profileId === undefined ? {} : { profileId: input.profileId }) },
        { signal: controller.signal, externalActionTarget: { kind: 'machine', machineId } });
        if (!response.ok) return { machineId, reason: { kind: 'action' as const, code: response.errorCode } };
        const parsed = BrowserExtensionsListResultV1Schema.safeParse(response.result);
        if (!parsed.success) return { machineId, reason: { kind: 'invalid_response' as const } };
        if (parsed.data.status === 'unavailable') return { machineId, reason: { kind: 'browser' as const, value: parsed.data } };
        return parsed.data.entries.map((native): InstalledBrowserExtensionRow => ({ kind: 'browserExtension',
          key: serverAccountScopedResourceKey(scope, 'browserExtension', machineId, native.profileId, native.extension.id), scope, machineId, native }));
      } catch { return { machineId, reason: { kind: 'transport' as const } }; }
    })).then(results => {
      if (!active) return;
      const rows = results.flatMap(result => Array.isArray(result) ? result : []);
      const failures = results.flatMap(result => Array.isArray(result) ? [] : [result]);
      setSnapshot({ key, result: { rows, coverage: failures.length === 0 ? 'available'
        : failures.length === machineIds.length ? { unavailable: failures } : { partial: failures }, continuation: refresh } });
    });
    return () => { active = false; controller.abort(); };
  }, [input.presented, scope, execution.ready, execution.execute, machineIds, input.profileId, key]);
  const result: NativeInventory = input.presented && scope && snapshot?.key === key
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
  const native = useBrowserExtensionsInventory({ scope: admitted.scope, presented,
    machineIds: held.machines.map(machine => machine.id) });
  if (!admitted.scope) return { rows: EMPTY_ROWS, coverage: admitted.coverage };
  if (!demand.presented) return { rows: EMPTY_ROWS, coverage: 'loading' };
  if (input.projectKey) return { rows: EMPTY_ROWS, coverage: 'available' };
  if (held.failure) return { rows: EMPTY_ROWS, coverage: { unavailable: held.failure } };
  if (!held.snapshot) return { rows: EMPTY_ROWS, coverage: 'loading' };
  if (held.snapshot.kind !== 'resolved') return { rows: EMPTY_ROWS, coverage: { unavailable: held.snapshot } };
  if (native.coverage === 'available' && (held.snapshot.settled !== true || held.snapshot.observation !== 'live')) {
    return { rows: native.rows, coverage: { partial: held.snapshot }, continuation: native.refresh };
  }
  return native;
}
