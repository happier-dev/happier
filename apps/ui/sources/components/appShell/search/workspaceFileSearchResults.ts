import type { FileSearchItem } from '@/sync/domains/fileSystem/fileSearchItem';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { leafFolderName } from '@/utils/path/pathUtils';

import {
    buildUniversalSearchScopeKey,
    UNIVERSAL_SEARCH_SOURCE_IDS,
    type UniversalSearchResult,
} from './universalSearchResult';

export function buildUniversalSearchWorkspaceFileResults(input: Readonly<{
    files: readonly FileSearchItem[];
    accountId: string;
    scope: WorkspaceScopeBase;
    workspaceRefId: string | null;
    sessionId: string | null;
    /** Changed files' line counts by path; those rows carry their +/− (lab FB2, FB2t). */
    changes?: Pick<ReadonlyMap<string, Readonly<{ added: number; removed: number }>>, 'get'>;
}>): UniversalSearchResult[] {
    const scopeKey = buildUniversalSearchScopeKey([
        input.accountId,
        input.scope.serverId,
        input.scope.machineId,
        input.scope.rootPath,
    ]);
    // Every row names its folder (lab FB2): a root file by the root's own name, so rows keep one rhythm.
    const rootName = leafFolderName(input.scope.rootPath) ?? '';
    return input.files.flatMap((file) => file.fileType === 'file' ? [{
        id: file.fullPath,
        scopeKey,
        sourceId: UNIVERSAL_SEARCH_SOURCE_IDS.files,
        kind: 'workspaceFile',
        title: file.fileName,
        subtitle: file.filePath.replace(/\/+$/, '') || rootName,
        ...(input.changes?.get(file.fullPath) ? { fileChange: input.changes.get(file.fullPath)! } : {}),
        target: {
            kind: 'workspaceFile' as const,
            scope: input.scope,
            path: file.fullPath,
            workspaceRefId: input.workspaceRefId,
            sessionId: input.sessionId,
            serverId: input.scope.serverId,
            accountId: input.accountId,
        },
    }] : []);
}
