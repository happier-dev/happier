import { splitUnifiedDiffByFile, type ChangeConfidence, type ChangeEvidenceSource, type FileChangeEvidence, type TurnChangeSet } from '@happier-dev/protocol';

import { TurnDiffEmitter } from './turnDiffEmitter';

type FileMetadata = Readonly<{
    source: ChangeEvidenceSource;
    confidence: ChangeConfidence;
    description?: string | null;
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

    constructor(params: Readonly<{ provider: string; snapshotUnifiedDiff?: boolean }>) {
        this.provider = params.provider;
        this.emitter = new TurnDiffEmitter({ snapshotUnifiedDiff: params.snapshotUnifiedDiff });
    }

    beginTurn(): void {
        this.metadataByFilePath.clear();
        this.snapshotMetadata = null;
        this.emitter.beginTurn();
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
                    changeKind: 'modified',
                    unifiedDiff: typeof file.unified_diff === 'string' ? file.unified_diff : undefined,
                    oldText: typeof file.oldText === 'string' ? file.oldText : undefined,
                    newText: typeof file.newText === 'string' ? file.newText : undefined,
                    source: metadata?.source ?? 'provider_tool',
                    confidence: metadata?.confidence ?? 'strong',
                    provider: this.provider,
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

        if (files.length === 0) return null;

        return {
            sessionId: params.sessionId,
            turnId: params.turnId,
            seqRange: params.seqRange,
            status: params.status,
            files,
            provider: this.provider,
            derivedAt: Date.now(),
        };
    }
}
