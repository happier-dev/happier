import * as React from 'react';

import { Modal } from '@/modal';
import { t } from '@/text';
import { resolveKeepBothTargetPath } from '@/sync/domains/files/resolveKeepBothTargetPath';
import { sessionDeletePath, sessionRenamePath, sessionStatFile } from '@/sync/ops';
import { setClipboardStringSafe } from '@/utils/ui/clipboard';

import type { RepositoryTreeRowActionMenuItemId } from './RepositoryTreeRowActionsMenu';
import { deletePathConfirm } from './deletePathConfirm';
import { renamePathPrompt } from './renamePathPrompt';
import { showRenameConflictResolutionDialog } from './showRenameConflictResolutionDialog';

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

export function useRepositoryTreeRowActions(params: Readonly<{
    sessionId: string;
    writeActionsEnabled: boolean;
    expandedPaths: readonly string[];
    onExpandedPathsChange: (paths: string[]) => void;
    onRequestRefresh?: (() => void) | null;
    onRequestDownload?: ((params: Readonly<{ path: string; asZip: boolean }>) => Promise<{ ok: true } | { ok: false; error: string }>) | null;
}>): Readonly<{
    onSelectRowMenuItem: (node: RepositoryTreeNodeLike, itemId: RepositoryTreeRowActionMenuItemId) => Promise<void>;
}> {
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
            if (!params.writeActionsEnabled) return;
            let nextPath = await renamePathPrompt({ currentPath: node.path });
            if (!nextPath) return;

            let result = await sessionRenamePath(params.sessionId, { from: node.path, to: nextPath, overwrite: undefined });
            if (!result.success && isDestinationAlreadyExistsError(result.error)) {
                const strategy = await showRenameConflictResolutionDialog({ path: nextPath });
                if (strategy === 'cancel') return;

                if (strategy === 'replace') {
                    result = await sessionRenamePath(params.sessionId, { from: node.path, to: nextPath, overwrite: true });
                } else {
                    nextPath = await resolveKeepBothTargetPath({
                        desiredPath: nextPath,
                        maxAttempts: 50,
                        pathExists: async (candidatePath) => {
                            const stat = await sessionStatFile(params.sessionId, candidatePath);
                            return !stat.success || stat.exists === true;
                        },
                    });
                    result = await sessionRenamePath(params.sessionId, { from: node.path, to: nextPath, overwrite: undefined });
                }
            }

            if (!result.success) {
                Modal.alert(t('common.error'), result.error || t('files.repositoryTree.rename.failed'));
                return;
            }

            if (node.type === 'directory') {
                const nextExpanded = remapExpandedPathsAfterRename({
                    expandedPaths: params.expandedPaths,
                    from: node.path,
                    to: nextPath,
                });
                params.onExpandedPathsChange(nextExpanded);
            }
            params.onRequestRefresh?.();
            return;
        }

        if (itemId === 'repository-tree-menuitem-delete') {
            if (!params.writeActionsEnabled) return;

            const confirm = await deletePathConfirm({ path: node.path, kind: node.type });
            if (!confirm.confirmed) return;

            const result = await sessionDeletePath(params.sessionId, { path: node.path, recursive: confirm.recursive });
            if (!result.success) {
                Modal.alert(t('common.error'), result.error || t('files.repositoryTree.delete.failed'));
                return;
            }

            if (node.type === 'directory') {
                params.onExpandedPathsChange(removeExpandedPathsUnderDirectory(params.expandedPaths, node.path));
            }
            params.onRequestRefresh?.();
            return;
        }

        if (itemId === 'repository-tree-menuitem-download' || itemId === 'repository-tree-menuitem-zip') {
            if (!params.onRequestDownload) return;
            const res = await params.onRequestDownload({ path: node.path, asZip: itemId === 'repository-tree-menuitem-zip' });
            if (!res.ok) {
                Modal.alert(t('common.error'), res.error);
            }
        }
    }, [isDestinationAlreadyExistsError, params]);

    return { onSelectRowMenuItem };
}
