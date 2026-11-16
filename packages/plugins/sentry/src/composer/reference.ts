/** Daemon-side resolver for selected Sentry occurrence references. */

import {
  PluginError,
  type ComposerReferenceCandidatePageV1,
  type ComposerReferenceResolutionV1,
  type PluginInvocationContext,
} from '@happier-dev/plugin-sdk';
import {
  fitComposerReferenceResolutionPrefixV1,
  readCurrentTriageConfiguredSourceInstanceV1,
} from '@happier-dev/triage-sources/runtime';

import { decodeSentryLocalInstanceKey } from '../instances/sentryInstanceConfiguration.js';
import { deriveSentryCollisionScope } from '../instances/sentryCollisionScope.js';
import {
  type SentryEventProjectionV1,
} from '../privacy/sentryEventProjection.js';
import { SENTRY_ACTION_IDS, SENTRY_ENTRY_KIND_ID, SENTRY_PLUGIN_ID } from '../sentryContracts.js';
import { SentryReadEventResultV1Schema } from '../detail/detailContracts.js';

import {
  decodeSentryEvidenceCandidate,
  deriveSentryEvidenceInstanceDigest,
  sentryEvidenceCandidateLabel,
  summarizeSentryEvidenceDisclosure,
} from './candidate.js';

export {
  SENTRY_EVIDENCE_REFERENCE,
  createSentryEvidenceCandidate,
  deriveSentryEvidenceInstanceDigest,
} from './candidate.js';

function unavailableEvidence(reason: string, retryable = false): PluginError {
  return new PluginError({
    code: 'sentry/evidence-unavailable',
    message: `The selected Sentry evidence is unavailable (${reason}).`,
    retryable,
    failureCause: { phase: 'composer_reference.resolve', errorClass: 'Error', errorCode: reason, httpStatus: null },
  });
}

type EvidenceChunkKind = 'section' | 'frame' | 'breadcrumb' | 'tag' | 'field';

type EvidenceChunk = Readonly<{
  kind: EvidenceChunkKind;
  text: string;
}>;

function timestampText(timestampMs: number | null): string | null {
  if (timestampMs === null) return null;
  // Protocol timestamps admit every safe integer while JavaScript Date has a
  // narrower representable range. Preserve the exact admitted provider value
  // when it is outside that range instead of making evidence resolution throw.
  const timestamp = new Date(timestampMs);
  return Number.isNaN(timestamp.getTime()) ? String(timestampMs) : timestamp.toISOString();
}

function evidenceChunks(projection: SentryEventProjectionV1): readonly EvidenceChunk[] {
  const chunks: EvidenceChunk[] = [];
  const field = (label: string, value: string | null): void => {
    if (value !== null && value !== '') chunks.push({ kind: 'field', text: `${label}: ${value}` });
  };
  field('Title', projection.title);
  if (projection.message !== projection.title) field('Message', projection.message);
  field('Location', projection.location);
  field('Culprit', projection.culprit);
  field('Platform', projection.platform);

  const release = projection.tags.find((tag) => tag.key === 'release' || tag.key === 'sentry:release');
  const environment = projection.tags.find((tag) => tag.key === 'environment');
  if (release !== undefined) field('Release', release.value);
  if (environment !== undefined) field('Environment', environment.value);
  for (const tag of projection.tags) {
    if (tag === release || tag === environment) continue;
    chunks.push({ kind: 'tag', text: `Tag ${tag.key}: ${tag.value}` });
  }

  for (const section of projection.sections) {
    if (section.kind === 'exception') {
      const identity = section.type === '' ? 'Exception' : section.type;
      chunks.push({
        kind: 'section',
        text: section.value === ''
          ? `Exception: ${identity}`
          : `Exception: ${identity}: ${section.value}`,
      });
      for (const frame of section.frames) {
        const where = frame.filename ?? 'unknown file';
        const line = frame.lineNo === null ? '' : `:${String(frame.lineNo)}`;
        const column = frame.colNo === null ? '' : `:${String(frame.colNo)}`;
        const label = frame.function ?? where;
        chunks.push({
          kind: 'frame',
          text: label === where
            ? `  at ${where}${line}${column}`
            : `  at ${label} (${where}${line}${column})${frame.inApp ? ' [application]' : ''}`,
        });
        field('    Context', frame.contextLine);
      }
      continue;
    }
    if (section.kind === 'stacktrace') {
      chunks.push({ kind: 'section', text: 'Stack trace:' });
      for (const frame of section.frames) {
        const where = frame.filename ?? 'unknown file';
        const line = frame.lineNo === null ? '' : `:${String(frame.lineNo)}`;
        const column = frame.colNo === null ? '' : `:${String(frame.colNo)}`;
        const label = frame.function ?? where;
        chunks.push({
          kind: 'frame',
          text: label === where
            ? `  at ${where}${line}${column}`
            : `  at ${label} (${where}${line}${column})${frame.inApp ? ' [application]' : ''}`,
        });
        field('    Context', frame.contextLine);
      }
      continue;
    }
    if (section.kind === 'breadcrumbs') {
      for (const breadcrumb of section.entries) {
        const parts = [
          timestampText(breadcrumb.timestampMs),
          breadcrumb.level,
          breadcrumb.category,
          breadcrumb.message,
        ].filter((value): value is string => value !== null && value !== '');
        if (parts.length > 0) chunks.push({ kind: 'breadcrumb', text: `Breadcrumb: ${parts.join(' · ')}` });
      }
      continue;
    }
    if (section.kind === 'message') {
      if (section.formatted !== projection.message) field('Message detail', section.formatted);
      continue;
    }
    chunks.push({ kind: 'section', text: `Unsupported event section: ${section.entryType}` });
  }

  return chunks;
}

