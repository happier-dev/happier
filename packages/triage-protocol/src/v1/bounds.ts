import { EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES } from '@happier-dev/plugin-sdk/actions';
import { PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1 } from '@happier-dev/plugin-sdk/collections';

/**
 * Stable V1 identity of the one target-owned Triage sources point.
 *
 * `CONTRACT.md` §1 and §2.1 fix these names and values as the wire contract.
 */
export const TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1 = 'sources';
export const TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1 = 'happier.triage/sources';
export const TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1 = 1;
export const TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1 = 'happier.triage';

/** The target-owned point where plugins declare agent action records (`subjectActions.ts`). */
export const TRIAGE_AGENT_ACTIONS_CONTRIBUTION_POINT_ID_V1 = 'agent-actions';
export const TRIAGE_AGENT_ACTIONS_CONTRIBUTION_PROTOCOL_ID_V1 = 'happier.triage/agent-actions';
export const TRIAGE_AGENT_ACTIONS_CONTRIBUTION_PROTOCOL_VERSION_V1 = 1;

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
 * Every V1 row-display string is a single-line string: C0 control characters and `U+007F`
 * are not representable in any of them.
 *
 * This is a byte contract as much as a display contract. A control character
 * costs one UTF-8 byte against the bounds below but six bytes once JSON escapes
 * it, so admitting one would multiply the derived worst-case encoded result for
 * content no list row can render. Sources normalize provider text — collapsing
 * newlines, tabs, and other control runs to spaces — before projecting it; the
 * target parses the completed result strictly and rejects a control-bearing
 * result atomically rather than repairing it (`CONTRACT.md` §2.1). Task write
 * documents have their own input schemas and preserve multiline body text.
 */
export { TRIAGE_SINGLE_LINE_STRING_PATTERN_V1 } from '@happier-dev/plugin-sdk/protocol';

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
export { TRIAGE_COMPOSITE_IDENTIFIER_PATTERN_V1 } from '@happier-dev/plugin-sdk/protocol';

/** One result page; the mounted store appends pages rather than limiting membership. */
export const MAX_TRIAGE_LIST_WINDOW_ROWS_V1 = 56;
/** One paged transport batch, not a configured-source membership limit. */
export const MAX_TRIAGE_LIST_SOURCE_BATCH_V1 = 32;

/**
 * Static presentation/control allocation inside the canonical Action envelope.
 * The finite schema witness has 26 allocated string slots per observed row and
 * four per source lane (label, failure detail, required permissions, continuation). Single-line
 * UTF-8 strings expand at most twofold in JSON. Its fixed framing, native
 * identities, stable scope-unit ids and explicit finite provider-fact witnesses
 * occupy 1,249,015 bytes, including configured row addresses, source-label
 * truncation markers and optional failures alongside partially readable lanes.
 * `maximumEncodedActionValue.test.ts` independently re-derives both coefficients
 * from the actual schema and proves this allocation fits and the next byte
 * does not, including all 56 rows and 32 lane continuations.
 *
 * This protects the bounded projection, not arbitrary provider collections:
 * facts, relations, transitions and configured scope units have no count quota;
 * their complete result remains governed by the existing host envelope.
 */
const listFixedEnvelopeBytes = 1_249_015;
const listEscapedFieldUnits = 2 * (
    MAX_TRIAGE_LIST_WINDOW_ROWS_V1 * 26 + MAX_TRIAGE_LIST_SOURCE_BATCH_V1 * 4
);
const listFieldUtf8Bytes = Math.floor(
    (EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES - listFixedEnvelopeBytes) / listEscapedFieldUnits,
);

/** Display truncation sets the existing row-local `projectionTruncated` marker. */
export const MAX_TRIAGE_TEXT_UTF8_BYTES_V1 = listFieldUtf8Bytes;
/**
 * Stable storage contract for configured-instance tokens and locator strings.
 * The retained source-instances V4 writer admits 7,336 UTF-8 bytes. List
 * projection growth must never narrow this persisted shape (QA82, 2026-10-31).
 */
export const MAX_TRIAGE_SOURCE_INSTANCE_FIELD_UTF8_BYTES_V1 = 7_336;
/**
 * A machine-meaningful location string — an entry or instance `webUrl`, a
 * selected workspace root, or a prepared repository path. An optional location
 * beyond the shared allocation is omitted, never shortened to another destination.
 */
