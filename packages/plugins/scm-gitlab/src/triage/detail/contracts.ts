/**
 * The source-native GitLab detail Action contracts.
 *
 * The detail body runs in a UI artifact that holds no credential and speaks no
 * HTTP, while `http/gitlabClient.ts` is this source's sole credential reader.
 * The bridge between them is these Actions, declared with the same public schema
 * builders the shared Triage contract uses. They carry no Triage role: a note, a
 * resource event, a discussion, an approval, a pipeline and a changed file are
 * GitLab-native content this source's own detail body reads, not Triage entries
 * the aggregate may hold.
 *
 * Every published bound is the exact value the boundary projector applies, so a
 * page the projector can produce always parses and a page it never could is
 * rejected here rather than becoming a second, looser statement of what may
 * leave this source. Each result object is `closed`, which is what makes an
 * accidentally widened projection a failure instead of a leak.
 *
 * The paging position is a token this source mints around GitLab's own
 * `Link rel="next"` URL. GitLab documents keyset pagination as "use only the
 * given link", so the URL is what a cursor must be here — and it is re-admitted
 * against the invoked origin every time it crosses back in, so a token can never
 * aim the binding's credential at another host.
 */

import {
  EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES,
} from '@happier-dev/plugin-sdk/actions';
import {
  defineProtocolArray,
  defineProtocolLiteral,
  defineProtocolNumber,
  defineProtocolObject,
  defineProtocolString,
  defineProtocolUnion,
  defineProtocolUtf8String,
} from '@happier-dev/plugin-sdk/protocol';
import {
  MAX_TRIAGE_ROUTING_TOKEN_UTF8_BYTES_V1,
  TriageConfiguredSourceInstanceV1Schema,
  TriageSourceEntryLocalRefV1Schema,
  TriageSourceFailureV1Schema,
} from '@happier-dev/triage-protocol/v1';

import {
  GITLAB_DETAIL_BOUNDS_V1,
} from './projection.js';
import { GITLAB_MAX_DETAIL_PAGE_SIZE_V1 } from './routes.js';

const GitlabBooleanSchema = defineProtocolUnion([
  defineProtocolLiteral(true),
  defineProtocolLiteral(false),
]);

const IdentifierSchema = defineProtocolUtf8String({
  maxUtf8Bytes: GITLAB_DETAIL_BOUNDS_V1.identifierUtf8Bytes,
  minLength: 1,
});
const LabelSchema = defineProtocolString({ minLength: 1 });
const PathSchema = defineProtocolString({ minLength: 1 });
const LocationSchema = defineProtocolUtf8String({
  maxUtf8Bytes: GITLAB_DETAIL_BOUNDS_V1.locationUtf8Bytes,
  minLength: 1,
});
/**
 * A note body may be empty: GitLab accepts a note whose content is only an
 * attachment, and such a note is still a real event in the conversation.
 */
const NoteBodySchema = defineProtocolString();
const TimestampSchema = defineProtocolNumber({ integer: true });
const CountSchema = defineProtocolNumber({ integer: true, minimum: 0 });

const RoutingTokenSchema = defineProtocolUtf8String({
  maxUtf8Bytes: MAX_TRIAGE_ROUTING_TOKEN_UTF8_BYTES_V1,
  minLength: 1,
});

const ContinuationSchema = defineProtocolString({
  minLength: 1,
});

const PageLimitSchema = defineProtocolNumber({
  integer: true,
  minimum: 1,
  maximum: GITLAB_MAX_DETAIL_PAGE_SIZE_V1,
});

/**
 * Why a walk stopped short of the whole collection.
 *
 * GitLab has no documented collection ceiling on these resources, so
 * `pagination` — a next page GitLab advertised that this source refused to
 * follow — is the only member. Rows already read are kept, and this is never an
 * empty result.
 */
const IncompleteReasonSchema = defineProtocolLiteral('pagination');

const pagedPlaneInput = defineProtocolObject({
  v: defineProtocolLiteral(1),
  instance: TriageConfiguredSourceInstanceV1Schema,
  localRef: TriageSourceEntryLocalRefV1Schema,
  routingToken: RoutingTokenSchema,
  limit: PageLimitSchema,
  /** Present only for a following page, and only as this source minted it. */
  continuation: ContinuationSchema.optional(),
}, { policy: 'closed' });

