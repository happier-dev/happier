import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { Pressable } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import type { AgentInputExtraActionChip, AgentInputExtraActionChipRenderContext } from '@/components/sessions/agentInput/agentInputContracts';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import { Text } from '@/components/ui/text/Text';
import {
    type NewSessionCheckoutChipModel,
} from '@/components/sessions/new/modules/newSessionCheckoutChipModel';
import {
    buildGitWorktreeCheckoutCreationDraft,
} from '@/components/sessions/new/modules/buildGitWorktreeCheckoutCreationDraft';
import { t } from '@/text';
import { generateWorktreeName } from '@/utils/worktree/generateWorktreeName';
import type { NewSessionCheckoutCreationDraft } from '@/sync/domains/state/newSessionCheckoutDraft';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';

import { buildWorktreeSelectionListSteps } from './buildWorktreeSelectionListSteps';

const CHIP_KEY = 'new-session-checkout';
const WORKTREE_RELATIVE_TIME_TICK_MS = 60_000;

function useWorktreePickerNowMs(): number {
    const [nowMs, setNowMs] = React.useState(() => Date.now());
    React.useEffect(() => {
        const intervalId = setInterval(() => {
            setNowMs(Date.now());
        }, WORKTREE_RELATIVE_TIME_TICK_MS);
        return () => clearInterval(intervalId);
    }, []);
    return nowMs;
}

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
    /**
     * Optional canonical home directory for the selected machine (e.g. `/Users/leeroy`,
     * `C:\\Users\\leeroy`). Threaded into `buildWorktreeSelectionListSteps` so tilde-prefixed
     * worktree paths and the canonical current dir compare correctly (R10 contract).
     */
    machineHomeDir?: string | null;
}>): AgentInputExtraActionChip | null {
    const nowMs = useWorktreePickerNowMs();
    const { theme } = useUnistyles();
    const rowIconColor = theme.colors.text.tertiary;
    return React.useMemo<AgentInputExtraActionChip | null>(() => {
        const supportsRepoWorktreeChip = params.repoScmSnapshot?.repo.isRepo === true && params.repoScmSnapshot.repo.backendId === 'git';
        if (!supportsRepoWorktreeChip) {
            return null;
        }

        const optionsById = Object.fromEntries(
            params.checkoutChipModel.options.map((option) => {
                if (option.kind === 'current_path') {
                    return [option.id, { label: t('newSession.checkout.noWorktree') }];
                }
                if (option.kind === 'create_git_worktree') {
                    return [option.id, { label: t('newSession.checkout.newWorktree') }];
                }
                return [option.id, { label: option.displayName }];
            }),
        ) as Record<string, { label: string }>;

        const clearPending = () => {
            params.pendingGitWorktreeBaseRefRef.current = null;
            params.pendingGitWorktreeSourceKindRef.current = 'current';
        };

        const closePopover = () => {
            params.setCheckoutPickerOpen(false);
        };

        const currentPathOption = params.checkoutChipModel.options.find((option) => option.kind === 'current_path');

        const onSelectCurrentDir = () => {
            params.shouldReconcileInitialHydratedCheckoutCreationDraftRef.current = false;
            params.setCheckoutCreationDraft(null);
            clearPending();
            if (currentPathOption?.kind === 'current_path') {
                params.setSelectedPath(currentPathOption.path);
            }
            closePopover();
        };

        const onSelectExistingWorktree = (worktreePath: string) => {
            params.shouldReconcileInitialHydratedCheckoutCreationDraftRef.current = false;
            params.setCheckoutCreationDraft(null);
            clearPending();
            params.setSelectedPath(worktreePath);
            closePopover();
        };

        const onSelectBranchForNewWorktree = (selection: Readonly<{ branchName: string; sourceKind: 'local' | 'remote' }>) => {
            params.shouldReconcileInitialHydratedCheckoutCreationDraftRef.current = false;
            params.pendingGitWorktreeBaseRefRef.current = selection.branchName;
            params.pendingGitWorktreeSourceKindRef.current = selection.sourceKind;
            params.setCheckoutCreationDraft((current) => buildGitWorktreeCheckoutCreationDraft({
                existingDraft: current,
                fallbackDisplayName: generateWorktreeName(),
                baseRef: selection.branchName,
                branchMode: 'new',
            }));
            clearPending();
            closePopover();
        };

        const onReuseExistingWorktreeForBranch = (info: Readonly<{ worktreePath: string; branch: string }>) => {
            params.shouldReconcileInitialHydratedCheckoutCreationDraftRef.current = false;
            params.setCheckoutCreationDraft(null);
            clearPending();
            params.setSelectedPath(info.worktreePath);
            closePopover();
        };

        const rootStep = buildWorktreeSelectionListSteps({
            snapshot: params.repoScmSnapshot,
            currentDirPath: currentPathOption?.kind === 'current_path' ? currentPathOption.path : params.selectedPath,
            machineId: params.selectedMachineId,
            machinePath: params.repoScmSnapshot?.repo.rootPath ?? params.selectedPath,
            machineHomeDir: params.machineHomeDir ?? null,
            rowIconColor,
            nowMs,
            onSelectCurrentDir,
            onSelectExistingWorktree,
            onSelectBranchForNewWorktree,
            onReuseExistingWorktreeForBranch,
        });

        const selectedLabel = optionsById[params.checkoutChipModel.selectedOptionId]?.label
            ?? t('newSession.checkout.noWorktree');

        function CheckoutChip(props: { ctx: AgentInputExtraActionChipRenderContext }) {
            const { ctx } = props;

            React.useEffect(() => {
                if (!params.checkoutPickerOpen) return;
                // Bridge the legacy auto-open state into the shared overlay controller so the checkout picker
                // participates in the global "only one popover open" behaviour.
                ctx.toggleCollapsedPopover?.(CHIP_KEY);
                params.setCheckoutPickerOpen(false);
            }, [ctx.toggleCollapsedPopover]);

            return (
                <Pressable
                    ref={ctx.chipAnchorRef}
                    testID="new-session-checkout-chip"
                    onPress={() => {
                        if (ctx.toggleCollapsedPopover) {
                            ctx.toggleCollapsedPopover(CHIP_KEY);
                            return;
                        }
                        params.setCheckoutPickerOpen((current) => !current);
                    }}
                    hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                    style={({ pressed }) => ctx.chipStyle(pressed)}
                    accessibilityRole="button"
                    accessibilityLabel={t('newSession.checkout.selectTitle')}
                >
                    {normalizeNodeForView(<Ionicons name="layers-outline" size={16} color={ctx.iconColor} />)}
                    {ctx.showLabel ? (
                        <Text numberOfLines={1} style={ctx.textStyle}>
                            {selectedLabel}
                        </Text>
                    ) : null}
                </Pressable>
            );
        }

        return {
            key: CHIP_KEY,
            controlId: 'checkout',
            collapsedOptionsPopover: {
                presentation: 'list',
                title: t('newSession.checkout.selectTitle'),
                label: selectedLabel,
                icon: (tint: string) => normalizeNodeForView(<Ionicons name="layers-outline" size={16} color={tint} />),
                rootStep,
                selectedOptionId: params.checkoutChipModel.selectedOptionId,
                onSelect: () => {
                    // Selection actions live on each SelectionList option's `onSelect`; the wrapper
                    // forwards the selected id here only for parity with the chip-picker contract.
                    // No-op: actions have already been dispatched by the option callbacks.
                },
                maxHeightCap: 480,
                maxWidthCap: 720,
                heightBehavior: 'stabilizedContentHeight',
            },
            render: (ctx) => <CheckoutChip ctx={ctx} />,
        };
    }, [
        params.checkoutChipModel,
        params.checkoutPickerOpen,
        params.machineHomeDir,
        params.pendingGitWorktreeBaseRefRef,
        params.pendingGitWorktreeSourceKindRef,
        params.repoScmSnapshot,
        params.router,
        params.selectedMachineId,
        params.selectedPath,
        params.setCheckoutCreationDraft,
        params.setCheckoutPickerOpen,
        params.setSelectedPath,
        params.shouldReconcileInitialHydratedCheckoutCreationDraftRef,
        nowMs,
        rowIconColor,
    ]);
}
