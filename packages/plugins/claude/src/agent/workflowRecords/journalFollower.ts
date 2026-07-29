import { join } from 'node:path';

import type {
  AgentTranscriptFileFollowHandle,
  AgentTranscriptFileFollowService,
} from '@happier-dev/plugin-sdk/agent-runtime';

import {
  createClaudeWorkflowJournalWrapper,
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
  let disposed = false;

  function logError(message: string, error: unknown): void {
    params.logError?.(message, error);
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
      closeEntry(runId, { finalDrain: true });
    },
    async syncAll() {
      if (pendingRegistrations.size > 0) {
        await Promise.allSettled([...pendingRegistrations]);
      }
      for (const entry of entriesByRunId.values()) {
        await entry.handle.drainNow({ timeoutMs: 5_000 });
      }
      if (pendingClosures.size > 0) {
        await Promise.allSettled([...pendingClosures]);
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
