import * as React from 'react';

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
}>;

/**
 * The Machine a Project's checkout is read through: its own Machine, or, for an attached workspace, the controller
 * it is reached via (a managed ref has no Machine of its own). The page announces this Machine, so the surfaces
 * beneath, which read through the same scope, inherit its offline line.
 */
export function checkoutMachineScopeOfProject(ref: WorkspaceRefV1): CheckoutMachineScope {
  const { serverId, machineId } = workspaceScopeFromProject(ref, ref.rootPath);
  return { serverId, machineId };
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
  const runtime = React.useMemo(() => describeMachinePresenceSummary(presence), [presence]);
  const unreachable = runtime.showStatus;
  // Every use of this name is inside a sentence, so a Machine still loading reads "this machine", never "Loading…".
  const machineName = presence.sentenceName ?? scope?.machineId ?? '';
  const lastSeenAt = unreachable ? (presence.lastSeenAt ?? null) : null;
  const announced =
    unreachable &&
    scope != null &&
    announcedScope?.serverId === scope.serverId &&
    announcedScope.machineId === scope.machineId;
  return React.useMemo(
    () => ({ unreachable, machineName, lastSeenAt, announced, runtime }),
    [unreachable, machineName, lastSeenAt, announced, runtime],
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
