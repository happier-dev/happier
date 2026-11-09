import { lazyZodSchema } from '@happier-dev/protocol/lazyZodSchema';
import { z } from 'zod/mini';
import { logger } from '@/ui/logger';

import {
  clearTrackedRunnerAgentDaemonServiceAdmission,
} from '@/daemon/agentRuntime/clearTrackedRunnerAgentDaemonServiceAdmission';
import { updateSessionMarkerActiveTurn } from '../sessionRegistry';
import type { TrackedSession } from '../types';
import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';

type TurnLifecycleEvent = 'prompt_or_steer' | 'task_started' | 'assistant_message_end' | 'turn_cancelled';

export const TrackedSessionTurnLifecycleResultSchema = lazyZodSchema(() => z.strictObject({
  status: z.enum([
    'recorded',
    'ignored_missing_exact_turn',
    'ignored_session_not_found',
    'ignored_session_ambiguous',
    'ignored_turn_mismatch',
    'ignored_marker_not_updated',
  ]),
  activeTurnId: z.nullable(z.string()),
}));

export type TrackedSessionTurnLifecycleResult =
  z.infer<typeof TrackedSessionTurnLifecycleResultSchema>;

export async function applyTrackedSessionTurnLifecycle(input: Readonly<{
  trackedSessions: Iterable<TrackedSession>;
  sessionId: string;
  event: TurnLifecycleEvent | 'reconcile_reattached';
  turnId?: string;
  activeTurnIdWitness?: string | null;
  readReattachedTurnSnapshot?: (sessionId: string) => Promise<Pick<RawSessionRecord,
    'id' | 'latestTurnId' | 'latestTurnStatus'> | null>;
  updateSessionMarkerActiveTurn?: typeof updateSessionMarkerActiveTurn;
}>): Promise<TrackedSessionTurnLifecycleResult> {
  const matches = Array.from(input.trackedSessions).filter(
    (tracked) => tracked.happySessionId === input.sessionId,
  );
  if (matches.length === 0) {
    return { status: 'ignored_session_not_found', activeTurnId: null };
  }
  if (matches.length !== 1) {
    return { status: 'ignored_session_ambiguous', activeTurnId: null };
  }

  const tracked = matches[0]!;
  const currentActiveTurnId = tracked.activeTurnId ?? null;
  const reattachedInterruptedTurnId =
    tracked.reattachedInterruptedTurnId ?? null;
  const retainedActiveTurnId =
    currentActiveTurnId ?? reattachedInterruptedTurnId;
  let recoveredTerminalTurnId: string | null = null;
  if (input.event === 'reconcile_reattached') {
    if (currentActiveTurnId || !reattachedInterruptedTurnId || !input.readReattachedTurnSnapshot) {
      return { status: 'ignored_missing_exact_turn', activeTurnId: currentActiveTurnId };
    }
    const runnerPid = tracked.sessionRunnerPid ?? tracked.pid;
    const runnerStart = tracked.processStartTimeMs;
    const runnerCommandHash = tracked.processCommandHash;
    const snapshot = await input.readReattachedTurnSnapshot(input.sessionId).catch(() => null);
    if ((tracked.sessionRunnerPid ?? tracked.pid) !== runnerPid
      || tracked.processStartTimeMs !== runnerStart || tracked.processCommandHash !== runnerCommandHash
      || tracked.activeTurnId || tracked.reattachedInterruptedTurnId !== reattachedInterruptedTurnId
      || snapshot?.id !== input.sessionId || snapshot.latestTurnId !== reattachedInterruptedTurnId
      || !['waiting', 'completed', 'failed', 'cancelled'].includes(snapshot.latestTurnStatus ?? '')) {
      return { status: 'ignored_turn_mismatch', activeTurnId: tracked.activeTurnId ?? null };
    }
    recoveredTerminalTurnId = reattachedInterruptedTurnId;
  }
  const hasRunnerPromptWitness =
    input.event === 'prompt_or_steer'
    && input.activeTurnIdWitness !== undefined;
  if (hasRunnerPromptWitness) {
    const activeTurnIdWitness =
      input.activeTurnIdWitness === null
        ? null
        : input.activeTurnIdWitness.trim();
    if (
      activeTurnIdWitness !== null
      && !activeTurnIdWitness
    ) {
      return {
        status: 'ignored_missing_exact_turn',
        activeTurnId: currentActiveTurnId,
      };
    }
    if (
      activeTurnIdWitness !== null
      && retainedActiveTurnId !== activeTurnIdWitness
    ) {
      return {
        status: 'ignored_turn_mismatch',
        activeTurnId: currentActiveTurnId,
      };
    }
    const markerUpdated = await (
      input.updateSessionMarkerActiveTurn
      ?? updateSessionMarkerActiveTurn
    )({
      pid: tracked.sessionRunnerPid ?? tracked.pid,
      sessionId: input.sessionId,
      activeTurnId: activeTurnIdWitness,
    });
    if (!markerUpdated) {
      return {
        status: 'ignored_marker_not_updated',
        activeTurnId: currentActiveTurnId,
      };
    }
    if (activeTurnIdWitness) {
      tracked.activeTurnId = activeTurnIdWitness;
    } else {
      delete tracked.activeTurnId;
      clearTrackedRunnerAgentDaemonServiceAdmission(tracked);
    }
    delete tracked.reattachedInterruptedTurnId;
    return {
      status: 'recorded',
      activeTurnId: activeTurnIdWitness,
    };
  }

  const turnId = recoveredTerminalTurnId ?? (typeof input.turnId === 'string' ? input.turnId.trim() : '');
  if (!turnId) {
    return { status: 'ignored_missing_exact_turn', activeTurnId: currentActiveTurnId };
  }

  const isTerminal = recoveredTerminalTurnId !== null || input.event === 'assistant_message_end' || input.event === 'turn_cancelled';
  if (
    input.event === 'task_started'
    && tracked
      .agentRuntimeDaemonServiceAdmittedTurnId
    && tracked
      .agentRuntimeDaemonServiceAdmittedTurnId
      !== turnId
  ) {
    return {
      status: 'ignored_turn_mismatch',
      activeTurnId: currentActiveTurnId,
    };
  }
  if (
    isTerminal
    && retainedActiveTurnId !== turnId
  ) {
    return { status: 'ignored_turn_mismatch', activeTurnId: currentActiveTurnId };
  }

  const nextActiveTurnId = isTerminal ? null : turnId;
  const retainedAdmission =
    nextActiveTurnId
    && tracked.agentRuntimeDaemonServiceAdmittedTurnId
      === nextActiveTurnId
    && tracked.agentRuntimeDaemonServiceAdmittedInputId
    && (
      typeof tracked
        .agentRuntimeDaemonServiceAdmittedUserMessageSeq
        === 'number'
      || tracked
        .agentRuntimeDaemonServiceAdmittedUserMessageSeq
        === null
    )
    && tracked.agentRuntimeDaemonServiceAdmittedUserMessageSeqs
      ? {
          turnId: nextActiveTurnId,
          inputId:
            tracked.agentRuntimeDaemonServiceAdmittedInputId,
          userMessageSeq:
            tracked
              .agentRuntimeDaemonServiceAdmittedUserMessageSeq,
          userMessageSeqs:
            tracked
              .agentRuntimeDaemonServiceAdmittedUserMessageSeqs,
        }
      : undefined;
  // A provider-started turn may have no earlier prompt witness. Capture accepted
  // identity before disk IO so runner death can use the existing exact-exit outbox
  // even while marker publication is pending or the filesystem is unavailable.
  const acceptedNativeBegin = input.event === 'task_started';
  if (acceptedNativeBegin) tracked.activeTurnId = turnId;
  let markerUpdated: boolean;
  try {
    markerUpdated = await (input.updateSessionMarkerActiveTurn ?? updateSessionMarkerActiveTurn)({
      pid: tracked.sessionRunnerPid ?? tracked.pid,
      sessionId: input.sessionId,
      activeTurnId: nextActiveTurnId,
      ...(recoveredTerminalTurnId ? { expectedActiveTurnId: recoveredTerminalTurnId } : {}),
      ...(retainedAdmission
        ? { agentRuntimeDaemonServiceActiveAdmission: retainedAdmission }
        : {}),
    });
  } catch (error) {
    if (!acceptedNativeBegin) throw error;
    try {
      logger.infoFile('[session-turn] Marker persistence unavailable; daemon retains accepted turn custody', {
        sessionId: input.sessionId, turnId,
      });
    } catch { /* Diagnostics cannot release accepted turn custody. */ }
    return { status: 'recorded', activeTurnId: turnId };
  }
  if (!markerUpdated) {
    if (acceptedNativeBegin && tracked.activeTurnId === turnId) {
      if (currentActiveTurnId) tracked.activeTurnId = currentActiveTurnId;
      else delete tracked.activeTurnId;
    }
    return { status: 'ignored_marker_not_updated', activeTurnId: currentActiveTurnId };
  }

  if (recoveredTerminalTurnId && (tracked.activeTurnId || tracked.reattachedInterruptedTurnId !== recoveredTerminalTurnId)) {
    return { status: 'ignored_turn_mismatch', activeTurnId: tracked.activeTurnId ?? null };
  }

  if (nextActiveTurnId) {
    tracked.activeTurnId = nextActiveTurnId;
  } else {
    delete tracked.activeTurnId;
    clearTrackedRunnerAgentDaemonServiceAdmission(tracked);
  }
  delete tracked.reattachedInterruptedTurnId;
  return { status: 'recorded', activeTurnId: nextActiveTurnId };
}
