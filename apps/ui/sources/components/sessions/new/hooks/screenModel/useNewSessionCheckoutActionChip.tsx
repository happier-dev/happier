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
                        subtitle: option.gitBranch ?? option.path,
                    },
                ];
            }),
        ) as Record<string, { label: string; subtitle: string }>;

        const pickerOptions: AgentInputChipPickerOption[] = interaction.kind === 'picker'
            ? interaction.selectableOptionIds.map((id) => {
                const option = params.checkoutChipModel.options.find((entry) => entry.id === id) ?? null;
                const optionCopy = optionsById[id];
                if (!option || !optionCopy) {
                    return { id, label: id };
                }

                if (option.kind === 'current_path') {
                    return {
                        id,
                        label: optionCopy.label,
                        subtitle: optionCopy.subtitle,
                        sectionId: 'current',
                        sectionLabel: t('newSession.checkout.noWorktreeSectionTitle'),
                        detailTitle: t('newSession.checkout.noWorktree'),
                        detailDescription: t('newSession.checkout.noWorktreeSubtitle'),
                        detailBullets: option.path
                            ? [
                                t('newSession.checkout.detailPath', { path: option.path }),
                                ...(params.checkoutChipModel.options.some((entry) => entry.kind === 'linked_checkout')
                                    ? [t('newSession.checkout.detailLinkedWorkspace')]
                                    : []),
                            ]
                            : [],
                    };
                }

                if (option.kind === 'create_git_worktree') {
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
                    return {
                        id,
                        label: optionCopy.label,
                        subtitle: optionCopy.subtitle,
                        sectionId: 'actions',
                        sectionLabel: t('newSession.checkout.actionsSectionTitle'),
                        detailTitle: t('newSession.checkout.newWorktree'),
                        detailDescription: reusableWorktree
                            ? t('newSession.checkout.existingBranchWorktreeDescription')
                            : canUseExistingBranchDirectly
                                ? t('newSession.checkout.existingBranchDescription')
                            : t('newSession.checkout.newWorktreeSubtitle'),
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
                                    params.setCheckoutCreationDraft((current) => ({
                                        kind: 'git_worktree',
                                        displayName: selectedBaseRef,
                                        baseRef: null,
                                        branchMode: 'existing',
                                        ...(current?.kind === 'git_worktree' ? {} : {}),
                                    }));
                                    clearPendingGitWorktreeBaseRef();
                                    params.setCheckoutPickerOpen(false);
                                }
                            : undefined,
                        onApply: () => {
                            applyCheckoutChipOption(option.id, {
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
                    };
                }

                return {
                    id,
                    label: optionCopy.label,
                    subtitle: optionCopy.subtitle,
                    sectionId: 'linked',
                    sectionLabel: t('newSession.checkout.existingWorktreesSectionTitle'),
                    detailTitle: option.displayName,
                    detailDescription: option.checkoutKind === 'primary'
                        ? t('newSession.checkout.primaryDetailDescription')
                        : t('newSession.checkout.gitWorktreeDetailDescription'),
                    detailBullets: [
                        option.gitBranch
                            ? t('newSession.checkout.detailBranch', { branch: option.gitBranch })
                            : t('newSession.checkout.detailPath', { path: option.path }),
                        option.gitBranch
                            ? t('newSession.checkout.detailPath', { path: option.path })
                            : t('newSession.checkout.detailLinkedWorkspace'),
                    ],
                };
            })
            : [];

        return createCheckoutActionChip({
            interaction,
            pickerOpen: params.checkoutPickerOpen,
            title: t('newSession.checkout.selectTitle'),
            selectedLabel: optionsById[params.checkoutChipModel.selectedOptionId]?.label ?? t('newSession.checkout.noWorktree'),
            selectedOptionId: params.checkoutChipModel.selectedOptionId,
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
