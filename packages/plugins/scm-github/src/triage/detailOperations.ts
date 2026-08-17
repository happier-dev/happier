import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { TriageSourceFailureV1 } from '@happier-dev/triage-protocol/v1';

import type { GithubApiClientV1 } from '../observations/githubApiClient.js';

import { readGithubTriageKindId } from './contribution.js';
import {
  GithubChangedFilesInputV1Schema,
  GithubChecksInputV1Schema,
  GithubCommentsInputV1Schema,
  GithubTimelineInputV1Schema,
  type GithubChangedFilesResultV1,
  type GithubChecksResultV1,
  type GithubCommentsResultV1,
  type GithubTimelineResultV1,
} from './detail/contracts.js';
import {
  decodeGithubDetailContinuation,
  encodeGithubDetailContinuation,
} from './detail/continuation.js';
import {
  GITHUB_DETAIL_BOUNDS_V1,
  projectGithubCheckRows,
} from './detail/projection.js';
import {
  readGithubChangedFilesPage,
  readGithubChecksSurface,
  readGithubIssueCommentsPage,
  readGithubTimelinePage,
  type GithubDetailPageV1,
} from './detail/reads.js';
import { parseGithubRoutingToken, type GithubRepositoryRouteV1 } from './locator.js';
import { toTriageFailure } from './mapping/protocol.js';
import {
  openGithubTriageClient,
  resolveGithubTriageInstance,
} from './operations.js';
import type { GithubTriageKindIdV1 } from './types.js';

/**
 * The four bound source-native detail operations.
 *
 * Each is the whole vertical for one Action invocation: it validates the
 * published input, admits the configured instance through the SAME rule `scan`
 * and `get` use, resolves the route from current source evidence, materializes
 * that exact account inside one request closure, and shapes the result into the
 * published contract. It owns no registry, no cache, no second route authority,
 * and it writes no configured state.
 *
 * The detail body invokes these; it never holds a credential, constructs a URL,
 * or sees a raw provider body. What crosses back is only what the boundary
 * projector copied.
 *
 * Every failure is a STATED outcome rather than an empty result. A timeline
 * refused for permission, a changed-file walk stopped at GitHub's documented
 * ceiling, and a pull request with no changed files at all are three different
 * answers, and each panel is given the one that is true.
 */

const INVALID_INPUT_FAILURE: TriageSourceFailureV1 = Object.freeze({
  class: 'unsupportedContract',
  code: 'github_detail_input_invalid',
});

const CONTINUATION_UNREADABLE_FAILURE: TriageSourceFailureV1 = Object.freeze({
  class: 'unsupportedContract',
  code: 'github_detail_continuation_unreadable',
});

const LOCATOR_UNUSABLE_FAILURE: TriageSourceFailureV1 = Object.freeze({
  class: 'unknown',
  code: 'github_locator_unusable',
});

const KIND_UNSUPPORTED_FAILURE: TriageSourceFailureV1 = Object.freeze({
  class: 'unsupportedContract',
  code: 'github_detail_kind_unsupported',
});

type AdmittedInvocation =
  | Readonly<{
    ok: true;
    route: GithubRepositoryRouteV1;
    entryNumber: string;
    kindId: GithubTriageKindIdV1;
    client: GithubApiClientV1;
  }>
  | Readonly<{ ok: false; failure: TriageSourceFailureV1 }>;

/**
 * Admits one detail invocation against the exact configured instance and the
 * route the target observed for THIS entry.
 *
 * The route comes only from current source evidence, exactly as `get`'s does:
 * `routingToken` is the newest locator the target holds, it is source-private,
 * and it grants no authority — the account is rematerialized from the configured
 * instance on every invocation. A token this source cannot parse yields a stated
 * failure and no outbound call; a path is never guessed from identity, display
 * text or a git remote.
 */
async function admitGithubDetailInvocation(
  input: Readonly<{
    instance: Parameters<typeof resolveGithubTriageInstance>[0];
    localRef: Readonly<{ kindId: string; entryId: string }>;
    routingToken: string;
    /** The kinds this plane can answer for at all. */
    admissibleKinds: readonly GithubTriageKindIdV1[];
  }>,
  context: PluginInvocationContext,
): Promise<AdmittedInvocation> {
  const kindId = readGithubTriageKindId(input.localRef.kindId);
  if (kindId === null || !input.admissibleKinds.includes(kindId)) {
    return Object.freeze({ ok: false as const, failure: KIND_UNSUPPORTED_FAILURE });
  }

  const resolved = resolveGithubTriageInstance(input.instance);
  if (!resolved.ok) return Object.freeze({ ok: false as const, failure: resolved.failure });

  const route = parseGithubRoutingToken(input.routingToken);
  if (route === null) {
    return Object.freeze({ ok: false as const, failure: LOCATOR_UNUSABLE_FAILURE });
  }

  const opened = await openGithubTriageClient(input.instance, context);
  if (!opened.ok) return Object.freeze({ ok: false as const, failure: opened.failure });

  return Object.freeze({
    ok: true as const,
    route,
    entryNumber: input.localRef.entryId,
    kindId,
    client: opened.client,
  });
}

