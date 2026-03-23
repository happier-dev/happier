import type { WorkspaceCheckoutKind } from '@happier-dev/protocol';

import type { NewSessionCheckoutCreationDraft } from '@/sync/domains/state/newSessionCheckoutDraft';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { normalizeFileSystemPath } from '@/sync/domains/fileSystem/normalizeFileSystemPath';

export type NewSessionCheckoutChipOption =
    | Readonly<{
        id: 'current_path';
        kind: 'current_path';
        path: string;
      }>
    | Readonly<{
        id: `checkout:${string}`;
        kind: 'linked_checkout';
        path: string;
        displayName: string;
        checkoutKind: WorkspaceCheckoutKind;
        gitBranch: string | null;
      }>
    | Readonly<{
        id: 'create_git_worktree';
        kind: 'create_git_worktree';
      }>;

export type NewSessionCheckoutChipModel = Readonly<{
    selectedOptionId: NewSessionCheckoutChipOption['id'];
    options: ReadonlyArray<NewSessionCheckoutChipOption>;
}>;

function normalizePath(raw: unknown): string {
    return normalizeFileSystemPath(raw) ?? '';
}

function isPathAtOrWithinRoot(path: string, rootPath: string): boolean {
    if (path === rootPath) {
        return true;
    }

    const nextCharacter = path.charAt(rootPath.length);
    return path.startsWith(rootPath) && (nextCharacter === '/' || nextCharacter === '\\');
}

function resolvePathDisplayName(path: string): string {
    const normalized = path.replace(/\\/g, '/');
    const segments = normalized.split('/').filter((segment) => segment.length > 0);
    return segments.at(-1) ?? path;
}

function supportsRepoWorktreeChip(snapshot: ScmWorkingSnapshot | null): boolean {
    return snapshot?.repo.isRepo === true && snapshot.repo.backendId === 'git';
}

function resolveMainRepoWorktreePath(snapshot: ScmWorkingSnapshot | null, fallbackPath: string): string {
    const mainWorktreePath = (snapshot?.repo.worktrees ?? [])
        .map((worktree) => normalizePath(worktree.path))
        .find((path, index) => Boolean(snapshot?.repo.worktrees?.[index]?.isMain) && path.length > 0);
    return mainWorktreePath || fallbackPath;
}

export function resolveNewSessionCheckoutChipModel(params: Readonly<{
    selectedPath: string;
    checkoutCreationDraft: NewSessionCheckoutCreationDraft | null;
    repoSnapshot: ScmWorkingSnapshot | null;
}>): NewSessionCheckoutChipModel {
    const selectedPath = normalizePath(params.selectedPath);
    if (!selectedPath) {
        return {
            selectedOptionId: 'current_path',
            options: [{ id: 'current_path', kind: 'current_path', path: selectedPath }],
        };
    }

    const repoRootPath = normalizePath(params.repoSnapshot?.repo.rootPath) || selectedPath;
    const noWorktreePath = resolveMainRepoWorktreePath(params.repoSnapshot, repoRootPath);
    const baseOptions: NewSessionCheckoutChipOption[] = [{
        id: 'current_path',
        kind: 'current_path',
        path: noWorktreePath,
    }];
    if (!supportsRepoWorktreeChip(params.repoSnapshot)) {
        return {
            selectedOptionId: 'current_path',
            options: baseOptions,
        };
    }

    const checkoutOptions: Array<Extract<NewSessionCheckoutChipOption, { kind: 'linked_checkout' }>> = Array.from(
        new Map(
            (params.repoSnapshot?.repo.worktrees ?? [])
                .map((worktree) => ({
                    ...worktree,
                    path: normalizePath(worktree.path),
                }))
                .filter((worktree) => worktree.path.length > 0 && worktree.path !== noWorktreePath)
                .map((worktree) => [worktree.path, worktree] as const),
        ).values(),
    )
        .sort((left, right) => {
            const leftLabel = left.branch ?? resolvePathDisplayName(left.path);
            const rightLabel = right.branch ?? resolvePathDisplayName(right.path);
            return leftLabel.localeCompare(rightLabel);
        })
        .map((worktree) => ({
            id: `checkout:${worktree.path}` as const,
            kind: 'linked_checkout' as const,
            path: worktree.path,
            displayName: worktree.branch ?? resolvePathDisplayName(worktree.path),
            checkoutKind: 'git_worktree' as const,
            gitBranch: worktree.branch ?? null,
        }));

    const options: NewSessionCheckoutChipOption[] = [
        ...baseOptions,
        {
            id: 'create_git_worktree',
            kind: 'create_git_worktree',
        },
        ...checkoutOptions,
    ];

    if (params.checkoutCreationDraft?.kind === 'git_worktree') {
        return {
            selectedOptionId: 'create_git_worktree',
            options,
        };
    }

    const selectedExistingCheckout = checkoutOptions
        .filter((option) => isPathAtOrWithinRoot(selectedPath, normalizePath(option.path)))
        .sort((left, right) => normalizePath(right.path).length - normalizePath(left.path).length)
        .at(0);
    if (selectedExistingCheckout) {
        return {
            selectedOptionId: selectedExistingCheckout.id,
            options,
        };
    }

    return {
        selectedOptionId: 'current_path',
        options,
    };
}
