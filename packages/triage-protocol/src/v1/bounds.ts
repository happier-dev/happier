/**
 * Stable V1 identity of the one target-owned Triage sources point.
 *
 * `CONTRACT.md` §1 and §2.1 fix these names and values as the wire contract.
 */
export const TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1 = 'sources';
export const TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1 = 'happier.triage/sources';
export const TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1 = 1;
export const TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1 = 'happier.triage';

/**
 * The one target-owned embedded Surface role a source contributes.
 *
 * The mounted aggregate has to name this role to pick the right handle out of
 * its admitted-contribution snapshot, and a role name spelled twice is a mount
 * that silently renders nothing when one spelling changes.
 * `contribution.test.ts` binds this constant to the declared surface set.
 */
export const TRIAGE_SOURCE_DETAIL_SURFACE_ROLE_V1 = 'detail';

/**
 * Every V1 string is a single-line string: C0 control characters and `U+007F`
 * are not representable in any of them.
 *
 * This is a byte contract as much as a display contract. A control character
 * costs one UTF-8 byte against the bounds below but six bytes once JSON escapes
 * it, so admitting one would multiply the derived worst-case encoded result for
 * content no list row can render. Sources normalize provider text — collapsing
 * newlines, tabs, and other control runs to spaces — before projecting it; the
 * target parses the completed result strictly and rejects a control-bearing
 * result atomically rather than repairing it (`CONTRACT.md` §2.1).
 */
export const TRIAGE_SINGLE_LINE_STRING_PATTERN_V1 = '^[^\\u0000-\\u001f\\u007f]+$';

/**
 * The grammar of a source-owned composite identifier: two single-line
 * components joined by at most one `U+001F`.
 *
 * V1 has exactly two such strings, and both are structural keys no surface
 * renders: `collisionScope`, which `CONTRACT.md` §6 maps for Sentry to
 * `origin U+001F organization id`, and `localInstanceKey`, which
 * `sources/SENTRY.md` §2.4 pins to the same
 * `<normalized deploymentOrigin> U+001F <organizationId>` pair. Both therefore
 * have to carry that byte or a first-party source cannot express its own
 * instance and entry identity, and every one of its results is rejected
 * atomically.
 *
 * One grammar owns both, so a third composite field cannot acquire a
 * similar-but-different separator rule. Admitting exactly one separator —
 * rather than relaxing the whole control range — is what keeps the exception
 * affordable: a separator escapes to six bytes, so a key filled with them
 * would cost three times a maximal display string for content no surface
 * renders. A source that composes more than two components picks a separator
 * its own components cannot contain, as PostHog, GitLab, GitHub, Bitbucket,
 * and Azure DevOps all do.
 */
export const TRIAGE_COMPOSITE_IDENTIFIER_PATTERN_V1 =
    '^[^\\u0000-\\u001f\\u007f]+(?:\\u001f[^\\u0000-\\u001f\\u007f]+)?$';

/**
 * One line of projected display text: a row title, subtitle, scope label, the
 * provider's own state word, or an attention reason. Source projection
 * truncates to this bound and sets `projectionTruncated`; it never drops an
 * identity-valid entry.
 *
 * This is a list-row bound, not a document bound. Body, description, comment,
 * activity, diff, and complete label/reviewer content is detail-surface content
 * that a live source materialization returns; it never rides a scan or get
 * result.
 *
 * It is a byte bound on text every writing system has to fit, so its size is
 * the widest encoding of the longest thing it carries, not a character count.
 * The longest is a title, and a title stops being one somewhere around a few
 * hundred characters. A CJK character costs three UTF-8 bytes and an emoji
 * four, so 768 bytes is that length in the widest script a title is routinely
 * written in: 512 Latin characters, 170 Chinese, Japanese, or Korean, 128
 * emoji. The predecessor bound of 192 bytes was that length in Latin only — it
 * clipped a Japanese title at 64 characters and an emoji-bearing one at 48.
 * The entity survived either way, with `projectionTruncated` set and the full
 * text on the detail surface, but the row read as truncated on every non-Latin
 * list in the product, which is a display bound failing at its one job.
 *
 * Its cost is paid entirely in the worst case: a scope label is a repository
 * name and a state word is a word whatever this bound admits.
 * `maximumEncodedResult.test.ts` derives that worst case, and
 * `MAX_TRIAGE_SCAN_PAGE_ENTRIES_V1` is where it is paid for.
 */
