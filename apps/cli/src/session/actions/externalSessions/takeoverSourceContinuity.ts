import type {
  ExternalSessionOperationRecordV1,
  ExternalSessionsSource,
} from '@happier-dev/protocol';

import type {
  ExternalSessionExecutionSurface,
} from '@/session/external/providerOps';

import {
  ExternalSessionPersistedTakeoverPreflightError,
  type ExternalSessionPersistedTakeoverImportRecord,
} from './materializeAction';
import {
  matchesExternalSessionSourceGenerationAnchor,
} from './sourceGenerationAnchor';

export type ExternalSessionPersistedTakeoverContinuityRequirement =
  | 'allow_advanced_for_catch_up'
  | 'already_current_for_admission';

export async function assertExternalSessionPersistedTakeoverSourceContinuity(
  input: Readonly<{
    record: ExternalSessionPersistedTakeoverImportRecord;
    providerOps: Pick<ExternalSessionExecutionSurface, 'readAfterTranscript'>;
    source: ExternalSessionsSource;
    requirement: ExternalSessionPersistedTakeoverContinuityRequirement;
  }>,
): Promise<void> {
  const sourceSnapshotEvidenceRef =
    input.record.canonicalOwnerEvidence.sourceSnapshotEvidenceRef;
  if (
    !sourceSnapshotEvidenceRef
    || (
      input.record.phase === 'validating'
      && !matchesExternalSessionSourceGenerationAnchor(
        input.record.request.source.sourceGeneration,
        sourceSnapshotEvidenceRef,
      )
    )
  ) {
    throw new ExternalSessionPersistedTakeoverPreflightError(
      'source_unavailable',
      'Persisted takeover source-generation evidence is unavailable.',
    );
  }
  if (!input.providerOps.readAfterTranscript) {
    throw new ExternalSessionPersistedTakeoverPreflightError(
      'source_unavailable',
      'Persisted takeover source continuity cannot be revalidated.',
    );
  }
  const continuity = await input.providerOps.readAfterTranscript({
    source: input.source,
    remoteSessionId: input.record.request.source.remoteSessionId,
    cursor: sourceSnapshotEvidenceRef,
    maxBytes: 512 * 1024,
    maxItems: 1,
  }).catch(() => null);
  const isContinuous = continuity?.outcome === 'already_current'
    || (
      input.requirement === 'allow_advanced_for_catch_up'
      && continuity?.outcome === 'advanced'
    );
  if (!isContinuous) {
    throw new ExternalSessionPersistedTakeoverPreflightError(
      'source_unavailable',
      input.requirement === 'already_current_for_admission'
        ? 'Persisted takeover source advanced after final catch-up.'
        : 'Persisted takeover source generation was replaced or could not be revalidated.',
    );
  }
}

type ExternalLinkedTakeoverRecord = ExternalSessionOperationRecordV1 & Readonly<{
  request: Extract<
    ExternalSessionOperationRecordV1['request'],
    { plan: 'takeover' }
  > & Readonly<{ targetStorageMode: 'external-linked' }>;
}>;

export async function assertExternalSessionExternalLinkedTakeoverSourceContinuity(
  input: Readonly<{
    record: ExternalLinkedTakeoverRecord;
    providerOps: Pick<ExternalSessionExecutionSurface, 'readAfterTranscript'>;
    source: ExternalSessionsSource;
  }>,
): Promise<void> {
  const sourceSnapshotEvidenceRef =
    input.record.canonicalOwnerEvidence.sourceSnapshotEvidenceRef;
  if (
    !sourceSnapshotEvidenceRef
    || !matchesExternalSessionSourceGenerationAnchor(
      input.record.request.source.sourceGeneration,
      sourceSnapshotEvidenceRef,
    )
  ) {
    throw new ExternalSessionPersistedTakeoverPreflightError(
      'source_unavailable',
      'External-linked takeover source-generation evidence is unavailable.',
    );
  }
  if (!input.providerOps.readAfterTranscript) {
    throw new ExternalSessionPersistedTakeoverPreflightError(
      'source_unavailable',
      'External-linked takeover source continuity cannot be revalidated.',
    );
  }
  const continuity = await input.providerOps.readAfterTranscript({
    source: input.source,
    remoteSessionId: input.record.request.source.remoteSessionId,
    cursor: sourceSnapshotEvidenceRef,
    maxBytes: 512 * 1024,
    maxItems: 1,
  }).catch(() => null);
  if (
    continuity?.outcome !== 'already_current'
    && continuity?.outcome !== 'advanced'
  ) {
    throw new ExternalSessionPersistedTakeoverPreflightError(
      'source_unavailable',
      'External-linked takeover source generation was replaced or could not be revalidated.',
    );
  }
}
