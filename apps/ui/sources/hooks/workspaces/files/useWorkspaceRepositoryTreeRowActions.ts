import * as React from 'react';

import { Modal } from '@/modal';
import { t } from '@/text';
import { resolveKeepBothTargetPath } from '@/sync/domains/files/resolveKeepBothTargetPath';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { workspaceDeletePath, workspaceRenamePath, workspaceStatFile } from '@/sync/ops/workspaceFileSystem';
import { setClipboardStringSafe } from '@/utils/ui/clipboard';

import type { RepositoryTreeRowActionMenuItemId } from '@/components/workspaces/files/repositoryTree/RepositoryTreeRowActionsMenu';
import { deletePathConfirm } from '@/components/workspaces/files/repositoryTree/deletePathConfirm';
import { renamePathPrompt } from '@/components/workspaces/files/repositoryTree/renamePathPrompt';
import { showRenameConflictResolutionDialog } from '@/components/workspaces/files/repositoryTree/showRenameConflictResolutionDialog';

type RepositoryTreeNodeLike = Readonly<{
    path: string;
    type: 'file' | 'directory';
}>;

function isPathWithinDirectory(path: string, directoryPath: string): boolean {
    const cleanDir = directoryPath.replace(/\/+$/g, '');
    if (!cleanDir) return false;
    if (path === cleanDir) return true;
    return path.startsWith(`${cleanDir}/`);
}

function remapExpandedPathsAfterRename(input: Readonly<{
    expandedPaths: readonly string[];
    from: string;
    to: string;
}>): string[] {
    const from = input.from.replace(/\/+$/g, '');
    const to = input.to.replace(/\/+$/g, '');
    if (!from || !to) return [...input.expandedPaths];
    if (from === to) return [...input.expandedPaths];

    const mapped: string[] = [];
    for (const raw of input.expandedPaths) {
        const path = typeof raw === 'string' ? raw.replace(/\/+$/g, '') : '';
        if (!path) continue;
        if (path === from) {
            mapped.push(to);
            continue;
        }
        if (path.startsWith(`${from}/`)) {
            mapped.push(`${to}${path.slice(from.length)}`);
            continue;
        }
        mapped.push(path);
    }
    return mapped;
}

function removeExpandedPathsUnderDirectory(expandedPaths: readonly string[], directoryPath: string): string[] {
    const cleanDir = directoryPath.replace(/\/+$/g, '');
    if (!cleanDir) return [...expandedPaths];
    return expandedPaths.filter((p) => !isPathWithinDirectory(String(p), cleanDir));
}

export function useWorkspaceRepositoryTreeRowActions(params: Readonly<{
    workspaceScope: WorkspaceScopeBase | null;
    writeActionsEnabled: boolean;
    expandedPaths: readonly string[];
    onExpandedPathsChange: (paths: string[]) => void;
    onRequestRefresh?: (() => void) | null;
    onRequestDownload?: ((params: Readonly<{ path: string; asZip: boolean }>) => Promise<{ ok: true } | { ok: false; error: string; canceled?: true }>) | null;
}>): Readonly<{
    onSelectRowMenuItem: (node: RepositoryTreeNodeLike, itemId: RepositoryTreeRowActionMenuItemId) => Promise<void>;
}> {
    const {
        expandedPaths,
        onExpandedPathsChange,
        onRequestDownload,
        onRequestRefresh,
        workspaceScope,
        writeActionsEnabled,
    } = params;
    const expandedPathsRef = React.useRef(expandedPaths);
    React.useEffect(() => {
        expandedPathsRef.current = expandedPaths;
    }, [expandedPaths]);

    const isDestinationAlreadyExistsError = React.useCallback((error: string | undefined): boolean => {
        return typeof error === 'string' && /destination already exists/i.test(error);
    }, []);

    const onSelectRowMenuItem = React.useCallback(async (node: RepositoryTreeNodeLike, itemId: RepositoryTreeRowActionMenuItemId) => {
        if (itemId === 'repository-tree-menuitem-copy-path') {
            const ok = await setClipboardStringSafe(node.path);
            Modal.alert(
                ok ? t('common.copied') : t('common.error'),
                ok
                    ? t('items.copiedToClipboard', { label: t('common.path') })
                    : t('items.failedToCopyToClipboard'),
            );
            return;
        }

        if (itemId === 'repository-tree-menuitem-rename') {
            if (!writeActionsEnabled) return;
            let nextPath = await renamePathPrompt({ currentPath: node.path });
            if (!nextPath) return;

            const target = workspaceScope;
            if (!target) {
                Modal.alert(t('common.error'), t('files.repositoryTree.rename.failed'));
                return;
            }

            let result = await workspaceRenamePath(target, { from: node.path, to: nextPath, overwrite: undefined });
            if (!result.success && isDestinationAlreadyExistsError(result.error)) {
                const strategy = await showRenameConflictResolutionDialog({ path: nextPath });
                if (strategy === 'cancel') return;

                if (strategy === 'replace') {
                    result = await workspaceRenamePath(target, { from: node.path, to: nextPath, overwrite: true });
                } else {
                    nextPath = await resolveKeepBothTargetPath({
                        desiredPath: nextPath,
                        maxAttempts: 50,
                        pathExists: async (candidatePath) => {
                            const stat = await workspaceStatFile(target, candidatePath);
                            return !stat.success || stat.exists === true;
                        },
                    });
                    result = await workspaceRenamePath(target, { from: node.path, to: nextPath, overwrite: undefined });
                }
            }

            if (!result.success) {
                Modal.alert(t('common.error'), result.error || t('files.repositoryTree.rename.failed'));
                return;
            }

            if (node.type === 'directory') {
                const nextExpanded = remapExpandedPathsAfterRename({
                    expandedPaths: expandedPathsRef.current,
                    from: node.path,
                    to: nextPath,
                });
                onExpandedPathsChange(nextExpanded);
            }
            onRequestRefresh?.();
            return;
        }

        if (itemId === 'repository-tree-menuitem-delete') {
            if (!writeActionsEnabled) return;

            const confirm = await deletePathConfirm({ path: node.path, kind: node.type });
            if (!confirm.confirmed) return;

            const target = workspaceScope;
            if (!target) {
                Modal.alert(t('common.error'), t('files.repositoryTree.delete.failed'));
                return;
            }

            const result = await workspaceDeletePath(target, { path: node.path, recursive: confirm.recursive });
            if (!result.success) {
                Modal.alert(t('common.error'), result.error || t('files.repositoryTree.delete.failed'));
                return;
            }

            if (node.type === 'directory') {
                onExpandedPathsChange(removeExpandedPathsUnderDirectory(expandedPathsRef.current, node.path));
            }
            onRequestRefresh?.();
            return;
        }

        if (itemId === 'repository-tree-menuitem-download' || itemId === 'repository-tree-menuitem-zip') {
            if (!onRequestDownload) return;
            const res = await onRequestDownload({ path: node.path, asZip: itemId === 'repository-tree-menuitem-zip' });
            if (!res.ok && res.canceled !== true) {
                Modal.alert(t('common.error'), res.error);
            }
        }
    }, [
        isDestinationAlreadyExistsError,
        onExpandedPathsChange,
        onRequestDownload,
        onRequestRefresh,
        workspaceScope,
        writeActionsEnabled,
    ]);

    return React.useMemo(() => ({ onSelectRowMenuItem }), [onSelectRowMenuItem]);
}
