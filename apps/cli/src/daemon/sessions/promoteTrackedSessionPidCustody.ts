import { logger } from '@/ui/logger';
import { processIdentityMatches } from '@happier-dev/cli-common/processInstance';

import {
  promoteSessionMarkerPid,
  readExactSessionMarkerOwnership,
} from '../sessionRegistry';
import type { TrackedSession } from '../types';
import {
  isCurrentTrackedSession,
  trackedSessionsForProcess,
  type TrackedSessionMap,
} from '@/daemon/sessions/sessionTrackingKey';

function normalizeSessionId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isPidPlaceholderSessionId(value: string): boolean {
  return /^PID-\d+$/.test(value);
}

export async function promoteTrackedSessionPidCustody(
  params: Readonly<{
    fromPid: number;
    toPid: number;
    trackedSession: TrackedSession;
    trackedSessionsByKey: TrackedSessionMap;
    promoteSessionMarkerFn?: typeof promoteSessionMarkerPid;
    requireExactTargetOwnership?: boolean;
    expectedTargetProcessIdentity?: Readonly<{
      processStartTimeMs: number;
      processCommandHash: string;
    }>;
    targetMarkerAlreadyPersisted?: boolean;
    readExactTargetMarkerOwnershipFn?:
      typeof readExactSessionMarkerOwnership;
    onPidPromoted?: (input: Readonly<{
      fromPid: number;
      toPid: number;
      trackedSession: TrackedSession;
    }>) => void;
  }>,
): Promise<boolean> {
  const {
    fromPid,
    toPid,
    trackedSession: tracked,
    trackedSessionsByKey,
    promoteSessionMarkerFn = promoteSessionMarkerPid,
    requireExactTargetOwnership = false,
    expectedTargetProcessIdentity,
    targetMarkerAlreadyPersisted = false,
    readExactTargetMarkerOwnershipFn =
      readExactSessionMarkerOwnership,
    onPidPromoted,
  } = params;
  // The Session keeps its key, its one marker and its key-addressed resource
  // cleanups; only its hosting pid moves.
  const ownsPid = (pid: number): boolean =>
    isCurrentTrackedSession(trackedSessionsByKey, tracked) && tracked.pid === pid;
  const inFlightPromotion =
    tracked.sessionMarkerPidPromotion;
  if (inFlightPromotion) {
    return (
      await inFlightPromotion
      && ownsPid(toPid)
    );
  }
  let resolvePromotion!: (promoted: boolean) => void;
  const promotionPromise = new Promise<boolean>((resolve) => {
    resolvePromotion = resolve;
  });
  tracked.sessionMarkerPidPromotion = promotionPromise;
  let promotionSucceeded = false;

  try {
    const targetHasCustody = (): boolean =>
      trackedSessionsForProcess(trackedSessionsByKey, toPid).some((other) => other !== tracked);
    if (targetHasCustody()) {
      logger.debug(
        '[DAEMON RUN] Target PID already has custody; retaining source PID custody',
        { fromPid, toPid },
      );
      return false;
    }

    let markerPromotion:
      Awaited<ReturnType<typeof promoteSessionMarkerPid>>;
    if (
      targetMarkerAlreadyPersisted
      && expectedTargetProcessIdentity
    ) {
      const exactMarker =
        await readExactTargetMarkerOwnershipFn({
          trackingKey: tracked.trackingKey,
          ownership: {
            happySessionId:
              normalizeSessionId(tracked.happySessionId)
              || `PID-${toPid}`,
            ...expectedTargetProcessIdentity,
          },
          ...(tracked.spawnOptions?.spawnNonce?.trim()
            ? {
                expectedSpawnNonce:
                  tracked.spawnOptions.spawnNonce.trim(),
              }
            : {}),
        });
      if (!exactMarker) {
        logger.debug(
          '[DAEMON RUN] Exact target session marker changed before PID transfer; retaining source custody',
          { fromPid, toPid },
        );
        return false;
      }
      markerPromotion = {
        sourceMarkerOwnership: null,
        targetMarkerOwnership: exactMarker.ownership,
        ...(exactMarker.processCommand
          ? { targetProcessCommand: exactMarker.processCommand }
          : {}),
      };
    } else {
      try {
        markerPromotion =
          await promoteSessionMarkerFn({
            trackingKey: tracked.trackingKey,
            fromPid,
            toPid,
          });
      } catch (error) {
        logger.debug(
          '[DAEMON RUN] Failed to promote session marker; retaining source PID custody',
          error,
        );
        return false;
      }
    }
    if (!markerPromotion) {
      logger.debug(
        '[DAEMON RUN] Session marker promotion was rejected; retaining source PID custody',
        { fromPid, toPid },
      );
      return false;
    }

    const rollbackTargetMarker = async (): Promise<void> => {
      if (!markerPromotion?.targetMarkerOwnership || !ownsPid(fromPid)) return;
      try {
        await promoteSessionMarkerFn({
          trackingKey: tracked.trackingKey,
          fromPid: toPid,
          toPid: fromPid,
        });
      } catch (error) {
        logger.debug(
          '[DAEMON RUN] Failed to roll back refused target session marker promotion',
          { fromPid, toPid, error },
        );
      }
    };

    if (
      !ownsPid(fromPid)
      || targetHasCustody()
    ) {
      await rollbackTargetMarker();
      logger.debug(
        '[DAEMON RUN] PID ownership changed during marker promotion; preserving source custody',
        { fromPid, toPid },
      );
      return false;
    }
    const targetMarkerOwnership =
      markerPromotion.targetMarkerOwnership;
    if (
      requireExactTargetOwnership
      && targetMarkerOwnership?.processStartTimeMs === undefined
    ) {
      await rollbackTargetMarker();
      logger.debug(
        '[DAEMON RUN] Promoted target lacks exact marker ownership; retaining source custody',
        { fromPid, toPid },
      );
      return false;
    }
    if (
      expectedTargetProcessIdentity
      && !processIdentityMatches({ pid: toPid, ...expectedTargetProcessIdentity }, {
        pid: toPid,
        processStartTimeMs: targetMarkerOwnership?.processStartTimeMs,
        processCommandHash: targetMarkerOwnership?.processCommandHash,
      })
    ) {
      await rollbackTargetMarker();
      logger.debug(
        '[DAEMON RUN] Promoted target marker did not match captured process identity; retaining source custody',
        { fromPid, toPid },
      );
      return false;
    }

    if (
      !ownsPid(fromPid)
      || targetHasCustody()
    ) {
      await rollbackTargetMarker();
      logger.debug(
        '[DAEMON RUN] PID ownership changed during marker custody promotion; preserving source custody',
        { fromPid, toPid },
      );
      return false;
    }

    const targetMarkerSessionId =
      normalizeSessionId(targetMarkerOwnership?.happySessionId);
    const currentSessionId =
      normalizeSessionId(tracked.happySessionId);
    const promotedSessionId =
      targetMarkerSessionId
      && (
        !isPidPlaceholderSessionId(targetMarkerSessionId)
        || !currentSessionId
        || isPidPlaceholderSessionId(currentSessionId)
      )
        ? targetMarkerSessionId
        : currentSessionId;
    Object.assign(tracked, {
      pid: toPid,
      sessionRunnerPid: undefined,
      childProcess: undefined,
      ...(targetMarkerOwnership
        ? {
            happySessionId: promotedSessionId,
            processCommandHash:
              targetMarkerOwnership.processCommandHash,
            processStartTimeMs:
              targetMarkerOwnership.processStartTimeMs,
            processCommand:
              markerPromotion.targetProcessCommand,
          }
        : {}),
    });
    onPidPromoted?.({
      fromPid,
      toPid,
      trackedSession: tracked,
    });

    promotionSucceeded = true;
    return true;
  } finally {
    resolvePromotion(promotionSucceeded);
    if (tracked.sessionMarkerPidPromotion === promotionPromise) {
      delete tracked.sessionMarkerPidPromotion;
    }
  }
}
