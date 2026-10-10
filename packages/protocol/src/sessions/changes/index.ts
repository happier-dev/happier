export {
  ChangeConfidenceSchema,
  ChangeEvidenceSourceSchema,
  ChangeSetConfidenceSummarySchema,
  CheckpointOverlapObservationSchema,
  FileChangeEvidenceSchema,
  FileChangeKindSchema,
  RepositoryCheckpointReceiptSchema,
  RepositoryCheckpointCommitEvidenceSchema,
  RepositoryCheckpointTurnMetadataSchema,
  SessionAttributionConfidenceSchema,
  SessionAttributionReasonSchema,
  SessionChangeAttributionSchema,
  SessionChangeSetFileSchema,
  SessionChangeSetSchema,
  SessionWorkingTreeMatchedFileSchema,
  SessionWorkingTreeProjectionSchema,
  TurnChangeSetSchema,
} from './schemas.js';
export type {
  ChangeConfidence,
  ChangeEvidenceSource,
  ChangeSetConfidenceSummary,
  CheckpointOverlapObservation,
  FileChangeEvidence,
  FileChangeKind,
  RepositoryCheckpointReceipt,
  RepositoryCheckpointCommitEvidence,
  RepositoryCheckpointTurnMetadata,
  SessionAttributionConfidence,
  SessionAttributionReason,
  SessionChangeAttribution,
  SessionChangeSet,
  SessionChangeSetFile,
  SessionWorkingTreeMatchedFile,
  SessionWorkingTreeProjection,
  TurnChangeSet,
  WorkspaceTouchedFileEvidence,
} from './types.js';
export { normalizeCheckpointAttributionScope } from './checkpointAttributionScope.js';
export type {
  CheckpointAttributionScope,
} from './checkpointAttributionScope.js';
export {
  combineChangedFilesAttribution,
  projectChangedFilesAttribution,
  deriveSessionChangeAttribution,
  compareTurnChangeSetChronology,
  mergeCheckpointOverlap,
  mergeTurnChangeSets,
} from './mergeTurnChangeSets.js';
export type { ChangedFilesTurnEvidenceScope, ChangedFilesAttributionProjection } from './mergeTurnChangeSets.js';
export { reconcileWithScmSnapshot, normalizeRepositoryFilePath } from './reconcileWithScmSnapshot.js';
export { excludeRolledBackTurns } from './rollbacks.js';
