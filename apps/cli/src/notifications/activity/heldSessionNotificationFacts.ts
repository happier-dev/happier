import { ACCOUNT_SESSION_FOLLOW_CHANGE_ENTITY_ID } from '@happier-dev/protocol/sessions/follow/changes';
import type { FollowDeliveryMuteScopeV1 } from '@happier-dev/protocol/sessions/follow/sessionDeliveryMuteV1';

import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';

/**
 * Notification eligibility facts a Session host already receives invalidations for.
 *
 * Personal eligibility reads the viewer's Follow facts, responsibility and effective access
 * (Session detail) and the Account's delivery mutes. Those change only through:
 * - the Account's Follow/mute writer, whose Account wake names `session-follows`;
 * - a Session relation change, pushed to the Session socket as `session-changed`;
 * - access changes, which retire the connection.
 * A live Session client that receives both pushes holds the last read and drops it on any of
 * them, so a Turn's notifications read nothing new. Without a live holder every read goes to
 * Home exactly as before (fail closed: absence of a holder never reuses a fact).
 */
type Held = {
  holders: number;
  sessions: Map<string, number>;
  contexts: Map<string, Promise<RawSessionRecord | null>>;
  mutes: Promise<readonly FollowDeliveryMuteScopeV1[] | null> | null;
};

const heldByToken = new Map<string, Held>();

export type SessionNotificationFactsHold = Readonly<{
  /** Drop held facts for this Session (relation push) or for the whole Account (Follow/mute change). */
  invalidate(scope: 'session' | 'account'): void;
  release(): void;
}>;

/** Registers one live Session client (both of its pushes connected) as a holder. */
export function holdSessionNotificationFacts(token: string, sessionId: string): SessionNotificationFactsHold {
  let held = heldByToken.get(token);
  if (!held) {
    held = { holders: 0, sessions: new Map(), contexts: new Map(), mutes: null };
    heldByToken.set(token, held);
  }
  const current = held;
  current.holders += 1;
  current.sessions.set(sessionId, (current.sessions.get(sessionId) ?? 0) + 1);
  let released = false;
  return {
    invalidate(scope) {
      if (released) return;
      current.contexts.delete(sessionId);
      if (scope === 'account') {
        current.contexts.clear();
        current.mutes = null;
      }
    },
    release() {
      if (released) return;
      released = true;
      current.contexts.delete(sessionId);
      current.mutes = null;
      const remaining = (current.sessions.get(sessionId) ?? 1) - 1;
      if (remaining > 0) current.sessions.set(sessionId, remaining);
      else current.sessions.delete(sessionId);
      current.holders -= 1;
      if (current.holders <= 0 && heldByToken.get(token) === current) heldByToken.delete(token);
    },
  };
}

/** Account wakes that may change Follow facts or delivery mutes: the named entity, or a coarse wake. */
export function isNotificationFactsAccountWake(body: unknown): boolean {
  if (!body || typeof body !== 'object' || (body as { t?: unknown }).t !== 'account-change') return false;
  const entityIds = (body as { entityIds?: unknown }).entityIds;
  return !Array.isArray(entityIds) || entityIds.includes(ACCOUNT_SESSION_FOLLOW_CHANGE_ENTITY_ID);
}

function share<T>(held: Held, slot: 'context' | 'mutes', sessionId: string | null,
  read: () => Promise<T | null>): Promise<T | null> {
  const pending = read().then(value => value, () => null);
  const drop = () => {
    if (slot === 'mutes') { if (held.mutes === (pending as unknown)) held.mutes = null; }
    else if (sessionId && held.contexts.get(sessionId) === (pending as unknown)) held.contexts.delete(sessionId);
  };
  // Only a successful read is held; unavailable stays unavailable and is retried next time.
  void pending.then(value => { if (value === null) drop(); });
  return pending;
}

export function readHeldSessionNotificationContext(token: string, sessionId: string,
  read: () => Promise<RawSessionRecord | null>): Promise<RawSessionRecord | null> {
  const held = heldByToken.get(token);
  if (!held || !held.sessions.has(sessionId)) return read();
  const existing = held.contexts.get(sessionId);
  if (existing) return existing;
  const pending = share(held, 'context', sessionId, read);
  held.contexts.set(sessionId, pending);
  return pending;
}

export function readHeldAccountDeliveryMutes(token: string,
  read: () => Promise<readonly FollowDeliveryMuteScopeV1[] | null>): Promise<readonly FollowDeliveryMuteScopeV1[] | null> {
  const held = heldByToken.get(token);
  if (!held) return read();
  if (held.mutes) return held.mutes;
  const pending = share(held, 'mutes', null, read);
  held.mutes = pending;
  return pending;
}
