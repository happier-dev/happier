import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type {
  TriageConfiguredSourceInstanceV1,
  TriageSourceFailureV1,
} from '@happier-dev/triage-protocol/v1';

import {
  readBitbucketActivityPage,
  readBitbucketBuildsPage,
  readBitbucketCommentsPage,
  type BitbucketDetailPagePositionV1,
  type BitbucketDetailReadDependenciesV1,
  type BitbucketWalkPositionV1,
} from '../detail/reads.js';
import { createBitbucketFailure } from '../failures.js';
import {
  admitBitbucketEntryInvocation,
  toBitbucketRuntime,
  type BitbucketEntryRouteV1,
} from './invocationAdmission.js';
import {
  decodeBitbucketDetailContinuation,
  encodeBitbucketDetailContinuation,
} from './detailContinuation.js';
import {
  BitbucketActivityInputV1Schema,
  BitbucketBuildsInputV1Schema,
  BitbucketCommentsInputV1Schema,
  type BitbucketActivityResultV1,
  type BitbucketBuildsResultV1,
  type BitbucketCommentsResultV1,
} from './detailContracts.js';
import { toTriageSourceFailure } from './failures.js';

/**
 * The three bound source-native Bitbucket Cloud detail operations.
 *
 * Each is the whole vertical for one Action invocation: it validates the
 * published input, admits the configured workspace through the SAME rule `scan`
 * and `get` use, resolves the repository from the collision scope this source
 * minted, materializes that exact account inside one request closure, and shapes
 * the result into the published contract. It owns no registry, no cache, and no
 * second route authority, and it writes no configured state.
 *
 * The detail body invokes these; it never holds a credential, constructs a URL,
 * or sees a raw provider body. What crosses back is only what the boundary
 * projector copied.
 */

/** The Action ids the mounted detail body invokes, and nothing else does. */
export const BITBUCKET_TRIAGE_DETAIL_ACTION_IDS = Object.freeze({
  listActivity: 'triage-list-activity',
  listBuilds: 'triage-list-builds',
  listComments: 'triage-list-comments',
});

const INVALID_INPUT = createBitbucketFailure('unsupportedContract', 'detail-input-invalid');
const CONTINUATION_UNREADABLE = createBitbucketFailure(
  'unsupportedContract',
  'detail-continuation-unreadable',
);

function unavailable(failure: TriageSourceFailureV1): Readonly<{
  kind: 'unavailable';
  failure: TriageSourceFailureV1;
}> {
  return Object.freeze({ kind: 'unavailable' as const, failure });
}

type AdmittedInvocation =
  | Readonly<{
    ok: true;
    route: BitbucketEntryRouteV1;
    dependencies: BitbucketDetailReadDependenciesV1;
  }>
  | Readonly<{ ok: false; failure: TriageSourceFailureV1 }>;

/**
 * Admits one detail invocation through the shared entry-admission owner.
 *
 * The rule is `invocationAdmission.ts`'s, not this file's: a mounted panel and a pull-request
 * write must agree byte-for-byte about which references route through which configured workspace.
 * What remains here is only the shape a paged detail reader consumes.
 */
async function admitBitbucketDetailInvocation(
  input: Readonly<{
    instance: TriageConfiguredSourceInstanceV1;
    localRef: Readonly<{ kindId: string; entryId: string; collisionScope: string }>;
  }>,
  context: PluginInvocationContext,
): Promise<AdmittedInvocation> {
  const runtime = toBitbucketRuntime(context, context.signal);
  const admitted = await admitBitbucketEntryInvocation(input, runtime);
  if (!admitted.ok) return admitted;

  return {
    ok: true,
    route: admitted.route,
    dependencies: Object.freeze({
      client: admitted.client,
      ...(runtime.signal === undefined ? {} : { signal: runtime.signal }),
    }),
  };
}

/**
 * Resolves where one paged read starts.
 *
 * A continuation this source did not mint, or one naming a URL outside the Cloud
 * API base, is refused rather than reinterpreted: resuming at a position nobody
 * can vouch for would silently skip or repeat part of the collection.
 */
function resolvePosition(
  continuation: string | undefined,
): Readonly<{ ok: true; position: BitbucketDetailPagePositionV1 }> | Readonly<{ ok: false }> {
  if (continuation === undefined) {
    return { ok: true, position: Object.freeze({ kind: 'first' as const }) };
  }
  const frontier = decodeBitbucketDetailContinuation(continuation);
  if (frontier === null) return { ok: false };
  return {
    ok: true,
    position: Object.freeze({ kind: 'continued' as const, nextUrl: frontier.nextUrl }),
  };
}