export const MAX_TRIAGE_TEXT_UTF8_BYTES_V1 = 512;
/**
 * A machine-meaningful location string — an entry or instance `webUrl`, a
 * selected workspace root, or a prepared repository path. It is larger than
 * display text because truncating it silently produces a wrong destination: a
 * source that cannot fit one omits it instead.
 */
export const MAX_TRIAGE_LOCATION_UTF8_BYTES_V1 = 384;
/**
 * Provider/source identifier boundary — a declared kind id, provider entry id,
 * native revision, attention reason id, failure code, account purpose, or
 * source-native instance key. Invalid identity omits the raw provider row.
 *
 * It fits a UUID, a numeric provider id, a commit sha, an entity tag, and a
 * normalized deployment origin with room to spare. It also bounds
 * `localInstanceKey`, whose composite form is one normalized origin beside one
 * immutable provider id and carries none of the source qualifier or encoded
 * repository id that widens `collisionScope`.
 */
export const MAX_TRIAGE_IDENTIFIER_UTF8_BYTES_V1 = 128;
/**
 * The source-owned composite entry-scope key.
 *
 * It is wider than a plain identifier because a real entry scope carries a
 * source qualifier and a normalized deployment origin — sometimes encoded —
 * beside an immutable provider id, and a self-managed origin is long. Like
 * `localInstanceKey` it can carry a sixfold-escaping byte, but at most one, so
 * its worst case stays comparable to a maximal display string.
 */
export const MAX_TRIAGE_COLLISION_SCOPE_UTF8_BYTES_V1 = 192;
/**
 * Source-private current route token carried on an entry locator.
 *
 * It is sized for what routing one entry needs — the owning repository or
 * project a scan discovered it in, so a later `get` reaches it without
 * re-deriving a route from identity — and every byte of it is multiplied by the
 * scan page size.
 */
export const MAX_TRIAGE_ROUTING_TOKEN_UTF8_BYTES_V1 = 192;
/**
 * Source-private configured-instance token.
 *
 * `listInstances` multiplies it by `MAX_TRIAGE_INSTANCE_DRAFTS_V1`, so it is
 * sized for what a real configured instance encodes — a codec version plus one
 * selected scope, key, or project id — and not for a provider inventory. The
 * first-party encoders produce well under a tenth of it.
 */
export const MAX_TRIAGE_CONFIGURATION_TOKEN_UTF8_BYTES_V1 = 1024;
/**
 * Invocation-local scan continuation token; exactly one per scan page, so it is
 * the one token that is never multiplied.
 *
 * It stays generous because a fair multi-lane traversal encodes one frontier
 * entry per open lane — a workspace repository, a project, or an involvement
 * lane — plus each lane's provider-issued next URL, and a source that cannot
 * fit its frontier has to abandon the walk rather than resume it.
 */
export const MAX_TRIAGE_PAGING_TOKEN_UTF8_BYTES_V1 = 4 * 1024;
/** Bounded non-secret failure detail. */
export const MAX_TRIAGE_FAILURE_DETAIL_UTF8_BYTES_V1 = 256;
/**
 * One projected row-fact string: a fact's source-local id, its short label, or
 * its rendered value. A row fact is a chip beside a list row, never a sentence.
 */
