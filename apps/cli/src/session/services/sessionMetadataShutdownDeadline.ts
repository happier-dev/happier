import { resolveSessionCriticalMetadataDrainTimeoutMs } from '@/session/transport/shared/sessionTimeouts';

export type SessionMetadataShutdownDeadline = Readonly<{
  remainingMs: () => number;
}>;

export function createSessionMetadataShutdownDeadline(opts?: Readonly<{
  budgetMs?: number;
  nowMs?: () => number;
}>): SessionMetadataShutdownDeadline {
  const nowMs = opts?.nowMs ?? Date.now;
  const budgetMs = opts?.budgetMs ?? resolveSessionCriticalMetadataDrainTimeoutMs();
  const deadlineMs = nowMs() + Math.max(1, Math.trunc(budgetMs));

  return {
    remainingMs: () => Math.max(1, Math.ceil(deadlineMs - nowMs())),
  };
}
