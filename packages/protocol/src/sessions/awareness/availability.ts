import type {
  SessionAwarenessCurrentnessInputV1,
  SessionContentAvailabilityInputV1,
} from './inputV1.js';
import type {
  SessionAwarenessAvailabilityV1,
  SessionAwarenessEncryptionV1,
} from './projectionV1.js';

/**
 * Content availability and completeness — the internal inputs behind the two public honesty
 * fields, `encryption` and `availability`.
 *
 * The rule that matters: readability is evidence, never inference. A caller that holds an
 * envelope has not opened it, so `ready` can only come from the incumbent decryption owner
 * saying it opened one. Everything else degrades toward `locked`/`repair_needed`, never toward
 * `plain` (AWI-04) — a content-blind server projection is allowed to be less complete than a
 * decrypted UI projection, but it must not disagree with it.
 */

export function resolveSessionAwarenessEncryptionV1(
  content: SessionContentAvailabilityInputV1,
): SessionAwarenessEncryptionV1 {
  if (content.mode === 'plain') return 'plain';
  switch (content.keyState) {
    case 'opened':
      return 'ready';
    case 'preparing':
      return 'preparing';
    case 'inconsistent':
      return 'repair_needed';
    case 'access_pending':
    case 'setup_required':
    case 'content_unavailable':
    case 'unknown':
      return content.keyState;
    default:
      return 'locked';
  }
}

/**
 * Whether this caller can actually read the Session's private content. Everything derived from
 * content — title, work headline, workspace path, lineage — is gated on this single answer so no
 * consumer can leak one of them by forgetting a different check (AWI-06).
 */
export function isSessionAwarenessContentReadableV1(
  encryption: SessionAwarenessEncryptionV1,
): encryption is 'plain' | 'ready' {
  return encryption === 'plain' || encryption === 'ready';
}

export function hasUnavailableAwarenessComponentV1(
  currentness: SessionAwarenessCurrentnessInputV1,
): boolean {
  return currentness.lifecycle === 'unavailable'
    || currentness.runtime === 'unavailable'
    || currentness.pending === 'unavailable'
    || currentness.work === 'unavailable';
}

export function resolveSessionAwarenessAvailabilityV1(
  params: Readonly<{
    encryption: SessionAwarenessEncryptionV1;
    currentness: SessionAwarenessCurrentnessInputV1;
  }>,
): SessionAwarenessAvailabilityV1 {
  if (!isSessionAwarenessContentReadableV1(params.encryption)) return 'locked';
  return hasUnavailableAwarenessComponentV1(params.currentness) ? 'partial' : 'complete';
}