export const MAX_TRIAGE_ROW_FACT_VALUE_UTF8_BYTES_V1 = 64;
/** Projected fact count; excess facts set `projectionTruncated`. */
export const MAX_TRIAGE_ROW_FACTS_V1 = 4;
/**
 * Entries in one scan page.
 *
 * This is the count that decides whether a scan result fits the Action byte
 * gate, because it multiplies every per-entry byte — including the six display
 * strings `MAX_TRIAGE_TEXT_UTF8_BYTES_V1` bounds. The two are one budget, and
 * lowering this count is the other way to pay for a wider display bound.
 *
 * It stays at 64 because it is not only a byte lever. A source sizes its own
 * provider paging against it — Azure DevOps fits exactly two 30-row native
 * pages inside 64, Bitbucket carries the pair as `scanLimit`/`nativePageSize`
 * in its continuation — so changing it changes four first-party walk
 * geometries, not just an arithmetic term. The display bound was widened out
 * of the gate headroom instead, which is where the headroom was going unspent
 * (`maximumEncodedResult.test.ts`).
 */
export const MAX_TRIAGE_SCAN_PAGE_ENTRIES_V1 = 64;
/**
 * Bounded discovery result. It multiplies the account binding, locator, and
 * configuration token of one draft, so it is the count that decides whether a
 * `listInstances` result fits the Action byte gate.
 */
export const MAX_TRIAGE_INSTANCE_DRAFTS_V1 = 32;
/** Bounded discovery failure result. */
export const MAX_TRIAGE_INSTANCE_FAILURES_V1 = 32;
/**
 * Configured instances one caller-scoped read can carry.
 *
 * It bounds the same per-instance payload `MAX_TRIAGE_INSTANCE_DRAFTS_V1`
 * bounds — one account binding, one locator, one configuration token — so the
 * two counts have the same byte consequence and are deliberately equal.
 *
 * It is NOT the target's active-set maximum, which is an Account-wide product
 * bound owned by the configured-instance writer and is never larger than this
 * count. What can exceed it is the caller's RETIRED rows: a retired row is the
 * record an explicit reactivation restores, so it is never deleted. The read
 * reports `truncated` when that happens rather than presenting a short page as
 * the whole set.
 */
export const MAX_TRIAGE_CONFIGURED_INSTANCE_RECORDS_V1 = 32;
/** Bounded descriptor kind vocabulary. */
export const MAX_TRIAGE_KINDS_V1 = 32;
/** Bounded detail projection of the canonical entry-to-Session link relation. */
export const MAX_TRIAGE_LINKED_SESSIONS_V1 = 32;

/**
 * The source-neutral workflow subject of one declared entry kind.
 * `CONTRACT.md` §5.3 admits review-workspace preparation only for `pullRequest`.
 */
export const TRIAGE_SOURCE_WORKFLOW_SUBJECTS_V1 = [
    'pullRequest',
    'issue',
    'errorIssue',
    'other',
] as const;

/**
 * Whether a source's `localInstanceKey` is immutable provider identity or is
 * derived from an explicitly configured normalized origin. `CONTRACT.md` §3.1
 * makes an origin change explicit reconfiguration rather than an alias
 * migration, so the distinction is declared rather than inferred.
 */
export const TRIAGE_SOURCE_INSTANCE_KEY_STABILITY_V1 = [
    'stable',
    'locatorDerived',
] as const;

/**
 * The closed source-neutral presentation projection of a provider state.
 * `unknown` is an enumerated V1 member with the nonterminal semantics in
 * `CONTRACT.md` §4: it stays `present` and never becomes a resolved,
 * suppressed, closed, or absent substitute.
 */
export const TRIAGE_ENTRY_PRESENTATION_STATES_V1 = [
    'active',
    'resolved',
    'closed',
    'suppressed',
    'unknown',
] as const;

/** The closed canonical viewer involvement vocabulary of `CONTRACT.md` §4. */
export const TRIAGE_VIEWER_INVOLVEMENTS_V1 = [
    'author',
    'assignee',
    'reviewRequested',
    'mentioned',
    'subscribed',
    'participating',
] as const;

/** Source-declared attention candidate levels; `none` is no meaningful candidate. */
export const TRIAGE_SOURCE_ATTENTION_LEVELS_V1 = [
    'suggested',
    'required',
] as const;

