/**
 * Browser-safe identity codec for one selected Sentry occurrence.
 *
 * The candidate carries only the selected identities plus a digest of the exact
 * configured source. It carries no provider route, account, response bytes,
 * credential, Composer address, or draft authority. Resolution rereads the
 * canonical configured-source row before using the existing Action vertical.
 */

import {
  ComposerReferenceCandidateIdV1Schema,
  computeCanonicalDomainSeparatedDigest,
} from '@happier-dev/plugin-sdk';
import type {
  TriageConfiguredSourceInstanceV1,
  TriageSourceEntryLocalRefV1,
} from '@happier-dev/triage-protocol/v1';
import { TriageSourceInstanceIdV1Schema } from '@happier-dev/triage-protocol/v1';
import type { TriageEvidenceCandidateV1 } from '@happier-dev/triage-sources/ui';

import type { SentryEventProjectionV1 } from '../privacy/sentryEventProjection.js';
import {
  SENTRY_CONNECTED_ACCOUNT_ID,
  SENTRY_CONNECTED_ACCOUNT_PURPOSE,
  SENTRY_CONTRIBUTION_ID,
  SENTRY_ENTRY_KIND_ID,
  SENTRY_EVIDENCE_REFERENCE_ID,
  SENTRY_PLUGIN_ID,
} from '../sentryContracts.js';
import {
  decodeSentryInstanceConfiguration,
  decodeSentryLocalInstanceKey,
} from '../instances/sentryInstanceConfiguration.js';
import { deriveSentryCollisionScope } from '../instances/sentryCollisionScope.js';

const CANDIDATE_PREFIX = 'se1';
const CANDIDATE_SEPARATOR = '|';

export const SENTRY_EVIDENCE_REFERENCE = Object.freeze({
  pluginId: SENTRY_PLUGIN_ID,
  localId: SENTRY_EVIDENCE_REFERENCE_ID,
});

export type DecodedSentryEvidenceCandidate = Readonly<{
  sourceInstanceId: string;
  instanceDigest: string;
  entryId: string;
  eventId: string;
}>;

const CANONICAL_DIGEST_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

/**
 * Freezes the exact configured source the disclosure was made through without
 * copying its account or routing fields into the persisted Composer candidate.
 * Dispatch rereads the canonical configured-source row and compares this
 * digest before any credential is materialized or provider request is made.
 */
export function deriveSentryEvidenceInstanceDigest(
  instance: TriageConfiguredSourceInstanceV1,
): string {
  return computeCanonicalDomainSeparatedDigest(
    'happier.sentry.selected-evidence-instance.v1',
    [
      String(instance.v),
      instance.instance.source.pluginId,
      instance.instance.source.localId,
      instance.instance.sourceInstanceId,
      instance.binding.purpose,
      instance.binding.account.service.pluginId,
      instance.binding.account.service.localId,
      instance.binding.account.accountId,
      instance.localInstanceKey,
      String(instance.configuration.v),
      instance.configuration.token,
    ],
  );
}

function encodePart(value: string): string {
  return value.replaceAll('%', '%25').replaceAll(CANDIDATE_SEPARATOR, '%7C');
}

function decodePart(value: string): string | null {
  let decoded = '';
  for (let index = 0; index < value.length; index += 1) {
    const point = value[index];
    if (point !== '%') {
      decoded += point;
      continue;
    }
    const escaped = value.slice(index, index + 3);
    if (escaped === '%25') decoded += '%';
    else if (escaped === '%7C') decoded += CANDIDATE_SEPARATOR;
    else return null;
    index += 2;
  }
  return decoded;
}

function encodeCandidate(value: DecodedSentryEvidenceCandidate): string | null {
  const encoded = [
    CANDIDATE_PREFIX,
    value.sourceInstanceId,
    value.instanceDigest,
    value.entryId,
    value.eventId,
  ].map(encodePart).join(CANDIDATE_SEPARATOR);
  return ComposerReferenceCandidateIdV1Schema.safeParse(encoded).success ? encoded : null;
}

export function decodeSentryEvidenceCandidate(
  candidateId: string,
): DecodedSentryEvidenceCandidate | null {
  if (!ComposerReferenceCandidateIdV1Schema.safeParse(candidateId).success) return null;
  const parts: string[] = [];
  for (const encoded of candidateId.split(CANDIDATE_SEPARATOR)) {
    const part = decodePart(encoded);
    if (part === null) return null;
    parts.push(part);
  }
  if (parts.length !== 5) return null;
  const [
    prefix = '',
    sourceInstanceId = '',
    instanceDigest = '',
    entryId = '',
    eventId = '',
  ] = parts;
  if (prefix !== CANDIDATE_PREFIX
    || !TriageSourceInstanceIdV1Schema.safeParse(sourceInstanceId).success
    || !CANONICAL_DIGEST_PATTERN.test(instanceDigest)
    || entryId === ''
    || eventId === '') return null;

  return Object.freeze({
    sourceInstanceId,
    instanceDigest,
    entryId,
    eventId,
  });
}

function candidateLabel(eventId: string): string {
  return `Sentry occurrence ${eventId}`;
}

/** Mints the one identity-only candidate the mounted detail may disclose. */
export function createSentryEvidenceCandidate(input: Readonly<{
  instance: TriageConfiguredSourceInstanceV1;
  localRef: TriageSourceEntryLocalRefV1;
  selected: SentryEventProjectionV1;
}>): TriageEvidenceCandidateV1 | null {
  const localInstance = decodeSentryLocalInstanceKey(input.instance.localInstanceKey);
  const configuration = decodeSentryInstanceConfiguration(input.instance.configuration.token);
  if (!localInstance.ok
    || !configuration.ok
    || configuration.configuration.organizationId !== localInstance.instance.organizationId
    || input.instance.instance.source.pluginId !== SENTRY_PLUGIN_ID
    || input.instance.instance.source.localId !== SENTRY_CONTRIBUTION_ID
    || input.instance.binding.purpose !== SENTRY_CONNECTED_ACCOUNT_PURPOSE
    || input.instance.binding.account.service.pluginId !== SENTRY_PLUGIN_ID
    || input.instance.binding.account.service.localId !== SENTRY_CONNECTED_ACCOUNT_ID
    || input.localRef.kindId !== SENTRY_ENTRY_KIND_ID
    || input.localRef.collisionScope !== deriveSentryCollisionScope(localInstance.instance)
    || input.localRef.entryId === ''
    || input.selected.eventId === '') return null;

  const id = encodeCandidate({
    sourceInstanceId: input.instance.instance.sourceInstanceId,
    instanceDigest: deriveSentryEvidenceInstanceDigest(input.instance),
    entryId: input.localRef.entryId,
    eventId: input.selected.eventId,
  });
  if (id === null) return null;
  return Object.freeze({
    reference: SENTRY_EVIDENCE_REFERENCE,
    candidate: Object.freeze({ id, label: candidateLabel(input.selected.eventId) }),
  });
}

export const sentryEvidenceCandidateLabel = candidateLabel;
