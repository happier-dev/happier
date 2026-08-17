/**
 * The one projection from this source's native shapes to the published Triage
 * source contract (`CONTRACT.md` §4, `SENTRY.md` §6).
 *
 * Stage 1 deliberately mirrored the contract's snapshot/fact vocabulary
 * structurally, so this module renames rather than re-derives: it invents no
 * fact, upgrades no evidence, and never reconstructs identity. Every value it
 * emits already passed the Sentry-owned mapper's identity and scope checks.
 */

import {
  MAX_TRIAGE_TEXT_UTF8_BYTES_V1,
  projectTriageDisplayTextV1,
} from '@happier-dev/triage-protocol/v1';

import type {
  TriageRowFactV1,
  TriageRowFactValueV1,
  TriageSourceEntryLocalRefV1,
  TriageSourceFailureV1,
  TriageSourceObservationV1,
  TriageSourceScanEvidenceV1,
  TriageSourceScanObservationV1,
} from '@happier-dev/triage-protocol/v1';

import type { SentryFailureV1 } from '../sentryContracts.js';
import type {
  SentryFactValueV1,
  SentryIssueSnapshotV1,
  SentryLocalRefV1,
  SentryRowFactV1,
} from '../entries/sentryIssueTypes.js';
import type { SentryScanHealthV1 } from '../scan/sentryScanHealth.js';

/** The reason carried when a Sentry walk reports a moving keyset rather than a stop. */
export const SENTRY_MOVING_SCAN_REASON = 'sentry-scan-window-moving';

/** Sentry's closed failure vocabulary is already the contract's shape. */
export function toTriageFailure(failure: SentryFailureV1): TriageSourceFailureV1 {
  return Object.freeze({
    class: failure.class,
    code: failure.code,
    ...(failure.retryNotBeforeMs === undefined
      ? {}
      : { retryNotBeforeMs: failure.retryNotBeforeMs }),
  });
}

export function toTriageLocalRef(localRef: SentryLocalRefV1): TriageSourceEntryLocalRefV1 {
  return Object.freeze({
    kindId: localRef.kindId,
    collisionScope: localRef.collisionScope,
    entryId: localRef.entryId,
  });
}

/**
 * `[SCHEMA]` Sentry counts are strings because they can exceed a safe integer,
 * while the contract's `number` arm is numeric. A value that cannot be carried
 * as an exact finite number stays truthful as its own text rather than becoming
 * a rounded total.
 */
function toTriageFactValue(value: SentryFactValueV1): TriageRowFactValueV1 {
  switch (value.kind) {
    case 'text':
      return Object.freeze({ kind: 'text' as const, value: value.text });
    case 'status':
      return Object.freeze({ kind: 'status' as const, value: value.label, tone: value.tone });
    case 'timestamp':
      return Object.freeze({
        kind: 'timestamp' as const,
        atMs: value.atMs,
        format: value.format,
      });
    case 'actor':
      return Object.freeze({ kind: 'actor' as const, value: value.displayName });
    case 'detailOnly':
      return Object.freeze({ kind: 'detailOnly' as const });
    case 'number': {
      const parsed = Number(value.value);
      if (!Number.isFinite(parsed) || !Number.isSafeInteger(parsed)) {
        return Object.freeze({ kind: 'text' as const, value: value.value });
      }
      return Object.freeze({
        kind: 'number' as const,
        value: parsed,
        format: value.format,
        ...(value.approximate ? { approximate: true as const } : {}),
      });
    }
  }
}

function toTriageFact(fact: SentryRowFactV1): TriageRowFactV1 {
  return Object.freeze({
    id: fact.id,
    importance: fact.importance,
    value: toTriageFactValue(fact.value),
  });
}

/**
 * One present observation.
 *
 * No `routingToken` is emitted: the configured instance already binds the exact
 * account, origin and organization, so a per-entry route would be a second,
 * staler routing authority (`SENTRY.md` §2.4c). V1 reads no viewer relationship
 * from Sentry, so `involvement` is honestly empty rather than guessed.
 */
export function toTriagePresentObservation(
  snapshot: SentryIssueSnapshotV1,
): Extract<TriageSourceObservationV1, Readonly<{ kind: 'present' }>> {
  const nativeLabel = projectTriageDisplayTextV1(
    snapshot.state.nativeLabel,
    MAX_TRIAGE_TEXT_UTF8_BYTES_V1,
  );
  return Object.freeze({
    kind: 'present' as const,
    localRef: toTriageLocalRef(snapshot.localRef),
    locator: Object.freeze({
      v: 1 as const,
      // A destination this source could not publish within the location bound is omitted,
      // never truncated into a different one; the omission already set
      // `projectionTruncated` at the mapper, so the row survives and says so.
      ...(snapshot.locator.webUrl === null ? {} : { webUrl: snapshot.locator.webUrl }),
      displayPath: snapshot.locator.displayPath,
    }),
    snapshot: Object.freeze({
      v: 1 as const,
      title: snapshot.title,
      scopeLabel: snapshot.scopeLabel,
      state: Object.freeze({
        presentation: snapshot.state.presentation,
        // Sentry's `status` is a bare provider string and an unrecognized value reaches
        // here verbatim, so it is projected into one bounded line like every other
        // display string. Nothing surviving omits the label rather than publishing a
        // blank one, which the non-empty published string would reject atomically.
        ...(nativeLabel.value.length === 0 ? {} : { nativeLabel: nativeLabel.value }),
      }),
      facts: Object.freeze(snapshot.facts.map(toTriageFact)),
      ...(snapshot.projectionTruncated ? { projectionTruncated: true as const } : {}),
    }),
    viewer: Object.freeze({ involvement: Object.freeze([]) }),
    ...(snapshot.sourceUpdatedAtMs === null
      ? {}
      : { sourceUpdatedAtMs: snapshot.sourceUpdatedAtMs }),
  });
}

/** Scan observations are the same present projection, bounded to the scan arms. */
export function toTriageScanObservation(
  snapshot: SentryIssueSnapshotV1,
): TriageSourceScanObservationV1 {
  return toTriagePresentObservation(snapshot);
}

/**
 * Scan health becomes scan evidence. `walkFinished` stays exactly what Sentry
 * meant by it — pagination ran out — and never becomes absence evidence.
 */
export function toTriageScanEvidence(health: SentryScanHealthV1): TriageSourceScanEvidenceV1 {
  switch (health.kind) {
    case 'walkFinished':
      return Object.freeze({ kind: 'walkFinished' as const });
    case 'moving':
      return Object.freeze({ kind: 'moving' as const, reason: SENTRY_MOVING_SCAN_REASON });
    case 'partial':
      return Object.freeze({
        kind: 'partial' as const,
        reason: health.reason,
        ...(health.omittedItemCount === undefined
          ? {}
          : { omittedItemCount: health.omittedItemCount }),
      });
  }
}
