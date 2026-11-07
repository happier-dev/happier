import * as React from 'react';
import { isMachineReplaced } from '@happier-dev/protocol/machines/identity/canonicalMachineId';

import type { ActivityAttentionSource } from '@/activity/source/activityAttentionSourceTypes';
import {
  forEachActivitySummaryCandidate,
  isActivityCandidateAwaitingPerson,
} from '@/activity/source/buildActivityOverviewFromSource';
import { buildActivityOverviewSummaryFromSource } from '@/activity/source/buildActivityOverviewFromSource';
import { useActivitySourceProjection, type ActivitySourceProjectionInput } from '@/activity/source/useActivityOverview';
import { useThisComputerMachineId } from '@/components/machines/add/useMachineAddPaths';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import {
  resolveDisplayMachineIdForSessionFromState,
  type SessionMachineTargetState,
} from '@/sync/domains/session/resolveMachineTargetForSessionFromState';
import { useActiveMachineFacts } from '@/sync/domains/state/storage';
import { retainDeep } from '@/sync/domains/state/structuralSharing';
import { resolveMachineDisplayNames } from '@/utils/sessions/machineDisplayNames';
import { useMachinePresenceSummaries } from '@/sync/domains/machines/reachability/useMachinePresenceSummary';

import {
  buildYourHomeModel,
  type YourHomeModel,
  type YourHomeSessionState,
} from './yourHomeModel';

/**
 * Each machine's sessions on this Home, as the Activity summary's own walk classifies them: needs
 * you (its one "needs you" rule), working (its `isThinking`), else idle while the session is live.
 * A second projection of the one classifier, grouped by the machine the session runs on (the same
 * resolution as the machines' working counts), never a second definition of either state.
 */
export function buildYourHomeSessionStates(
  params: Readonly<{
    source: ActivityAttentionSource;
    nowMs: number;
    serverId: string;
    state: SessionMachineTargetState;
  }>,
): ReadonlyMap<string, readonly YourHomeSessionState[]> {
  const byMachine = new Map<string, YourHomeSessionState[]>();
  forEachActivitySummaryCandidate(
    { ...params, includeWarmSourceWhenNotReady: true },
    ({ entry, candidate }) => {
      if (entry.address.serverId !== params.serverId) return;
      const state: YourHomeSessionState | null =
        isActivityCandidateAwaitingPerson(candidate)
          ? 'need'
          : candidate.reasons.isThinking
            ? 'work'
            : entry.session.active
              ? 'idle'
              : null;
      if (!state) return;
      const machineId = resolveDisplayMachineIdForSessionFromState({
        state: params.state,
        serverId: entry.address.serverId,
        sessionId: entry.address.sessionId,
        metadata: readSessionOwnerMetadataView(entry.session),
      });
      if (!machineId) return;
      const states = byMachine.get(machineId);
      if (states) states.push(state);
      else byMachine.set(machineId, [state]);
    },
  );
  return byMachine;
}

const NO_SESSIONS: readonly YourHomeSessionState[] = Object.freeze([]);

type YourHomeActivity = Readonly<{
  statesByMachine: Readonly<Record<string, readonly YourHomeSessionState[]>>;
  nextAttentionBoundaryMs: number | null;
}>;

/**
 * Each machine's session states, projected on the Activity summary's boundary clock by the shared
 * selector owner: a Session write that moves no machine's states keeps the published projection, so it
 * renders no Your Home consumer.
 */
function useYourHomeActivity(serverId: string): YourHomeActivity {
  const project = React.useCallback(({ source, nowMs, state }: ActivitySourceProjectionInput): YourHomeActivity => ({
    statesByMachine: Object.fromEntries(buildYourHomeSessionStates({
      source, nowMs, serverId, state: state as SessionMachineTargetState,
    })),
    nextAttentionBoundaryMs: buildActivityOverviewSummaryFromSource({
      source, nowMs, includeWarmSourceWhenNotReady: true,
    }).nextAttentionBoundaryMs,
  }), [serverId]);
  return useActivitySourceProjection(project, retainDeep);
}

/** The active Home's machines and their sessions, on the Activity summary's boundary clock. */
export function useYourHomeModel(): YourHomeModel {
  const serverId = useActiveServerSnapshot().serverId;
  const { statesByMachine } = useYourHomeActivity(serverId);
  const allMachines = useActiveMachineFacts();
  // A replaced identity (the same computer before a reinstall) is not a machine to show or count.
  const machines = React.useMemo(
    () => allMachines.filter((machine) => !isMachineReplaced(machine)),
    [allMachines],
  );
  const machineIds = React.useMemo(() => machines.map(machine => machine.id), [machines]);
  const presence = useMachinePresenceSummaries(serverId, machineIds);
  const names = React.useMemo(
    () => resolveMachineDisplayNames(machines),
    [machines],
  );
  const thisComputerId = useThisComputerMachineId();
  // A machine heartbeat republishes the facts list; the model keeps its identity while it reads the same.
  const published = React.useRef<YourHomeModel | undefined>(undefined);
  return React.useMemo(() => {
    published.current = retainDeep(published.current, buildYourHomeModel(
      machines.map((machine, index) => {
        const reachability = presence[index]?.reachability ?? 'unknown';
        const online = reachability === 'unknown' ? null : reachability === 'reachable';
        return {
          id: machine.id,
          name: names.get(machine.id) ?? machine.id,
          online,
          lastSeenAt: online === false ? (presence[index]?.lastSeenAt ?? null) : null,
          isThisComputer: machine.id === thisComputerId,
          sessions: statesByMachine[machine.id] ?? NO_SESSIONS,
        };
      }),
    ));
    return published.current;
  }, [machines, names, statesByMachine, thisComputerId, presence]);
}
