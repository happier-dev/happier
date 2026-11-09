import type { TurnChangeSet, ToolNormalizationSourceV3 } from '@happier-dev/protocol';

import { buildTurnChangeSetDiffInput } from '@/agent/tools/diff/buildTurnChangeSetDiffInput';
import { resolveCanonicalTurnDiffCallId } from '@/agent/tools/diff/canonicalTurnDiffIdentity';

export function emitCanonicalTurnDiffTool(params: Readonly<{
    turnChangeSet: TurnChangeSet;
    source: ToolNormalizationSourceV3;
    rawToolName: string;
    sendToolCall: (params: { toolName: string; input: unknown; callId?: string }) => string;
    sendToolResult: (params: { callId: string; output: unknown }) => void;
}>): string | null {
    // A zero-file change set never becomes a transcript row, even when it carries
    // repository-checkpoint metadata: a titled "Turn Diff" recap for a turn that
    // changed nothing, or that ran outside a repository, is noise on the primary
    // surface. The checkpoint lifecycle owner asserts that absence for every
    // unavailable and empty checkpoint outcome.
    if (params.turnChangeSet.files.length === 0) {
        return null;
    }

    const input = buildTurnChangeSetDiffInput({
        turnChangeSet: params.turnChangeSet,
        source: params.source,
        rawToolName: params.rawToolName,
    });
    const callId = params.sendToolCall({
        toolName: 'Diff',
        input,
        callId: resolveCanonicalTurnDiffCallId(input),
    });
    params.sendToolResult({
        callId,
        output: { status: 'completed' },
    });
    return callId;
}
