export type ChangeEvidenceSource =
  | 'provider_native'
  | 'provider_tool'
  | 'canonical_diff_tool'
  | 'canonical_patch_tool'
  | 'scm_checkpoint'
  | 'scm_reconciled'
  | 'inferred';

export type ChangeConfidence = 'exact' | 'strong' | 'best_effort';

export type FileChangeKind =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'unknown';

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
  attributionScope: 'exclusive_worktree' | 'shared_worktree' | 'unknown';
  receipts: readonly RepositoryCheckpointReceipt[];
  unavailableReason?: string;
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
}>;

export type ChangeSetConfidenceSummary = Readonly<{
  source: ChangeEvidenceSource;
  confidence: ChangeConfidence;
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
