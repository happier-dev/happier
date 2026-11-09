import {
  applyExecutionRunLinkReportV1,
  readExecutionRunLinkV1,
  type ExecutionRunLinkReportV1,
  type SessionExecutionRunChildTurnReportV1Request,
  type SessionExecutionRunChildTurnReportV1Response,
} from '@happier-dev/protocol';

import { logger } from '@/ui/logger';

/**
 * The child half of a visible run (plan 2B, 2M). A Session whose metadata holds a run link wakes its
 * parent runner after each completed turn and confirms the link with a `linked` handshake. Reports
 * are wake-ups only; the parent reads this Session's transcript. The child records the outcome of
 * its own report (R21) through its own metadata writer.
 */
export function createExecutionRunChildReporter(params: Readonly<{
  sessionId: string;
  readMetadata: () => Record<string, unknown> | null;
  updateMetadata: (updater: (metadata: Record<string, unknown>) => Record<string, unknown>) => Promise<void>;
  reportToParent: (
    parentSessionId: string,
    request: SessionExecutionRunChildTurnReportV1Request,
  ) => Promise<SessionExecutionRunChildTurnReportV1Response | null>;
  getNowMs?: () => number;
  /**
   * Waits before each retry of a failed report. The child is the side that observes the failure, so
   * it keeps a bounded backoff (about 20 minutes in all) for a relay or server outage; the parent's
   * scheduled transcript re-reads cover a child that never reports. A newer turn supersedes a wait.
   */
  retryDelaysMs?: readonly number[];
}>) {
  const getNowMs = params.getNowMs ?? (() => Date.now());
  const retryDelaysMs = params.retryDelaysMs ?? [1_000, 4_000, 60_000, 300_000, 900_000];
  let linkKey: string | null = null;
  let turnEpoch = 0;
  let tail: Promise<void> = Promise.resolve();
  // A newer turn or link supersedes a report still waiting to retry.
  let generation = 0;
  let cancelRetryWait: (() => void) | null = null;
  const supersede = () => {
    generation += 1;
    cancelRetryWait?.();
  };
  const waitForRetry = (delayMs: number) => new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      cancelRetryWait = null;
      resolve();
    }, delayMs);
    timer.unref?.();
    cancelRetryWait = () => {
      clearTimeout(timer);
      cancelRetryWait = null;
      resolve();
    };
  });

  const currentLink = () => readExecutionRunLinkV1(params.readMetadata());

  const writeReport = async (runId: string, report: ExecutionRunLinkReportV1) => {
    await params.updateMetadata((metadata) => applyExecutionRunLinkReportV1(metadata, { runId, report }))
      .catch((error) => logger.debug('[EXECUTION RUN] Child report record write failed', {
        runId,
        error: error instanceof Error ? error.message : String(error),
      }));
  };

  const send = async (request: SessionExecutionRunChildTurnReportV1Request, parentSessionId: string, record: boolean) => {
    const maxAttempts = retryDelaysMs.length + 1;
    const sendGeneration = generation;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (generation !== sendGeneration) return;
      try {
        const response = await params.reportToParent(parentSessionId, request);
        if (record && response?.accepted === true) {
          await writeReport(request.runId, { turnEpoch: request.turnEpoch, reportedAt: getNowMs(), ack: 'accepted', attempts: attempt });
        }
        // A valid response that accepts nothing (finished or foreign run) leaves the record as it is.
        return;
      } catch (error) {
        logger.debug('[EXECUTION RUN] Child turn report failed', {
          runId: request.runId,
          attempt,
          error: error instanceof Error ? error.message : String(error),
        });
        if (!record) continue;
        const exhausted = attempt === maxAttempts;
        await writeReport(request.runId, {
          turnEpoch: request.turnEpoch,
          reportedAt: getNowMs(),
          ack: exhausted ? 'failed' : 'pending',
          attempts: attempt,
        });
        if (exhausted) return;
      }
      const delayMs = retryDelaysMs[attempt - 1] ?? 0;
      if (delayMs > 0) await waitForRetry(delayMs);
    }
  };

  const serialize = (work: () => Promise<void>): Promise<void> => {
    tail = tail.then(work, work);
    return tail;
  };

  return {
    /**
     * Startup and every metadata change: a new link sends the handshake. The epoch resumes from this
     * child's own last report record, so after a child restart a live parent still sees a greater epoch.
     */
    onMetadataObserved(): Promise<void> {
      const link = currentLink();
      if (link && `${link.parentSessionId}:${link.runId}` !== linkKey) supersede();
      return serialize(async () => {
        const link = currentLink();
        if (!link) {
          linkKey = null;
          return;
        }
        const key = `${link.parentSessionId}:${link.runId}`;
        if (key === linkKey) return;
        linkKey = key;
        turnEpoch = Math.max(link.turnEpoch, link.report?.turnEpoch ?? 0);
        await send({ runId: link.runId, linkedSessionId: params.sessionId, turnEpoch, kind: 'linked' }, link.parentSessionId, false);
      });
    },

    /** After an assistant turn ends (provider-agnostic lifecycle); a failed turn is reported with its status. */
    onTurnCompleted(opts?: Readonly<{ turnStatus?: 'completed' | 'failed' }>): Promise<void> {
      supersede();
      return serialize(async () => {
        const link = currentLink();
        if (!link || `${link.parentSessionId}:${link.runId}` !== linkKey) return;
        turnEpoch += 1;
        await send({
          runId: link.runId,
          linkedSessionId: params.sessionId,
          turnEpoch,
          kind: 'turn_completed',
          ...(opts?.turnStatus === 'failed' ? { turnStatus: 'failed' as const } : {}),
        }, link.parentSessionId, true);
      });
    },
  };
}
