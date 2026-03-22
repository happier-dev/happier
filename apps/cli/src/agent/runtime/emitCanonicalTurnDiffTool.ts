import { randomUUID } from 'node:crypto';

import type { TurnChangeSet, ToolNormalizationProtocol } from '@happier-dev/protocol';

import { buildTurnChangeSetDiffInput } from '@/agent/tools/diff/buildTurnChangeSetDiffInput';

export function emitCanonicalTurnDiffTool(params: Readonly<{
    turnChangeSet: TurnChangeSet;
    protocol: ToolNormalizationProtocol;
    rawToolName: string;
    sendToolCall: (params: { toolName: string; input: unknown; callId?: string }) => string;
    sendToolResult: (params: { callId: string; output: unknown }) => void;
}>): string {
    const callId = params.sendToolCall({
        toolName: 'Diff',
        input: buildTurnChangeSetDiffInput({
            turnChangeSet: params.turnChangeSet,
            protocol: params.protocol,
            rawToolName: params.rawToolName,
        }),
        callId: randomUUID(),
    });
    params.sendToolResult({
        callId,
        output: { status: 'completed' },
    });
    return callId;
}
