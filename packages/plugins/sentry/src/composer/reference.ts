/** Daemon-side resolver for selected Sentry occurrence references. */

import {
  PluginError,
  type ComposerReferenceCandidatePageV1,
  type ComposerReferenceResolutionV1,
  type PluginInvocationContext,
} from '@happier-dev/plugin-sdk';
import {
  TRIAGE_SOURCES_READ_CONFIGURED_ACTION_REF_V1,
  TriageReadConfiguredSourceInstancesResultV1Schema,
  type TriageConfiguredSourceInstanceV1,
} from '@happier-dev/triage-protocol/v1';

import { decodeSentryLocalInstanceKey } from '../instances/sentryInstanceConfiguration.js';
import { deriveSentryCollisionScope } from '../instances/sentryCollisionScope.js';
import type { SentryEventProjectionV1 } from '../privacy/sentryEventProjection.js';
import { SENTRY_ENTRY_KIND_ID } from '../sentryContracts.js';
import { readSentryEvent } from '../source/detailOperations.js';

import {
  decodeSentryEvidenceCandidate,
  deriveSentryEvidenceInstanceDigest,
  sentryEvidenceCandidateLabel,
} from './candidate.js';

export {
  SENTRY_EVIDENCE_REFERENCE,
  createSentryEvidenceCandidate,
  deriveSentryEvidenceInstanceDigest,
} from './candidate.js';

function unavailableEvidence(reason: string): PluginError {
  return new PluginError({
    code: 'sentry/evidence-unavailable',
    message: `The selected Sentry evidence is unavailable (${reason}).`,
  });
}

function selectedEvidenceContext(projection: SentryEventProjectionV1): string {
  const lines = [sentryEvidenceCandidateLabel(projection.eventId)];
  if (projection.dateCreatedMs !== null) {
    lines.push(`Occurred: ${new Date(projection.dateCreatedMs).toISOString()}`);
  }
  if (projection.title !== '') lines.push(projection.title);
  if (projection.message !== '' && projection.message !== projection.title) {
    lines.push(projection.message);
  }
  if (projection.location !== null) lines.push(`Location: ${projection.location}`);
  if (projection.culprit !== null) lines.push(`Culprit: ${projection.culprit}`);
  for (const section of projection.sections) {
    if (section.kind === 'exception') lines.push(`${section.type}: ${section.value}`);
    if (section.kind !== 'exception' && section.kind !== 'stacktrace') continue;
    // The allow-list projector already owns the event bound. This dormant
    // resolver must not silently create a second, source-private excerpt while
    // the manifest fails closed pending the evidence-projection amendment.
    for (const frame of section.frames) {
      const where = frame.filename ?? 'unknown file';
      const line = frame.lineNo === null ? '' : `:${String(frame.lineNo)}`;
      const label = frame.function ?? where;
      lines.push(label === where ? `  at ${where}${line}` : `  at ${label} (${where}${line})`);
    }
  }
  return lines.join('\n');
}

/** This provider is direct-disclosure-only; generic Composer search returns no rows. */
export async function searchSentryEvidenceReferences(
  _query: string,
  _context: PluginInvocationContext,
): Promise<ComposerReferenceCandidatePageV1> {
  return [];
}

/** Re-reads the exact selected event through the canonical Sentry Action vertical. */
export async function resolveSentryEvidenceReference(
  candidateId: string,
  context: PluginInvocationContext,
): Promise<ComposerReferenceResolutionV1> {
  const candidate = decodeSentryEvidenceCandidate(candidateId);
  if (candidate === null) throw unavailableEvidence('candidate-invalid');

  const currentRaw = await context.services.actions.execute(
    TRIAGE_SOURCES_READ_CONFIGURED_ACTION_REF_V1,
    { v: 1 },
    { signal: context.signal },
  );
  const current = TriageReadConfiguredSourceInstancesResultV1Schema.safeParse(currentRaw);
  if (!current.success || current.data.kind !== 'read' || current.data.status !== 'complete') {
    throw unavailableEvidence('configured-source-unavailable');
  }
  const matches = current.data.instances.filter((record) => (
    record.lifecycle === 'active'
    && record.configured.instance.sourceInstanceId === candidate.sourceInstanceId
    && deriveSentryEvidenceInstanceDigest(record.configured) === candidate.instanceDigest
  ));
  if (matches.length !== 1) throw unavailableEvidence('configured-source-changed');
  const instance: TriageConfiguredSourceInstanceV1 = matches[0]!.configured;
  const invoked = decodeSentryLocalInstanceKey(instance.localInstanceKey);
  if (!invoked.ok) throw unavailableEvidence('configured-source-invalid');
  const result = await readSentryEvent({
    v: 1,
    instance,
    localRef: {
      kindId: SENTRY_ENTRY_KIND_ID,
      collisionScope: deriveSentryCollisionScope(invoked.instance),
      entryId: candidate.entryId,
    },
    selector: { kind: 'event', eventId: candidate.eventId },
  }, context);
  if (result.kind !== 'event' || result.projection.eventId !== candidate.eventId) {
    throw unavailableEvidence(result.kind === 'event' ? 'event-changed' : result.failure.code);
  }

  return Object.freeze({
    id: candidateId,
    label: sentryEvidenceCandidateLabel(candidate.eventId),
    context: selectedEvidenceContext(result.projection),
  });
}
