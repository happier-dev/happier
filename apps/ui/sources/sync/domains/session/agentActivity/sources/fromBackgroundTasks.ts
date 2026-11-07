import { isTerminalAgentActivityStatus, type SessionBackgroundTaskRecordV1 } from '@happier-dev/protocol';

import type { AgentActivityLocalEntry } from '../types';

/**
 * Durable background-task records, as roster entries (R-9).
 *
 * **A background command is a headless process, not an agent.** It renders through the same row
 * because a person watching a session wants one list of what is running, not two — but it has no
 * transcript, no sidechain and no recipient, so it contributes no handle, no run id and no
 * subagent, and it can never be joined onto a headline entry.
 *
 * **Only attested fields cross into presentation.** The record is the CLI's redacted, evidence-based
 * outcome (PLAN §4.9): no output, no `cwd`, no invented exit code, and above all no fabricated
 * timestamp — an absent `startedAt` stays absent so the row shows no elapsed value rather than the
 * `0:00` D-8 shipped.
 */

/** The local entry-id prefix for a background task. See the note on `AgentActivityEntryKind`. */
export const BACKGROUND_TASK_ENTRY_ID_PREFIX = 'background_task';

export function buildBackgroundTaskEntryId(taskId: string): string {
    return `${BACKGROUND_TASK_ENTRY_ID_PREFIX}:${taskId}`;
}

/** Read an entry id back to its task id, or `null` when the id names something else. */
export function readBackgroundTaskEntryTaskId(entryId: string): string | null {
    const prefix = `${BACKGROUND_TASK_ENTRY_ID_PREFIX}:`;
    if (!entryId.startsWith(prefix)) return null;
    const taskId = entryId.slice(prefix.length).trim();
    return taskId.length > 0 ? taskId : null;
}

/**
 * Whether the user has dismissed exactly this report.
 *
 * **An acknowledgement is presentation, not an outcome.** It is keyed on the record's `updatedAt`,
 * the instant of the newest evidence the user was looking at, so any later progress or terminal
 * report no longer matches and the row speaks for itself again. The provider record is never
 * written: the CLI publisher owns outcomes, and a dismissal says nothing about whether the command
 * is still running.
 */
function isReportAcknowledged(
    record: SessionBackgroundTaskRecordV1,
    acknowledgedUpdatedAtByTaskId: Readonly<Record<string, number>> | undefined,
): boolean {
    if (isTerminalAgentActivityStatus(record.status)) return false;
    return acknowledgedUpdatedAtByTaskId?.[record.taskId] === record.updatedAt;
}

function readInstant(value: number | undefined): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : null;
}

/**
 * One record as one local entry.
 *
 * The caller supplies the fallback name, for the same reason the subagent adapter beside this one
 * takes a projection: naming is translated presentation and belongs to the component layer. A task
 * first observed at its terminal event carries no description, and an unnamed background command
 * must not borrow the roster's "Unnamed agent" — it is not one.
 */
export function toBackgroundTaskLocalEntry(params: Readonly<{
    record: SessionBackgroundTaskRecordV1;
    /** Translated name for a record whose redacted label is absent. */
    fallbackTitle: string;
    /** Per task, the `updatedAt` of the report the user dismissed. */
    acknowledgedUpdatedAtByTaskId?: Readonly<Record<string, number>>;
}>): AgentActivityLocalEntry {
    const { fallbackTitle, record } = params;
    return {
        id: buildBackgroundTaskEntryId(record.taskId),
        kind: 'background_task',
        // Never joined to a headline: no CLI publishes background tasks into one.
        handle: null,
        // A dismissed, still-nonterminal report keeps no claim of ongoing work and no invented
        // outcome: `unknown` is the vocabulary's existing "we cannot say" (never live, never terminal).
        status: isReportAcknowledged(record, params.acknowledgedUpdatedAtByTaskId) ? 'unknown' : record.status,
        title: record.label ?? fallbackTitle,
        // The provider's own progress or terminal sentence, which is the only prose this row has.
        metaDetail: record.summary ?? null,
        startedAtMs: readInstant(record.startedAt),
        updatedAtMs: readInstant(record.updatedAt),
        endedAtMs: readInstant(record.endedAt),
    };
}

export function deriveBackgroundTaskActivityEntries(params: Readonly<{
    records: readonly SessionBackgroundTaskRecordV1[];
    fallbackTitle: string;
    acknowledgedUpdatedAtByTaskId?: Readonly<Record<string, number>>;
}>): readonly AgentActivityLocalEntry[] {
    if (params.records.length === 0) return [];
    return params.records.map((record) => toBackgroundTaskLocalEntry({
        record,
        fallbackTitle: params.fallbackTitle,
        ...(params.acknowledgedUpdatedAtByTaskId
            ? { acknowledgedUpdatedAtByTaskId: params.acknowledgedUpdatedAtByTaskId }
            : {}),
    }));
}
