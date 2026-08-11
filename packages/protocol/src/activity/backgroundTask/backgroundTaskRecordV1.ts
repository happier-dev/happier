import { z } from 'zod';

import { AgentActivityStatusV1Schema } from '../../sessionAgentActivity/agentActivityStatusV1.js';

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
 * `task_notification.summary` is provider prose of unbounded length (OBSERVED: the SDK types it as
 * a plain `string`), and this record is synced to every client on every read, so it is bounded here
 * rather than at each renderer.
 */
export const BACKGROUND_TASK_SUMMARY_MAX = 2_000;

/**
 * What a background task IS, as one classified bucket.
 *
 * Not the provider's `task_type`. The raw type drifts — t3code's production note records an
 * allowlist that silently dropped real subagents when `local_agent` appeared — so the CLI classifies
 * once at ingestion and persists the answer, and every renderer reads the answer instead of
 * re-deriving it from a string it does not own.
 *
 * Distinct from `AgentActivityKindV1`, which says what kind of ROW a piece of agent activity is.
 * This says which kind of headless work one background task is, and only ever describes tasks that
 * already failed the "is this an agent?" question.
 *
 * - `command` — a shell that outlives its turn (`local_bash`, `shell`).
 * - `monitoring` — a watch loop (`monitor`, `monitor_mcp`). Recognised now so that a provider that
 *   starts emitting these classifies them instead of dropping them; PLAN §4.9.2 ships no monitor
 *   row, action or schedule model, because no producer is verified.
 * - `unknown` — fully typed, admitted, but of a type this build does not recognise. PLAN §4.9.1
 *   step 5 degrades such a task to background rather than guessing that it is an agent.
 */
export const BACKGROUND_TASK_KINDS_V1 = [
  'command',
  'monitoring',
  'unknown',
] as const;

export const BackgroundTaskKindV1Schema = z.enum(BACKGROUND_TASK_KINDS_V1);
export type BackgroundTaskKindV1 = z.infer<typeof BackgroundTaskKindV1Schema>;

/**
 * Durable outcome record for ONE Claude background task, persisted as a session system record
 * under namespace `activity`, kind `background_task.v1`.
 *
 * **Only attested fields.** Every field below is one this program has seen a provider payload
 * carry, and the record deliberately lacks the ones it has not:
 *
 * - **No `cwd`.** It appears in no observed Claude task payload (checked against the recorded
 *   fixtures in `apps/cli/src/backends/claude/workflows/__fixtures__/**` and the SDK's declared
 *   `SDKTaskStarted/Progress/Notification/Updated` message types). A detail view degrades to the
 *   progress line or the status alone.
 * - **No output.** `stdout`/`stderr` arrive on the originating `Bash` tool result, which is where
 *   the transcript already renders them. A second copy here would be a second authority.
 * - **No retention promise.** There is no TTL mechanism, so no field or copy may imply one.
 *
 * Liveness is NOT stored here. The in-memory provider ledger owns "is this task still running" and
 * is rebuildable; this record owns the durable outcome (PLAN §4.9).
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
     * **No renderer reads it today, and that is deliberate — not an oversight and not dead weight.**
     * PLAN §4.9.2 item 3 requires the persisted row to be self-describing: the CLI is the only party
     * that ever sees the provider's raw `task_type`, that string drifts between SDK releases, and
     * the record outlives the process that wrote it. A row that carried only a label and a status
     * could never afterwards answer "was this a shell or a watch loop?", because the evidence is
     * gone. Re-deriving it later would also mean shipping the classifier to every reader, which is
     * exactly the split-brain §8.4 forbids.
     *
     * So the deletion test is answered by the WRITE side, not the read side: remove this field and
     * `monitoring` rows become indistinguishable from `command` rows forever. It is required, not
     * optional, precisely so no row can exist without the answer.
     */
    kind: BackgroundTaskKindV1Schema,
    /**
     * The one presentation status vocabulary (PLAN §8.4: no second status enum). Provider words —
     * `completed`, `stopped`, `killed` — map into it at the CLI adapter and never land here.
     */
    status: AgentActivityStatusV1Schema,
    /**
     * The command, as `redactBackgroundCommand` left it. Optional because it comes from
     * `task_started.description`: a task first observed at its terminal event has no description,
     * and inventing one would be worse than a row that names only its status.
     *
     * The raw command is never persisted and never crosses the wire.
     */
    label: z.string().trim().min(1).max(BACKGROUND_TASK_LABEL_MAX).optional(),
    /**
     * Epoch ms. Optional and never synthesised: D-8 shipped `startedAt ?? updatedAt ?? finishedAt`
     * one layer up and made a 16-second run report `0:00`. Absent evidence of a start, the field is
     * absent and the surface shows no duration.
     */
    startedAt: z.number().int().nonnegative().optional(),
    /** Epoch ms of the terminal transition. OBSERVED source: `task_updated.patch.end_time`. */
    endedAt: z.number().int().nonnegative().optional(),
    /** Provider-authored terminal or progress summary. */
    summary: z.string().trim().min(1).max(BACKGROUND_TASK_SUMMARY_MAX).optional(),
    /*
     * There is deliberately NO `exitCode`.
     *
     * It shipped as an optional field on the strength of the plan naming it, and then no producer
     * for it was ever found: `exit_code` exists in the SDK only on `SDKHookResponseMessage` and
     * `SpawnedProcess`, `BashOutput` has no exit-code field, and there is no `TaskOutputOutput` in
     * `ToolOutputSchemas` at all. An optional field nothing can write is not a forward-compatible
     * hook — it is a promise to a reader that some rows carry an exit code, which is false for
     * every row. Failed-without-a-code is the designed state (§4.9). Re-add it with its producer.
     */
    /** Epoch ms of the most recent evidence about this task. */
    updatedAt: z.number().int().nonnegative(),
  })
  .strip();
export type SessionBackgroundTaskRecordV1 = z.infer<typeof SessionBackgroundTaskRecordV1Schema>;
