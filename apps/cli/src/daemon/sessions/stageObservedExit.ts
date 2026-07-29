import { createHash } from 'node:crypto';

import {
  ExactSessionTurnEndMutationV1Schema,
  type ExactSessionTurnEndMutationV1,
} from '@happier-dev/protocol';

import type { TrackedSession } from '../types';
import { resolveTrackedSessionActiveTurn } from './trackedSessionActiveTurn';

type MarkerEvidenceRelease = Readonly<{
  markerPid: number;
  sessionId: string;
  turnId: string | null;
}>;

export type StageObservedExitResult =
  | Readonly<{ status: 'staged'; markerPid: number }>
  | Readonly<{ status: 'no_exact_turn'; markerPid: number }>;

export function resolveDaemonObservedExitMutationId(params: Readonly<{
  sessionId: string;
  turnId: string;
}>): string {
  const digest = createHash('sha256')
    .update(JSON.stringify({ sessionId: params.sessionId, turnId: params.turnId }))
    .digest('hex');
  return `daemon-observed-exit:${digest}`;
}

export async function stageObservedExit(params: Readonly<{
  trackedSession: Pick<TrackedSession, 'pid' | 'sessionRunnerPid' | 'happySessionId' | 'activeTurnId'>;
  observedAt: number;
  enqueueExactTurnEnd: (mutation: ExactSessionTurnEndMutationV1) => Promise<void>;
  releaseMarkerEvidence: (evidence: MarkerEvidenceRelease) => Promise<void>;
}>): Promise<StageObservedExitResult> {
  const exactTurn = resolveTrackedSessionActiveTurn(params.trackedSession);
  const fallbackMarkerPid = params.trackedSession.sessionRunnerPid ?? params.trackedSession.pid;
  if (!exactTurn) {
    const sessionId = params.trackedSession.happySessionId?.trim() ?? '';
    await params.releaseMarkerEvidence({
      markerPid: fallbackMarkerPid,
      sessionId,
      turnId: null,
    });
    return { status: 'no_exact_turn', markerPid: fallbackMarkerPid };
  }

  const mutation = ExactSessionTurnEndMutationV1Schema.parse({
    v: 1,
    sessionId: exactTurn.sessionId,
    mutationId: resolveDaemonObservedExitMutationId(exactTurn),
    action: 'end_session',
    turnId: exactTurn.turnId,
    observedAt: params.observedAt,
  });
  await params.enqueueExactTurnEnd(mutation);
  await params.releaseMarkerEvidence({
    markerPid: exactTurn.markerPid,
    sessionId: exactTurn.sessionId,
    turnId: exactTurn.turnId,
  });
  return { status: 'staged', markerPid: exactTurn.markerPid };
}