const itemPlaneInput = defineProtocolObject({
  v: defineProtocolLiteral(1),
  instance: TriageConfiguredSourceInstanceV1Schema,
  localRef: TriageSourceEntryLocalRefV1Schema,
  routingToken: RoutingTokenSchema,
}, { policy: 'closed' });

const GitlabDetailUnavailableSchema = defineProtocolObject({
  kind: defineProtocolLiteral('unavailable'),
  failure: TriageSourceFailureV1Schema,
}, { policy: 'closed' });

/* --------------------------------------------------------------------- notes */

export const GitlabNotesInputV1Schema = pagedPlaneInput;
export type GitlabNotesInputV1 = ReturnType<typeof GitlabNotesInputV1Schema.parse>;

export const GitlabProjectedNoteRowV1Schema = defineProtocolObject({
  id: IdentifierSchema,
  author: LabelSchema.optional(),
  body: NoteBodySchema,
  atMs: TimestampSchema.optional(),
  editedAtMs: TimestampSchema.optional(),
  /** GitLab's own `system` flag: a state change served through the notes route. */
  system: GitlabBooleanSchema,
  resolved: GitlabBooleanSchema.optional(),
  truncated: defineProtocolLiteral(true).optional(),
}, { policy: 'closed' });

export const GitlabNotesResultV1Schema = defineProtocolUnion([
  defineProtocolObject({
    kind: defineProtocolLiteral('notes'),
    rows: defineProtocolArray(GitlabProjectedNoteRowV1Schema, {
      maxItems: GITLAB_MAX_DETAIL_PAGE_SIZE_V1,
    }),
    omittedRowCount: CountSchema,
    projectionTruncated: GitlabBooleanSchema,
    incomplete: IncompleteReasonSchema.optional(),
    /** Absent when this page ends the walk. */
    continuation: ContinuationSchema.optional(),
  }, { policy: 'closed' }),
  GitlabDetailUnavailableSchema,
]);
export type GitlabNotesResultV1 = ReturnType<typeof GitlabNotesResultV1Schema.parse>;

/* ------------------------------------------------------------ activity events */

/**
 * The event source is part of the request because the three collections are
 * three endpoints with three independent cursors. Folding them into one Action
 * with one continuation is exactly the sharing `sources/SCM.md` §4.6 forbids:
 * advancing one source would silently advance the others.
 */
const ActivityEventSourceSchema = defineProtocolUnion([
  defineProtocolLiteral('state'),
  defineProtocolLiteral('label'),
  defineProtocolLiteral('milestone'),
]);

export const GitlabActivityEventsInputV1Schema = defineProtocolObject({
  v: defineProtocolLiteral(1),
  instance: TriageConfiguredSourceInstanceV1Schema,
  localRef: TriageSourceEntryLocalRefV1Schema,
  routingToken: RoutingTokenSchema,
  eventSource: ActivityEventSourceSchema,
  limit: PageLimitSchema,
  continuation: ContinuationSchema.optional(),
}, { policy: 'closed' });
export type GitlabActivityEventsInputV1 = ReturnType<
  typeof GitlabActivityEventsInputV1Schema.parse
>;

export const GitlabProjectedActivityEventRowV1Schema = defineProtocolObject({
  id: IdentifierSchema,
  source: ActivityEventSourceSchema,
  action: LabelSchema,
  atMs: TimestampSchema.optional(),
  actor: LabelSchema.optional(),
  subject: LabelSchema.optional(),
  truncated: defineProtocolLiteral(true).optional(),
}, { policy: 'closed' });

export const GitlabActivityEventsResultV1Schema = defineProtocolUnion([
  defineProtocolObject({
    kind: defineProtocolLiteral('activityEvents'),
    source: ActivityEventSourceSchema,
    rows: defineProtocolArray(GitlabProjectedActivityEventRowV1Schema, {
      maxItems: GITLAB_MAX_DETAIL_PAGE_SIZE_V1,
    }),
    omittedRowCount: CountSchema,
    projectionTruncated: GitlabBooleanSchema,
    incomplete: IncompleteReasonSchema.optional(),
    continuation: ContinuationSchema.optional(),
  }, { policy: 'closed' }),
  GitlabDetailUnavailableSchema,
]);
export type GitlabActivityEventsResultV1 = ReturnType<
  typeof GitlabActivityEventsResultV1Schema.parse
>;

/* --------------------------------------------------------------- discussions */

export const GitlabDiscussionsInputV1Schema = pagedPlaneInput;
export type GitlabDiscussionsInputV1 = ReturnType<typeof GitlabDiscussionsInputV1Schema.parse>;

