import type { BlockedSessionContentAvailability } from '@/sync/domains/session/encryptedContentAvailability';

/**
 * The typed failure for an E2EE Session this client cannot open or seal: no Session
 * reader is installed and none could be hydrated from the Session's published data-key
 * envelope. The Session itself may well exist, so this must never read as "not found",
 * and callers must never answer it by falling back to plaintext.
 *
 * `session_encryption_not_found` is the code the by-id hydration owner already returns
 * for the same condition; `scoped_session_encryption_unavailable` is the scoped
 * (captured Account authority) hydration owner's code.
 */
export type SessionEncryptionUnavailableCode =
    | 'session_encryption_not_found'
    | 'scoped_session_encryption_unavailable';

/**
 * `contentAvailability` is the viewer's settled content fact when hydration decided why no reader
 * exists (for example a Team recipient whose envelope is not sealed yet). It explains the refusal;
 * it never opens anything.
 */
export function createSessionEncryptionUnavailableError(
    sessionId: string,
    code: SessionEncryptionUnavailableCode = 'session_encryption_not_found',
    contentAvailability?: BlockedSessionContentAvailability,
): Error & Readonly<{ code: SessionEncryptionUnavailableCode; contentAvailability?: BlockedSessionContentAvailability }> {
    return Object.assign(
        new Error(`Session encryption is unavailable for ${sessionId}`),
        { code, ...(contentAvailability ? { contentAvailability } : {}) },
    );
}
