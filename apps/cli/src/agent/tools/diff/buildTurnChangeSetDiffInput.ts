import type { TurnChangeSet } from '@happier-dev/protocol';
import type { ToolNormalizationProtocol } from '@happier-dev/protocol';

import { buildSessionChangeToolMetadata } from './sessionChangeToolMetadata';

export function buildTurnChangeSetDiffInput(params: Readonly<{
    turnChangeSet: TurnChangeSet;
    protocol: ToolNormalizationProtocol;
    rawToolName: string;
}>): Record<string, unknown> {
    return {
        files: params.turnChangeSet.files.map((file) => ({
            file_path: file.filePath,
            ...(typeof file.unifiedDiff === 'string' && file.unifiedDiff.trim().length > 0 ? { unified_diff: file.unifiedDiff } : {}),
            ...(typeof file.oldText === 'string' ? { oldText: file.oldText } : {}),
            ...(typeof file.newText === 'string' ? { newText: file.newText } : {}),
            ...(typeof file.description === 'string' && file.description.trim().length > 0 ? { description: file.description } : {}),
        })),
        _happier: buildSessionChangeToolMetadata({
            turnChangeSet: params.turnChangeSet,
            protocol: params.protocol,
            rawToolName: params.rawToolName,
        }),
    };
}
