import { extractCanonicalDiffFiles, readTurnChangeToolMetadataFromToolCall } from '@happier-dev/protocol/sessions/messages/canonicalTurnDiffTool';

import { buildScmFileStatusFromChangeEvidence } from '@/scm/scmEvidenceFileStatus';
import type { ScmFileStatus } from '@/scm/scmStatusFiles';

export type TurnChangesFromDiffTool = Readonly<{
    turnId: string;
    files: readonly ScmFileStatus[];
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
    for (const evidence of extractCanonicalDiffFiles(tool.input, metadata)) {
        byPath.set(evidence.filePath, buildScmFileStatusFromChangeEvidence(evidence));
    }
    return { turnId: metadata.turnId, files: Array.from(byPath.values()) };
}
