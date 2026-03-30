import * as React from 'react';

import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import { DEFAULT_OPTION_CHIP_CYCLE_MAX_OPTIONS, resolveChipOptionInteraction } from '@/components/sessions/agentInput/chipOptionInteraction';
import type { AgentInputChipPickerOption } from '@/components/sessions/agentInput/components/AgentInputChipPickerTypes';
import { createCheckoutActionChip } from '@/components/sessions/agentInput/definitions/createCheckoutActionChip';
import { NewSessionWorktreeBranchDetail } from '@/components/sessions/new/components/NewSessionWorktreeBranchDetail';
import {
    type NewSessionCheckoutChipModel,
} from '@/components/sessions/new/modules/newSessionCheckoutChipModel';
import {
    buildGitWorktreeCheckoutCreationDraft,
} from '@/components/sessions/new/modules/buildGitWorktreeCheckoutCreationDraft';
import { findReusableRepoWorktreeForBranch } from '@/scm/repository/repoScmWorktreeService';
import { t } from '@/text';
import { generateWorktreeName } from '@/utils/worktree/generateWorktreeName';
import type { NewSessionCheckoutCreationDraft } from '@/sync/domains/state/newSessionCheckoutDraft';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import type { NewSessionWorktreeBranchSelection } from '@/components/sessions/new/components/NewSessionWorktreeBranchDetail';

const EXISTING_WORKTREE_MODE_OPTION_ID = '__existing_worktree__';

