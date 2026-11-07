import type { SentrySourceContext } from '../api/sentryApiClient.js';
import {
  MAX_TRIAGE_TEXT_UTF8_BYTES_V1,
  TriageListScopeUnitsConnectedAccountInputV1Schema,
  decodeTriagePagingTokenV1,
  encodeTriagePagingTokenV1,
  projectTriageDisplayTextV1,
  type TriageListScopeUnitsResultV1,
  type TriageSourceFailureV1,
  type TriageSourceScopeUnitV1,
} from '@happier-dev/triage-protocol/v1';

import { createSentryApiClient } from '../api/sentryApiClient.js';
import { classifySentryFailure } from '../api/sentryFailure.js';
import { readSentryNextPageRelation } from '../api/sentryLinkHeader.js';
import { isSentryNumericId } from '../instances/sentryCollisionScope.js';
import { decodeSentryInstanceConfiguration } from '../instances/sentryInstanceConfiguration.js';
import { SENTRY_CONTINUATION_UNAVAILABLE_REASON } from '../scan/sentryContinuation.js';
import { SENTRY_FAILURE_CODES, SENTRY_PROJECTS_PAGE_SIZE } from '../sentryContracts.js';
import { toTriageFailure } from './observation.js';
import { resolveInstanceDeployment, sourceFailure } from './operations.js';

/** Source-owned directory; configured mode interprets only retained private configuration. */
export async function listSentryScopeUnits(
  input: unknown,
  context: SentrySourceContext,
): Promise<TriageListScopeUnitsResultV1> {
  const parsed = TriageListScopeUnitsConnectedAccountInputV1Schema.parse(input);
  const configured = decodeSentryInstanceConfiguration(parsed.draft.configuration.token);
  const routed = resolveInstanceDeployment(parsed.draft.localInstanceKey);
  if (!configured.ok || !routed.ok || configured.configuration.organizationId !== routed.instance.organizationId) {
    return { kind: 'failed', failure: sourceFailure(SENTRY_FAILURE_CODES.invokedOrganizationMismatch) };
  }
  const configuration = configured.configuration;
  const selection = configuration.projectScope;
  if (parsed.mode === 'configured') {
    const retained = new Map(configuration.projectUnits?.map((unit) => [unit.id, unit]));
    return {
      kind: 'page', status: 'complete', selection,
      units: selection.kind === 'all' ? [] : selection.unitIds.map((id) => retained.get(id) ?? { id, label: id }),
    };
  }

  let cursor: string | undefined;
  if (parsed.cursor !== undefined) {
    const decoded = decodeTriagePagingTokenV1(parsed.cursor.token);
    if (decoded === null || typeof decoded.cursor !== 'string' || decoded.cursor === '') {
      return { kind: 'failed', failure: sourceFailure(SENTRY_FAILURE_CODES.paginationCursorMalformed) };
    }
    cursor = decoded.cursor;
  }
  // https://docs.sentry.io/api/organizations/list-an-organizations-projects/
  const url = new URL(`/api/0/organizations/${routed.instance.organizationId}/projects/`, routed.deployment.origin);
  url.searchParams.set('per_page', String(SENTRY_PROJECTS_PAGE_SIZE));
  if (parsed.query !== undefined && parsed.query !== '') url.searchParams.set('query', parsed.query);
  if (cursor !== undefined) url.searchParams.set('cursor', cursor);
  const client = await createSentryApiClient(context, {
    account: parsed.draft.binding.account, deployment: routed.deployment, nowMs: Date.now,
  });
  const outcome = await client.request({ url: url.toString(), operation: 'projects' });
  if (outcome.kind === 'failed') return { kind: 'failed', failure: toTriageFailure(outcome.failure) };
  const { response } = outcome;
  if (response.status !== 200) {
    return { kind: 'failed', failure: toTriageFailure(classifySentryFailure({
      kind: 'status', operation: 'projects', response, nowMs: Date.now(),
    })) };
  }
  let body: unknown;
  try { body = JSON.parse(response.bodyText); } catch {
    return { kind: 'failed', failure: sourceFailure(SENTRY_FAILURE_CODES.responseUnparseable) };
  }
  if (!Array.isArray(body)) return { kind: 'failed', failure: sourceFailure(SENTRY_FAILURE_CODES.responseUnparseable) };
  const byId = new Map<string, TriageSourceScopeUnitV1>();
  let failure: TriageSourceFailureV1 | undefined;
  const rows: readonly unknown[] = body;
  for (const value of rows) {
    const row = typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as Readonly<Record<string, unknown>> : null;
    if (row === null || typeof row.id !== 'string' || !isSentryNumericId(row.id)) {
      failure = sourceFailure(SENTRY_FAILURE_CODES.malformedProjectRow);
      continue;
    }
    if (row.hasAccess === false) continue;
    const name = typeof row.name === 'string' && row.name.trim() !== '' ? row.name : null;
    const slug = typeof row.slug === 'string' && row.slug.trim() !== '' ? row.slug : null;
    byId.set(row.id, {
      id: row.id,
      label: projectTriageDisplayTextV1(name ?? slug ?? row.id, MAX_TRIAGE_TEXT_UTF8_BYTES_V1).value,
      ...(slug === null ? {} : { secondaryText: projectTriageDisplayTextV1(slug, MAX_TRIAGE_TEXT_UTF8_BYTES_V1).value }),
    });
  }
  const units = [...byId.values()];
  const relation = readSentryNextPageRelation(response.headers);
  if (relation.kind === 'exhausted' && failure === undefined) return { kind: 'page', status: 'complete', selection, units };
  if (relation.kind === 'headerAbsent') failure ??= sourceFailure(SENTRY_FAILURE_CODES.paginationHeaderAbsent);
  if (relation.kind === 'unusable') failure ??= sourceFailure(SENTRY_FAILURE_CODES.paginationCursorMalformed);
  if (relation.kind === 'next') {
    if (relation.cursor === cursor) failure ??= sourceFailure(SENTRY_FAILURE_CODES.paginationCursorNotAdvancing);
    else {
      const token = encodeTriagePagingTokenV1({ cursor: relation.cursor });
      if (token !== null) return { kind: 'page', status: 'partial', selection, units, nextCursor: { v: 1, token }, ...(failure === undefined ? {} : { failure }) };
      failure ??= sourceFailure(SENTRY_CONTINUATION_UNAVAILABLE_REASON);
    }
  }
  return { kind: 'page', status: 'partial', selection, units, ...(failure === undefined ? {} : { failure }) };
}
