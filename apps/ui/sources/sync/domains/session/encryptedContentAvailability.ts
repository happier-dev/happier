import type { SessionDataKeyHydrationState } from '@/sync/encryption/sessionDataKeyHydration';
import type { AccountRecipientEnvelopeReadiness } from '@happier-dev/protocol/account/encryptionMode';

export const SESSION_CONTENT_AVAILABILITIES = [
    'ready',
    'encrypted_access_pending',
    'recipient_encryption_setup_required',
    'encrypted_access_needs_repair',
    'encrypted_content_unavailable',
] as const;

/**
 * What the current viewer can do about this Session's encrypted content right now.
 *
 * Derived only by the decryption owners (`deriveSessionContentAvailability`); never sent to or
 * stored by a Home. Route access, Home connectivity, Account unlock and deletion stay separate
 * concerns, and no component re-interprets a raw crypto failure on its own. The device-local warm
 * cache keeps the last settled value beside the row it describes, as last-known state that the
 * next hydration re-derives.
 */
export type SessionContentAvailability = typeof SESSION_CONTENT_AVAILABILITIES[number];

/**
 * The Account-owned view of whether this viewer's Account can receive Session keys at all.
 * The Account response owns this decision; local credentials and fingerprints do not replace it.
 */
export type RecipientEncryptionReadiness = AccountRecipientEnvelopeReadiness;

export function deriveSessionContentAvailability(params: Readonly<{
    hydrationState: SessionDataKeyHydrationState;
    recipientReadiness?: RecipientEncryptionReadiness;
    contentAuthenticationFailed?: boolean;
}>): SessionContentAvailability {
    switch (params.hydrationState) {
        case 'not_required':
        case 'ready':
        case 'legacy_fallback_ready':
            // The key path succeeded, so a failure below it is a content fact, not an envelope one.
            return params.contentAuthenticationFailed === true
                ? 'encrypted_content_unavailable'
                : 'ready';
        case 'unopenable_envelope':
            return 'encrypted_access_needs_repair';
        case 'missing_envelope':
            switch (params.recipientReadiness?.status === 'unavailable' ? params.recipientReadiness.reason : undefined) {
                case 'plain_account':
                case 'encryption_setup_required':
                    return 'recipient_encryption_setup_required';
                case 'encryption_inconsistent':
                    return 'encrypted_access_needs_repair';
                default:
                    return 'encrypted_access_pending';
            }
    }
}

/** Every availability that must be explained instead of showing content. */
export type BlockedSessionContentAvailability = Exclude<SessionContentAvailability, 'ready'>;

/** The two fields every Session and list row carry for the content fact. */
export type SessionContentAvailabilitySubject = Readonly<{
    encryptionMode?: 'e2ee' | 'plain' | null;
    encryptedContentAvailability?: SessionContentAvailability | null;
}>;

/**
 * The one reader of a Session's (or list row's) content fact; every locked, readable or blocked
 * decision starts here.
 *
 * A plain Session defaults to readable, except when its Account-scoped owner metadata has a
 * settled unavailable result. An absent E2EE fact means *unsettled*: no decryption owner has
 * decided it for this viewer yet (hydration still running, or a row restored from a cache entry
 * written before the fact was persisted). Unsettled is `null`, and it is neither readable nor
 * blocked: content-derived surfaces keep only a safe identity until hydration decides.
 */
export function readSessionContentAvailability(
    subject: SessionContentAvailabilitySubject,
): SessionContentAvailability | null {
    return subject.encryptedContentAvailability
        ?? (subject.encryptionMode === 'plain' ? 'ready' : null);
}

/** An encrypted Session no decryption owner has decided for this viewer yet: neither readable nor blocked. */
export function isSessionContentUnsettled(subject: SessionContentAvailabilitySubject): boolean {
    return subject.encryptionMode !== 'plain' && readSessionContentAvailability(subject) === null;
}

/**
 * Every derived value is settled by construction: hydration has finished deciding and retrying
 * cannot change the answer, so a present availability means route and list surfaces stop showing
 * progress. Unsettled (`null`) is not readable.
 */
export function isSessionContentReadable(availability: SessionContentAvailability | null): boolean {
    return availability === 'ready';
}

/** A settled availability that must replace content with an explanation; `null` when content may show or is unsettled. */
export function readBlockedSessionContentAvailability(
    availability: SessionContentAvailability | null,
): BlockedSessionContentAvailability | null {
    return availability === null || availability === 'ready' ? null : availability;
}
