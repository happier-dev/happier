import { extractCanonicalDiffFiles, readTurnChangeToolMetadataFromToolCall } from '@happier-dev/protocol/sessions/messages/canonicalTurnDiffTool';
import { describeHunkRange, parseUnifiedDiffHunks } from '@happier-dev/protocol/diff/hunks';

import { buildScmFileStatusFromChangeEvidence } from '@/scm/scmEvidenceFileStatus';
import type { ScmFileStatus } from '@/scm/scmStatusFiles';
import type { ReviewCommentAnchor } from '@/sync/domains/input/reviewComments/reviewCommentTypes';
import { deriveFileChangeDiff } from '@/sync/domains/session/changes/derivation/deriveFileChangeDiff';

export type TurnChangesFromDiffTool = Readonly<{
    turnId: string;
    files: readonly ScmFileStatus[];
    /** Checkpoint projection publishes one shared repository-relative identity, including provider evidence. */
    repositoryRelative: boolean;
    firstHunkAnchors: Readonly<Record<string, ReviewCommentAnchor>>;
}>;

/**
 * The turn-end Diff row (the host's recap of a turn's changes, `sessionChangeScope: 'turn'`) as the
 * turn's files, in the order the turn reported them; a path reported twice keeps its last evidence.
 * Any other tool, or a Diff without turn identity, is not a turn's changes and returns null.
 */
export function readTurnChangesFromDiffTool(tool: Readonly<{ name?: string; input?: unknown; result?: unknown }>): TurnChangesFromDiffTool | null {
    if (tool.name !== 'Diff') return null;
    const metadata = readTurnChangeToolMetadataFromToolCall(tool);
    if (!metadata) return null;
    const byPath = new Map<string, ScmFileStatus>();
    const anchorsByPath = new Map<string, ReviewCommentAnchor>();
    for (const evidence of extractCanonicalDiffFiles(tool.input, metadata)) {
        const diff = deriveFileChangeDiff(evidence);
        byPath.set(evidence.filePath, buildScmFileStatusFromChangeEvidence(evidence, diff));
        const firstHunk = diff ? parseUnifiedDiffHunks(diff)[0] : undefined;
        const range = firstHunk ? describeHunkRange(firstHunk) : null;
        if (range && range.startLine > 0) {
            anchorsByPath.set(evidence.filePath, { kind: 'diffLine', startLine: range.startLine,
                side: range.side === 'new' ? 'after' : 'before',
                newLine: range.side === 'new' ? range.startLine : null,
                oldLine: range.side === 'old' ? range.startLine : null });
        } else anchorsByPath.delete(evidence.filePath);
    }
    return { turnId: metadata.turnId, repositoryRelative: metadata.repositoryCheckpoint !== undefined, files: Array.from(byPath.values()), firstHunkAnchors: Object.fromEntries(anchorsByPath) };
}
