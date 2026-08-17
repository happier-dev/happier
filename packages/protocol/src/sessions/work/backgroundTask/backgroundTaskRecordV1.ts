import { z } from 'zod';

import { AgentActivityStatusV1Schema } from '../agentActivity/agentActivityStatusV1.js';

/**
 * Longest label this record may persist.
 *
 * The bound is the redaction contract's, not a display preference: `redactBackgroundCommand`
 * truncates to exactly this many characters, so a label that exceeds it did not come through
 * redaction. Failing the parse is therefore the last gate before an unredacted command reaches
 * persistence and every client.
 */
export const BACKGROUND_TASK_LABEL_MAX = 120;

/**
 * Longest provider summary this record may persist.
 *
 * A provider task notification's summary is prose of unbounded length, and this record is synced to
 * every client on every read, so it is bounded here rather than at each renderer.
 */
export const BACKGROUND_TASK_SUMMARY_MAX = 2_000;

/**
 * What a background task IS, as one classified bucket.
 *
 * Not the provider's `task_type`. That raw string drifts between SDK releases, so the CLI classifies
 * once at ingestion and persists the answer, and every reader reads the answer instead of
 * re-deriving it from a string it does not own.
 *
 * - `command` — a shell that outlives its turn (`local_bash`, `shell`).
 * - `monitoring` — a watch loop (`monitor`, `monitor_mcp`). Recognised now so that a provider that
 *   starts emitting these classifies them instead of dropping them. No monitor row, action or
 *   schedule model is built on it: no producer is verified.
 * - `unknown` — fully typed, admitted, but of a type this build does not recognise. Degrading such a
 *   task to background is honest; guessing that it is an agent is not.
 */
export const BACKGROUND_TASK_KINDS_V1 = [
  'command',
  'monitoring',
  'unknown',
] as const;

export const BackgroundTaskKindV1Schema = z.enum(BACKGROUND_TASK_KINDS_V1);
export type BackgroundTaskKindV1 = z.infer<typeof BackgroundTaskKindV1Schema>;

/**
 * Durable outcome record for ONE headless background task, persisted as a session system record
 * under namespace `activity`, kind `background_task.v1`.
 *
 * **Only attested fields.** Every field below is one an observed provider payload carries, and the
 * record deliberately lacks the ones no payload does:
 *
 * - **No `cwd`.** It appears in no observed Claude task payload. A detail view degrades to the
 *   progress line or the status alone.
 * - **No output.** `stdout`/`stderr` arrive on the originating `Bash` tool result, which is where
 *   the transcript already renders them. A second copy here would be a second authority.
 * - **No `exitCode`.** No producer for one exists: `BashOutput` carries no exit-code field and the
 *   SDK publishes no `TaskOutput` output schema at all. An optional field nothing can write is a
 *   promise to a reader that some rows carry an exit code, which would be false for every row.
 *   Failed-without-a-code is the designed state. Re-add it with its producer.
 * - **No retention promise.** There is no TTL mechanism, so no field may imply one.
 *
 * Liveness is NOT stored here. The in-memory provider ledger owns "is this task still running" and
 * is rebuildable; this record owns the durable outcome.
 *
 * `.strip()` rather than the `.passthrough()` its `workflow_run.v1` sibling uses, and deliberately:
 * this record is the one place a redaction bug could persist a raw command, so the schema is a
 * chokepoint that drops anything the contract does not name instead of forwarding it.
 */
export const SessionBackgroundTaskRecordV1Schema = z
  .object({
    v: z.literal(1),
    /** Provider task id. Also the record's local-id component, so it is the join key. */
    taskId: z.string().trim().min(1),
    /**
     * What this task IS, classified once at ingestion.
     *
     * Required, not optional, so no row can exist without the answer. The CLI is the only party that
     * ever sees the provider's raw `task_type`, and the record outlives the process that wrote it: a
     * row carrying only a label and a status could never afterwards answer "was this a shell or a
     * watch loop?", because the evidence is gone. Re-deriving it later would mean shipping the
     * classifier to every reader, which is the split-brain this record exists to avoid.
     */
    kind: BackgroundTaskKindV1Schema,
    /**
     * The one presentation status vocabulary — no second status enum. Provider words (`completed`,
     * `stopped`, `killed`) map into it at the CLI adapter and never land here.
     */
    status: AgentActivityStatusV1Schema,
    /**
     * The command, as `redactBackgroundCommand` left it. Optional because it comes from the launch
     * event's description: a task first observed at its terminal event has no description, and
     * inventing one would be worse than a row that names only its status.
     *
     * The raw command is never persisted and never crosses the wire.
     */
    label: z.string().trim().min(1).max(BACKGROUND_TASK_LABEL_MAX).optional(),
    /**
     * Epoch ms. Optional and never synthesised: a `startedAt ?? updatedAt ?? endedAt` fallback one
     * layer up is what makes a finished 16-second run report `0:00`. Absent evidence of a start, the
     * field is absent and the surface shows no duration.
     */
    startedAt: z.number().int().nonnegative().optional(),
    /** Epoch ms of the terminal transition. */
    endedAt: z.number().int().nonnegative().optional(),
    /** Provider-authored terminal or progress summary. */
    summary: z.string().trim().min(1).max(BACKGROUND_TASK_SUMMARY_MAX).optional(),
    /** Epoch ms of the most recent evidence about this task. */
    updatedAt: z.number().int().nonnegative(),
  })
  .strip();
export type SessionBackgroundTaskRecordV1 = z.infer<typeof SessionBackgroundTaskRecordV1Schema>;
