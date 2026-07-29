import type {
    ChangeConfidence,
    ChangeEvidenceSource,
    FileChangeKind,
    RepositoryCheckpointTurnMetadata,
    TurnChangeSet,
} from '@happier-dev/protocol';

export type NormalizedToolFileMutation = Readonly<{
    kind?: 'create' | 'update' | 'delete' | 'unknown';
    filePath?: string;
    oldText?: string | null;
    newText?: string | null;
}>;

export type NormalizedToolChangeResult = Readonly<{
    fileMutation?: NormalizedToolFileMutation | null;
}>;

export type PendingNormalizedToolChange =
    | Readonly<{
        kind: 'text-diff';
        filePath: string;
        oldText: string;
        newText: string;
        description?: string;
    }>
    | Readonly<{
        kind: 'placeholder-diff';
        filePath: string;
        description: string;
    }>
    | Readonly<{
        kind: 'canonical-diff';
        files: ReadonlyArray<Readonly<{
            filePath: string;
            previousFilePath?: string | null;
            changeKind?: FileChangeKind;
            unifiedDiff?: string;
            oldText?: string;
            newText?: string;
            binary?: boolean;
            source?: ChangeEvidenceSource;
            confidence?: ChangeConfidence;
            provider?: string;
            agentTurnId?: string | null;
            providerMessageId?: string | null;
            description?: string;
        }>>;
        turnMetadata?: Readonly<{
            sessionId?: string;
            turnId?: string;
            seqRange?: TurnChangeSet['seqRange'];
            status?: TurnChangeSet['status'];
            provider?: string;
            repositoryCheckpoint?: RepositoryCheckpointTurnMetadata;
        }>;
    }>;