/** Shapes one settled walk position into the one member every paged plane shares. */
function shapeWalkPosition(page: BitbucketWalkPositionV1): Readonly<{ continuation?: string }> {
  const continuation = page.nextUrl === null
    ? null
    : encodeBitbucketDetailContinuation(page.nextUrl);
  return continuation === null ? Object.freeze({}) : Object.freeze({ continuation });
}

/* ------------------------------------------------------------------ activity */

/**
 * One bounded page of the pull request's combined activity stream.
 *
 * Bitbucket serves approvals, updates and comments from ONE endpoint, so this is
 * one read rather than three. Reading only comments would lose every approval
 * and every branch update, and Bitbucket exposes no separate collection for
 * either.
 */
export async function listBitbucketActivity(
  input: unknown,
  context: PluginInvocationContext,
): Promise<BitbucketActivityResultV1> {
  const parsed = BitbucketActivityInputV1Schema.safeParse(input);
  if (!parsed.success) return unavailable(toTriageSourceFailure(INVALID_INPUT));
  const request = parsed.data;

  const admitted = await admitBitbucketDetailInvocation({
    instance: request.instance,
    localRef: request.localRef,
  }, context);
  if (!admitted.ok) return unavailable(admitted.failure);

  const position = resolvePosition(request.continuation);
  if (!position.ok) return unavailable(toTriageSourceFailure(CONTINUATION_UNREADABLE));

  const page = await readBitbucketActivityPage(
    { route: admitted.route, position: position.position },
    admitted.dependencies,
  );
  if (!page.ok) return unavailable(toTriageSourceFailure(page.failure));

  return Object.freeze({
    kind: 'activity' as const,
    rows: page.value.rows,
    omittedRowCount: page.value.omittedRowCount,
    projectionTruncated: page.value.projectionTruncated,
    ...shapeWalkPosition(page.value),
  });
}

/* -------------------------------------------------------------------- builds */

/**
 * One bounded page of the pull request's own status collection, plus the rollup
 * — and only when this page IS the whole collection.
 *
 * The three counts are present together or absent together. A partial rollup
 * would be a number the reader cannot interpret, and a zeroed one is a number
 * they would trust.
 */
export async function listBitbucketBuilds(
  input: unknown,
  context: PluginInvocationContext,
): Promise<BitbucketBuildsResultV1> {
  const parsed = BitbucketBuildsInputV1Schema.safeParse(input);
  if (!parsed.success) return unavailable(toTriageSourceFailure(INVALID_INPUT));
  const request = parsed.data;

  const admitted = await admitBitbucketDetailInvocation({
    instance: request.instance,
    localRef: request.localRef,
  }, context);
  if (!admitted.ok) return unavailable(admitted.failure);

  const position = resolvePosition(request.continuation);
  if (!position.ok) return unavailable(toTriageSourceFailure(CONTINUATION_UNREADABLE));

  const page = await readBitbucketBuildsPage(
    { route: admitted.route, position: position.position },
    admitted.dependencies,
  );
  if (!page.ok) return unavailable(toTriageSourceFailure(page.failure));

  const { rollup } = page.value;
  return Object.freeze({
    kind: 'builds' as const,
    rows: page.value.rows,
    ...(rollup === null
      ? {}
      : {
        failingCount: rollup.failingCount,
        runningCount: rollup.runningCount,
        passingCount: rollup.passingCount,
      }),
    omittedRowCount: page.value.omittedRowCount,
    projectionTruncated: page.value.projectionTruncated,
    ...shapeWalkPosition(page.value),
  });
}

/* ------------------------------------------------------------------ comments */

/** One bounded page of the pull request's comment records, in provider order. */
export async function listBitbucketComments(
  input: unknown,
  context: PluginInvocationContext,
): Promise<BitbucketCommentsResultV1> {
  const parsed = BitbucketCommentsInputV1Schema.safeParse(input);
  if (!parsed.success) return unavailable(toTriageSourceFailure(INVALID_INPUT));
  const request = parsed.data;

  const admitted = await admitBitbucketDetailInvocation({
    instance: request.instance,
    localRef: request.localRef,
  }, context);
  if (!admitted.ok) return unavailable(admitted.failure);

  const position = resolvePosition(request.continuation);
  if (!position.ok) return unavailable(toTriageSourceFailure(CONTINUATION_UNREADABLE));

  const page = await readBitbucketCommentsPage(
    { route: admitted.route, position: position.position },
    admitted.dependencies,
  );
  if (!page.ok) return unavailable(toTriageSourceFailure(page.failure));

  return Object.freeze({
    kind: 'comments' as const,
    rows: page.value.rows,
    omittedRowCount: page.value.omittedRowCount,
    projectionTruncated: page.value.projectionTruncated,
    ...shapeWalkPosition(page.value),
  });
}