/**
 * Resolves the page one paged detail read starts from.
 *
 * A continuation this source did not mint, or one minted under a different page
 * geometry, is refused rather than reinterpreted: resuming at a page number that
 * names different rows would silently skip or repeat part of the collection.
 */
function resolvePage(
  continuation: string | undefined,
  limit: number,
): Readonly<{ ok: true; page: number }> | Readonly<{ ok: false }> {
  if (continuation === undefined) return Object.freeze({ ok: true as const, page: 1 });
  const frontier = decodeGithubDetailContinuation(continuation);
  if (frontier === null || frontier.perPage !== limit) {
    return Object.freeze({ ok: false as const });
  }
  return Object.freeze({ ok: true as const, page: frontier.page });
}

function mintContinuation(nextPage: number | null, perPage: number): string | null {
  return nextPage === null
    ? null
    : encodeGithubDetailContinuation({ v: 1, page: nextPage, perPage });
}

type PagedShape<TRow> = Readonly<{
  rows: readonly TRow[];
  omittedRowCount: number;
  projectionTruncated: boolean;
  incomplete?: 'ceiling' | 'pagination';
  continuation?: string;
}>;

/** Shapes one settled page into the members every paged plane result shares. */
function shapePage<TRow>(
  page: GithubDetailPageV1<TRow>,
  perPage: number,
): PagedShape<TRow> {
  const continuation = mintContinuation(page.nextPage, perPage);
  // A next page this source cannot mint a token for ends the walk, and saying so
  // is the point: a silently dropped position reads as a finished collection.
  const incomplete = page.incomplete
    ?? (page.nextPage !== null && continuation === null ? 'pagination' : null);
  return Object.freeze({
    rows: page.rows,
    omittedRowCount: page.omittedRowCount,
    projectionTruncated: page.projectionTruncated,
    ...(incomplete === null ? {} : { incomplete }),
    ...(continuation === null ? {} : { continuation }),
  });
}

function unavailable(failure: TriageSourceFailureV1): Readonly<{
  kind: 'unavailable';
  failure: TriageSourceFailureV1;
}> {
  return Object.freeze({ kind: 'unavailable' as const, failure });
}

/* ------------------------------------------------------------------- timeline */

/** One bounded page of the event timeline of a pull request or an issue. */
export async function listGithubTimeline(
  input: unknown,
  context: PluginInvocationContext,
): Promise<GithubTimelineResultV1> {
  const parsed = GithubTimelineInputV1Schema.safeParse(input);
  if (!parsed.success) return unavailable(INVALID_INPUT_FAILURE);
  const request = parsed.data;

  const admitted = await admitGithubDetailInvocation({
    instance: request.instance,
    localRef: request.localRef,
    routingToken: request.routingToken,
    admissibleKinds: ['pull-request', 'issue'],
  }, context);
  if (!admitted.ok) return unavailable(admitted.failure);

  const position = resolvePage(request.continuation, request.limit);
  if (!position.ok) return unavailable(CONTINUATION_UNREADABLE_FAILURE);

  const page = await readGithubTimelinePage({
    route: admitted.route,
    entryNumber: admitted.entryNumber,
    perPage: request.limit,
    page: position.page,
  }, { client: admitted.client, now: Date.now });
  if (!page.ok) return unavailable(toTriageFailure(page.failure));

  return Object.freeze({
    kind: 'timeline' as const,
    ...shapePage(page.value, request.limit),
  });
}

/* -------------------------------------------------------------- changed files */

