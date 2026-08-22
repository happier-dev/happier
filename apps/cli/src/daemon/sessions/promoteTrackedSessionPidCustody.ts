import { logger } from '@/ui/logger';

import {
  promoteSessionMarkerPid,
  readExactSessionMarkerOwnership,
  removeSessionMarkerIfOwned,
  type SessionMarkerOwnership,
} from '../sessionRegistry';
import type { TrackedSession } from '../types';

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
    pidToTrackedSession: Map<number, TrackedSession>;
    spawnResourceCleanupByPid: Map<
      number,
      () => void | Promise<void>
    >;
    sessionAttachCleanupByPid: Map<
      number,
      () => Promise<void>
    >;
    promoteSessionMarkerFn?: typeof promoteSessionMarkerPid;
    removeSessionMarkerIfOwnedFn?: typeof removeSessionMarkerIfOwned;
    requireExactTargetOwnership?: boolean;
    expectedTargetProcessIdentity?: Readonly<{
      processStartTimeMs: number;
      processCommandHash: string;
    }>;
    targetMarkerAlreadyPersisted?: boolean;
    readExactTargetMarkerOwnershipFn?:
      typeof readExactSessionMarkerOwnership;
    removeSourceMarker?: (
      ownership: SessionMarkerOwnership,
      isStillOwned: () => boolean,
    ) => Promise<void>;
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
    pidToTrackedSession,
    spawnResourceCleanupByPid,
    sessionAttachCleanupByPid,
    promoteSessionMarkerFn = promoteSessionMarkerPid,
    removeSessionMarkerIfOwnedFn = removeSessionMarkerIfOwned,
    requireExactTargetOwnership = false,
    expectedTargetProcessIdentity,
    targetMarkerAlreadyPersisted = false,
    readExactTargetMarkerOwnershipFn =
      readExactSessionMarkerOwnership,
    removeSourceMarker,
    onPidPromoted,
  } = params;
  const inFlightPromotion =
    tracked.sessionMarkerPidPromotion;
  if (inFlightPromotion) {
    return (
      await inFlightPromotion
      && pidToTrackedSession.get(toPid) === tracked
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
      pidToTrackedSession.has(toPid)
      || spawnResourceCleanupByPid.has(toPid)
      || sessionAttachCleanupByPid.has(toPid);
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
          pid: toPid,
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
          await promoteSessionMarkerFn(fromPid, toPid);
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
      const ownership = markerPromotion?.targetMarkerOwnership;
      if (!ownership) return;
      try {
        await removeSessionMarkerIfOwnedFn({
          pid: toPid,
          ...ownership,
          isStillOwned: () =>
            pidToTrackedSession.get(fromPid) === tracked,
        });
      } catch (error) {
        logger.debug(
          '[DAEMON RUN] Failed to roll back refused target session marker promotion',
          { fromPid, toPid, error },
        );
      }
    };

    if (
      pidToTrackedSession.get(fromPid) !== tracked
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
      && (
        !targetMarkerOwnership?.processCommandHash
        || targetMarkerOwnership.processStartTimeMs === undefined
      )
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
      && (
        targetMarkerOwnership?.processStartTimeMs
          !== expectedTargetProcessIdentity
            .processStartTimeMs
        || targetMarkerOwnership?.processCommandHash
          !== expectedTargetProcessIdentity
            .processCommandHash
      )
    ) {
      await rollbackTargetMarker();
      logger.debug(
        '[DAEMON RUN] Promoted target marker did not match captured process identity; retaining source custody',
        { fromPid, toPid },
      );
      return false;
    }

    if (
      pidToTrackedSession.get(fromPid) !== tracked
      || targetHasCustody()
    ) {
      await rollbackTargetMarker();
      logger.debug(
        '[DAEMON RUN] PID ownership changed during marker custody promotion; preserving source custody',
        { fromPid, toPid },
      );
      return false;
    }

    const spawnCleanup =
      spawnResourceCleanupByPid.get(fromPid);
    if (spawnCleanup) {
      spawnResourceCleanupByPid.delete(fromPid);
      spawnResourceCleanupByPid.set(toPid, spawnCleanup);
    }
    const attachCleanup =
      sessionAttachCleanupByPid.get(fromPid);
    if (attachCleanup) {
      sessionAttachCleanupByPid.delete(fromPid);
      sessionAttachCleanupByPid.set(toPid, attachCleanup);
    }
    pidToTrackedSession.delete(fromPid);
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
      ...(
        tracked.spawnStartupAwaiterPid !== undefined
        || !targetMarkerSessionId
        || isPidPlaceholderSessionId(targetMarkerSessionId)
          ? {
              spawnStartupAwaiterPid:
                tracked.spawnStartupAwaiterPid ?? fromPid,
            }
          : { spawnStartupAwaiterPid: undefined }
      ),
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
    pidToTrackedSession.set(toPid, tracked);
    onPidPromoted?.({
      fromPid,
      toPid,
      trackedSession: tracked,
    });

    if (
      markerPromotion.sourceMarkerOwnership
      && !pidToTrackedSession.has(fromPid)
    ) {
      try {
        const isStillOwned = () =>
          pidToTrackedSession.get(toPid) === tracked;
        if (removeSourceMarker) {
          await removeSourceMarker(
            markerPromotion.sourceMarkerOwnership,
            isStillOwned,
          );
        } else {
          await removeSessionMarkerIfOwnedFn({
            pid: fromPid,
            ...markerPromotion.sourceMarkerOwnership,
            isStillOwned,
          });
        }
      } catch (error) {
        logger.debug(
          '[DAEMON RUN] Failed to remove superseded source session marker after promotion',
          error,
        );
      }
    }
    promotionSucceeded = true;
    return true;
  } finally {
    resolvePromotion(promotionSucceeded);
    if (tracked.sessionMarkerPidPromotion === promotionPromise) {
      delete tracked.sessionMarkerPidPromotion;
    }
  }
}
