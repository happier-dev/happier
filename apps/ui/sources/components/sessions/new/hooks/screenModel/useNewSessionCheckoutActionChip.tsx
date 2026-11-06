import { getNewSessionCheckoutActionChipPlacement } from '../../newSessionActionChipPlacements';
import * as React from 'react';
import { Pressable } from 'react-native';

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
import type { NewSessionCheckoutCreationDraft } from '@/sync/domains/state/newSessionCheckoutDraft';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { Icon } from '@/components/ui/icons/Icon';
import { AGENT_INPUT_CHIP_ICON_SIZE_PX, AGENT_INPUT_CHIP_ICON_STYLE } from '@/components/sessions/agentInput/definitions/agentInputChipIconMetrics';

import type { WorktreeCreateSelection } from './buildWorktreeSelectionListSteps';
import { useCheckoutSelectionPicker } from './useCheckoutSelectionPicker';

const CHIP_KEY = 'new-session-checkout';

/**
 * Module scope on purpose. The chip descriptor below is rebuilt whenever any of its inputs move —
 * including the once-a-minute tick that keeps the picker's relative times fresh. A component
 * declared inside that rebuild would be a new type each time, so React would unmount and remount the
 * chip on a timer, dropping its press state and re-running the popover bridge below as if it were a
 * fresh mount. Everything the chip used to close over arrives as props instead.
 */
function CheckoutChip(props: Readonly<{
    ctx: AgentInputExtraActionChipRenderContext;
    label: string;
    checkoutPickerOpen: boolean;
    setCheckoutPickerOpen: React.Dispatch<React.SetStateAction<boolean>>;
}>) {
    const { ctx, checkoutPickerOpen, setCheckoutPickerOpen } = props;
    const toggleCollapsedPopover = ctx.toggleCollapsedPopover;

    React.useEffect(() => {
        if (!checkoutPickerOpen) return;
        // Bridge the legacy auto-open state into the shared overlay controller so the checkout picker
        // participates in the global "only one popover open" behaviour. `checkoutPickerOpen` is a
        // dependency because the chip now survives the rebuild that used to remount it.
        toggleCollapsedPopover?.(CHIP_KEY);
        setCheckoutPickerOpen(false);
    }, [toggleCollapsedPopover, checkoutPickerOpen, setCheckoutPickerOpen]);

    return (
        <Pressable
            ref={ctx.chipAnchorRef}
            testID="new-session-checkout-chip"
            onPress={() => {
                if (toggleCollapsedPopover) {
                    toggleCollapsedPopover(CHIP_KEY);
                    return;
                }
                setCheckoutPickerOpen((current) => !current);
            }}
            hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
            style={({ pressed }) => ctx.chipStyle(pressed)}
            accessibilityRole="button"
            accessibilityLabel={t('newSession.checkout.selectTitle')}
        >
            {normalizeNodeForView(<Icon name="stack-simple" size={AGENT_INPUT_CHIP_ICON_SIZE_PX} color={ctx.iconColor} style={AGENT_INPUT_CHIP_ICON_STYLE} />)}
            {ctx.showLabel ? (
                <Text numberOfLines={1} style={ctx.textStyle}>
                    {props.label}
                </Text>
            ) : null}
        </Pressable>
    );
}

