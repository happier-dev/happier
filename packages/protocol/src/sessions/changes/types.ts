import type { CheckpointAttributionScope } from './checkpointAttributionScope.js';

export type ChangeEvidenceSource =
  | 'provider_native'
  | 'provider_tool'
  | 'canonical_diff_tool'
  | 'canonical_patch_tool'
  | 'scm_checkpoint'
  | 'scm_reconciled'
  | 'inferred';

/** How certain the recorded file content delta itself is. */
export type ChangeConfidence = 'exact' | 'strong' | 'best_effort';

/**
 * How certain it is that this Session or turn produced the change. Exact content evidence does not
 * imply exact authorship: a checkpoint delta can be byte-exact while overlapping writers make
 * authorship uncertain.
 */
export type SessionAttributionConfidence =
  | 'session_exact'
  | 'session_likely'
  | 'session_possible'
  | 'unknown';

export type SessionAttributionReason =
  | 'provider_correlated'
  | 'canonical_tool_correlated'
  | 'checkpoint_no_happier_overlap_observed'
  | 'checkpoint_overlap_observed'
  | 'workspace_touched_path'
  | 'unavailable';

export type SessionChangeAttribution = Readonly<{
  confidence: SessionAttributionConfidence;
  reason: SessionAttributionReason;
}>;

/**
 * Whether another Happier checkpoint capture interval was observed on the same resolved repository
 * root. `not_observed` is bounded process-local evidence, never proof of exclusive access.
 */
export type CheckpointOverlapObservation = 'observed' | 'not_observed' | 'unknown';

export type FileChangeKind =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'unknown';

export type FileChangeEvidenceStats = Readonly<{
  oldTextBytes?: number;
  newTextBytes?: number;
  unifiedDiffBytes?: number;
  addedLines?: number;
  removedLines?: number;
}>;

export type FileChangeEvidence = Readonly<{
  filePath: string;
  previousFilePath?: string | null;
  changeKind: FileChangeKind;
  unifiedDiff?: string | null;
  oldText?: string | null;
  newText?: string | null;
  binary?: boolean;
  source: ChangeEvidenceSource;
  confidence: ChangeConfidence;
  provider: string;
  agentTurnId?: string | null;
  providerMessageId?: string | null;
  description?: string | null;
  /** The retained content is a bounded projection rather than the complete observed bytes. */
  truncated?: true;
  stats?: FileChangeEvidenceStats;
}>;

export type RepositoryCheckpointReceiptId =
  | 'checkpoint.captured'
  | 'checkpoint.aliased'
  | 'checkpoint.finalized'
  | 'checkpoint.diff_computed'
  | 'checkpoint.cleanup_pruned';

export type RepositoryCheckpointReceipt = Readonly<{
  id: RepositoryCheckpointReceiptId;
  ref?: string;
  commitSha?: string;
  treeSha?: string;
  phase?: 'message-start' | 'turn-start' | 'turn-final';
  prunedCount?: number;
  refs?: readonly string[];
}>;

export type RepositoryCheckpointTurnMetadata = Readonly<{
  version: 1;
  scopeId: string;
  startRef?: string;
  finalRef?: string;
  baseRefSource: 'turn_start' | 'message_start' | 'previous_final' | 'unavailable';
  contentConfidence: 'exact' | 'unavailable';
  attributionScope: CheckpointAttributionScope;
  receipts: readonly RepositoryCheckpointReceipt[];
  unavailableReason?: string;
}>;

/** Exact checkpoint/commit content correspondence, never an authorship claim. */
export type RepositoryCheckpointCommitEvidence = Readonly<{
  sessionId: string;
  turnId: string;
  repositoryKey: string;
  checkpointRef: string;
  checkpointCommitSha: string;
  commitSha: string;
  attributionScope: CheckpointAttributionScope;
}>;

export type TurnChangeSet = Readonly<{
  sessionId: string;
  turnId: string;
  seqRange: Readonly<{
    startSeqInclusive: number;
    endSeqInclusive: number;
  }>;
  status: 'completed' | 'aborted' | 'interrupted' | 'unknown';
  files: readonly FileChangeEvidence[];
  provider: string;
  derivedAt: number;
  repositoryCheckpoint?: RepositoryCheckpointTurnMetadata;
}>;

export type SessionChangeSetFile = Readonly<FileChangeEvidence & {
  turns: readonly string[];
  attribution: SessionChangeAttribution;
  checkpointOverlap: CheckpointOverlapObservation;
}>;

export type ChangeSetConfidenceSummary = Readonly<{
  source: ChangeEvidenceSource | 'unavailable';
  confidence: ChangeConfidence | 'unavailable';
  attribution: SessionChangeAttribution;
  checkpointOverlap: CheckpointOverlapObservation;
}>;

export type SessionChangeSet = Readonly<{
  sessionId: string;
  turns: readonly TurnChangeSet[];
  files: readonly SessionChangeSetFile[];
  rolledBackTurnIds: readonly string[];
  confidenceSummary: ChangeSetConfidenceSummary;
}>;

export type SessionWorkingTreeMatchedFile = Readonly<{
  filePath: string;
  repositoryPath: string;
  sessionChange: SessionChangeSetFile;
  repositoryEntry: {
    path: string;
    previousPath: string | null;
    kind: string;
  };
}>;

export type SessionWorkingTreeProjection = Readonly<{
  sessionId: string;
  matchedFiles: readonly SessionWorkingTreeMatchedFile[];
  unmatchedSessionFiles: readonly SessionChangeSetFile[];
  repositoryOnlyFiles: readonly {
    path: string;
    previousPath: string | null;
    kind: string;
  }[];
  projectionReliability: ChangeConfidence;
}>;

/** Raw repository facts supplied by a workspace-wide touched-path fallback adapter. */
export type WorkspaceTouchedFileEvidence = Readonly<{
  filePath: string;
  changeKind: FileChangeKind;
  binary?: boolean;
}>;
