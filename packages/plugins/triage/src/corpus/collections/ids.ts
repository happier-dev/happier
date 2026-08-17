/**
 * Canonical Collection, field and index identifiers for Triage's durable user
 * state.
 *
 * Every one of these strings is durable server metadata: it survives in the
 * admitted contract digest, and an index value is plaintext even on an E2EE
 * Account. Renaming or adding one is a persistence change, not a refactor.
 *
 * There are three Collections and no more. Provider-derived data is never
 * Account-persisted, so it has no storage identity here at all: no collection
 * id, no field, no index.
 */

export const CORPUS_SOURCE_INSTANCES_COLLECTION_ID = 'source-instances';
export const CORPUS_SESSION_LINKS_COLLECTION_ID = 'session-links';
export const CORPUS_USER_MARKS_COLLECTION_ID = 'user-marks';

export const CORPUS_SOURCE_INSTANCES_FIELD = {
    instanceTag: 'instanceTag',
    sourceQualifiedId: 'sourceQualifiedId',
    lifecycle: 'lifecycle',
    configuredAtMs: 'configuredAtMs',
    configured: 'configured',
    retiredReason: 'retiredReason',
} as const;

export const CORPUS_SESSION_LINKS_FIELD = {
    linkTag: 'linkTag',
    entryTag: 'entryTag',
    sessionId: 'sessionId',
    linkedAtMs: 'linkedAtMs',
    cardPublicationId: 'cardPublicationId',
    entryRef: 'entryRef',
    identityEntryRef: 'identityEntryRef',
    displayPathAtLink: 'displayPathAtLink',
} as const;

export const CORPUS_USER_MARKS_FIELD = {
    markTag: 'markTag',
    pinned: 'pinned',
    markedAtMs: 'markedAtMs',
    entryRef: 'entryRef',
    displayAtMark: 'displayAtMark',
} as const;

export const CORPUS_SOURCE_INSTANCES_INDEX_ID = {
    byLifecycle: 'by-lifecycle',
} as const;

export const CORPUS_SESSION_LINKS_INDEX_ID = {
    byEntry: 'by-entry',
    bySession: 'by-session',
} as const;

export const CORPUS_USER_MARKS_INDEX_ID = {
    byPinned: 'by-pinned',
} as const;

/**
 * The one declared UI query, and its declared page size.
 *
 * A UI query is the only way a mounted Plugin surface reaches an Account
 * Collection at all — a surface holds a Host API with no storage member — and
 * the Data client refuses any id the admitted contract does not declare exactly
 * once. It lives beside the Collection it addresses so the declaring half and
 * the surface's half cannot name two different queries.
 */
export const CORPUS_SESSION_LINKS_UI_QUERY_ID = {
    linkedForSession: 'linked-for-session',
} as const;

/**
 * One page, deliberately not an accumulating list: a Session with hundreds of
 * links must not turn a sidebar tab into an unbounded list, and every rendered
 * row costs one private row read.
 */
export const CORPUS_SESSION_LINKS_UI_QUERY_PAGE_SIZE = 50;

/** Numerically prefixed so `by-lifecycle` enumerates active instances first. */
export const CORPUS_SOURCE_INSTANCE_LIFECYCLE = {
    active: '1-active',
    retired: '2-retired',
} as const;
export type CorpusSourceInstanceLifecycleV1 =
    (typeof CORPUS_SOURCE_INSTANCE_LIFECYCLE)[keyof typeof CORPUS_SOURCE_INSTANCE_LIFECYCLE];

export const CORPUS_SOURCE_INSTANCE_RETIRED_REASONS = [
    'sourceUninstalled',
    'userRemoved',
    'reconfigured',
] as const;
export type CorpusSourceInstanceRetiredReasonV1 = (typeof CORPUS_SOURCE_INSTANCE_RETIRED_REASONS)[number];

/**
 * Every durable identity is 43 characters over `[A-Za-z0-9_-]` in both Account
 * modes, so the row-id byte ceiling is unreachable and U+0000 is not
 * representable in the output alphabet at all.
 */
export const CORPUS_IDENTITY_TAG_LENGTH = 43;
export const CORPUS_IDENTITY_TAG_PATTERN = '^[A-Za-z0-9_-]{43}$';
