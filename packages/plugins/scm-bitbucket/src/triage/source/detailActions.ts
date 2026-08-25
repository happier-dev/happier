import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type {
  TriageConfiguredSourceInstanceV1,
  TriageSourceFailureV1,
} from '@happier-dev/triage-protocol/v1';
import { createBoundedInvocation } from '@happier-dev/triage-sources/runtime';

import {
  readBitbucketActivityPage,
  readBitbucketBuildsPage,
  readBitbucketCommentsPage,
  readBitbucketDiffstatPage,
  readBitbucketRawDiff,
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
  BITBUCKET_ACTION_RESULT_JSON_BYTE_LIMIT_V1,
  BitbucketDiffInputV1Schema,
  BitbucketOverviewInputV1Schema,
  type BitbucketDiffResultV1,
  type BitbucketOverviewResultV1,
  type BitbucketActivityResultV1,
  type BitbucketBuildsResultV1,
  type BitbucketCommentsResultV1,
} from './detailContracts.js';
import { observeBitbucketEntry } from './observeEntry.js';
import { toTriageSourceFailure } from './failures.js';

/**
 * The five bound source-native Bitbucket Cloud detail operations.
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
  readOverview: 'triage-read-overview',
  listActivity: 'triage-list-activity',
  readDiff: 'triage-read-diff',
  listBuilds: 'triage-list-builds',
  listComments: 'triage-list-comments',
});

/** One user-visible mounted detail operation, including account materialization and all reads. */
export const BITBUCKET_MOUNTED_DETAIL_DEADLINE_MS = 20_000;

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
    dispose(): void;
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
  const bounded = createBoundedInvocation({
    callerSignal: context.signal,
    timeoutMs: BITBUCKET_MOUNTED_DETAIL_DEADLINE_MS,
  });
  const runtime = toBitbucketRuntime(context, bounded.signal);
  const admitted = await admitBitbucketEntryInvocation(input, runtime);
  if (!admitted.ok) {
    const deadlineExpired = bounded.signal.aborted
      && (bounded.signal.reason as Readonly<{ name?: unknown }> | null)?.name === 'TimeoutError';
    bounded.dispose();
    return deadlineExpired
      ? {
        ok: false,
        failure: toTriageSourceFailure(createBitbucketFailure(
          'transient',
          'invocation-deadline-exceeded',
        )),
      }
      : admitted;
  }

  return {
    ok: true,
    dispose: bounded.dispose,
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

/* ------------------------------------------------------------------ overview */

export async function readBitbucketOverview(
  input: unknown,
  context: PluginInvocationContext,
): Promise<BitbucketOverviewResultV1> {
  const parsed = BitbucketOverviewInputV1Schema.safeParse(input);
  if (!parsed.success) return unavailable(toTriageSourceFailure(INVALID_INPUT));
  const request = parsed.data;
  const admitted = await admitBitbucketDetailInvocation({
    instance: request.instance,
    localRef: request.localRef,
  }, context);
  if (!admitted.ok) return unavailable(admitted.failure);
  try {
  const observation = await observeBitbucketEntry({
    client: admitted.dependencies.client,
    route: admitted.route,
    localRef: request.localRef,
    ...(admitted.dependencies.signal === undefined
      ? {}
      : { signal: admitted.dependencies.signal }),
  });
  if (observation.kind === 'unresolved') return unavailable(observation.failure);
  return Object.freeze({ kind: 'overview' as const, observedAtMs: Date.now(), observation });
  } finally {
    admitted.dispose();
  }
}

/* ---------------------------------------------------------------------- diff */

function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

/** JSON.stringify's exact UTF-8 contribution for one code point in a string value. */
function jsonStringCodePointBytes(codePoint: number, codeUnit: number): number {
  if (codeUnit === 0x22 || codeUnit === 0x5c) return 2;
  if (codeUnit <= 0x1f) {
    return codeUnit === 0x08
      || codeUnit === 0x09
      || codeUnit === 0x0a
      || codeUnit === 0x0c
      || codeUnit === 0x0d
      ? 2
      : 6;
  }
  if (codeUnit >= 0xd800 && codeUnit <= 0xdfff && codePoint === codeUnit) return 6;
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

/** Fits the actual serialized result against the Action gate, with no picked reserve. */
function fitRawDiff(
  text: string,
  base: Omit<Extract<BitbucketDiffResultV1, { kind: 'diff' }>, 'raw' | 'projectionTruncated'>
    & Readonly<{ projectionTruncated: boolean }>,
): Extract<BitbucketDiffResultV1, { kind: 'diff' }> {
  const complete = { ...base, raw: { kind: 'available' as const, text, truncated: false } };
  if (jsonBytes(complete) <= BITBUCKET_ACTION_RESULT_JSON_BYTE_LIMIT_V1) return complete;

  const empty = { ...base, projectionTruncated: true, raw: {
    kind: 'available' as const,
    text: '',
    truncated: true,
  } };
  const availableTextBytes = BITBUCKET_ACTION_RESULT_JSON_BYTE_LIMIT_V1 - jsonBytes(empty);
  let escapedBytes = 0;
  let end = 0;
  while (end < text.length) {
    const codePoint = text.codePointAt(end) ?? 0;
    const contribution = jsonStringCodePointBytes(codePoint, text.charCodeAt(end));
    if (escapedBytes + contribution > availableTextBytes) break;
    escapedBytes += contribution;
    end += codePoint > 0xffff ? 2 : 1;
  }
  // `false` is one byte longer than `true`. If changing the flags alone made the complete text
  // fit, remove one actual code point so `truncated: true` remains a truthful statement.
  if (end === text.length && end > 0) {
    const last = text.charCodeAt(end - 1);
    end -= last >= 0xdc00 && last <= 0xdfff ? 2 : 1;
  }
  return { ...base, projectionTruncated: true, raw: {
    kind: 'available' as const,
    text: text.slice(0, end),
    truncated: true,
  } };
}

export async function readBitbucketDiff(
  input: unknown,
  context: PluginInvocationContext,
): Promise<BitbucketDiffResultV1> {
  const parsed = BitbucketDiffInputV1Schema.safeParse(input);
  if (!parsed.success) return unavailable(toTriageSourceFailure(INVALID_INPUT));
  const request = parsed.data;
  const admitted = await admitBitbucketDetailInvocation({
    instance: request.instance,
    localRef: request.localRef,
  }, context);
  if (!admitted.ok) return unavailable(admitted.failure);
  try {
  const position = resolvePosition(request.continuation);
  if (!position.ok) return unavailable(toTriageSourceFailure(CONTINUATION_UNREADABLE));

  const diffstatPromise = readBitbucketDiffstatPage(
    { route: admitted.route, position: position.position },
    admitted.dependencies,
  );
  const rawPromise = request.continuation === undefined
    ? readBitbucketRawDiff(admitted.route, admitted.dependencies)
    : null;
  const diffstat = await diffstatPromise;
  if (!diffstat.ok) return unavailable(toTriageSourceFailure(diffstat.failure));

  const base = Object.freeze({
    kind: 'diff' as const,
    files: diffstat.value.rows,
    omittedRowCount: diffstat.value.omittedRowCount,
    projectionTruncated: diffstat.value.projectionTruncated,
    ...shapeWalkPosition(diffstat.value),
  });
  if (rawPromise === null) return base;
  const raw = await rawPromise;
  if (!raw.ok) return unavailable(toTriageSourceFailure(raw.failure));
  if (raw.value.kind === 'tooLarge') {
    return Object.freeze({ ...base, raw: Object.freeze({ kind: 'tooLarge' as const }) });
  }
  return Object.freeze(fitRawDiff(raw.value.text, base));
  } finally {
    admitted.dispose();
  }
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
  try {

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
  } finally {
    admitted.dispose();
  }
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
  try {

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
  } finally {
    admitted.dispose();
  }
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
  try {

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
  } finally {
    admitted.dispose();
  }
}