function selectedEvidenceContext(
  projection: SentryEventProjectionV1,
  selected: readonly EvidenceChunk[],
  all: readonly EvidenceChunk[],
): string {
  const lines = [sentryEvidenceCandidateLabel(projection.eventId)];
  const occurredAt = timestampText(projection.dateCreatedMs);
  if (occurredAt !== null) lines.push(`Occurred: ${occurredAt}`);
  lines.push(...selected.map((chunk) => chunk.text));
  // The same summary the mounted confirmation was built from, so what the reader
  // approved and what the model is told about it cannot drift apart.
  const disclosure = summarizeSentryEvidenceDisclosure(projection);
  lines.push(
    `Evidence disclosure: ${String(disclosure.providerScrubbed)} provider-scrubbed field(s), `
      + `${String(disclosure.pluginWithheld)} plugin-withheld field(s), `
      + `${String(disclosure.sensitivePaths)} sensitive projected path(s).`,
  );
  const counted = (count: number, noun: string): string => (
    `${String(count)} ${noun}${count === 1 ? '' : 's'}`
  );
  const selectedSet = new Set(selected);
  const notAdmitted = (kind: EvidenceChunkKind): number => all.filter(
    (chunk) => chunk.kind === kind && !selectedSet.has(chunk),
  ).length;
  const userFields = disclosure.userFields;
  const omissions = [
    projection.omitted.frames + notAdmitted('frame') === 0
      ? null : counted(projection.omitted.frames + notAdmitted('frame'), 'frame'),
    projection.omitted.tags + notAdmitted('tag') === 0
      ? null : counted(projection.omitted.tags + notAdmitted('tag'), 'tag'),
    projection.omitted.sections + notAdmitted('section') === 0
      ? null : counted(projection.omitted.sections + notAdmitted('section'), 'section'),
    projection.omitted.breadcrumbs + notAdmitted('breadcrumb') === 0
      ? null : counted(projection.omitted.breadcrumbs + notAdmitted('breadcrumb'), 'breadcrumb'),
    notAdmitted('field') === 0 ? null : counted(notAdmitted('field'), 'field'),
    userFields === 0 ? null : counted(userFields, 'event user field'),
    projection.projectionTruncated ? 'additional upstream-projected content' : null,
  ].filter((value): value is string => value !== null);
  if (omissions.length > 0) lines.push(`Agent evidence omitted: ${omissions.join(', ')}.`);
  return lines.join('\n');
}

/**
 * Selects whole, already-redacted semantic items against the canonical Composer
 * resolution schema. There is no provider-local byte/count ledger: each item is
 * retained as one provider-ordered prefix admitted by the complete public wire
 * object, and every remaining item stays visible in the omission disclosure.
 */
function selectedEvidenceResolution(
  candidateId: string,
  label: string,
  projection: SentryEventProjectionV1,
): ComposerReferenceResolutionV1 {
  const all = evidenceChunks(projection);
  const fitted = fitComposerReferenceResolutionPrefixV1({
    identity: { id: candidateId, label },
    itemCount: all.length,
    contextForPrefix: (includedCount) => selectedEvidenceContext(
      projection,
      all.slice(0, includedCount),
      all,
    ),
  });
  if (fitted === null) throw unavailableEvidence('evidence-contract-exceeded');
  return fitted;
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

  const current = await readCurrentTriageConfiguredSourceInstanceV1({
    context,
    sourceInstanceId: candidate.sourceInstanceId,
    instanceDigest: candidate.instanceDigest,
  });
  if (current.kind === 'unavailable') {
    throw unavailableEvidence('configured-source-unavailable');
  }
  if (current.kind === 'changed') throw unavailableEvidence('configured-source-changed');
  const instance = current.instance;
  const invoked = decodeSentryLocalInstanceKey(instance.localInstanceKey);
  if (!invoked.ok) throw unavailableEvidence('configured-source-invalid');
  const result = SentryReadEventResultV1Schema.parse(await context.services.actions.execute({
    pluginId: SENTRY_PLUGIN_ID, localId: SENTRY_ACTION_IDS.readEvent,
  }, {
    v: 1,
    instance,
    localRef: {
      kindId: SENTRY_ENTRY_KIND_ID,
      collisionScope: deriveSentryCollisionScope(invoked.instance),
      entryId: candidate.entryId,
    },
    selector: { kind: 'event', eventId: candidate.eventId },
  }, { signal: context.signal }));
  if (result.kind !== 'event') {
    throw unavailableEvidence(result.failure.code, result.failure.class === 'transient');
  }
  if (result.projection.eventId !== candidate.eventId) {
    throw unavailableEvidence('event-changed');
  }
  return selectedEvidenceResolution(
    candidateId,
    sentryEvidenceCandidateLabel(candidate.eventId),
    result.projection,
  );
}