export const GitlabProjectedDiscussionRowV1Schema = defineProtocolObject({
  id: IdentifierSchema,
  individualNote: GitlabBooleanSchema,
  /**
   * The whole returned thread, bounded. The reader's four-reply window is a
   * client-local window over these rows and never a nested HTTP cursor: GitLab
   * documents no per-discussion note pagination.
   */
  notes: defineProtocolArray(GitlabProjectedNoteRowV1Schema),
  omittedNoteCount: CountSchema,
  truncated: defineProtocolLiteral(true).optional(),
}, { policy: 'closed' });

export const GitlabDiscussionsResultV1Schema = defineProtocolUnion([
  defineProtocolObject({
    kind: defineProtocolLiteral('discussions'),
    rows: defineProtocolArray(GitlabProjectedDiscussionRowV1Schema, {
      maxItems: GITLAB_MAX_DETAIL_PAGE_SIZE_V1,
    }),
    omittedRowCount: CountSchema,
    projectionTruncated: GitlabBooleanSchema,
    incomplete: IncompleteReasonSchema.optional(),
    continuation: ContinuationSchema.optional(),
  }, { policy: 'closed' }),
  GitlabDetailUnavailableSchema,
]);
export type GitlabDiscussionsResultV1 = ReturnType<typeof GitlabDiscussionsResultV1Schema.parse>;

/* ----------------------------------------------------------------- approvals */

export const GitlabApprovalsInputV1Schema = itemPlaneInput;
export type GitlabApprovalsInputV1 = ReturnType<typeof GitlabApprovalsInputV1Schema.parse>;

export const GitlabProjectedApprovalRuleV1Schema = defineProtocolObject({
  id: IdentifierSchema,
  name: LabelSchema,
  approvalsRequired: CountSchema.optional(),
  approved: GitlabBooleanSchema.optional(),
  truncated: defineProtocolLiteral(true).optional(),
}, { policy: 'closed' });

/**
 * Approval RULES are Premium/Ultimate; approval STATE and the approve verb are
 * not. The two therefore settle separately, and a `403`/`404` on the rules route
 * is `editionUnsupported` — a licence answer — rather than a failure that would
 * take the whole tab down with it.
 */
const GitlabApprovalRulesSchema = defineProtocolUnion([
  defineProtocolObject({
    kind: defineProtocolLiteral('available'),
    rules: defineProtocolArray(GitlabProjectedApprovalRuleV1Schema),
    omittedRuleCount: CountSchema,
  }, { policy: 'closed' }),
  defineProtocolObject({
    kind: defineProtocolLiteral('editionUnsupported'),
  }, { policy: 'closed' }),
  defineProtocolObject({
    kind: defineProtocolLiteral('unavailable'),
    failure: TriageSourceFailureV1Schema,
  }, { policy: 'closed' }),
]);

export const GitlabApprovalsResultV1Schema = defineProtocolUnion([
  defineProtocolObject({
    kind: defineProtocolLiteral('approvals'),
    approvalsRequired: CountSchema.optional(),
    approvalsLeft: CountSchema.optional(),
    approvedBy: defineProtocolArray(LabelSchema),
    omittedApproverCount: CountSchema,
    userHasApproved: GitlabBooleanSchema.optional(),
    /**
     * GitLab's own answer for THIS account. Absent means GitLab did not say, and
     * the reader offers the verb rather than hiding it: gating approve behind an
     * edition guess removes a working button from every Free user.
     */
    userCanApprove: GitlabBooleanSchema.optional(),
    rules: GitlabApprovalRulesSchema,
    projectionTruncated: GitlabBooleanSchema,
  }, { policy: 'closed' }),
  GitlabDetailUnavailableSchema,
]);
export type GitlabApprovalsResultV1 = ReturnType<typeof GitlabApprovalsResultV1Schema.parse>;

/* ----------------------------------------------------------------- pipelines */

export const GitlabPipelinesInputV1Schema = pagedPlaneInput;
export type GitlabPipelinesInputV1 = ReturnType<typeof GitlabPipelinesInputV1Schema.parse>;

export const GitlabProjectedPipelineRowV1Schema = defineProtocolObject({
  id: IdentifierSchema,
  status: LabelSchema,
  ref: LabelSchema.optional(),
  sha: IdentifierSchema.optional(),
  source: LabelSchema.optional(),
  webUrl: LocationSchema.optional(),
  createdAtMs: TimestampSchema.optional(),
  updatedAtMs: TimestampSchema.optional(),
  truncated: defineProtocolLiteral(true).optional(),
}, { policy: 'closed' });

