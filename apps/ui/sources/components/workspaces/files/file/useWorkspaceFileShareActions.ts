import { Platform } from 'react-native';
import type { ComposerRefV1 } from '@happier-dev/protocol/plugins/ui/composerRef';
import type { EntityDragScopeV1 } from '@happier-dev/protocol/plugins/ui';
import type { WorkspaceFileOpenInput } from '@happier-dev/protocol/actions/workspaceActionFamily';

import { useWorkspaceFileTransfers, type WorkspaceFileCachedContent, type WorkspaceFileDownloadAction } from '@/hooks/workspaces/transfers/useWorkspaceFileTransfers';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import type { FileSuggestionScope } from '@/sync/domains/input/suggestionFile';
import { resolveMachineAbsolutePath } from '@/sync/domains/fileSystem/resolveMachineAbsolutePath';
import { resolveAbsolutePath } from '@/utils/path/pathUtils';
import { isAbsoluteLocalPath, normalizeLocalPathForComparison } from '@/utils/path/resolvePathRelativeToRoot';
import { buildWorkspaceFileLink } from '@/utils/url/sessionFileDeepLink';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { useEntityComposerMention } from '@/components/ui/treeDragDrop/useEntityComposerMention';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { buildFileShareClipboardRequest, resolveFileShareActionScope, type FileShareClipboardIntent } from './fileShareClipboard';
import { canOpenFileInDefaultApp } from '@/sync/runtime/files/saveFileBytes';
import { Modal } from '@/modal';
import { t } from '@/text';

type FileShareCallback = () => void | Promise<void>;

export type WorkspaceFileShareActionsInput = Readonly<{
    workspaceScope: WorkspaceScopeBase | null;
    path: string;
    entryKind?: 'file' | 'directory';
    actionScope?: ServerAccountScope | null;
    linkInput?: WorkspaceFileOpenInput;
    homeDir?: string | null;
    machineReachable: boolean;
    unavailableReason: string;
    cachedContent?: WorkspaceFileCachedContent | null;
    composer?: Readonly<{ scope: EntityDragScopeV1; ref: ComposerRefV1; workspace: FileSuggestionScope | null }> | null;
    onSaveAsArtifact?: FileShareCallback;
}>;

/** Supplies behaviour to the canonical file menu; platform and menu presentation stay separate. */
export function useWorkspaceFileShareActions(input: WorkspaceFileShareActionsInput) {
    const mention = useEntityComposerMention();
    const transfers = useWorkspaceFileTransfers({ workspaceScope: input.workspaceScope });
    const actionScope = resolveFileShareActionScope(input.actionScope, input.composer?.scope);
    const execution = useMountedActionExecution(actionScope, { retainInvocation: true });
    const report = async (run: () => Promise<void>) => {
        try { await run(); }
        catch (error) { Modal.alert(t('common.error'), error instanceof Error ? error.message : t('errors.operationFailed')); }
    };
    const expandedRoot = input.workspaceScope ? resolveAbsolutePath(input.workspaceScope.rootPath, input.homeDir ?? undefined) : null;
    const absolutePath = expandedRoot && isAbsoluteLocalPath(normalizeLocalPathForComparison(expandedRoot) ?? '')
        ? resolveMachineAbsolutePath({ rootPath: expandedRoot, requestPath: input.path, pathKind: 'workspace_entry' })
        : null;
    const copy = (intent: FileShareClipboardIntent) => report(async () => {
        if (!execution.isCurrent()) return;
        const request = buildFileShareClipboardRequest({ relativePath: input.path, absolutePath,
            link: intent.kind === 'link' && input.linkInput ? buildWorkspaceFileLink(input.linkInput) : null,
        }, intent);
        if (!request) throw new Error(t('common.unavailable'));
        const result = await execution.execute(request.actionId, request.input);
        if (!execution.isCurrent()) return;
        if (!result.ok) throw new Error(result.error);
    });
    const download = (action?: WorkspaceFileDownloadAction) => report(async () => {
        if (action === 'open' && !input.machineReachable) throw new Error(input.unavailableReason);
        if (!input.machineReachable && !input.cachedContent) throw new Error(input.unavailableReason);
        const result = await transfers.startDownload({ path: input.path, asZip: false,
            action,
            ...(!input.machineReachable ? { cachedContent: input.cachedContent } : {}),
        });
        if (!result.ok && !result.canceled) throw new Error(result.error);
    });
    const openSupported = canOpenFileInDefaultApp();
    const openInDefaultApp = openSupported ? () => download('open') : undefined;
    const source = input.workspaceScope;
    const mentionInComposer = actionScope && source ? () => report(async () => {
        if (!execution.isCurrent()) return;
        await mention({ kind: 'repository-file', scope: { serverId: source.serverId, accountId: actionScope.accountId }, machineId: source.machineId,
            entryKind: input.entryKind ?? 'file',
            path: resolveMachineAbsolutePath({ rootPath: expandedRoot ?? source.rootPath, requestPath: input.path, pathKind: 'workspace_entry' }),
        }, input.path);
    }) : undefined;
    return {
        mentionInComposer, download, openInDefaultApp, saveAsArtifact: input.onSaveAsArtifact,
        copyPath: actionScope ? (options?: Readonly<{ absolute?: boolean }>) => copy({ kind: 'path', absolute: options?.absolute }) : undefined,
        copyAbsolutePath: actionScope && absolutePath ? () => copy({ kind: 'path', absolute: true }) : undefined,
        copyLink: actionScope && input.linkInput ? () => copy({ kind: 'link' }) : undefined,
        shareFile: Platform.OS === 'android' ? () => download('share') : undefined,
        busy: transfers.downloadState.status === 'downloading',
    };
}
