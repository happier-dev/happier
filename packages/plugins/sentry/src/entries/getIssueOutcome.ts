/**
 * The authoritative single-issue read outcome (`SENTRY.md` §4, §5).
 *
 * **The merge comparison is a mandatory pre-flight, not an optimization.**
 * `[SOURCE]` `src/sentry/issues/endpoints/bases/group.py` calls
 * `get_group_with_redirect(...)` and discards the `redirected` flag, with an
 * in-code TODO acknowledging it. A `GET` on a merged-away issue id therefore
 * returns HTTP 200 carrying the **successor's** full body — no `3xx`, no header,
 * no field announcing the substitution. Comparing the returned `id` against the
 * requested one is the only detection available to any client, and skipping it
 * overwrites issue A's record with issue B's content.
 *
 * **This vertical never emits `absent`.** The public org-scoped `404` is
 * ambiguous: unknown id, an issue hidden while `pending_deletion`/`pending_merge`,
 * a project moved outside the configured organization, or genuinely unavailable.
 * The endpoint supplies no independent tombstone that separates those meanings,
 * so the honest result is `unresolved` and the entry stays visible.
 */

import { SENTRY_FAILURE_CODES, type SentryFailureV1 } from '../sentryContracts.js';
import type { SentryApiOutcomeV1 } from '../api/sentryApiClient.js';
import { classifySentryFailure } from '../api/sentryFailure.js';
import {
  resolveSentryInvokedScope,
  type SentryInvokedInstanceV1,
} from '../instances/sentryCollisionScope.js';

import { mapSentryIssueForInvokedInstance } from './sentryIssueMapping.js';
import type { SentryIssueSnapshotV1, SentryLocalRefV1 } from './sentryIssueTypes.js';

export type SentryGetOutcomeInputV1 = Readonly<{
  requestedEntryId: string;
  configured: SentryInvokedInstanceV1;
  requestUrl: string;
  organizationSlug: string | null;
  nowMs: number;
  outcome: SentryApiOutcomeV1;
}>;

export type SentryGetOutcomeV1 =
  | Readonly<{ kind: 'present'; localRef: SentryLocalRefV1; snapshot: SentryIssueSnapshotV1 }>
  | Readonly<{ kind: 'merged'; localRef: SentryLocalRefV1; successor: SentryLocalRefV1 }>
  | Readonly<{ kind: 'unresolved'; localRef: SentryLocalRefV1; failure: SentryFailureV1 }>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function resolveSentryGetOutcome(input: SentryGetOutcomeInputV1): SentryGetOutcomeV1 {
  const scope = resolveSentryInvokedScope({
    configured: input.configured,
    requestUrl: input.requestUrl,
  });
  const collisionScope = scope.ok ? scope.collisionScope : '';
  const localRef: SentryLocalRefV1 = Object.freeze({
    kindId: 'error-issue' as const,
    collisionScope,
    entryId: input.requestedEntryId,
  });

  const unresolved = (failure: SentryFailureV1): SentryGetOutcomeV1 => Object.freeze({
    kind: 'unresolved' as const,
    localRef,
    failure,
  });

  if (!scope.ok) return unresolved(scope.failure);
  if (input.outcome.kind === 'failed') return unresolved(input.outcome.failure);

  const { response } = input.outcome;
  if (response.status !== 200) {
    return unresolved(classifySentryFailure({
      kind: 'status',
      operation: 'issue',
      nowMs: input.nowMs,
      response,
    }));
  }

  let body: unknown;
  try {
    body = JSON.parse(response.bodyText);
  } catch {
    return unresolved(classifySentryFailure({ kind: 'unparseable', operation: 'issue' }));
  }
  if (!isRecord(body)) {
    return unresolved(classifySentryFailure({ kind: 'unparseable', operation: 'issue' }));
  }

  const returnedId = typeof body.id === 'string' && body.id.trim() !== '' ? body.id : null;
  if (returnedId === null) {
    return unresolved(classifySentryFailure({ kind: 'unparseable', operation: 'issue' }));
  }

  if (returnedId !== input.requestedEntryId) {
    // The successor scope is derived from the exact invoked instance. It is
    // never recomputed from the response body's project, which is locator and
    // presentation data only.
    return Object.freeze({
      kind: 'merged' as const,
      localRef,
      successor: Object.freeze({
        kindId: 'error-issue' as const,
        collisionScope,
        entryId: returnedId,
      }),
    });
  }

  const mapped = mapSentryIssueForInvokedInstance({
    raw: body,
    configured: input.configured,
    requestUrl: input.requestUrl,
    organizationSlug: input.organizationSlug,
  });
  if (!mapped.ok) {
    return unresolved(mapped.reason === 'scope-mismatch'
      ? mapped.failure
      : Object.freeze({
        class: 'unsupportedContract' as const,
        code: SENTRY_FAILURE_CODES.responseUnparseable,
      }));
  }

  return Object.freeze({
    kind: 'present' as const,
    localRef: mapped.snapshot.localRef,
    snapshot: mapped.snapshot,
  });
}