export const MAX_TRIAGE_LOCATION_UTF8_BYTES_V1 = listFieldUtf8Bytes;
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
export { MAX_TRIAGE_IDENTIFIER_UTF8_BYTES_V1 } from '@happier-dev/plugin-sdk/protocol';
/**
 * A forge's canonical repository path (`ScmHostingProviderRef.nameWithOwner`).
 *
 * This is not a generic provider identifier. Its ceiling is the largest real
 * path admitted by the four V1 forges, measured in their path alphabets:
 * GitHub `owner/name` is `39 + 1 + 100 = 140` bytes; GitLab's complete routed
 * project path is 255 bytes; Bitbucket Cloud `workspace/repository-slug` is
 * `62 + 1 + 62 = 125` bytes; and Azure DevOps
 * `organization/project/repository` is `64 + 1 + 64 + 1 + 64 = 194` bytes.
 * The maximum of those contracts is therefore 255 bytes.
 *
 * A source still omits an over-bound repository identity rather than
 * truncating it or rejecting the entry: a shortened repository path names a
 * different checkout. The dedicated bound prevents that honest degradation
 * from silently removing placement for a path its forge legitimately admits.
 */
export const MAX_TRIAGE_REPOSITORY_PATH_UTF8_BYTES_V1 = 255;
/**
 * The source-owned composite entry-scope key.
 *
 * It is wider than a plain identifier because a real entry scope carries a
 * source qualifier and a normalized deployment origin — sometimes encoded —
 * beside an immutable provider id, and a self-managed origin is long. Like
 * `localInstanceKey` it can carry a sixfold-escaping byte, but at most one, so
 * its worst case stays comparable to a maximal display string.
 */
export { MAX_TRIAGE_COLLISION_SCOPE_UTF8_BYTES_V1 } from '@happier-dev/plugin-sdk/protocol';
/**
 * Source-private current route token carried on an entry locator.
 *
 * Uses the shared allocation; a source retains native route validation and
 * its existing omission evidence rather than truncating a route into another entry.
 */
export const MAX_TRIAGE_ROUTING_TOKEN_UTF8_BYTES_V1 = listFieldUtf8Bytes;
/**
 * Source-private configured-instance token.
 *
 * Shares the stable configured-instance storage contract, never list allocation.
 */
export const MAX_TRIAGE_CONFIGURATION_TOKEN_UTF8_BYTES_V1 = MAX_TRIAGE_SOURCE_INSTANCE_FIELD_UTF8_BYTES_V1;
/**
 * One source lane's invocation-local continuation, derived against the real
 * external Action response envelope alongside the row/control allocation above.
 * All lane frontiers survive the finite witness; no runtime fitter or new
 * continuation state is needed.
 */
export const MAX_TRIAGE_PAGING_TOKEN_UTF8_BYTES_V1 = listFieldUtf8Bytes;
/** Bounded non-secret failure detail. */
export const MAX_TRIAGE_FAILURE_DETAIL_UTF8_BYTES_V1 = listFieldUtf8Bytes;
/**
 * One projected row-fact string: a fact's source-local id, label or value.
 * The presenter selects its Signal from the full fact set.
 */
export const MAX_TRIAGE_ROW_FACT_VALUE_UTF8_BYTES_V1 = listFieldUtf8Bytes;
/**
 * One page of the canonical entry-to-Session relation.
 *
 * This is the generic Collection query boundary, not a Triage product count:
 * `PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1` is 200 at the Collection owner and the
 * aggregate test pins this projection to it. A detail read reports `hasMore`
 * from the Collection cursor, so the page never claims to be the whole durable
 * relation and linking itself remains uncapped.
 */
export const MAX_TRIAGE_LINKED_SESSIONS_PAGE_SIZE_V1 = PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1;

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
 * What a configured agent action can be offered on (`appliesTo`): every source
 * workflow subject plus the native subjects whose owners declare their own
 * action records (owner ruling 2026-11-07 "Agent actions: one shared flow").
 * Source descriptors keep the narrower source vocabulary above; a native record
 * still declares `other` as its source workflow subject.
 */
export const TRIAGE_ACTION_SUBJECTS_V1 = [
    ...TRIAGE_SOURCE_WORKFLOW_SUBJECTS_V1,
    'deploymentReceipt',
    'deploymentEnvironment',
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

/**
 * The target-owned detail tab vocabulary (r0.42), in the one order the target
 * renders it. A source declares which of these it supports per entry kind and
 * renders the requested one as a panel; its own extra tabs follow them.
 */
export const TRIAGE_DETAIL_SHARED_TABS_V1 = [
    'overview',
    'activity',
    'files',
    'checks',
] as const;
export type TriageDetailSharedTabIdV1 = (typeof TRIAGE_DETAIL_SHARED_TABS_V1)[number];

/**
 * The one non-tab panel: a kind that declares `detailActions` renders its
 * write controls (merge, close, reviewers…) when asked for this panel, and the
 * target places them in the detail header (r0.42).
 */
export const TRIAGE_DETAIL_ACTIONS_PANEL_V1 = 'actions';
