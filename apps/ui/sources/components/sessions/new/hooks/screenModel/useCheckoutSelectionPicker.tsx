import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import type { SelectionListStep } from '@/components/ui/selectionList';
import type { NewSessionCheckoutChipModel } from '@/components/sessions/new/modules/newSessionCheckoutChipModel';
import { isFirstPartyGitScmBackendId } from '@/scm/registry/firstPartyScmBackendIdentity';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { t } from '@/text';
import { generateWorktreeName } from '@/utils/worktree/generateWorktreeName';

import {
    buildWorktreeSelectionListSteps,
    PENDING_GIT_WORKTREE_OPTION_ID,
    type WorktreeCreateSelection,
    type WorktreeSelectionWorkflowScope,
} from './buildWorktreeSelectionListSteps';

/**
 * The one project checkout picker: which checkout of the selected repository
 * work starts in — the selected folder itself or one of its existing linked
 * worktrees — plus, for a host that can carry it, a new worktree to create.
 *
 * New Session presents it as its composer chip; the Workflow editor presents it
 * beside the project folder. Both hand in their own selection effects, and the
 * picker owns everything else — which checkouts exist, which one is selected,
 * how each is labelled — so the two pages cannot
 * offer different checkouts for the same folder.
 *
 * Without a first-party Git repository, only a Workflow's folder and step choices remain.
 * Other hosts receive `null` because they have no checkout to pick within.
 */
export type CheckoutSelectionPicker = Readonly<{
    rootStep: SelectionListStep;
    selectedOptionId: string;
    selectedLabel: string;
}>;

export function useCheckoutSelectionPicker(params: Readonly<{
    repoScmSnapshot: ScmWorkingSnapshot | null;
    checkoutChipModel: NewSessionCheckoutChipModel;
    serverId?: string | null;
    selectedMachineId: string | null;
    selectedPath: string;
    machineHomeDir?: string | null;
    machinePlatform?: string | null;
    /**
     * Starts work in an existing checkout. `null` means "the selected folder
     * itself" when the model could not name it as a path.
     */
    onSelectCheckoutPath: (path: string | null) => void;
    /**
     * A host that can carry a pending creation supplies it; omitting it removes
     * the creation branch from the picker entirely.
     */
    creation?: Readonly<{
        pendingWorktree: Readonly<{ name: string; baseRef: string | null }> | null;
        onCreateWorktree: (selection: WorktreeCreateSelection) => void;
        onSelectPendingWorktree: () => void;
    }>;
    /** A workflow's choices: a per-run new worktree and, for a step, its own rows (see `buildWorktreeSelectionListSteps`). */
    workflowScope?: WorktreeSelectionWorkflowScope;
    /**
     * The host's current choice when it is not a checkout of the folder ("Same as the workflow", a
     * step's folder, a new worktree not yet named): the row the popover selects and what the chip says.
     */
    selection?: Readonly<{ optionId: string; label: string }>;
}>): CheckoutSelectionPicker | null {
    const { theme } = useUnistyles();
    const rowIconColor = theme.colors.text.tertiary;
    // Stable suggested name for this picker's lifetime. Pre-populates the
    // "name your worktree" step and is the fallback when the user commits an
    // empty/invalid name. Lazily generated once so the step tree (and the
    // picker rebuild) keep a stable suggestion rather than reshuffling.
    const [worktreeNameSuggestion] = React.useState(() => generateWorktreeName());
    const {
        checkoutChipModel,
        creation,
        machineHomeDir,
        machinePlatform,
        onSelectCheckoutPath,
        repoScmSnapshot,
        selectedMachineId,
        selectedPath,
        selection,
        serverId,
        workflowScope,
    } = params;

    return React.useMemo<CheckoutSelectionPicker | null>(() => {
        const supportsRepoWorktreePicker = repoScmSnapshot?.repo.isRepo === true
            && isFirstPartyGitScmBackendId(repoScmSnapshot.repo.backendId);
        if (!supportsRepoWorktreePicker && workflowScope === undefined) return null;

        const labelsById = new Map<string, string>(checkoutChipModel.options.map((option) => {
            if (option.kind === 'current_path') return [option.id, t('newSession.checkout.noWorktree')];
            if (option.kind === 'create_git_worktree') return [option.id, t('newSession.checkout.newWorktree')];
            return [option.id, option.displayName];
        }));
        const currentPathOption = checkoutChipModel.options.find((option) => option.kind === 'current_path');
        const pendingWorktree = creation?.pendingWorktree ?? null;

        const rootStep = buildWorktreeSelectionListSteps({
            snapshot: repoScmSnapshot,
            currentDirPath: currentPathOption?.kind === 'current_path' ? currentPathOption.path : selectedPath,
            ...(serverId !== undefined ? { serverId } : {}),
            machineId: selectedMachineId,
            machinePath: repoScmSnapshot?.repo.rootPath ?? selectedPath,
            machineHomeDir: machineHomeDir ?? null,
            machinePlatform: machinePlatform ?? null,
            rowIconColor,
            onSelectCurrentDir: () => onSelectCheckoutPath(
                currentPathOption?.kind === 'current_path' ? currentPathOption.path : null,
            ),
            onSelectExistingWorktree: onSelectCheckoutPath,
            ...(creation === undefined ? {} : {
                worktreeNameSuggestion,
                pendingWorktreeName: pendingWorktree?.name ?? null,
                pendingWorktreeBaseRef: pendingWorktree?.baseRef ?? null,
                onSelectPendingWorktree: creation.onSelectPendingWorktree,
                onCreateWorktreeWithName: creation.onCreateWorktree,
                onReuseExistingWorktreeForBranch: (info: Readonly<{ worktreePath: string }>) => (
                    onSelectCheckoutPath(info.worktreePath)
                ),
            }),
            ...(workflowScope === undefined ? {} : { workflowScope: supportsRepoWorktreePicker
                ? workflowScope : { step: workflowScope.step } }),
        });
        if (selection !== undefined) return { rootStep, selectedOptionId: selection.optionId, selectedLabel: selection.label };

        // A pending creation names itself (e.g. "New worktree: clever-cloud")
        // rather than the generic "New worktree".
        const selectedLabel = pendingWorktree !== null
            ? `${t('newSession.checkout.newWorktree')}: ${pendingWorktree.name}`
            : labelsById.get(checkoutChipModel.selectedOptionId) ?? t('newSession.checkout.noWorktree');

        return {
            rootStep,
            selectedOptionId: pendingWorktree !== null
                ? PENDING_GIT_WORKTREE_OPTION_ID
                : checkoutChipModel.selectedOptionId,
            selectedLabel,
        };
    }, [
        checkoutChipModel,
        creation,
        machineHomeDir,
        machinePlatform,
        onSelectCheckoutPath,
        repoScmSnapshot,
        rowIconColor,
        selectedMachineId,
        selectedPath,
        selection,
        serverId,
        workflowScope,
        worktreeNameSuggestion,
    ]);
}
