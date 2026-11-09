import * as React from 'react';

import { Modal } from '@/modal';
import { t } from '@/text';
import { resolveKeepBothTargetPath } from '@/sync/domains/files/resolveKeepBothTargetPath';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { workspaceDeletePath, workspaceRenamePath, workspaceStatFile } from '@/sync/ops/workspaceFileSystem';
import { useClipboardWrite } from '@/hooks/ui/useClipboardWrite';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { createActionApprovalContinuation, type ActionApprovalRegistration } from '@/components/approvals/actionApprovalContinuation';
import type { FilesystemMutationOutput } from '@happier-dev/protocol/actions/filesystemActionFamily';

import type { RepositoryTreeRowActionMenuItemId } from '@/components/workspaces/files/repositoryTree/RepositoryTreeRowActionsMenu';
import { deletePathConfirm } from '@/components/workspaces/files/repositoryTree/deletePathConfirm';
import { renamePathPrompt } from '@/components/workspaces/files/repositoryTree/renamePathPrompt';
import { showRenameConflictResolutionDialog } from '@/components/workspaces/files/repositoryTree/showRenameConflictResolutionDialog';
import { previewFileRenameEdits, showFileRenameReview } from '@/components/workspaces/files/intelligence/showFileRenameReview';

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
    onActionApproval?: (registration: ActionApprovalRegistration) => void;
    onRequestDownload?: ((params: Readonly<{ path: string; asZip: boolean }>) => Promise<{ ok: true } | { ok: false; error: string; canceled?: true }>) | null;
}>): Readonly<{
    onSelectRowMenuItem: (node: RepositoryTreeNodeLike, itemId: RepositoryTreeRowActionMenuItemId) => Promise<void>;
    isRenaming: boolean;
}> {
    const {
        expandedPaths,
        onExpandedPathsChange,
        onRequestDownload,
        onRequestRefresh,
        onActionApproval,
        workspaceScope,
        writeActionsEnabled,
    } = params;
    const writeClipboard = useClipboardWrite(workspaceScope?.serverId ?? null);
    const expandedPathsRef = React.useRef(expandedPaths);
    React.useEffect(() => {
        expandedPathsRef.current = expandedPaths;
    }, [expandedPaths]);
    const scopeRef = React.useRef(workspaceScope);
    scopeRef.current = workspaceScope;
    const mounted = React.useRef(true);
    const [isRenaming, setIsRenaming] = React.useState(false);
    React.useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; };
    }, []);

    const isDestinationAlreadyExistsError = React.useCallback((error: string | undefined): boolean => {
        return typeof error === 'string' && /destination already exists/i.test(error);
    }, []);

    const performRowMenuAction = React.useCallback(async (node: RepositoryTreeNodeLike, itemId: RepositoryTreeRowActionMenuItemId) => {
        if (itemId === 'repository-tree-menuitem-copy-path') {
            const ok = await writeClipboard(node.path);
            Modal.alert(
                ok ? t('common.copied') : t('common.error'),
                ok
                    ? t('items.copiedToClipboard', { label: t('common.path') })
                    : t('items.failedToCopyToClipboard'),
            );
            return;
        }

        const lifetime = captureActiveServerAccountScopeLifetime();
        const target = workspaceScope;
        const current = () => mounted.current && (!lifetime || lifetime.isCurrent())
            && scopeRef.current?.serverId === target?.serverId
            && scopeRef.current?.machineId === target?.machineId
            && scopeRef.current?.rootPath === target?.rootPath;

        if (itemId === 'repository-tree-menuitem-rename') {
            if (!writeActionsEnabled) return;
            let nextPath = await renamePathPrompt({ currentPath: node.path });
            if (!nextPath || !current()) return;

            if (!target) {
                Modal.alert(t('common.error'), t('files.repositoryTree.rename.failed'));
                return;
            }

            // "Update imports": when a language server would follow the move with edits, the person reviews
            // them first; its apply moves the file. Otherwise, or on "Rename only", the plain move below.
            if (node.type === 'file') {
                const accountId = lifetime?.scope.accountId ?? null;
                const files = await previewFileRenameEdits({ scope: target, accountId, path: node.path, newPath: nextPath });
                if (!current()) return;
                if (files) {
                    const outcome = await showFileRenameReview({ scope: target, accountId, path: node.path, newPath: nextPath, files });
                    if (!current()) return;
                    if (outcome === 'done') {
                        onRequestRefresh?.();
                        return;
                    }
                }
            }

            let result = await workspaceRenamePath(target, { from: node.path, to: nextPath, overwrite: undefined });
            if (!current()) return;
            if (!result.success && isDestinationAlreadyExistsError(result.error)) {
                const strategy = await showRenameConflictResolutionDialog({ path: nextPath });
                if (strategy === 'cancel' || !current()) return;

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
                    if (!current()) return;
                    result = await workspaceRenamePath(target, { from: node.path, to: nextPath, overwrite: undefined });
                }
            }
            if (!current()) return;

            const renamedPath = nextPath;
            const complete = () => {
                if (node.type === 'directory') {
                    onExpandedPathsChange(remapExpandedPathsAfterRename({
                        expandedPaths: expandedPathsRef.current, from: node.path, to: renamedPath,
                    }));
                }
                onRequestRefresh?.();
            };
            if (!result.success) {
                if (result.errorCode === 'approval_required' && result.approvalArtifactId && onActionApproval) {
                    onActionApproval(lifetime && areServerProfileIdentifiersEquivalent(target.serverId ?? lifetime.scope.serverId, lifetime.scope.serverId)
                        ? createActionApprovalContinuation<FilesystemMutationOutput, 'daemon.filesystem.rename'>({
                            artifactId: result.approvalArtifactId, actionId: 'daemon.filesystem.rename', scope: lifetime.scope,
                            refreshAfterExecution: false,
                            onFailed: (code, failure) => {
                                if (current()) Modal.alert(t('common.error'), failure?.error || code);
                            },
                            onSucceeded: value => {
                                if (!current()) return;
                                if (value.success) complete();
                                else Modal.alert(t('common.error'), value.error);
                            },
                        }) : result.approvalArtifactId);
                    return;
                }
                Modal.alert(t('common.error'), result.error || t('files.repositoryTree.rename.failed'));
                return;
            }

            complete();
            return;
        }

        if (itemId === 'repository-tree-menuitem-delete') {
            if (!writeActionsEnabled) return;

            const confirm = await deletePathConfirm({ path: node.path, kind: node.type });
            if (!confirm.confirmed || !current()) return;

            if (!target) {
                Modal.alert(t('common.error'), t('files.repositoryTree.delete.failed'));
                return;
            }

            const result = await workspaceDeletePath(target, { path: node.path, recursive: confirm.recursive });
            if (!current()) return;
            const complete = () => {
                if (node.type === 'directory') {
                    onExpandedPathsChange(removeExpandedPathsUnderDirectory(expandedPathsRef.current, node.path));
                }
                onRequestRefresh?.();
            };
            if (!result.success) {
                if (result.errorCode === 'approval_required' && result.approvalArtifactId && onActionApproval) {
                    onActionApproval(lifetime && areServerProfileIdentifiersEquivalent(target.serverId ?? lifetime.scope.serverId, lifetime.scope.serverId)
                        ? createActionApprovalContinuation<FilesystemMutationOutput, 'daemon.filesystem.delete'>({
                            artifactId: result.approvalArtifactId, actionId: 'daemon.filesystem.delete', scope: lifetime.scope,
                            refreshAfterExecution: false,
                            onFailed: (code, failure) => {
                                if (current()) Modal.alert(t('common.error'), failure?.error || code);
                            },
                            onSucceeded: value => {
                                if (!current()) return;
                                if (value.success) complete();
                                else Modal.alert(t('common.error'), value.error);
                            },
                        }) : result.approvalArtifactId);
                    return;
                }
                Modal.alert(t('common.error'), result.error || t('files.repositoryTree.delete.failed'));
                return;
            }

            complete();
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
        onActionApproval,
        workspaceScope,
        writeActionsEnabled,
        writeClipboard,
    ]);

    const onSelectRowMenuItem = React.useCallback(async (node: RepositoryTreeNodeLike, itemId: RepositoryTreeRowActionMenuItemId) => {
        if (itemId !== 'repository-tree-menuitem-rename') return await performRowMenuAction(node, itemId);
        setIsRenaming(true);
        try {
            await performRowMenuAction(node, itemId);
        } finally {
            if (mounted.current) setIsRenaming(false);
        }
    }, [performRowMenuAction]);

    return React.useMemo(() => ({ onSelectRowMenuItem, isRenaming }), [onSelectRowMenuItem, isRenaming]);
}
