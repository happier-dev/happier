/**
 * Plugin-local mapped entry → the public `present` observation arm.
 *
 * This is the only place GitLab vocabulary becomes source-contract vocabulary.
 * It adds no fact the provider did not supply: an omitted row fact means the
 * provider did not report it here, which is not the same as a known-zero value.
 */

import {
  MAX_TRIAGE_LOCATION_UTF8_BYTES_V1,
  MAX_TRIAGE_ROUTING_TOKEN_UTF8_BYTES_V1,
  normalizeTriageSingleLineV1,
  type TriageRowFactV1,
  type TriageSourceEntrySnapshotV1,
  type TriageSourceScanObservationV1,
} from '@happier-dev/triage-protocol/v1';

import { boundGitlabText, type BoundedText } from './mapping/bounded.js';
import type {
  GitlabMappedEntry,
  GitlabRowFact,
  GitlabRowFactValue,
} from './types.js';

type PresentObservation = Extract<TriageSourceScanObservationV1, { kind: 'present' }>;

function projectRowFactValue(value: GitlabRowFactValue): TriageRowFactV1['value'] {
  switch (value.kind) {
    case 'text':
      return { kind: 'text', value: value.text };
    case 'actor':
      return { kind: 'actor', value: value.actor };
    case 'timestamp':
      return { kind: 'timestamp', atMs: value.epochMs, format: value.display };
    case 'number':
      return { kind: 'number', value: value.value, format: value.display };
    case 'status':
      return { kind: 'status', value: value.label, tone: value.tone };
    case 'detailOnly':
      return { kind: 'detailOnly' };
  }
}

function projectRowFact(fact: GitlabRowFact): TriageRowFactV1 {
  return { id: fact.id, importance: fact.importance, value: projectRowFactValue(fact.value) };
}

/**
 * A machine-meaningful locator string is emitted whole or not at all.
 *
 * Shortening a route addresses a different project and shortening a URL is a different
 * destination, so an over-bound one is omitted — never cut, never repaired. The ceiling
 * is read from its published owner, because the target rejects an over-bound result
 * ATOMICALLY and one deep group path would discard every sibling row on the same page.
 */
function fittingGitlabLocation(value: string, maxUtf8Bytes: number): string | null {
  if (value === '' || value !== normalizeTriageSingleLineV1(value)) return null;
  return new TextEncoder().encode(value).byteLength > maxUtf8Bytes ? null : value;
}

function projectSnapshot(
  entry: GitlabMappedEntry,
  displayPath: BoundedText,
  locatorTruncated: boolean,
): TriageSourceEntrySnapshotV1 {
  const scopeLabel = boundGitlabText(entry.locator.repositoryKey);
  return {
    v: 1,
    // A GitLab item can be saved with an empty title. Display text is bounded
    // below by the contract, so the reference the user would type instead of
    // the title stands in for it rather than dropping an identity-valid row.
    title: entry.snapshot.title === '' ? displayPath.text : entry.snapshot.title,
    // A deep group path is display text here and routing in `routingToken`. The display
    // copies are shortened; the routing copy is omitted instead, because shortening it
    // would address another project.
    scopeLabel: scopeLabel.text,
    ...(entry.snapshot.sourceCreatedAtMs === null
      ? {}
      : { createdAtMs: entry.snapshot.sourceCreatedAtMs }),
    state: {
      presentation: entry.snapshot.state.presentation,
      nativeLabel: entry.snapshot.state.nativeLabel,
    },
    facts: entry.rowFacts.map(projectRowFact),
    ...(entry.projectionTruncated || scopeLabel.truncated || locatorTruncated
      ? { projectionTruncated: true }
      : {}),
  };
}

/**
 * Builds the `present` arm shared by `scan` and authoritative `get`. GitLab
 * exposes no per-item revision on these reads, so `nativeRevision` is omitted
 * rather than filled with a timestamp that is not one.
 */
export function projectGitlabPresentObservation(entry: GitlabMappedEntry): PresentObservation {
  const displayPath = boundGitlabText(entry.locator.displayPath);
  const routingToken = fittingGitlabLocation(
    entry.locator.routingToken,
    MAX_TRIAGE_ROUTING_TOKEN_UTF8_BYTES_V1,
  );
  const webUrl = entry.locator.webUrl === null
    ? null
    : fittingGitlabLocation(entry.locator.webUrl, MAX_TRIAGE_LOCATION_UTF8_BYTES_V1);
  const locatorTruncated = displayPath.truncated
    || routingToken === null
    || (webUrl === null && entry.locator.webUrl !== null);

  return {
    kind: 'present',
    localRef: {
      kindId: entry.identity.kindId,
      collisionScope: entry.identity.collisionScope,
      entryId: entry.identity.entryId,
    },
    locator: {
      v: 1,
      ...(webUrl === null ? {} : { webUrl }),
      displayPath: displayPath.text,
      ...(routingToken === null ? {} : { routingToken }),
    },
    snapshot: projectSnapshot(entry, displayPath, locatorTruncated),
    viewer: { involvement: [...entry.viewer.involvement] },
    ...(entry.snapshot.sourceUpdatedAtMs === null
      ? {}
      : { sourceUpdatedAtMs: entry.snapshot.sourceUpdatedAtMs }),
  };
}
