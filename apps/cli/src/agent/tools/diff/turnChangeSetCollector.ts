import { splitUnifiedDiffByFile, type ChangeConfidence, type ChangeEvidenceSource, type FileChangeEvidence, type FileChangeKind, type RepositoryCheckpointTurnMetadata, type TurnChangeSet } from '@happier-dev/protocol';
import { deriveCanonicalPatchFileDiffs } from '@happier-dev/protocol/tools/v2';

import { TurnDiffEmitter } from './turnDiffEmitter';

type FileMetadata = Readonly<{
    source: ChangeEvidenceSource;
    confidence: ChangeConfidence;
    previousFilePath?: string | null;
    changeKind?: FileChangeKind;
    binary?: boolean;
    provider?: string;
    agentTurnId?: string | null;
    providerMessageId?: string | null;
    description?: string | null;
}>;

type TurnMetadata = Readonly<{
    sessionId?: string;
    turnId?: string;
    seqRange?: TurnChangeSet['seqRange'];
    status?: TurnChangeSet['status'];
    provider?: string;
    repositoryCheckpoint?: RepositoryCheckpointTurnMetadata;
}>;

function stripDiffPrefix(path: string): string {
    return path.replace(/^(a|b)\//, '');
}

function extractFilePathFromDiffBlock(block: string): string | null {
    const lines = block.split('\n');
    for (const line of lines) {
        if (line.startsWith('diff --git ')) {
            const parts = line.split(/\s+/).slice(2);
            const candidate = parts[1] ?? '';
            if (candidate && candidate !== '/dev/null') return stripDiffPrefix(candidate);
        }
        if (line.startsWith('+++ ')) {
            const candidate = (line.slice('+++ '.length).split('\t')[0] ?? '').trim();
            if (candidate && candidate !== '/dev/null') return stripDiffPrefix(candidate);
        }
        if (line.startsWith('--- ')) {
            const candidate = (line.slice('--- '.length).split('\t')[0] ?? '').trim();
            if (candidate && candidate !== '/dev/null') return stripDiffPrefix(candidate);
        }
    }
    return null;
}

function deriveFilesFromUnifiedSnapshot(params: Readonly<{
    unifiedDiff: string;
    provider: string;
    source: ChangeEvidenceSource;
    confidence: ChangeConfidence;
}>): FileChangeEvidence[] {
    return splitUnifiedDiffByFile(params.unifiedDiff)
        .map((block, index) => {
            const filePath = extractFilePathFromDiffBlock(block) ?? `unknown:${index + 1}`;
            return {
                filePath,
                changeKind: 'modified' as const,
                unifiedDiff: block,
                source: params.source,
                confidence: params.confidence,
                provider: params.provider,
            };
        });
}

export class TurnChangeSetCollector {
    private readonly provider: string;
    private readonly emitter: TurnDiffEmitter;
    private readonly metadataByFilePath = new Map<string, FileMetadata>();
    private snapshotMetadata: FileMetadata | null = null;
    private turnMetadata: TurnMetadata | null = null;

    constructor(params: Readonly<{ provider: string; snapshotUnifiedDiff?: boolean }>) {
        this.provider = params.provider;
        this.emitter = new TurnDiffEmitter({ snapshotUnifiedDiff: params.snapshotUnifiedDiff });
    }

    beginTurn(): void {
        this.metadataByFilePath.clear();
        this.snapshotMetadata = null;
        this.turnMetadata = null;
        this.emitter.beginTurn();
    }

    observeCanonicalDiff(params: Readonly<{
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
        turnMetadata?: TurnMetadata;
    }>): void {
        this.turnMetadata = params.turnMetadata ?? null;
        for (const file of params.files) {
            this.metadataByFilePath.set(file.filePath, {
                source: file.source ?? 'provider_tool',
                confidence: file.confidence ?? 'exact',
                previousFilePath: file.previousFilePath ?? null,
                changeKind: file.changeKind,
                binary: file.binary,
                provider: file.provider,
                agentTurnId: file.agentTurnId ?? null,
                providerMessageId: file.providerMessageId ?? null,
                description: file.description ?? null,
            });
            if (typeof file.oldText === 'string' && typeof file.newText === 'string') {
                this.emitter.observeTextDiff({
                    filePath: file.filePath,
                    oldText: file.oldText,
                    newText: file.newText,
                    ...(file.description ? { description: file.description } : {}),
                });
                continue;
            }
            if (typeof file.unifiedDiff === 'string' && file.unifiedDiff.trim().length > 0) {
                this.emitter.observeUnifiedDiff({
                    filePath: file.filePath,
                    unifiedDiff: file.unifiedDiff,
                    ...(file.description ? { description: file.description } : {}),
                });
                continue;
            }
            this.emitter.observeUnifiedDiff({
                filePath: file.filePath,
                unifiedDiff: `diff --git a/${file.filePath} b/${file.filePath}`,
                ...(file.description ? { description: file.description } : {}),
            });
        }
    }

    observeTextDiff(params: Readonly<{
        filePath: string;
        oldText: string;
        newText: string;
        source: ChangeEvidenceSource;
        confidence: ChangeConfidence;
        description?: string;
    }>): void {
        this.metadataByFilePath.set(params.filePath, {
            source: params.source,
            confidence: params.confidence,
            description: params.description ?? null,
        });
        this.emitter.observeTextDiff({
            filePath: params.filePath,
            oldText: params.oldText,
            newText: params.newText,
            ...(params.description ? { description: params.description } : {}),
        });
    }

    observeUnifiedDiff(params: Readonly<{
        filePath: string;
        unifiedDiff: string;
        source: ChangeEvidenceSource;
        confidence: ChangeConfidence;
        description?: string;
    }>): void {
        this.metadataByFilePath.set(params.filePath, {
            source: params.source,
            confidence: params.confidence,
            description: params.description ?? null,
        });
        this.emitter.observeUnifiedDiff({
            filePath: params.filePath,
            unifiedDiff: params.unifiedDiff,
            ...(params.description ? { description: params.description } : {}),
        });
    }

    observeUnifiedDiffSnapshot(params: Readonly<{
        unifiedDiff: string;
        source: ChangeEvidenceSource;
        confidence: ChangeConfidence;
    }>): void {
        this.snapshotMetadata = {
            source: params.source,
            confidence: params.confidence,
        };
        this.emitter.observeUnifiedDiffSnapshot({ unifiedDiff: params.unifiedDiff });
    }

    observePatchChanges(params: Readonly<{
        changes: Record<string, unknown>;
        source: ChangeEvidenceSource;
        confidence: ChangeConfidence;
    }>): void {
        const files = deriveCanonicalPatchFileDiffs({ changes: params.changes });
        if (files.length === 0) {
            for (const filePath of Object.keys(params.changes)) {
                if (!filePath.trim()) continue;
                this.metadataByFilePath.set(filePath, {
                    source: params.source,
                    confidence: params.confidence,
                });
                this.emitter.observeUnifiedDiff({
                    filePath,
                    unifiedDiff: `diff --git a/${filePath} b/${filePath}`,
                });
            }
            return;
        }

        for (const file of files) {
            const filePath = file.filePath;
            this.metadataByFilePath.set(filePath, {
                source: params.source,
                confidence: params.confidence,
            });
            if (typeof file.oldText === 'string' && typeof file.newText === 'string') {
                this.emitter.observeTextDiff({
                    filePath,
                    oldText: file.oldText,
                    newText: file.newText,
                });
                continue;
            }
            if (typeof file.unifiedDiff === 'string' && file.unifiedDiff.trim().length > 0) {
                this.emitter.observeUnifiedDiff({
                    filePath,
                    unifiedDiff: file.unifiedDiff,
                });
                continue;
            }
            this.emitter.observeUnifiedDiff({
                filePath,
                unifiedDiff: `diff --git a/${filePath} b/${filePath}`,
            });
        }
    }

    flushTurn(params: Readonly<{
        sessionId: string;
        turnId: string;
        seqRange: { startSeqInclusive: number; endSeqInclusive: number };
        status: TurnChangeSet['status'];
    }>): TurnChangeSet | null {
        const output = this.emitter.flushTurn();
        const files: FileChangeEvidence[] = [];

        if (Array.isArray(output.files) && output.files.length > 0) {
            for (const file of output.files) {
                const filePath = typeof file.file_path === 'string' ? file.file_path : null;
                if (!filePath) continue;
                const metadata = this.metadataByFilePath.get(filePath);
                files.push({
                    filePath,
                    previousFilePath: metadata?.previousFilePath ?? null,
                    changeKind: metadata?.changeKind ?? 'modified',
                    unifiedDiff: typeof file.unified_diff === 'string' ? file.unified_diff : undefined,
                    oldText: typeof file.oldText === 'string' ? file.oldText : undefined,
                    newText: typeof file.newText === 'string' ? file.newText : undefined,
                    binary: metadata?.binary,
                    source: metadata?.source ?? 'provider_tool',
                    confidence: metadata?.confidence ?? 'strong',
                    provider: metadata?.provider ?? this.provider,
                    agentTurnId: metadata?.agentTurnId ?? null,
                    providerMessageId: metadata?.providerMessageId ?? null,
                    description: metadata?.description ?? null,
                });
            }
        } else if (typeof output.unified_diff === 'string' && output.unified_diff.trim().length > 0) {
            files.push(...deriveFilesFromUnifiedSnapshot({
                unifiedDiff: output.unified_diff,
                provider: this.provider,
                source: this.snapshotMetadata?.source ?? 'provider_native',
                confidence: this.snapshotMetadata?.confidence ?? 'strong',
            }));
        }

        this.metadataByFilePath.clear();
        this.snapshotMetadata = null;
        const turnMetadata = this.turnMetadata;
        this.turnMetadata = null;

        if (files.length === 0 && !turnMetadata?.repositoryCheckpoint) return null;

        return {
            sessionId: turnMetadata?.sessionId ?? params.sessionId,
            turnId: turnMetadata?.turnId ?? params.turnId,
            seqRange: turnMetadata?.seqRange ?? params.seqRange,
            status: turnMetadata?.status ?? params.status,
            files,
            provider: turnMetadata?.provider ?? this.provider,
            derivedAt: Date.now(),
            ...(turnMetadata?.repositoryCheckpoint ? { repositoryCheckpoint: turnMetadata.repositoryCheckpoint } : {}),
        };
    }
}