export function useNewSessionCheckoutActionChip(params: Readonly<{
    repoScmSnapshot: ScmWorkingSnapshot | null;
    checkoutChipModel: NewSessionCheckoutChipModel;
    checkoutPickerOpen: boolean;
    setCheckoutPickerOpen: React.Dispatch<React.SetStateAction<boolean>>;
    checkoutCreationDraft: NewSessionCheckoutCreationDraft | null;
    selectedMachineId: string | null;
    selectedPath: string;
    setSelectedPath: React.Dispatch<React.SetStateAction<string>>;
    setCheckoutCreationDraft: React.Dispatch<React.SetStateAction<NewSessionCheckoutCreationDraft | null>>;
    pendingGitWorktreeBaseRefRef: React.MutableRefObject<string | null>;
    pendingGitWorktreeSourceKindRef: React.MutableRefObject<'current' | 'local' | 'remote'>;
    shouldReconcileInitialHydratedCheckoutCreationDraftRef: React.MutableRefObject<boolean>;
    router: Readonly<{ push: (href: any) => void }>;
}>): AgentInputExtraActionChip | null {
    const [pendingGitWorktreeSelectionVersion, bumpPendingGitWorktreeSelectionVersion] = React.useState(0);

    return React.useMemo<AgentInputExtraActionChip | null>(() => {
        const supportsRepoWorktreeChip = params.repoScmSnapshot?.repo.isRepo === true && params.repoScmSnapshot.repo.backendId === 'git';
        if (!supportsRepoWorktreeChip) {
            return null;
        }

        const optionIds = params.checkoutChipModel.options.map((option) => option.id);
        const hasExistingWorktreeOption = params.checkoutChipModel.options.some((option) => option.kind === 'linked_checkout');
        const shouldForcePicker = params.checkoutChipModel.options.some((option) => option.kind === 'create_git_worktree');
        const interaction = shouldForcePicker
            ? {
                kind: 'picker' as const,
                selectableOptionIds: optionIds,
            }
            : resolveChipOptionInteraction({
                currentOptionId: params.checkoutChipModel.selectedOptionId,
                selectableOptionIds: optionIds,
                cycleMaxOptions: hasExistingWorktreeOption ? 2 : DEFAULT_OPTION_CHIP_CYCLE_MAX_OPTIONS,
            });

        const clearPendingGitWorktreeBaseRef = () => {
            params.pendingGitWorktreeBaseRefRef.current = null;
            params.pendingGitWorktreeSourceKindRef.current = 'current';
            bumpPendingGitWorktreeSelectionVersion((current) => current + 1);
        };

        const applyCheckoutChipOption = (optionId: string, overrides?: Readonly<{ baseRef?: string | null }>) => {
            const option = params.checkoutChipModel.options.find((entry) => entry.id === optionId) ?? null;
            if (!option || option.kind === 'current_path') {
                params.shouldReconcileInitialHydratedCheckoutCreationDraftRef.current = false;
                params.setCheckoutCreationDraft(null);
                clearPendingGitWorktreeBaseRef();
                if (option?.kind === 'current_path') {
                    params.setSelectedPath(option.path);
                }
                params.setCheckoutPickerOpen(false);
                return;
            }

            if (option.kind === 'create_git_worktree') {
                params.shouldReconcileInitialHydratedCheckoutCreationDraftRef.current = false;
                params.setCheckoutCreationDraft((current) => buildGitWorktreeCheckoutCreationDraft({
                    existingDraft: current,
                    fallbackDisplayName: generateWorktreeName(),
                    baseRef: overrides?.baseRef ?? params.pendingGitWorktreeBaseRefRef.current ?? current?.baseRef ?? null,
                    branchMode: 'new',
                }));
                clearPendingGitWorktreeBaseRef();
                params.setCheckoutPickerOpen(false);
                return;
            }

            params.shouldReconcileInitialHydratedCheckoutCreationDraftRef.current = false;
            params.setCheckoutCreationDraft(null);
            clearPendingGitWorktreeBaseRef();
            params.setSelectedPath(option.path);
            params.setCheckoutPickerOpen(false);
        };

        const optionsById = Object.fromEntries(
            params.checkoutChipModel.options.map((option) => {
                if (option.kind === 'current_path') {
                    return [
                        option.id,
                        {
                            label: t('newSession.checkout.noWorktree'),
                            subtitle: option.path,
                        },
                    ];
                }
                if (option.kind === 'create_git_worktree') {
                    return [
                        option.id,
                        {
                            label: t('newSession.checkout.newWorktree'),
                            subtitle: t('newSession.checkout.newWorktreeSubtitle'),
                        },
                    ];
                }
                return [
                    option.id,
                    {
                        label: option.displayName,
                        // The label already includes the effective branch name; keep the subtitle as the path
                        // so we don't show duplicate "main / main" rows in the existing worktree list.
                        subtitle: option.path,
                    },
                ];
            }),
        ) as Record<string, { label: string; subtitle: string }>;

        const currentPathOption = params.checkoutChipModel.options.find((option) => option.kind === 'current_path') ?? null;
        const createWorktreeOption = params.checkoutChipModel.options.find((option) => option.kind === 'create_git_worktree') ?? null;
        const linkedWorktreeOptions = params.checkoutChipModel.options.filter((option) => option.kind === 'linked_checkout');

        const pickerOptions: AgentInputChipPickerOption[] = interaction.kind === 'picker'
            ? [
                ...(currentPathOption ? [{
                    id: currentPathOption.id,
                    label: optionsById[currentPathOption.id]?.label ?? t('newSession.checkout.noWorktree'),
                    subtitle: optionsById[currentPathOption.id]?.subtitle ?? currentPathOption.path,
                    sectionId: 'worktreeMode',
                    detailDescription: t('newSession.checkout.noWorktreeSubtitle'),
                    detailBullets: currentPathOption.path
                        ? [
                            t('newSession.checkout.detailPath', { path: currentPathOption.path }),
                            ...(linkedWorktreeOptions.length > 0 ? [t('newSession.checkout.detailLinkedWorkspace')] : []),
                        ]
                        : [],
                    onSelectImmediate: () => {
                        applyCheckoutChipOption(currentPathOption.id);
                    },
                }] : []),
                ...(createWorktreeOption ? (() => {
                    const selectedBaseRef = params.pendingGitWorktreeBaseRefRef.current
                        ?? (
                            params.checkoutCreationDraft?.branchMode === 'existing'
                                ? params.checkoutCreationDraft.displayName
                                : params.checkoutCreationDraft?.baseRef ?? null
                        );
                    const selectedSourceKind = params.pendingGitWorktreeSourceKindRef.current;
                    const canUseExistingBranchDirectly = selectedSourceKind === 'local'
                        && selectedBaseRef !== null
                        && selectedBaseRef !== params.repoScmSnapshot?.branch.head;
                    const reusableWorktree = findReusableRepoWorktreeForBranch({
                        snapshot: params.repoScmSnapshot,
                        selectedBaseRef,
                        currentBranch: params.repoScmSnapshot?.branch.head ?? null,
                        currentPath: params.selectedPath,
                    });

                    return [{
                        id: createWorktreeOption.id,
                        label: optionsById[createWorktreeOption.id]?.label ?? t('newSession.checkout.newWorktree'),
                        subtitle: optionsById[createWorktreeOption.id]?.subtitle ?? t('newSession.checkout.newWorktreeSubtitle'),
                        sectionId: 'worktreeMode',
                        // The right pane starts directly at the “Start from” picker (keeps parity with model/mode panels).
                        detailBullets: reusableWorktree
                            ? [
                                reusableWorktree.branch
                                    ? t('newSession.checkout.detailBranch', { branch: reusableWorktree.branch })
                                    : t('newSession.checkout.detailPath', { path: reusableWorktree.path }),
                                t('newSession.checkout.detailPath', { path: reusableWorktree.path }),
                                t('newSession.checkout.createNewBranchFromBranchHint'),
                            ]
                            : canUseExistingBranchDirectly
                                ? [
                                    t('newSession.checkout.detailBranch', { branch: selectedBaseRef }),
                                    t('newSession.checkout.createNewBranchFromBranchHint'),
                                ]
                                : [
                                    t('newSession.checkout.newWorktreeDetailWorkspace'),
                                    t('newSession.checkout.newWorktreeDetailBranch'),
                                ],
                        detailActionLabel: reusableWorktree
                            ? t('newSession.checkout.useExistingWorktreeAction')
                            : canUseExistingBranchDirectly
                                ? t('newSession.checkout.useExistingBranchAction')
                                : undefined,
                        onDetailAction: reusableWorktree
                            ? () => {
                                params.shouldReconcileInitialHydratedCheckoutCreationDraftRef.current = false;
                                params.setCheckoutCreationDraft(null);
                                clearPendingGitWorktreeBaseRef();
                                params.setSelectedPath(reusableWorktree.path);
                                params.setCheckoutPickerOpen(false);
                            }
                            : canUseExistingBranchDirectly
                                ? () => {
                                    params.shouldReconcileInitialHydratedCheckoutCreationDraftRef.current = false;
                                    params.setCheckoutCreationDraft(() => ({
                                        kind: 'git_worktree',
                                        displayName: selectedBaseRef,
                                        baseRef: null,
                                        branchMode: 'existing',
                                    }));
                                    clearPendingGitWorktreeBaseRef();
                                    params.setCheckoutPickerOpen(false);
                                }
                                : undefined,
                        onApply: () => {
                            applyCheckoutChipOption(createWorktreeOption.id, {
                                baseRef: params.pendingGitWorktreeBaseRefRef.current ?? params.checkoutCreationDraft?.baseRef ?? null,
                            });
                        },
                        renderDetailContent: () => (
                            <NewSessionWorktreeBranchDetail
                                machineId={params.selectedMachineId}
                                path={params.selectedPath}
                                selectedBaseRef={selectedBaseRef}
                                onSelectionChange={(selection) => {
                                    params.pendingGitWorktreeBaseRefRef.current = selection.baseRef;
                                    params.pendingGitWorktreeSourceKindRef.current = selection.sourceKind;
                                    bumpPendingGitWorktreeSelectionVersion((current) => current + 1);
                                }}
                            />
                        ),
                    }] satisfies AgentInputChipPickerOption[];
                })() : []),
                {
                    id: EXISTING_WORKTREE_MODE_OPTION_ID,
                    label: t('newSession.checkout.existingWorktree'),
                    subtitle: t('newSession.checkout.existingWorktreeSubtitle'),
                    sectionId: 'worktreeMode',
                    detailDescription: t('newSession.checkout.gitWorktreeDetailDescription'),
                    detailSelectOptions: linkedWorktreeOptions.length > 0
                        ? linkedWorktreeOptions.map((option) => ({
                            id: option.id,
                            label: optionsById[option.id]?.label ?? option.displayName,
                            subtitle: optionsById[option.id]?.subtitle ?? option.path,
                            selected: params.checkoutChipModel.selectedOptionId === option.id,
                        }))
                        : [{
                            id: '__existing_worktree_empty__',
                            label: t('newSession.checkout.existingWorktreeEmptyTitle'),
                            subtitle: t('newSession.checkout.existingWorktreeEmptySubtitle'),
                            selected: false,
                            disabled: true,
                        }],
                },
            ]
            : [];

        const effectivePickerSelectedOptionId = params.checkoutChipModel.options.some((option) =>
            option.kind === 'linked_checkout' && option.id === params.checkoutChipModel.selectedOptionId
        )
            ? EXISTING_WORKTREE_MODE_OPTION_ID
            : params.checkoutChipModel.selectedOptionId;

        return createCheckoutActionChip({
            interaction,
            pickerOpen: params.checkoutPickerOpen,
            title: t('newSession.checkout.selectTitle'),
            selectedLabel: optionsById[params.checkoutChipModel.selectedOptionId]?.label ?? t('newSession.checkout.noWorktree'),
            selectedOptionId: effectivePickerSelectedOptionId,
            pickerOptions,
            onApplyOption: applyCheckoutChipOption,
            onRequestClose: () => {
                clearPendingGitWorktreeBaseRef();
                params.setCheckoutPickerOpen(false);
            },
            setPickerOpen: params.setCheckoutPickerOpen,
        });
    }, [
        params.checkoutCreationDraft?.baseRef,
        params.checkoutPickerOpen,
        params.pendingGitWorktreeBaseRefRef,
        params.pendingGitWorktreeSourceKindRef,
        pendingGitWorktreeSelectionVersion,
        params.repoScmSnapshot,
        params.router,
        params.selectedMachineId,
        params.selectedPath,
        params.setCheckoutCreationDraft,
        params.setCheckoutPickerOpen,
        params.setSelectedPath,
        params.shouldReconcileInitialHydratedCheckoutCreationDraftRef,
        params.checkoutChipModel,
    ]);
}
