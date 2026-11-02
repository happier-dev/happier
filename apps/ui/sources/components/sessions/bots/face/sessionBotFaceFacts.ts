import { areSessionBotFacesEqual, readSessionBotFaceV1, readSessionBotV1, type SessionBotFaceV1 } from '@happier-dev/protocol/sessions/identity/sessionBotV1';
import { readSessionListPresentationRuntime, readSessionListRenderableSharedMetadata, type SessionListPresentationSource } from '@/sync/domains/session/listing/sessionListRenderableSessionProjection';
import { getSessionAvatarId } from '@/utils/sessions/sessionUtils';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { deriveSessionReadState } from '@/sync/domains/session/readState/sessionReadState';
import { readSessionTurnCompletedAt } from '@/sync/domains/session/sessionLifecycleProjection';
import type { BotFaceMood } from './botFaceGeometry';

type SessionFaceSource = Parameters<typeof getSessionAvatarId>[0]
  & Partial<Pick<SessionListRenderableSession, 'lastTurnCompletedAt' | 'latestTurnStatus' | 'latestTurnStatusObservedAt' | 'seq' | 'latestReadyEventSeq' | 'viewer' | 'lastViewedSessionSeq' | 'hasUnreadMessages'>>;
export type SessionBotFaceFacts = Readonly<{
  seed: string;
  face: SessionBotFaceV1 | null;
  completedAt?: number | null;
  failedAt?: number | null;
  restingMood?: BotFaceMood;
}>;

/**
 * The one reading of a Session's Bot face: null for an ordinary Session; otherwise its seed (`getSessionAvatarId`
 * decides it) and its saved shared choices. Every identity surface takes this instead of re-reading metadata.
 */
export function readSessionBotFaceFacts(
  identity: SessionFaceSource,
  serverId: string | null,
  presentation?: SessionListPresentationSource,
): SessionBotFaceFacts | null {
  const shared = readSessionListRenderableSharedMetadata(identity);
  if (!readSessionBotV1(shared?.bot)) return null;
  const session = presentation ? { ...presentation.row, ...readSessionListPresentationRuntime(presentation) } : identity;
  const completedAt = readSessionTurnCompletedAt(session);
  return {
    seed: getSessionAvatarId(identity, serverId),
    face: readSessionBotFaceV1(shared?.botFace),
    completedAt,
    failedAt: session.latestTurnStatus === 'failed' ? session.latestTurnStatusObservedAt ?? null : null,
    restingMood: session.latestTurnStatus === 'failed' ? 'failed'
      : completedAt !== null && deriveSessionReadState({ ...session, seq: session.seq ?? 0 }) === 'unread' ? 'done' : 'quiet',
  };
}

/** Value equality, so projections keep an unchanged face's identity across unrelated Session pushes. */
export function areSessionBotFaceFactsEqual(left: SessionBotFaceFacts | null, right: SessionBotFaceFacts | null): boolean {
  return left === right || Boolean(left && right && left.seed === right.seed
    && left.completedAt === right.completedAt && left.failedAt === right.failedAt
    && left.restingMood === right.restingMood
    && areSessionBotFacesEqual(left.face, right.face));
}
