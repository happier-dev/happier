/**
 * The exception Actions' wire contracts, free of the collector runtime so the detail surface
 * (a UI artifact) parses the same results the daemon Actions declare.
 */
import {
  defineProtocolArray,
  defineProtocolLiteral,
  defineProtocolNumber,
  defineProtocolObject,
  defineProtocolString,
  defineProtocolUnion,
} from '@happier-dev/plugin-sdk/protocol';

const text = defineProtocolString({ minLength: 1 });
const time = defineProtocolNumber({ integer: true, minimum: 0 });
const environment = { serverId: text, environmentId: text };
const maybe = (schema: ReturnType<typeof defineProtocolString>) =>
  defineProtocolUnion([schema, defineProtocolLiteral(null)]).optional();

export const exceptionOccurrencesReadInputSchema = defineProtocolObject(
  {
    ...environment,
    fingerprint: text,
    page: defineProtocolObject(
      {
        limit: defineProtocolNumber({ integer: true, minimum: 1 }),
        before: defineProtocolObject(
          { at: time, id: text },
          { policy: 'closed' },
        ).optional(),
      },
      { policy: 'closed' },
    ),
    /** Demand one occurrence's redacted stack; list items never carry stacks. */
    occurrenceId: text.optional(),
    /** Demand the group's per-bucket counts and Requests affected over an authored retained window. */
    window: defineProtocolObject(
      { since: time, until: time, bucketMs: defineProtocolNumber({ integer: true, minimum: 1 }) },
      { policy: 'closed' },
    ).optional(),
  },
  { policy: 'closed' },
);
const occurrenceSchema = defineProtocolObject(
  {
    id: text,
    at: time,
    origin: defineProtocolUnion([
      defineProtocolLiteral('span'),
      defineProtocolLiteral('log'),
    ]),
    serviceName: maybe(defineProtocolString()),
    serviceVersion: maybe(defineProtocolString()),
    type: maybe(defineProtocolString()),
    message: maybe(defineProtocolString()),
    topFrame: maybe(defineProtocolString()),
    traceId: maybe(defineProtocolString()),
    spanId: maybe(defineProtocolString()),
    escaped: defineProtocolUnion([
      defineProtocolLiteral(true),
      defineProtocolLiteral(false),
    ]).optional(),
  },
  { policy: 'closed' },
);
export const exceptionOccurrencesReadResultSchema = defineProtocolUnion([
  defineProtocolObject(
    { status: defineProtocolLiteral('disabled') },
    { policy: 'closed' },
  ),
  defineProtocolObject(
    {
      status: defineProtocolLiteral('ok'),
      items: defineProtocolArray(occurrenceSchema),
      nextCursor: defineProtocolObject(
        { at: time, id: text },
        { policy: 'closed' },
      ).optional(),
      /** Redacted app text; consumers frame it as data, never as instructions. */
      stacktrace: maybe(defineProtocolString()),
      /** Counts per bucket over retained occurrences; older history has expired, not fallen to zero. */
      trend: defineProtocolArray(defineProtocolObject({ since: time, until: time, count: time }, { policy: 'closed' })).optional(),
      /** Distinct traces the group reached in the window; occurrences without trace context are not counted. */
      requestsAffected: time.optional(),
    },
    { policy: 'closed' },
  ),
]);

const transitionAction = defineProtocolUnion([
  defineProtocolLiteral('resolve'),
  defineProtocolLiteral('reopen'),
  defineProtocolLiteral('ignore'),
  defineProtocolLiteral('unignore'),
]);
export const exceptionIssueTransitionInputSchema = defineProtocolObject(
  {
    ...environment,
    issueId: text,
    action: transitionAction,
    /** The fixed release, when the person names one on Resolve. */
    version: text.optional(),
  },
  { policy: 'closed' },
);
const issueSummarySchema = defineProtocolObject(
  {
    issueId: text,
    revision: time,
    status: defineProtocolUnion([
      defineProtocolLiteral('open'),
      defineProtocolLiteral('resolved'),
      defineProtocolLiteral('ignored'),
    ]),
    regressed: defineProtocolLiteral(true).optional(),
    count: time,
    lastSeenAtMs: time,
    asOfMs: time,
  },
  { policy: 'closed' },
);
export const exceptionIssueTransitionResultSchema = defineProtocolUnion([
  defineProtocolObject(
    { status: defineProtocolLiteral('absent') },
    { policy: 'closed' },
  ),
  defineProtocolObject(
    {
      status: defineProtocolUnion([
        defineProtocolLiteral('applied'),
        defineProtocolLiteral('unchanged'),
      ]),
      issue: issueSummarySchema,
    },
    { policy: 'closed' },
  ),
]);
export const exceptionIssuesRefreshInputSchema = defineProtocolObject(
  { ...environment, issueId: text.optional() },
  { policy: 'closed' },
);
export const exceptionIssuesRefreshResultSchema = defineProtocolObject(
  {
    projection: defineProtocolUnion([
      defineProtocolLiteral('ready'),
      defineProtocolLiteral('unavailable'),
    ]),
    code: text.optional(),
    issue: issueSummarySchema.optional(),
  },
  { policy: 'closed' },
);


const issueStatus = defineProtocolUnion([
  defineProtocolLiteral('open'),
  defineProtocolLiteral('resolved'),
  defineProtocolLiteral('ignored'),
]);

/**
 * The source-owned facts the exact `get` hands the detail surface (`detailData`): what its
 * occurrence and stack reads address and the lifecycle facts its overview states. A Team-shared
 * read omits the fingerprint, the owner's collector address.
 */
export const exceptionDetailDataSchema = defineProtocolObject(
  {
    v: defineProtocolLiteral(1),
    environmentId: text,
    fingerprint: text.optional(),
    status: issueStatus,
    regressed: defineProtocolLiteral(true).optional(),
    count: time,
    firstSeenAtMs: time,
    lastSeenAtMs: time,
    asOfMs: time,
    serviceName: defineProtocolString().optional(),
    type: defineProtocolString().optional(),
    topFrame: defineProtocolString().optional(),
    lastServiceVersion: defineProtocolString().optional(),
    resolution: defineProtocolObject(
      {
        atMs: time,
        version: defineProtocolString().optional(),
        priorVersions: defineProtocolArray(defineProtocolString()),
      },
      { policy: 'closed' },
    ).optional(),
  },
  { policy: 'additive-open/drop' },
);
export type ExceptionDetailDataV1 = ReturnType<typeof exceptionDetailDataSchema.parse>;
