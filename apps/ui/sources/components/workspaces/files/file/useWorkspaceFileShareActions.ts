import { useMemo } from 'react';
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
import { desktopHostKind, desktopHostPlatform, invokeDesktopHost } from '@/utils/platform/desktopHost';
import { useThisComputerMachineId } from '@/components/machines/add/useMachineAddPaths';
import { resolveMachineControlTargetForSessionFromState } from '@/sync/domains/session/resolveMachineTargetForSessionFromState';
import { storage } from '@/sync/domains/state/storage';
import type { OriginalFileActions } from './fileMenus';
import { canOpenFileInDefaultApp } from '@/sync/runtime/files/saveFileBytes';
import { resolveFileViewerKind } from '@/scm/utils/filePresentation';
import { Modal } from '@/modal';
import { t } from '@/text';
import { writeClipboardStringFromUi } from '@/utils/ui/clipboard';

type FileShareCallback = () => void | Promise<void>;

async function reportFileShareFailure(run: () => Promise<void>): Promise<void> {
    try {
        await run();
    } catch (error) {
        const message = typeof error === 'string' ? error : error instanceof Error ? error.message : t('errors.operationFailed');
        Modal.alert(t('common.error'), message);
    }
}

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
    const expandedRoot = input.workspaceScope ? resolveAbsolutePath(input.workspaceScope.rootPath, input.homeDir ?? undefined) : null;
    const absolutePath = expandedRoot && isAbsoluteLocalPath(normalizeLocalPathForComparison(expandedRoot) ?? '')
        ? resolveMachineAbsolutePath({ rootPath: expandedRoot, requestPath: input.path, pathKind: 'workspace_entry' })
        : null;
    const copy = (intent: FileShareClipboardIntent) => reportFileShareFailure(async () => {
        if (!execution.isCurrent()) return;
        const request = buildFileShareClipboardRequest({ relativePath: input.path, absolutePath,
            link: intent.kind === 'link' && input.linkInput ? buildWorkspaceFileLink(input.linkInput) : null,
        }, intent);
        if (!request) throw new Error(t('common.unavailable'));
        const result = await writeClipboardStringFromUi(request.input.text, execution.execute);
        if (!execution.isCurrent()) return;
        if (!result.ok) throw new Error(result.error);
    });
    const download = (action?: WorkspaceFileDownloadAction) => reportFileShareFailure(async () => {
        if (action === 'open' && !input.machineReachable) throw new Error(input.unavailableReason);
        if (!input.machineReachable && !input.cachedContent) throw new Error(input.unavailableReason);
        const result = await transfers.startDownload({ path: input.path, asZip: false,
            action,
            ...(!input.machineReachable ? { cachedContent: input.cachedContent } : {}),
        });
        if (!result.ok && !result.canceled) throw new Error(result.error);
    });
    const openSupported = canOpenFileInDefaultApp(resolveFileViewerKind({ path: input.path }).mimeType);
    const openInDefaultApp = openSupported ? () => download('open') : undefined;
    const target = input.linkInput?.target;
    const sessionId = desktopHostKind() === 'tauri' && input.entryKind !== 'directory' && target?.kind === 'session'
        ? target.sessionId : null;
    const thisComputerMachineId = useThisComputerMachineId(undefined, sessionId !== null);
    const isLocalFile = thisComputerMachineId !== null && thisComputerMachineId === input.workspaceScope?.machineId;
    const serverId = input.workspaceScope?.serverId;
    const sessionWorkspaceRoot = storage(state => {
        if (!isLocalFile || !sessionId || !serverId) return null;
        const session = resolveMachineControlTargetForSessionFromState(state, { sessionId, serverId });
        return session?.machineId === thisComputerMachineId ? session.basePath : null;
    });
    const workspaceRoot = sessionWorkspaceRoot ? resolveAbsolutePath(sessionWorkspaceRoot, input.homeDir ?? undefined) : null;
    const originalFile = useMemo<OriginalFileActions | undefined>(() => {
        if (!workspaceRoot || !absolutePath) return undefined;
        const platform = desktopHostPlatform();
        const handoff = (action: 'open' | 'reveal') => reportFileShareFailure(
            () => invokeDesktopHost<void>('desktop_handoff_workspace_file', { workspaceRoot, filePath: absolutePath, action }),
        );
        return {
            open: () => handoff('open'),
            reveal: () => handoff('reveal'),
            revealTitleKey: platform === 'macos' ? 'files.pane.menu.showInFinder'
                : platform === 'windows' ? 'files.pane.menu.showInExplorer' : 'files.pane.menu.showInFileManager',
        };
    }, [workspaceRoot, absolutePath]);
    const source = input.workspaceScope;
    const mentionInComposer = actionScope && source ? () => reportFileShareFailure(async () => {
        if (!execution.isCurrent()) return;
        await mention({ kind: 'repository-file', scope: { serverId: source.serverId, accountId: actionScope.accountId }, machineId: source.machineId,
            entryKind: input.entryKind ?? 'file',
            path: resolveMachineAbsolutePath({ rootPath: expandedRoot ?? source.rootPath, requestPath: input.path, pathKind: 'workspace_entry' }),
        }, input.path);
    }) : undefined;
    return {
        mentionInComposer, download, openInDefaultApp, originalFile, saveAsArtifact: input.onSaveAsArtifact,
        copyPath: actionScope ? (options?: Readonly<{ absolute?: boolean }>) => copy({ kind: 'path', absolute: options?.absolute }) : undefined,
        copyAbsolutePath: actionScope && absolutePath ? () => copy({ kind: 'path', absolute: true }) : undefined,
        copyLink: actionScope && input.linkInput ? () => copy({ kind: 'link' }) : undefined,
        shareFile: Platform.OS === 'android' ? () => download('share') : undefined,
        busy: transfers.downloadState.status === 'downloading',
    };
}