export const GitlabPipelinesResultV1Schema = defineProtocolUnion([
  defineProtocolObject({
    kind: defineProtocolLiteral('pipelines'),
    rows: defineProtocolArray(GitlabProjectedPipelineRowV1Schema, {
      maxItems: GITLAB_MAX_DETAIL_PAGE_SIZE_V1,
    }),
    /**
     * The per-job rollup of the newest pipeline on this page.
     *
     * Every count is OMITTED, never zeroed, when the breakdown is unavailable. A
     * rendered `0 failing` over a job list nobody could read is a fabricated
     * fact, and it is the fabrication a reviewer acts on.
     */
    failingCount: CountSchema.optional(),
    runningCount: CountSchema.optional(),
    passingCount: CountSchema.optional(),
    /** The pipeline the rollup describes, absent when there is no rollup. */
    rollupPipelineId: IdentifierSchema.optional(),
    omittedRowCount: CountSchema,
    projectionTruncated: GitlabBooleanSchema,
    incomplete: IncompleteReasonSchema.optional(),
    continuation: ContinuationSchema.optional(),
  }, { policy: 'closed' }),
  GitlabDetailUnavailableSchema,
]);
export type GitlabPipelinesResultV1 = ReturnType<typeof GitlabPipelinesResultV1Schema.parse>;

/* ------------------------------------------------------------------- changes */

export const GitlabChangesInputV1Schema = pagedPlaneInput;
export type GitlabChangesInputV1 = ReturnType<typeof GitlabChangesInputV1Schema.parse>;

export const GitlabProjectedChangedFileRowV1Schema = defineProtocolObject({
  path: PathSchema,
  previousPath: PathSchema.optional(),
  newFile: GitlabBooleanSchema,
  renamedFile: GitlabBooleanSchema,
  deletedFile: GitlabBooleanSchema,
  /** Present ONLY when GitLab supplied the 18.4 field. Absent is not `false`. */
  collapsed: GitlabBooleanSchema.optional(),
  tooLarge: GitlabBooleanSchema.optional(),
  truncated: defineProtocolLiteral(true).optional(),
}, { policy: 'closed' });

/**
 * `reported` — every file on this page carried GitLab's per-file truncation
 * evidence. `unknown` — at least one did not, so no whole-diff claim is made and
 * the tab says so. A reviewer who approves a diff they believe is whole is the
 * failure this discriminant exists to prevent.
 */
const DiffLimitStatusSchema = defineProtocolUnion([
  defineProtocolLiteral('reported'),
  defineProtocolLiteral('unknown'),
]);

export const GitlabChangesResultV1Schema = defineProtocolUnion([
  defineProtocolObject({
    kind: defineProtocolLiteral('changes'),
    rows: defineProtocolArray(GitlabProjectedChangedFileRowV1Schema, {
      maxItems: GITLAB_MAX_DETAIL_PAGE_SIZE_V1,
    }),
    diffLimitStatus: DiffLimitStatusSchema,
    omittedRowCount: CountSchema,
    projectionTruncated: GitlabBooleanSchema,
    incomplete: IncompleteReasonSchema.optional(),
    continuation: ContinuationSchema.optional(),
  }, { policy: 'closed' }),
  GitlabDetailUnavailableSchema,
]);
export type GitlabChangesResultV1 = ReturnType<typeof GitlabChangesResultV1Schema.parse>;

/* --------------------------------------------------------------- raw diff */

/**
 * The raw-evidence read is deliberately separate from the `/diffs` walk. It is
 * user initiated, returns GitLab's text without interpreting it as structured
 * files, and never runs as part of first paint.
 */
export const GitlabRawDiffInputV1Schema = itemPlaneInput;
export type GitlabRawDiffInputV1 = ReturnType<typeof GitlabRawDiffInputV1Schema.parse>;

export const GitlabRawDiffResultV1Schema = defineProtocolUnion([
  defineProtocolObject({
    kind: defineProtocolLiteral('rawDiff'),
    text: defineProtocolUtf8String({
      maxUtf8Bytes: EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES,
    }),
    /** True exactly when the Action envelope retained only a prefix. */
    truncated: GitlabBooleanSchema,
  }, { policy: 'closed' }),
  GitlabDetailUnavailableSchema,
]);
export type GitlabRawDiffResultV1 = ReturnType<typeof GitlabRawDiffResultV1Schema.parse>;