/** One bounded page of the changed files of a pull request. */
export async function listGithubChangedFiles(
  input: unknown,
  context: PluginInvocationContext,
): Promise<GithubChangedFilesResultV1> {
  const parsed = GithubChangedFilesInputV1Schema.safeParse(input);
  if (!parsed.success) return unavailable(INVALID_INPUT_FAILURE);
  const request = parsed.data;

  const admitted = await admitGithubDetailInvocation({
    instance: request.instance,
    localRef: request.localRef,
    routingToken: request.routingToken,
    // An issue has no changed files, and answering with an empty page would be a
    // different claim from "this plane does not apply to this kind".
    admissibleKinds: ['pull-request'],
  }, context);
  if (!admitted.ok) return unavailable(admitted.failure);

  const position = resolvePage(request.continuation, request.limit);
  if (!position.ok) return unavailable(CONTINUATION_UNREADABLE_FAILURE);

  const page = await readGithubChangedFilesPage({
    route: admitted.route,
    entryNumber: admitted.entryNumber,
    perPage: request.limit,
    page: position.page,
  }, { client: admitted.client, now: Date.now });
  if (!page.ok) return unavailable(toTriageFailure(page.failure));

  return Object.freeze({
    kind: 'changedFiles' as const,
    ...shapePage(page.value, request.limit),
  });
}

/* ------------------------------------------------------------------- comments */

/** One bounded page of the issue-level comment stream of a pull request or issue. */
export async function listGithubComments(
  input: unknown,
  context: PluginInvocationContext,
): Promise<GithubCommentsResultV1> {
  const parsed = GithubCommentsInputV1Schema.safeParse(input);
  if (!parsed.success) return unavailable(INVALID_INPUT_FAILURE);
  const request = parsed.data;

  const admitted = await admitGithubDetailInvocation({
    instance: request.instance,
    localRef: request.localRef,
    routingToken: request.routingToken,
    admissibleKinds: ['pull-request', 'issue'],
  }, context);
  if (!admitted.ok) return unavailable(admitted.failure);

  const position = resolvePage(request.continuation, request.limit);
  if (!position.ok) return unavailable(CONTINUATION_UNREADABLE_FAILURE);

  const page = await readGithubIssueCommentsPage({
    route: admitted.route,
    entryNumber: admitted.entryNumber,
    perPage: request.limit,
    page: position.page,
  }, { client: admitted.client, now: Date.now });
  if (!page.ok) return unavailable(toTriageFailure(page.failure));

  return Object.freeze({
    kind: 'comments' as const,
    ...shapePage(page.value, request.limit),
  });
}

/* --------------------------------------------------------------------- checks */

/**
 * The whole check surface of one pull request, at its current head revision.
 *
 * The two provider collections are read together because their rollup is one
 * answer: one of them failing renders the other's rows beside a failure that
 * names which read could not be made, and neither is ever presented as "no
 * checks configured".
 */
export async function readGithubChecks(
  input: unknown,
  context: PluginInvocationContext,
): Promise<GithubChecksResultV1> {
  const parsed = GithubChecksInputV1Schema.safeParse(input);
  if (!parsed.success) return unavailable(INVALID_INPUT_FAILURE);
  const request = parsed.data;

  const admitted = await admitGithubDetailInvocation({
    instance: request.instance,
    localRef: request.localRef,
    routingToken: request.routingToken,
    admissibleKinds: ['pull-request'],
  }, context);
  if (!admitted.ok) return unavailable(admitted.failure);

  const read = await readGithubChecksSurface({
    route: admitted.route,
    entryNumber: admitted.entryNumber,
  }, { client: admitted.client, now: Date.now, signal: context.signal });
  if (!read.ok) return unavailable(toTriageFailure(read.failure));

  const { headRevision, surface } = read.value;
  const projected = projectGithubCheckRows(surface.observations, GITHUB_DETAIL_BOUNDS_V1);
  return Object.freeze({
    kind: 'checks' as const,
    headRevision,
    state: surface.state,
    rows: projected.rows,
    // A count is omitted rather than zeroed wherever a per-job breakdown is
    // unavailable: a rendered `0 failing` on a suite nobody could read is a
    // fabricated fact, not a conservative one.
    ...(surface.failingCount === null ? {} : { failingCount: surface.failingCount }),
    ...(surface.runningCount === null ? {} : { runningCount: surface.runningCount }),
    ...(surface.passingCount === null ? {} : { passingCount: surface.passingCount }),
    ...(surface.checkRunsFailure === null
      ? {}
      : { checkRunsFailure: toTriageFailure(surface.checkRunsFailure) }),
    ...(surface.commitStatusFailure === null
      ? {}
      : { commitStatusFailure: toTriageFailure(surface.commitStatusFailure) }),
    omittedRowCount: projected.omittedRowCount,
    projectionTruncated: projected.projectionTruncated,
  });
}
