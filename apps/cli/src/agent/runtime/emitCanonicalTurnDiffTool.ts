import type { TurnChangeSet, ToolNormalizationProtocol } from '@happier-dev/protocol';

import { buildTurnChangeSetDiffInput } from '@/agent/tools/diff/buildTurnChangeSetDiffInput';
import { resolveCanonicalTurnDiffCallId } from '@/agent/tools/diff/canonicalTurnDiffIdentity';

export function emitCanonicalTurnDiffTool(params: Readonly<{
    turnChangeSet: TurnChangeSet;
    protocol: ToolNormalizationProtocol;
    rawToolName: string;
    sendToolCall: (params: { toolName: string; input: unknown; callId?: string }) => string;
    sendToolResult: (params: { callId: string; output: unknown }) => void;
}>): string | null {
    if (params.turnChangeSet.files.length === 0) {
        return null;
    }

    const input = buildTurnChangeSetDiffInput({
        turnChangeSet: params.turnChangeSet,
        protocol: params.protocol,
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
