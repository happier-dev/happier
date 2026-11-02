import { stat } from 'node:fs/promises';

import {
  createJsonlFollowController,
  type JsonlFollowControllerOptions,
} from '@/agent/localControl/jsonlFollowController';
import { logger } from '@/ui/logger';

import { readClaudeAttachmentRecord } from '../attachments/claudeAttachmentTypes';

/**
 * True only for a Claude transcript `attachment` record whose `attachment.type === 'goal_status'`.
 * This is the SOLE row the agent-SDK runner cannot observe from its own stream: `--output-format
 * stream-json` omits transcript attachments (confirmed empirically), so `goal_status` lives ONLY in
 * the persisted `session.transcriptPath` JSONL.
 */
export function isClaudeGoalStatusAttachmentValue(value: unknown): boolean {
  return readClaudeAttachmentRecord(value)?.attachment.type === 'goal_status';
}

export type ClaudeGoalStatusTranscriptTail = Readonly<{
  /**
   * Begin (or re-target) following `transcriptPath`. Idempotent for the same path; a different path
   * stops the previous follower and starts a fresh one (e.g. `--continue`/`--resume` learns the real
   * transcript only after the session-start hook fires).
   */
  start(transcriptPath: string | null | undefined): Promise<void>;
  /** Stop following and release the watcher. */
  stop(): Promise<void>;
}>;

type FollowController = Readonly<{
  start(): Promise<void>;
  stop(): Promise<void>;
}>;

/**
 * A NARROW, scoped follow of a Claude session's persisted transcript JSONL that extracts ONLY
 * `goal_status` attachment records and forwards them to the centralized goal work-state source.
 *
 * The unified-terminal + local launchers already feed the goal source via the session scanner's RAW
 * channel (`onRawJsonlValue`). The agent-SDK remote runner has NO file scanner — it emits `SDKMessage`s
 * directly — so without this tail the `/goal` work-state never loads in agent-SDK mode. This reuses the
 * lightweight `jsonlFollowController` (the same follow primitive the unified bridge's known-resume raw
 * follower uses) rather than a full `createSessionScanner`, so it performs no visible-transcript emit,
 * no sidechain/team-inbox collection, and no work other than goal_status extraction.
 *
 * Workflow activity is intentionally NOT forwarded here: in agent-SDK mode the SDK stream already
 * carries the (richer) workflow lifecycle through `onMessage`, so re-feeding it from the file would
 * double-feed the workflow source.
 */
export function createClaudeGoalStatusTranscriptTail(params: Readonly<{
  /** Forward one `goal_status` transcript value to the goal source (`observeTranscriptMessage`). */
  onGoalStatusValue: (value: unknown) => void;
  /** Share this existing JSONL observation with provider identity; do not create another follower. */
  onRawTranscriptValue?: (value: unknown) => void;
  logPrefix?: string;
  /** Test seam: inject the follow primitive (defaults to the real file-watching controller). */
  createFollow?: (opts: JsonlFollowControllerOptions) => FollowController;
}>): ClaudeGoalStatusTranscriptTail {
  const logPrefix = params.logPrefix ?? '[claude-goal-tail]';
  const createFollow = params.createFollow ?? ((opts) => createJsonlFollowController(opts));

  let activePath: string | null = null;
  let follower: FollowController | null = null;
  let starting: Promise<void> | null = null;

  const stopFollower = async (): Promise<void> => {
    const current = follower;
    follower = null;
    activePath = null;
    if (!current) return;
    try {
      await current.stop();
    } catch (error) {
      logger.debug(`${logPrefix}: failed stopping goal_status transcript follower (non-fatal)`, error);
    }
  };

  const startForPath = async (transcriptPath: string): Promise<void> => {
    if (follower && activePath === transcriptPath) return;
    if (follower) await stopFollower();

    // Start from the current end of file. The goal work-state item is published to DURABLE session
    // metadata, so a goal set before this launch already persists there across a resume/relaunch — the
    // agent-SDK path only needs the LIVE `goal_status` deltas appended after launch. Replaying history
    // from offset 0 would instead risk re-surfacing a goal the user cleared between runs (a `/goal
    // clear` emits no `goal_status`, so the last historical row is the now-stale active one).
    const startOffsetBytes = await stat(transcriptPath).then(
      (snapshot) => snapshot.size,
      () => 0,
    );
    const next = createFollow({
      filePath: transcriptPath,
      startOffsetBytes,
      onJson: (value) => {
        params.onRawTranscriptValue?.(value);
        if (!isClaudeGoalStatusAttachmentValue(value)) return;
        try {
          params.onGoalStatusValue(value);
        } catch (error) {
          logger.debug(`${logPrefix}: goal_status forward threw (non-fatal)`, error);
        }
      },
      onError: (error) => {
        logger.debug(`${logPrefix}: goal_status transcript follower error (non-fatal)`, error);
      },
    });
    follower = next;
    activePath = transcriptPath;
    await next.start();
    if (follower !== next) {
      // A concurrent re-target / stop superseded us while starting; release the orphan.
      await next.stop().catch(() => undefined);
    }
  };

  return {
    async start(transcriptPath) {
      const path = typeof transcriptPath === 'string' ? transcriptPath.trim() : '';
      if (!path) return;
      if (follower && activePath === path) return;
      const run = (starting ?? Promise.resolve())
        .catch(() => undefined)
        .then(() => startForPath(path));
      starting = run.finally(() => {
        if (starting === run) starting = null;
      });
      await starting;
    },
    async stop() {
      const pending = starting;
      if (pending) await pending.catch(() => undefined);
      await stopFollower();
    },
  };
}
