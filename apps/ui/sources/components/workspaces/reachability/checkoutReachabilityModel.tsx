import * as React from 'react';
import { useSessionListRuntimeDeadlineNowMs } from '@/hooks/session/sessionListRuntimeClock';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { useHostActivelyViewed } from '@/utils/runtime/useHostActivelyViewed';
import { readLastSeenRefreshAtMs } from '@/utils/sessions/sessionUtils';

import { useMachinePresenceSummary } from '@/components/sessions/model/useMachinePresenceSummary';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { workspaceScopeFromProject } from '@/sync/domains/workspaces/workspaceScope';
import { t } from '@/text';
import { describeMachinePresenceSummary, type MachineRuntimePresence } from '@/utils/sessions/machinePresenceLine';

// The checkout-reachability facts and their one sentence, without any rendering, so a hook or an
// opener (the Computer menu item) consumes them without loading the state components.

/** The machine a checkout lives on: reachability is a fact of the machine, not of the folder. */
export type CheckoutMachineScope = Readonly<{
  serverId: string;
  machineId: string;
  /** An attached workspace is reached through this Machine (its controller) rather than living on it. */
  workspace?: Readonly<{ kind: 'managed' }>;
}>;

/**
 * One checkout-reachability state. When the machine a checkout lives on isn't answering, the page
 * that owns the checkout says so once, with when it was last seen and Retry
 * ({@link CheckoutReachabilityLine}); every surface beneath it (Code, Local changes, Scripts, README,
 * the Git pane) inherits that and shows a quiet {@link CheckoutUnreachableState} instead of failing
 * on its own. A surface with no announcing page above it (a Session's Files pane) says it itself,
 * once, with its own Retry.
 *
 * `unknown` reachability (the machine record isn't visible from here, e.g. a shared Session) is never
 * presented as offline.
 */
export type CheckoutReachability = Readonly<{
  unreachable: boolean;
  runtime: MachineRuntimePresence;
  machineName: string;
  lastSeenAt: number | null;
  /** A page above already says it; this surface only inherits. */
  announced: boolean;
  /** The checkout is an attached workspace reached through this Machine: it recovers when the Machine is back. */
  reachedThrough?: boolean;
}>;

/**
 * The Machine a Project's checkout is read through: its own Machine, or, for an attached workspace, the controller
 * it is reached via (a managed ref has no Machine of its own). The page announces this Machine, so the surfaces
 * beneath, which read through the same scope, inherit its offline line.
 */
export function checkoutMachineScopeOfProject(ref: WorkspaceRefV1): CheckoutMachineScope {
  const { serverId, machineId, workspace } = workspaceScopeFromProject(ref, ref.rootPath);
  return { serverId, machineId, ...(workspace ? { workspace } : {}) };
}

const AnnouncedCheckoutMachine =
  React.createContext<CheckoutMachineScope | null>(null);

/** Declares that this subtree's page announces its checkout machine's reachability. */
export function CheckoutReachabilityScope(
  props: Readonly<{ scope: CheckoutMachineScope; children: React.ReactNode }>,
) {
  const { serverId, machineId } = props.scope;
  const scope = React.useMemo(
    () => ({ serverId, machineId }),
    [serverId, machineId],
  );
  return (
    <AnnouncedCheckoutMachine.Provider value={scope}>
      {props.children}
    </AnnouncedCheckoutMachine.Provider>
  );
}

/** The checkout machine the page above announces, for a surface that only knows it sits under it. */
export function useAnnouncedCheckoutMachine(): CheckoutMachineScope | null {
  return React.useContext(AnnouncedCheckoutMachine);
}

export function useCheckoutReachability(
  scope: CheckoutMachineScope | null,
): CheckoutReachability {
  const presence = useMachinePresenceSummary(scope?.serverId, scope?.machineId);
  return useCheckoutReachabilityPresentation(scope, presence);
}

/** A surface already holding the selected Machine summary shares the announcement without another subscription. */
export function useCheckoutReachabilityPresentation(
  scope: CheckoutMachineScope | null,
  presence: Parameters<typeof describeMachinePresenceSummary>[0],
): CheckoutReachability {
  const announcedScope = React.useContext(AnnouncedCheckoutMachine);
  const baseRuntime = React.useMemo(() => describeMachinePresenceSummary(presence), [presence]);
  const lastSeenAt = baseRuntime.showStatus ? (presence.lastSeenAt ?? null) : null;
  const readNextRefreshAtMs = React.useCallback((nowMs: number) =>
    baseRuntime.nativeWord || presence.presenceOnline !== false || lastSeenAt === null
      ? null : readLastSeenRefreshAtMs(lastSeenAt, nowMs),
  [baseRuntime.nativeWord, lastSeenAt, presence.presenceOnline]);
  const presented = useLayoutPresentationActive();
  const viewed = useHostActivelyViewed();
  const nowMs = useSessionListRuntimeDeadlineNowMs(readNextRefreshAtMs, presented && viewed);
  const runtime = React.useMemo(() => describeMachinePresenceSummary(presence, nowMs), [presence, nowMs]);
  const unreachable = runtime.showStatus;
  // Every use of this name is inside a sentence, so a Machine still loading reads "this machine", never "Loading…".
  const machineName = presence.sentenceName ?? scope?.machineId ?? '';
  const reachedThrough = scope?.workspace?.kind === 'managed';
  const announced =
    unreachable &&
    scope != null &&
    announcedScope?.serverId === scope.serverId &&
    announcedScope.machineId === scope.machineId;
  return React.useMemo(
    () => ({ unreachable, machineName, lastSeenAt, announced, reachedThrough, runtime }),
    [unreachable, machineName, lastSeenAt, announced, reachedThrough, runtime],
  );
}

/**
 * Presence is pushed by the machine; Retry asks the server for the machine's current state now. The one
 * Retry of every "machine isn't answering" line (a checkout's page, a Session's Work pane).
 */
// Loaded on press: the states that offer Retry stay leaf modules without the sync engine's graph.
export async function retryMachineReachability(): Promise<unknown> {
  const { sync } = await import('@/sync/sync');
  return sync.refreshMachinesThrottled({ staleMs: 0, force: true });
}

/**
 * The one sentence for an unreachable checkout Machine ("devbox is out of reach"), or a managed
 * Machine's own state ("Stopped"). It is the title of the shared state and the reason on every control
 * the Machine's absence disables, so one cause reads the same everywhere.
 */
export function describeCheckoutUnreachable(reachability: CheckoutReachability): string {
  return reachability.runtime.nextAction === 'retry'
    ? t('projects.checkouts.outOfReach', { machine: reachability.machineName })
    : reachability.runtime.label;
}

/**
 * How a checkout read with nothing to show defers to its Machine's presence (Files root, a Review diff row, the README):
 * an unreachable Machine is that one state, and a Machine whose presence has not answered yet is still loading, so
 * neither reads as the read's own failure. `attributed`: the read knows which Machine it waits for. Null: the read's
 * own result stands.
 */
export function resolveCheckoutReadPresence(
  reachability: CheckoutReachability,
  attributed: boolean,
): 'unreachable' | 'pending' | null {
  if (reachability.unreachable) return 'unreachable';
  return attributed && reachability.runtime.status === 'unknown' ? 'pending' : null;
}
