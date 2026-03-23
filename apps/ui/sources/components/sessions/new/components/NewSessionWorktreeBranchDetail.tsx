import * as React from 'react';

import type { ScmBranchListEntry } from '@happier-dev/protocol';

import { OptionPickerOverlay, type OptionPickerOption } from '@/components/sessions/pickers/OptionPickerOverlay';
import { repoScmBranchService } from '@/scm/repository/repoScmBranchService';
import { useRepoScmBranchList } from '@/scm/repository/useRepoScmBranchList';
import { t } from '@/text';

export const NEW_SESSION_WORKTREE_BRANCH_CURRENT_HEAD_SENTINEL = '__repo_head__';

export type NewSessionWorktreeBranchSelection = Readonly<{
    baseRef: string | null;
    sourceKind: 'current' | 'local' | 'remote';
}>;

export type NewSessionWorktreeBranchDetailProps = Readonly<{
    machineId: string | null;
    path: string | null;
    selectedBaseRef: string | null;
    onSelectionChange?: (selection: NewSessionWorktreeBranchSelection) => void;
}>;

function buildBranchOption(branch: ScmBranchListEntry): OptionPickerOption {
    if (branch.upstream) {
        return {
            value: branch.name,
            label: branch.name,
            description: t('files.branchMenu.branch.upstream', { upstream: branch.upstream }),
        };
    }

    if (branch.type === 'remote') {
        return {
            value: branch.name,
            label: branch.name,
            description: t('files.branchMenu.category.remote'),
        };
    }

    return {
        value: branch.name,
        label: branch.name,
    };
}

export function NewSessionWorktreeBranchDetail(props: NewSessionWorktreeBranchDetailProps) {
    const readCachedBranches = React.useCallback(() => {
        if (!props.machineId || !props.path) {
            return [];
        }
        return repoScmBranchService.readCachedBranchesForMachinePath({
            machineId: props.machineId,
            path: props.path,
            includeRemotes: true,
        });
    }, [props.machineId, props.path]);

    const fetchBranches = React.useCallback(async () => {
        if (!props.machineId || !props.path) {
            return [];
        }
        return await repoScmBranchService.fetchBranchesForMachinePath({
            machineId: props.machineId,
            path: props.path,
            includeRemotes: true,
        });
    }, [props.machineId, props.path]);

    const { branches, phase: probePhase, refresh } = useRepoScmBranchList({
        ready: Boolean(props.machineId && props.path),
        autoLoad: Boolean(props.machineId && props.path),
        readCached: readCachedBranches,
        fetch: fetchBranches,
    });

    const options = React.useMemo<ReadonlyArray<OptionPickerOption>>(() => {
        return [
            {
                value: NEW_SESSION_WORKTREE_BRANCH_CURRENT_HEAD_SENTINEL,
                label: t('newSession.checkout.branchPickerCurrentHead'),
                description: t('newSession.checkout.branchPickerCurrentHeadDescription'),
            },
            ...branches.map(buildBranchOption),
        ];
    }, [branches]);

    const selectedValue = props.selectedBaseRef ?? NEW_SESSION_WORKTREE_BRANCH_CURRENT_HEAD_SENTINEL;
    const effectiveLabel = selectedValue === NEW_SESSION_WORKTREE_BRANCH_CURRENT_HEAD_SENTINEL
        ? t('newSession.checkout.branchPickerCurrentHead')
        : selectedValue;

    return (
        <OptionPickerOverlay
            title={t('newSession.checkout.branchPickerTitle')}
            effectiveLabel={effectiveLabel}
            notes={[]}
            options={options}
            selectedValue={selectedValue}
            emptyText={t('newSession.checkout.branchPickerEmpty')}
            canEnterCustomValue={false}
            searchPlaceholder={t('newSession.checkout.branchPickerSearchPlaceholder')}
            onSelect={(value) => {
                if (value === NEW_SESSION_WORKTREE_BRANCH_CURRENT_HEAD_SENTINEL) {
                    props.onSelectionChange?.({
                        baseRef: null,
                        sourceKind: 'current',
                    });
                    return;
                }

                const selectedBranch = branches.find((branch) => branch.name === value) ?? null;
                props.onSelectionChange?.({
                    baseRef: value,
                    sourceKind: selectedBranch?.type === 'remote' ? 'remote' : 'local',
                });
            }}
            probe={{
                phase: probePhase,
                onRefresh: () => {
                    void refresh('refreshing');
                },
                refreshAccessibilityLabel: t('newSession.checkout.branchPickerRefreshA11y'),
                loadingAccessibilityLabel: t('newSession.checkout.branchPickerLoadingA11y'),
                refreshingAccessibilityLabel: t('newSession.checkout.branchPickerRefreshingA11y'),
            }}
        />
    );
}
