import type { ToolCall } from '@/sync/domains/messages/messageTypes';
import { readTurnChangeToolMetadataFromToolCall } from '@/sync/domains/session/changes/parsing/readTurnChangeToolMetadata';
import { t } from '@/text';

import { parseUnifiedDiffFilePaths } from './parseUnifiedDiffFilePaths';

function basenameFromPath(path: string): string {
    return path.split('/').pop() || path;
}

export function resolveDiffToolHeaderPresentation(opts: {
    tool: ToolCall;
    filePathFallback?: string | null;
}): Readonly<{
    title: string;
    subtitle: string | null;
    description: string;
}> {
    if (readTurnChangeToolMetadataFromToolCall(opts.tool) != null) {
        const recap = t('tools.desc.turnDiffRecap');
        return {
            title: t('tools.names.turnDiff'),
            subtitle: recap,
            description: recap,
        };
    }

    const filePathFallback =
        typeof opts.filePathFallback === 'string' && opts.filePathFallback.trim().length > 0
            ? opts.filePathFallback.trim()
            : null;
    if (filePathFallback) {
        return {
            title: t('tools.names.viewDiff'),
            subtitle: basenameFromPath(filePathFallback),
            description: t('tools.desc.showingDiff'),
        };
    }

    const diff = opts.tool.input?.unified_diff;
    if (typeof diff !== 'string' || !diff) {
        return {
            title: t('tools.names.viewDiff'),
            subtitle: null,
            description: t('tools.desc.showingDiff'),
        };
    }

    const paths = parseUnifiedDiffFilePaths(diff);
    const subtitle = paths.length === 1 ? basenameFromPath(paths[0]!) : null;
    return {
        title: t('tools.names.viewDiff'),
        subtitle,
        description: t('tools.desc.showingDiff'),
    };
}
