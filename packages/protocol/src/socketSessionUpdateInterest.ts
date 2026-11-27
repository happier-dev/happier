/**
 * A user-scoped connection can narrow session updates without changing its account scope.
 * The transcript marker means this connection never consumes live transcript streams; the runtime interest set
 * arrives through a later runtime event, so the marker alone declares an empty set.
 */
export const SESSION_UPDATE_INTEREST_SOCKET_AUTH_FIELD = 'sessionUpdateInterest';
export const TRANSCRIPT_INTEREST_DECLARED_SOCKET_AUTH_FIELD = 'transcriptInterestDeclared';
