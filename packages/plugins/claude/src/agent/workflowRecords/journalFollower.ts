import { readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import type {
  AgentTranscriptFileFollowHandle,
  AgentTranscriptFileFollowService,
} from '@happier-dev/plugin-sdk/agents/runtime';

import {
  createClaudeWorkflowJournalWrapper,
  createClaudeWorkflowRunRecordWrapper,
  parseClaudeWorkflowFact,
} from './correlation.js';

type WorkflowJournalFileFollow = Pick<AgentTranscriptFileFollowService, 'follow'>;

type WorkflowJournalEntry = Readonly<{
  workflowToolUseId: string;
  transcriptDir: string;
  sourceSessionId?: string;
  handle: AgentTranscriptFileFollowHandle;
}>;

export type ClaudeWorkflowJournalFollower = Readonly<{
  observeTranscriptMessage(message: unknown): void;
  markRunCompleted(runId: string): void;
  syncAll(): Promise<void>;
  dispose(): void;
}>;

export function createClaudeWorkflowJournalFollower(params: Readonly<{
  fileFollow?: WorkflowJournalFileFollow | undefined;
  onJournalValue: (value: unknown) => void;
  logError?: (message: string, error: unknown) => void;
}>): ClaudeWorkflowJournalFollower {
  const entriesByRunId = new Map<string, WorkflowJournalEntry>();
  const pendingRegistrations = new Set<Promise<void>>();
  const pendingClosures = new Set<Promise<void>>();
  const pendingRecordReads = new Set<Promise<void>>();
  const runRecordsReadByRunId = new Set<string>();
  let disposed = false;

  function logError(message: string, error: unknown): void {
    params.logError?.(message, error);
  }

  /**
   * Read the run's durable record, which sits BESIDE the sidecar directory rather than inside it.
   *
   * Layout, verified on disk:
   *   `<sessionRoot>/subagents/workflows/<runId>/`   <- `transcriptDir`, the journal
   *   `<sessionRoot>/workflows/<runId>.json`         <- this record
   * so the path is derived structurally from the directory this follower already holds — three
   * levels up, then the run id, which IS that directory's own name. Nothing is guessed.
   *
   * Written once at terminal state, so it is retried until it appears and then never re-read. A
   * missing file is the NORMAL state of a live run, not a fault, and is not latched: latching it
   * would permanently deny a finished run the only phase attribution it will ever have.
   *
   * Treated as an INTERNAL, undocumented artifact throughout: unknown shapes are dropped by the
   * shared `workflow_progress[]` parser rather than trusted, and a read that yields nothing is
   * REPORTED rather than swallowed, so a shape change downgrades this run's detail instead of
   * failing the session.
   */
  function readRunRecord(entry: WorkflowJournalEntry): void {
    if (runRecordsReadByRunId.has(entry.workflowToolUseId)) return;
    const runId = basename(entry.transcriptDir);
    if (!runId.startsWith('wf_')) return;
    const recordPath = join(dirname(dirname(dirname(entry.transcriptDir))), 'workflows', `${runId}.json`);
    const read = (async () => {
      let raw: string;
      try {
        raw = await readFile(recordPath, 'utf8');
      } catch {
        // The overwhelmingly common case while a run is still going: it has not been written yet.
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        logError(`workflow run record ${recordPath} is not readable JSON`, error);
        return;
      }
      const progress = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>).workflowProgress
        : undefined;
      if (!Array.isArray(progress) || progress.length === 0) {
        logError(`workflow run record ${recordPath} carries no workflowProgress`, null);
        return;
      }
      // Latched only now — the file exists, parsed, and had content, so re-reading it cannot say
      // anything new.
      runRecordsReadByRunId.add(entry.workflowToolUseId);
      params.onJournalValue(createClaudeWorkflowRunRecordWrapper({
        workflowToolUseId: entry.workflowToolUseId,
        workflowProgress: progress,
        ...(entry.sourceSessionId ? { sourceSessionId: entry.sourceSessionId } : {}),
      }));
    })();
    pendingRecordReads.add(read);
    void read.finally(() => pendingRecordReads.delete(read));
  }

  function closeEntry(runId: string, options?: Readonly<{ finalDrain?: boolean }>): void {
    const entry = entriesByRunId.get(runId);
    if (!entry) return;
    entriesByRunId.delete(runId);
    const closure = entry.handle.close({
      finalDrain: options?.finalDrain === true,
      drainTimeoutMs: 5_000,
    }).catch((error) => {
      logError(`workflow journal follower close failed for ${runId}`, error);
    });
    pendingClosures.add(closure);
    void closure.finally(() => pendingClosures.delete(closure));
  }

  function registerJournal(paramsForRun: Readonly<{
    workflowToolUseId: string;
    transcriptDir: string;
    sourceSessionId?: string | undefined;
  }>): void {
    if (!params.fileFollow || disposed) return;
    const existing = entriesByRunId.get(paramsForRun.workflowToolUseId);
    if (existing?.transcriptDir === paramsForRun.transcriptDir) return;
    if (existing) {
      closeEntry(paramsForRun.workflowToolUseId);
    }

    const journalPath = join(paramsForRun.transcriptDir, 'journal.jsonl');
    const registration = params.fileFollow.follow({
      path: journalPath,
      startAt: 'beginning',
      strategy: 'poll',
      onLine: async ({ line }) => {
        if (disposed) return;
        const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line;
        if (!trimmed.trim()) return;
        let entry: unknown;
        try {
          entry = JSON.parse(trimmed);
        } catch {
          return;
        }
        params.onJournalValue(createClaudeWorkflowJournalWrapper({
          workflowToolUseId: paramsForRun.workflowToolUseId,
          entry,
          ...(paramsForRun.sourceSessionId ? { sourceSessionId: paramsForRun.sourceSessionId } : {}),
        }));
      },
      onError: (error) => {
        logError(`workflow journal follower error for ${paramsForRun.workflowToolUseId}`, error);
      },
    }).then((handle) => {
      if (disposed) {
        void handle.close({ finalDrain: true, drainTimeoutMs: 5_000 }).catch((error) => {
          logError(`workflow journal follower post-dispose close failed for ${paramsForRun.workflowToolUseId}`, error);
        });
        return;
      }
      entriesByRunId.set(paramsForRun.workflowToolUseId, {
        workflowToolUseId: paramsForRun.workflowToolUseId,
        transcriptDir: paramsForRun.transcriptDir,
        ...(paramsForRun.sourceSessionId ? { sourceSessionId: paramsForRun.sourceSessionId } : {}),
        handle,
      });
    }).catch((error) => {
      logError(`workflow journal follower failed to start for ${paramsForRun.workflowToolUseId}`, error);
    });
    pendingRegistrations.add(registration);
    void registration.finally(() => pendingRegistrations.delete(registration));
  }

  return {
    observeTranscriptMessage(message) {
      const fact = parseClaudeWorkflowFact(message);
      if (fact?.kind !== 'workflow-launch' || !fact.transcriptDir) return;
      registerJournal({
        workflowToolUseId: fact.workflowToolUseId,
        transcriptDir: fact.transcriptDir,
        ...(fact.sourceSessionId ? { sourceSessionId: fact.sourceSessionId } : {}),
      });
    },
    markRunCompleted(runId) {
      // The record is written at terminal state, so the run ending is the first moment it can
      // exist — and it is read BEFORE the entry closes, because closing forgets the entry.
      const entry = entriesByRunId.get(runId);
      if (entry) readRunRecord(entry);
      closeEntry(runId, { finalDrain: true });
    },
    async syncAll() {
      if (pendingRegistrations.size > 0) {
        await Promise.allSettled([...pendingRegistrations]);
      }
      for (const entry of entriesByRunId.values()) {
        await entry.handle.drainNow({ timeoutMs: 5_000 });
      }
      // The same drain is the BACKFILL trigger: a resumed session replays the transcript that
      // launched an already-finished run, so its record is on disk before this follower ever saw
      // it, and no completion event is coming to ask for it.
      for (const entry of entriesByRunId.values()) readRunRecord(entry);
      if (pendingClosures.size > 0) {
        await Promise.allSettled([...pendingClosures]);
      }
      // Record reads are started BY the loop above, so they are awaited after it.
      while (pendingRecordReads.size > 0) {
        await Promise.allSettled([...pendingRecordReads]);
      }
    },
    dispose() {
      disposed = true;
      for (const runId of [...entriesByRunId.keys()]) {
        closeEntry(runId);
      }
      pendingRegistrations.clear();
    },
  };
}
