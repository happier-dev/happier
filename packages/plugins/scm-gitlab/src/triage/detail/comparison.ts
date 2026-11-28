import { isExternalActionResultWithinResponseEnvelopeLimitV1 } from '@happier-dev/plugin-sdk/actions';
import { fitActionResultPageV1 } from '@happier-dev/triage-sources/projection/actionResultSequence';
import type { GitlabAdmittedInvocation } from '../admission.js';
import { projectGitlabSourceFailure } from '../sourceFailure.js';
import type { GitlabComparisonEndpoints } from '../mapping/mergeRequestHead.js';
import { buildGitlabComparisonRepositoryKey } from '../identity.js';
import type { GitlabChangesInputV1, GitlabChangesResultV1, GitlabComparisonFileV1 } from './contracts.js';
import { decodeGitlabDetailContinuation, encodeGitlabDetailContinuation, type GitlabDetailContinuationProvenanceV1 } from './continuation.js';
import { readGitlabChangesPage, readGitlabComparisonMetadata, type GitlabDetailPagePositionV1 } from './reads.js';

type ComparisonPage = Extract<GitlabChangesResultV1, { kind: 'changedFiles' }>;

function sameEndpoints(left: GitlabComparisonEndpoints, right: GitlabComparisonEndpoints): boolean {
  return left.beforeOid === right.beforeOid && left.baseOid === right.baseOid && left.headOid === right.headOid
    && left.totalFileCount === right.totalFileCount;
}

