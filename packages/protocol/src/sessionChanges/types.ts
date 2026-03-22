export type ChangeEvidenceSource =
  | 'provider_native'
  | 'provider_tool'
  | 'canonical_diff_tool'
  | 'canonical_patch_tool'
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
  providerTurnId?: string | null;
  providerMessageId?: string | null;
  description?: string | null;
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
