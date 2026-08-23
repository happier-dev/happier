import * as React from 'react';
import {
    resolveNewSessionCheckoutChipModel,
    type NewSessionCheckoutChipModel,
} from '@/components/sessions/new/modules/newSessionCheckoutChipModel';
import {
    resolveNewSessionCheckoutSelection,
    type NewSessionCheckoutCreationDraft,
    type NewSessionCheckoutMode,
    type NewSessionCheckoutSelection,
} from '@/sync/domains/state/newSessionCheckoutDraft';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { generateWorktreeName } from '@/utils/worktree/generateWorktreeName';

function resolveCheckoutCreationDraftAction(
    action: React.SetStateAction<NewSessionCheckoutCreationDraft | null>,
    current: NewSessionCheckoutCreationDraft | null,
): NewSessionCheckoutCreationDraft | null {
    return typeof action === 'function' ? action(current) : action;
}

export function useNewSessionCheckoutSelectionState(params: Readonly<{
    persistedDraft: unknown;
    tempSessionData?: unknown;
    selectedMachineId: string | null;
    selectedPath: string;
    repoScmSnapshot: ScmWorkingSnapshot | null;
    defaultCheckoutMode: NewSessionCheckoutMode;
    autoOpenWorktreePickerKey?: string | null;
}>): Readonly<{
    checkoutCreationDraft: NewSessionCheckoutCreationDraft | null;
    setCheckoutCreationDraft: React.Dispatch<React.SetStateAction<NewSessionCheckoutCreationDraft | null>>;
    checkoutSelectionExplicit: boolean;
    checkoutPickerOpen: boolean;
    setCheckoutPickerOpen: React.Dispatch<React.SetStateAction<boolean>>;
    pendingGitWorktreeBaseRefRef: React.MutableRefObject<string | null>;
    pendingGitWorktreeSourceKindRef: React.MutableRefObject<'current' | 'local' | 'remote'>;
    shouldReconcileInitialHydratedCheckoutCreationDraftRef: React.MutableRefObject<boolean>;
    checkoutChipModel: NewSessionCheckoutChipModel;
}> {
    const initialCheckoutSelection = React.useMemo(() => (
        resolveNewSessionCheckoutSelection(params.tempSessionData, params.persistedDraft)
    ), [params.persistedDraft, params.tempSessionData]);

    const [checkoutSelectionState, setCheckoutSelectionState] = React.useState<NewSessionCheckoutSelection>(initialCheckoutSelection);
    const hasLocalCheckoutSelectionAuthorityRef = React.useRef(false);
    const effectiveCheckoutSelection = !hasLocalCheckoutSelectionAuthorityRef.current
        && initialCheckoutSelection.explicitMode !== null
        ? initialCheckoutSelection
        : checkoutSelectionState;
    const checkoutCreationDraft = effectiveCheckoutSelection.checkoutCreationDraft;
    const checkoutSelectionExplicit = effectiveCheckoutSelection.explicitMode !== null;
    const setCheckoutCreationDraft = React.useCallback<React.Dispatch<React.SetStateAction<NewSessionCheckoutCreationDraft | null>>>((next) => {
        setCheckoutSelectionState((current) => ({
            ...current,
            checkoutCreationDraft: resolveCheckoutCreationDraftAction(next, current.checkoutCreationDraft),
        }));
    }, []);
    const setExplicitCheckoutCreationDraft = React.useCallback<React.Dispatch<React.SetStateAction<NewSessionCheckoutCreationDraft | null>>>((next) => {
        hasLocalCheckoutSelectionAuthorityRef.current = true;
        setCheckoutSelectionState((current) => {
            const checkoutCreationDraft = resolveCheckoutCreationDraftAction(next, current.checkoutCreationDraft);
            return {
                checkoutCreationDraft,
                explicitMode: checkoutCreationDraft ? 'git_worktree' : 'current_path',
            };
        });
    }, []);
    const hasAppliedCheckoutDraftEffectRef = React.useRef(false);
    const shouldReconcileInitialHydratedCheckoutCreationDraftRef = React.useRef(initialCheckoutSelection.checkoutCreationDraft !== null);
    const [checkoutPickerOpen, setCheckoutPickerOpen] = React.useState(false);
    const pendingGitWorktreeBaseRefRef = React.useRef<string | null>(null);
    const pendingGitWorktreeSourceKindRef = React.useRef<'current' | 'local' | 'remote'>('current');
    const previousSelectionKeyRef = React.useRef<string | null>(null);
    const lastAutoOpenWorktreePickerKeyRef = React.useRef<string | null>(null);
    const defaultWorktreeNameRef = React.useRef(generateWorktreeName());

    React.useEffect(() => {
        if (!hasAppliedCheckoutDraftEffectRef.current) {
            hasAppliedCheckoutDraftEffectRef.current = true;
            return;
        }
        if (hasLocalCheckoutSelectionAuthorityRef.current) {
            return;
        }
        shouldReconcileInitialHydratedCheckoutCreationDraftRef.current = false;
        setCheckoutSelectionState(initialCheckoutSelection);
    }, [
        initialCheckoutSelection.checkoutCreationDraft,
        initialCheckoutSelection.explicitMode,
    ]);

    const checkoutChipModel = React.useMemo(() => {
        return resolveNewSessionCheckoutChipModel({
            selectedPath: params.selectedPath,
            checkoutCreationDraft,
            repoSnapshot: params.repoScmSnapshot,
        });
    }, [
        checkoutCreationDraft,
        params.repoScmSnapshot,
        params.selectedPath,
    ]);

    React.useEffect(() => {
        const selectedExistingCheckout = checkoutChipModel.selectedOptionId.startsWith('checkout:');
        const shouldPreserveCheckoutCreationDraft = checkoutCreationDraft !== null
            && (
                (
                    !shouldReconcileInitialHydratedCheckoutCreationDraftRef.current
                    || !selectedExistingCheckout
                )
                && (
                    params.repoScmSnapshot === null
                    || (params.repoScmSnapshot.repo.isRepo === true && params.repoScmSnapshot.repo.backendId === 'git')
                )
            );

        if (!shouldPreserveCheckoutCreationDraft && checkoutCreationDraft !== null) {
            shouldReconcileInitialHydratedCheckoutCreationDraftRef.current = false;
            hasLocalCheckoutSelectionAuthorityRef.current = true;
            setCheckoutSelectionState({
                checkoutCreationDraft: null,
                explicitMode: effectiveCheckoutSelection.explicitMode === null ? null : 'current_path',
            });
        }
    }, [
        checkoutCreationDraft,
        effectiveCheckoutSelection.explicitMode,
        params.repoScmSnapshot,
        checkoutChipModel.selectedOptionId,
    ]);

    React.useEffect(() => {
        const selectionKey = `${params.selectedMachineId ?? ''}\n${params.selectedPath}`;
        if (previousSelectionKeyRef.current === null) {
            previousSelectionKeyRef.current = selectionKey;
            return;
        }
        if (previousSelectionKeyRef.current === selectionKey) {
            return;
        }
        previousSelectionKeyRef.current = selectionKey;
        hasLocalCheckoutSelectionAuthorityRef.current = true;
        if (checkoutCreationDraft === null) {
            return;
        }
        shouldReconcileInitialHydratedCheckoutCreationDraftRef.current = false;
        setCheckoutCreationDraft(null);
    }, [checkoutCreationDraft, params.selectedMachineId, params.selectedPath]);

    React.useEffect(() => {
        if (params.repoScmSnapshot === null || checkoutCreationDraft !== null) return;
        if (
            (effectiveCheckoutSelection.explicitMode ?? params.defaultCheckoutMode) !== 'git_worktree'
            || params.repoScmSnapshot.repo.isRepo !== true
            || params.repoScmSnapshot.repo.backendId !== 'git'
        ) {
            return;
        }

        setCheckoutCreationDraft({
            kind: 'git_worktree',
            displayName: defaultWorktreeNameRef.current,
            baseRef: null,
            branchMode: 'new',
        });
    }, [
        checkoutCreationDraft,
        effectiveCheckoutSelection.explicitMode,
        params.defaultCheckoutMode,
        params.repoScmSnapshot,
        params.selectedMachineId,
        params.selectedPath,
    ]);

    React.useEffect(() => {
        const autoOpenKey = params.autoOpenWorktreePickerKey ?? null;
        if (!autoOpenKey) {
            return;
        }
        if (!(params.repoScmSnapshot?.repo.isRepo === true && params.repoScmSnapshot.repo.backendId === 'git')) {
            return;
        }
        if (lastAutoOpenWorktreePickerKeyRef.current === autoOpenKey) {
            return;
        }
        lastAutoOpenWorktreePickerKeyRef.current = autoOpenKey;
        setCheckoutPickerOpen(true);
    }, [params.autoOpenWorktreePickerKey, params.repoScmSnapshot]);

    return {
        checkoutCreationDraft,
        setCheckoutCreationDraft: setExplicitCheckoutCreationDraft,
        checkoutSelectionExplicit,
        checkoutPickerOpen,
        setCheckoutPickerOpen,
        pendingGitWorktreeBaseRefRef,
        pendingGitWorktreeSourceKindRef,
        shouldReconcileInitialHydratedCheckoutCreationDraftRef,
        checkoutChipModel,
    };
}
