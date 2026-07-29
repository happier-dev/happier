import type { ExactSessionTurnEndMutationV1 } from '@happier-dev/protocol';
import type {
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

export async function publishOrphanedStartupSessionEnds(params: Readonly<{
  apiMachine: {
    enqueueDaemonTerminalExactTurnEnd: (mutation: ExactSessionTurnEndMutationV1) => Promise<void>;
    captureMachineSessionTerminal: (sessionId: string) => Promise<MachineSessionTerminalCaptureResponseV1>;
    finalizeMachineSessionTerminal: (
      target: Readonly<{ sessionId: string; committedFenceMs: number }>,
    ) => Promise<MachineSessionTerminalFinalizeResponseV1>;
  };
  orphanedDeadDaemonSessions: ReadonlyArray<OrphanedDeadDaemonSession>;
  isShuttingDown?: () => boolean;
  now?: () => number;
  removeSessionMarkerFn?: typeof removeSessionMarker;
  removeSessionMarkerIfOwnedFn?: typeof removeSessionMarkerIfOwned;
}>): Promise<void> {
  const now = params.now ?? (() => Date.now());
  const isShuttingDown = (): boolean => params.isShuttingDown?.() === true;
  const groups = new Map<string, OrphanedDeadDaemonSession[]>();
  for (const orphan of params.orphanedDeadDaemonSessions) {
    const group = groups.get(orphan.sessionId) ?? [];
    group.push(orphan);
    groups.set(orphan.sessionId, group);
  }
  const removeEvidence = async (evidence: readonly OrphanedDeadDaemonSession[]): Promise<boolean> => {
    for (const marker of evidence) {
      if (isShuttingDown()) return false;
      if (params.removeSessionMarkerFn) {
        await params.removeSessionMarkerFn(marker.pid);
        continue;
      }
      await (params.removeSessionMarkerIfOwnedFn ?? removeSessionMarkerIfOwned)({
        pid: marker.pid,
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

  await Promise.all(Array.from(groups, async ([sessionId, evidence]) => {
    try {
      if (evidence.some((marker) => marker.recoveredLiveSession === true)) {
        if (!await stageEvidence(evidence)) return;
        await removeEvidence(evidence);
        return;
      }
      if (isShuttingDown()) return;
      const captured = await params.apiMachine.captureMachineSessionTerminal(sessionId);
      if (captured.status !== 'captured') {
        if (captured.status !== 'already_inactive') {
          logger.debug('[DAEMON] Startup orphan terminal capture was not accepted; retaining marker evidence', {
            sessionId,
            markerPids: evidence.map((marker) => marker.pid),
            status: captured.status,
            reason: captured.reason,
          });
          return;
        }
      }
      if (!await stageEvidence(evidence)) return;
      if (captured.status === 'already_inactive') {
        await removeEvidence(evidence);
        return;
      }
      if (isShuttingDown()) return;
      const finalized = await params.apiMachine.finalizeMachineSessionTerminal({
        sessionId: captured.sessionId,
        committedFenceMs: captured.committedFenceMs,
      });
      if (finalized.status === 'rejected') {
        logger.debug('[DAEMON] Startup orphan terminal finalize was not accepted; retaining marker evidence', {
          sessionId,
          markerPids: evidence.map((marker) => marker.pid),
          status: finalized.status,
          reason: finalized.reason,
        });
        return;
      }
      if (isShuttingDown()) return;
      await removeEvidence(evidence);
    } catch (error) {
      logger.debug('[DAEMON] Startup orphan settlement failed; retaining marker evidence', {
        sessionId,
        markerPids: evidence.map((marker) => marker.pid),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }));
}