export function useNewSessionCheckoutActionChip(params: Readonly<{
    repoScmSnapshot: ScmWorkingSnapshot | null;
    checkoutChipModel: NewSessionCheckoutChipModel;
    checkoutPickerOpen: boolean;
    setCheckoutPickerOpen: React.Dispatch<React.SetStateAction<boolean>>;
    checkoutCreationDraft: NewSessionCheckoutCreationDraft | null;
    serverId?: string | null;
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
    /**
     * Optional machine platform. Used with `machineHomeDir` for platform-specific path aliases such
     * as macOS `/private/tmp` and `/tmp`.
     */
    machinePlatform?: string | null;
}>): AgentInputExtraActionChip | null {
    const {
        checkoutCreationDraft,
        checkoutPickerOpen,
        pendingGitWorktreeBaseRefRef,
        pendingGitWorktreeSourceKindRef,
        setCheckoutCreationDraft,
        setCheckoutPickerOpen,
        setSelectedPath,
        shouldReconcileInitialHydratedCheckoutCreationDraftRef,
    } = params;

    const clearPending = React.useCallback(() => {
        pendingGitWorktreeBaseRefRef.current = null;
        pendingGitWorktreeSourceKindRef.current = 'current';
    }, [pendingGitWorktreeBaseRefRef, pendingGitWorktreeSourceKindRef]);
    const closePopover = React.useCallback(() => {
        setCheckoutPickerOpen(false);
    }, [setCheckoutPickerOpen]);

    // Choosing an existing checkout — the folder itself, a listed worktree or
    // the one a branch already has — is one effect here: it retires any pending
    // creation and moves the Session's path.
    const selectCheckoutPath = React.useCallback((path: string | null) => {
        shouldReconcileInitialHydratedCheckoutCreationDraftRef.current = false;
        setCheckoutCreationDraft(null);
        clearPending();
        if (path !== null) setSelectedPath(path);
        closePopover();
    }, [clearPending, closePopover, setCheckoutCreationDraft, setSelectedPath, shouldReconcileInitialHydratedCheckoutCreationDraftRef]);

    const createWorktree = React.useCallback((selection: WorktreeCreateSelection) => {
        shouldReconcileInitialHydratedCheckoutCreationDraftRef.current = false;
        pendingGitWorktreeBaseRefRef.current = selection.baseRef;
        pendingGitWorktreeSourceKindRef.current = selection.sourceKind;
        setCheckoutCreationDraft((current) => buildGitWorktreeCheckoutCreationDraft({
            existingDraft: current,
            // The name is user-chosen (or the accepted suggestion) and already
            // git-sanitized, so it is authoritative — never silently keep a
            // previously generated name.
            displayName: selection.name,
            fallbackDisplayName: selection.name,
            baseRef: selection.baseRef,
            branchMode: 'new',
        }));
        clearPending();
        closePopover();
    }, [
        clearPending,
        closePopover,
        pendingGitWorktreeBaseRefRef,
        pendingGitWorktreeSourceKindRef,
        setCheckoutCreationDraft,
        shouldReconcileInitialHydratedCheckoutCreationDraftRef,
    ]);

    // A pending git-worktree creation (chosen but not yet materialized) is
    // surfaced as a selected "New worktree: <name>" row so the choice is
    // visible/highlighted on reopen.
    const pendingWorktreeName = checkoutCreationDraft?.kind === 'git_worktree'
        ? checkoutCreationDraft.displayName
        : null;
    const pendingWorktreeBaseRef = checkoutCreationDraft?.kind === 'git_worktree'
        ? checkoutCreationDraft.baseRef ?? null
        : null;
    const creation = React.useMemo(() => ({
        pendingWorktree: pendingWorktreeName === null
            ? null
            : { name: pendingWorktreeName, baseRef: pendingWorktreeBaseRef },
        onCreateWorktree: createWorktree,
        onSelectPendingWorktree: closePopover,
    }), [closePopover, createWorktree, pendingWorktreeBaseRef, pendingWorktreeName]);

    const picker = useCheckoutSelectionPicker({
        repoScmSnapshot: params.repoScmSnapshot,
        checkoutChipModel: params.checkoutChipModel,
        ...(params.serverId !== undefined ? { serverId: params.serverId } : {}),
        selectedMachineId: params.selectedMachineId,
        selectedPath: params.selectedPath,
        machineHomeDir: params.machineHomeDir ?? null,
        machinePlatform: params.machinePlatform ?? null,
        onSelectCheckoutPath: selectCheckoutPath,
        creation,
    });

    return React.useMemo<AgentInputExtraActionChip | null>(() => {
        if (picker === null) return null;
        return {
            key: CHIP_KEY,
            controlId: 'checkout',
            placement: getNewSessionCheckoutActionChipPlacement(),
            collapsedOptionsPopover: {
                presentation: 'list',
                title: t('newSession.checkout.selectTitle'),
                label: picker.selectedLabel,
                icon: (tint: string) => normalizeNodeForView(<Icon name="stack-simple" size={16} color={tint} />),
                rootStep: picker.rootStep,
                selectedOptionId: picker.selectedOptionId,
                onSelect: () => {
                    // Selection actions live on each SelectionList option's `onSelect`; the wrapper
                    // forwards the selected id here only for parity with the chip-picker contract.
                    // No-op: actions have already been dispatched by the option callbacks.
                },
                maxHeightCap: 480,
                maxWidthCap: 720,
                heightBehavior: 'stabilizedContentHeight',
            },
            render: (ctx) => (
                <CheckoutChip
                    ctx={ctx}
                    label={picker.selectedLabel}
                    checkoutPickerOpen={checkoutPickerOpen}
                    setCheckoutPickerOpen={setCheckoutPickerOpen}
                />
            ),
        };
    }, [checkoutPickerOpen, picker, setCheckoutPickerOpen]);
}
