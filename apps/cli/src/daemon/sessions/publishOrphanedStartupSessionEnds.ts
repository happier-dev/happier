import type { ExactSessionTurnEndMutationV1 } from '@happier-dev/protocol';
import type {
  MachineSessionTerminalAuthorityV1,
  MachineSessionTerminalCaptureResponseV1,
  MachineSessionTerminalFinalizeResponseV1,
} from '@happier-dev/protocol';
import { logger } from '@/ui/logger';

import {
  removeSessionMarker,
  removeSessionMarkerIfOwned,
} from '../sessionRegistry';
import { stageObservedExit } from './stageObservedExit';
import type { OrphanedDeadDaemonSession } from './reattachFromMarkers';
import { isSessionTerminalPermanentlyUnavailable } from './sessionTerminalSettlement';

export async function publishOrphanedStartupSessionEnds(params: Readonly<{
  serverId: string;
  apiMachine: {
    enqueueDaemonTerminalExactTurnEnd: (mutation: ExactSessionTurnEndMutationV1) => Promise<void>;
    captureMachineSessionTerminal: (sessionId: string) => Promise<MachineSessionTerminalCaptureResponseV1>;
    finalizeMachineSessionTerminal: (
      target: Readonly<{ sessionId: string; authority: MachineSessionTerminalAuthorityV1 }>,
    ) => Promise<MachineSessionTerminalFinalizeResponseV1>;
  };
  orphanedDeadDaemonSessions: ReadonlyArray<OrphanedDeadDaemonSession>;
  isSessionAlreadyRunning?: (sessionId: string) => Promise<boolean>;
  retireTerminalControlServiceability?: (marker: OrphanedDeadDaemonSession) => Promise<void>;
  isShuttingDown?: () => boolean;
  now?: () => number;
  removeSessionMarkerFn?: typeof removeSessionMarker;
  removeSessionMarkerIfOwnedFn?: typeof removeSessionMarkerIfOwned;
}>): Promise<ReadonlyArray<OrphanedDeadDaemonSession>> {
  const now = params.now ?? (() => Date.now());
  const isShuttingDown = (): boolean => params.isShuttingDown?.() === true;
  const groups = new Map<string, OrphanedDeadDaemonSession[]>();
  for (const orphan of params.orphanedDeadDaemonSessions) {
    if (orphan.requesterWorkAttributionV1 && orphan.requesterWorkAttributionV1.serverId !== params.serverId) {
      logger.debug('[DAEMON] Retaining orphan marker for another Home', { sessionId: orphan.sessionId });
      continue;
    }
    const group = groups.get(orphan.sessionId) ?? [];
    group.push(orphan);
    groups.set(orphan.sessionId, group);
  }
  const removeEvidence = async (evidence: readonly OrphanedDeadDaemonSession[]): Promise<boolean> => {
    for (const marker of evidence) {
      if (isShuttingDown()) return false;
      if (params.removeSessionMarkerFn) {
        await params.removeSessionMarkerFn(marker.trackingKey);
        continue;
      }
      await (params.removeSessionMarkerIfOwnedFn ?? removeSessionMarkerIfOwned)({
        trackingKey: marker.trackingKey,
        happySessionId: marker.sessionId,
        ...(marker.processCommandHash ? { processCommandHash: marker.processCommandHash } : {}),
        ...(marker.processStartTimeMs !== undefined
          ? { processStartTimeMs: marker.processStartTimeMs }
          : {}),
        isStillOwned: () => true,
      });
    }
    return true;
  };
  const retireEvidence = async (evidence: readonly OrphanedDeadDaemonSession[]): Promise<boolean> => {
    for (const marker of evidence) {
      if (isShuttingDown()) return false;
      await params.retireTerminalControlServiceability?.(marker);
    }
    return !isShuttingDown();
  };
  const stageEvidence = async (evidence: readonly OrphanedDeadDaemonSession[]): Promise<boolean> => {
    for (const marker of evidence) {
      if (isShuttingDown()) return false;
      await stageObservedExit({
        trackedSession: {
          happySessionId: marker.sessionId,
          pid: marker.pid,
          ...(marker.activeTurnId ? { activeTurnId: marker.activeTurnId } : {}),
        },
        observedAt: now(),
        enqueueExactTurnEnd: (mutation) => params.apiMachine.enqueueDaemonTerminalExactTurnEnd(mutation),
        releaseMarkerEvidence: async () => undefined,
      });
    }
    return true;
  };

  const settledMarkers = new Set<OrphanedDeadDaemonSession>();
  await Promise.all(Array.from(groups, async ([sessionId, evidence]) => {
    try {
      if (isShuttingDown()) return;
      // Retained evidence can outlive startup and a subsequent Session resume.
      // Reuse the current runner owner before capturing terminal authority.
      if (evidence.some((marker) => marker.recoveredLiveSession === true)
        || await params.isSessionAlreadyRunning?.(sessionId)) {
        if (!await stageEvidence(evidence)) return;
        if (await removeEvidence(evidence)) evidence.forEach(marker => settledMarkers.add(marker));
        return;
      }
      if (isShuttingDown()) return;
      const captured = await params.apiMachine.captureMachineSessionTerminal(sessionId);
      if (captured.status === 'rejected') {
        if (isSessionTerminalPermanentlyUnavailable(captured.reason)) {
          // The Session or peer cannot accept terminal retirement; repeating it
          // cannot acquire authority. Only the dead runner's marker is released.
          if (await removeEvidence(evidence)) evidence.forEach(marker => settledMarkers.add(marker));
          return;
        }
        logger.debug('[DAEMON] Startup orphan terminal capture was not accepted; retaining marker evidence', {
          sessionId,
          markerPids: evidence.map((marker) => marker.pid),
          status: captured.status,
          reason: captured.reason,
        });
        return;
      }
      if (!await stageEvidence(evidence)) return;
      if (captured.status === 'already_inactive') {
        if (!await retireEvidence(evidence)) return;
        if (await removeEvidence(evidence)) evidence.forEach(marker => settledMarkers.add(marker));
        return;
      }
      if (isShuttingDown()) return;
      if (await params.isSessionAlreadyRunning?.(sessionId)) {
        if (await removeEvidence(evidence)) evidence.forEach(marker => settledMarkers.add(marker));
        return;
      }
      if (isShuttingDown()) return;
      const finalized = await params.apiMachine.finalizeMachineSessionTerminal({
        sessionId: captured.sessionId,
        authority: captured.authority,
      });
      if (finalized.status === 'rejected') {
        if (isSessionTerminalPermanentlyUnavailable(finalized.reason)) {
          if (await removeEvidence(evidence)) evidence.forEach(marker => settledMarkers.add(marker));
          return;
        }
        logger.debug('[DAEMON] Startup orphan terminal finalize was not accepted; retaining marker evidence', {
          sessionId,
          markerPids: evidence.map((marker) => marker.pid),
          status: finalized.status,
          reason: finalized.reason,
        });
        return;
      }
      if (isShuttingDown()) return;
      if (!await retireEvidence(evidence)) return;
      if (await removeEvidence(evidence)) evidence.forEach(marker => settledMarkers.add(marker));
    } catch (error) {
      logger.debug('[DAEMON] Startup orphan settlement failed; retaining marker evidence', {
        sessionId,
        markerPids: evidence.map((marker) => marker.pid),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }));
  return params.orphanedDeadDaemonSessions.filter((marker) => !settledMarkers.has(marker));
}
