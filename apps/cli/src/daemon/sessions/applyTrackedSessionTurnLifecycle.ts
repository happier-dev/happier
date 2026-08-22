import { z } from 'zod';

import {
  clearTrackedRunnerAgentDaemonServiceAdmission,
} from '@/daemon/agentRuntime/clearTrackedRunnerAgentDaemonServiceAdmission';
import { updateSessionMarkerActiveTurn } from '../sessionRegistry';
import type { TrackedSession } from '../types';

type TurnLifecycleEvent = 'prompt_or_steer' | 'task_started' | 'assistant_message_end' | 'turn_cancelled';

export const TrackedSessionTurnLifecycleResultSchema = z.object({
  status: z.enum([
    'recorded',
    'ignored_missing_exact_turn',
    'ignored_session_not_found',
    'ignored_session_ambiguous',
    'ignored_turn_mismatch',
    'ignored_marker_not_updated',
  ]),
  activeTurnId: z.string().nullable(),
}).strict();

export type TrackedSessionTurnLifecycleResult =
  z.infer<typeof TrackedSessionTurnLifecycleResultSchema>;

export async function applyTrackedSessionTurnLifecycle(input: Readonly<{
  trackedSessions: Iterable<TrackedSession>;
  sessionId: string;
  event: TurnLifecycleEvent;
  turnId?: string;
  activeTurnIdWitness?: string | null;
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

  const turnId = typeof input.turnId === 'string' ? input.turnId.trim() : '';
  if (!turnId) {
    return { status: 'ignored_missing_exact_turn', activeTurnId: currentActiveTurnId };
  }

  const isTerminal = input.event === 'assistant_message_end' || input.event === 'turn_cancelled';
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
  const markerUpdated = await (input.updateSessionMarkerActiveTurn ?? updateSessionMarkerActiveTurn)({
    pid: tracked.sessionRunnerPid ?? tracked.pid,
    sessionId: input.sessionId,
    activeTurnId: nextActiveTurnId,
    ...(retainedAdmission
      ? {
          agentRuntimeDaemonServiceActiveAdmission:
            retainedAdmission,
        }
      : {}),
  });
  if (!markerUpdated) {
    return { status: 'ignored_marker_not_updated', activeTurnId: currentActiveTurnId };
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