/** Relative display weight of one projected row fact. */
export const TRIAGE_ROW_FACT_IMPORTANCES_V1 = [
    'primary',
    'secondary',
    'supplementary',
] as const;

/** Display tone of a `status` row-fact value. */
export const TRIAGE_ROW_FACT_STATUS_TONES_V1 = [
    'success',
    'warning',
    'danger',
    'info',
    'neutral',
] as const;

/** Display format of a `timestamp` row-fact value. */
export const TRIAGE_ROW_FACT_TIMESTAMP_FORMATS_V1 = [
    'relative',
    'absolute',
] as const;

/** Display format of a `number` row-fact value. */
export const TRIAGE_ROW_FACT_NUMBER_FORMATS_V1 = [
    'compact',
    'plain',
] as const;

/**
 * Closed source failure classification. A class carries authority: an
 * unrecognized class is invalid rather than skipped (`CONTRACT.md` §8).
 */
export const TRIAGE_SOURCE_FAILURE_CLASSES_V1 = [
    'authentication',
    'permission',
    'rateLimit',
    'transient',
    'unsupportedContract',
    'unknown',
] as const;

/**
 * Closed reasons an optional review-workspace preparation could not reach an
 * execution target at all. `CONTRACT.md` §5.3.
 */
export const TRIAGE_REVIEW_WORKSPACE_UNAVAILABLE_REASONS_V1 = [
    'account',
    'machine',
    'scmResolver',
] as const;

/**
 * Closed reasons a source refused review-workspace preparation after
 * reauthorizing and rereading, before it touched a worktree.
 */
export const TRIAGE_REVIEW_WORKSPACE_REFUSED_REASONS_V1 = [
    'instanceMoved',
    'pullRequestMoved',
    'observedHeadMoved',
] as const;

/** Closed reasons a prepared workspace was deliberately left at a stale head. */
export const TRIAGE_REVIEW_WORKSPACE_STALE_REASONS_V1 = [
    'localCommits',
    'dirtyWorktree',
    'unresolvedHead',
] as const;

export type TriageSourceWorkflowSubjectValueV1 = (typeof TRIAGE_SOURCE_WORKFLOW_SUBJECTS_V1)[number];
export type TriageSourceInstanceKeyStabilityV1 = (typeof TRIAGE_SOURCE_INSTANCE_KEY_STABILITY_V1)[number];
export type TriageEntryPresentationStateV1 = (typeof TRIAGE_ENTRY_PRESENTATION_STATES_V1)[number];
export type TriageViewerInvolvementV1 = (typeof TRIAGE_VIEWER_INVOLVEMENTS_V1)[number];
export type TriageSourceAttentionLevelV1 = (typeof TRIAGE_SOURCE_ATTENTION_LEVELS_V1)[number];
export type TriageRowFactImportanceV1 = (typeof TRIAGE_ROW_FACT_IMPORTANCES_V1)[number];
export type TriageRowFactStatusToneV1 = (typeof TRIAGE_ROW_FACT_STATUS_TONES_V1)[number];
export type TriageRowFactTimestampFormatV1 = (typeof TRIAGE_ROW_FACT_TIMESTAMP_FORMATS_V1)[number];
export type TriageRowFactNumberFormatV1 = (typeof TRIAGE_ROW_FACT_NUMBER_FORMATS_V1)[number];
export type TriageSourceFailureClassV1 = (typeof TRIAGE_SOURCE_FAILURE_CLASSES_V1)[number];
export type TriageReviewWorkspaceUnavailableReasonV1 =
    (typeof TRIAGE_REVIEW_WORKSPACE_UNAVAILABLE_REASONS_V1)[number];
export type TriageReviewWorkspaceRefusedReasonV1 =
    (typeof TRIAGE_REVIEW_WORKSPACE_REFUSED_REASONS_V1)[number];
export type TriageReviewWorkspaceStaleReasonV1 =
    (typeof TRIAGE_REVIEW_WORKSPACE_STALE_REASONS_V1)[number];
