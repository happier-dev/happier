import type { SessionRunnerRestartDisabledReason } from '@happier-dev/protocol';
import type { TrackedSession } from '@/daemon/types';
import { resolveTrackedSessionActiveTurn } from '@/daemon/sessions/trackedSessionActiveTurn';

export type SessionRunnerActivityDisabledReasonReaders = Readonly<{
  isTurnInProgress?: (sessionId: string) => boolean;
  hasPendingApproval?: (sessionId: string) => boolean;
  isTerminalDetached?: (sessionId: string) => boolean;
  isTerminalHostAttached?: (sessionId: string) => boolean;
}>;

export function resolveSessionRunnerActivityDisabledReason(
  sessionId: string,
  readers: SessionRunnerActivityDisabledReasonReaders,
  tracked?: TrackedSession | null,
): SessionRunnerRestartDisabledReason | null {
  const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!normalizedSessionId) return null;

  // Reattached runners retain exact turn custody even before this daemon observes an event.
  const activeTurn = tracked ? resolveTrackedSessionActiveTurn(tracked) : null;
  if (activeTurn?.sessionId === normalizedSessionId
    || readers.isTurnInProgress?.(normalizedSessionId) === true) return 'turn_in_progress';
  if (readers.hasPendingApproval?.(normalizedSessionId) === true) return 'approval_pending';
  if (readers.isTerminalDetached?.(normalizedSessionId) === true) return 'terminal_detached';
  if (readers.isTerminalHostAttached?.(normalizedSessionId) === true) return 'terminal_host_attached';

  return null;
}