/** Source-owned evidence for the incumbent host comparison reader, never display flags. */
export async function readGitlabComparisonPage(
  request: GitlabChangesInputV1,
  admitted: Extract<GitlabAdmittedInvocation, { ok: true }>,
  provenance: GitlabDetailContinuationProvenanceV1,
  position: GitlabDetailPagePositionV1,
): Promise<GitlabChangesResultV1> {
  const frontier = request.continuation === undefined ? null : decodeGitlabDetailContinuation({
    token: request.continuation, origin: admitted.route.origin, limit: request.limit, provenance,
  });
  const previous = frontier?.comparison;
  if (request.continuation !== undefined && previous === undefined) return { kind: 'unavailable',
    failure: { class: 'unsupportedContract', code: 'gitlab-detail-continuation-unreadable' } };

  const captured = await readGitlabComparisonMetadata(admitted.route, request.localRef.collisionScope, admitted.dependencies);
  if (!captured.ok) return { kind: 'unavailable', failure: projectGitlabSourceFailure(captured.failure) };
  const endpoints = previous ?? captured.value;
  const number = Number(admitted.route.iid);
  if (!Number.isSafeInteger(number)) return { kind: 'unavailable',
    failure: { class: 'unsupportedContract', code: 'gitlab-detail-input-invalid' } };
  const locator = { providerId: 'gitlab' as const,
    repository: buildGitlabComparisonRepositoryKey(admitted.route.origin, admitted.route.repositoryKey), number };
  const base: ComparisonPage = { kind: 'changedFiles', rows: [], omittedRowCount: 0, projectionTruncated: false,
    comparison: { locator, ...(captured.value.url ? { url: captured.value.url } : {}),
      ...(captured.value.title ? { title: captured.value.title } : {}),
      beforeOid: endpoints.beforeOid, baseOid: endpoints.baseOid, headOid: endpoints.headOid,
      totalFileCount: endpoints.totalFileCount, enumeratedFileCount: previous?.enumeratedFileCount ?? 0,
      freshness: 'current', inventory: 'incomplete', content: previous?.contentIncomplete ? 'incomplete' : 'complete', reasons: [] } };
  if (!sameEndpoints(endpoints, captured.value)) return { ...base,
    comparison: { ...base.comparison, freshness: 'stale', reasons: ['source_changed'] } };

  const page = await readGitlabChangesPage({ route: admitted.route, perPage: request.limit, position, comparison: true }, admitted.dependencies);
  if (!page.ok) return { ...base, comparison: { ...base.comparison, freshness: 'unverified', content: 'incomplete',
    reasons: ['page_failed'], failure: projectGitlabSourceFailure(page.failure) } };
  const refreshed = await readGitlabComparisonMetadata(admitted.route, request.localRef.collisionScope, admitted.dependencies);
  const freshness = !refreshed.ok ? 'unverified' : sameEndpoints(endpoints, refreshed.value) ? 'current' : 'stale';
  const enumeratedFileCount = (previous?.enumeratedFileCount ?? 0) + page.value.rows.length + page.value.omittedRowCount;
  const inventoryIncomplete = previous?.inventoryIncomplete === true || page.value.omittedRowCount > 0 || page.value.projectionTruncated;
  const contentIncomplete = previous?.contentIncomplete === true || page.value.rows.some(row => row.evidence.state !== 'available');
  const reasons = [
    ...(page.value.nextUrl === null ? [] : ['pages_pending']),
    ...(page.value.incomplete === null ? [] : ['pagination']),
    ...(inventoryIncomplete ? ['omitted_rows'] : []),
    ...(endpoints.totalFileCount === null ? ['file_count_unavailable']
      : page.value.nextUrl === null && endpoints.totalFileCount !== enumeratedFileCount ? ['file_count_mismatch'] : []),
    ...(freshness === 'current' ? [] : [freshness === 'stale' ? 'source_changed' : 'freshness_unverified']),
  ];
  const comparison: ComparisonPage['comparison'] = { ...base.comparison, enumeratedFileCount, freshness,
    inventory: reasons.length ? 'incomplete' : 'complete', content: contentIncomplete ? 'incomplete' : 'complete', reasons,
    ...(!refreshed.ok ? { failure: projectGitlabSourceFailure(refreshed.failure) } : {}) };

  const continuation = freshness === 'current' && page.value.nextUrl !== null
    ? { nextUrl: page.value.nextUrl, limit: request.limit, provenance,
      comparison: { beforeOid: endpoints.beforeOid, baseOid: endpoints.baseOid, headOid: endpoints.headOid,
        totalFileCount: endpoints.totalFileCount, enumeratedFileCount, inventoryIncomplete, contentIncomplete } } : undefined;
  const shape = (rows: readonly GitlabComparisonFileV1[], omitted: number,
    next: typeof continuation, continuationOmitted: boolean, textOmitted: boolean): ComparisonPage => ({
    kind: 'changedFiles', rows: [...rows], omittedRowCount: page.value.omittedRowCount + omitted,
    projectionTruncated: page.value.projectionTruncated || omitted > 0,
    comparison: { ...comparison,
      inventory: omitted || continuationOmitted ? 'incomplete' : comparison.inventory,
      content: textOmitted ? 'incomplete' : comparison.content,
      reasons: [...comparison.reasons, ...(textOmitted || omitted ? ['transport_limit'] : []), ...(continuationOmitted ? ['pagination'] : [])] },
    ...(page.value.incomplete !== null || continuationOmitted ? { incomplete: 'pagination' as const } : {}),
    ...(next === undefined ? {} : { continuation: encodeGitlabDetailContinuation({ ...next, comparison: {
      ...next.comparison, contentIncomplete: contentIncomplete || textOmitted,
      inventoryIncomplete: inventoryIncomplete || omitted > 0,
    } }) ?? undefined }),
  });
  const complete = shape(page.value.rows, 0, continuation, false, false);
  if (isExternalActionResultWithinResponseEnvelopeLimitV1(complete)) return complete;
  // Preserve file identities before patch text at the real Action byte boundary.
  const rows = page.value.rows.map(row => ({ ...row,
    evidence: { state: 'unavailable' as const, reason: 'transport_limit' } }));
  return fitActionResultPageV1(rows, continuation, (included, omitted, next, continuationOmitted) =>
    shape(included, omitted, next, continuationOmitted, true)).result;
}
