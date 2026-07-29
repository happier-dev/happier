import type { TurnChangeSet } from '@happier-dev/protocol';
import type { ToolNormalizationProtocol } from '@happier-dev/protocol';

import { boundTurnDiffFiles, type TurnDiffFileEntry } from './boundTurnDiffFiles';
import { buildSessionChangeToolMetadata } from './sessionChangeToolMetadata';
import { resolveTurnDiffFileBudgetBytes, resolveTurnDiffTurnBudgetBytes } from './turnDiffPayloadBudget';

export function buildTurnChangeSetDiffInput(params: Readonly<{
    turnChangeSet: TurnChangeSet;
    protocol: ToolNormalizationProtocol;
    rawToolName: string;
    fileBudgetBytes?: number;
    turnBudgetBytes?: number;
}>): Record<string, unknown> {
    const rawFiles: TurnDiffFileEntry[] = params.turnChangeSet.files.map((file) => ({
        file_path: file.filePath,
        change_kind: file.changeKind,
        ...(file.previousFilePath ? { previous_file_path: file.previousFilePath } : {}),
        ...(typeof file.binary === 'boolean' ? { binary: file.binary } : {}),
        source: file.source,
        confidence: file.confidence,
        provider: file.provider,
        ...(file.agentTurnId ? { provider_turn_id: file.agentTurnId } : {}),
        ...(file.providerMessageId ? { provider_message_id: file.providerMessageId } : {}),
        ...(typeof file.unifiedDiff === 'string' && file.unifiedDiff.trim().length > 0 ? { unified_diff: file.unifiedDiff } : {}),
        ...(typeof file.oldText === 'string' ? { oldText: file.oldText } : {}),
        ...(typeof file.newText === 'string' ? { newText: file.newText } : {}),
        ...(typeof file.description === 'string' && file.description.trim().length > 0 ? { description: file.description } : {}),
    }));
    const bounded = boundTurnDiffFiles({
        files: rawFiles,
        fileBudgetBytes: resolveTurnDiffFileBudgetBytes(params.fileBudgetBytes),
        turnBudgetBytes: resolveTurnDiffTurnBudgetBytes(params.turnBudgetBytes),
    });

    return {
        files: bounded.files,
        _happier: {
            ...buildSessionChangeToolMetadata({
                turnChangeSet: params.turnChangeSet,
                protocol: params.protocol,
                rawToolName: params.rawToolName,
            }),
            ...(bounded.truncatedFileCount > 0 ? { turnDiffTruncatedFileCount: bounded.truncatedFileCount } : {}),
        },
    };
}
