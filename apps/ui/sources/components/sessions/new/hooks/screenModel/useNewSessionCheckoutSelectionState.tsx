import * as React from 'react';
import {
    resolveNewSessionCheckoutChipModel,
    type NewSessionCheckoutChipModel,
} from '@/components/sessions/new/modules/newSessionCheckoutChipModel';
import {
    resolveNewSessionCheckoutSelection,
    type NewSessionCheckoutCreationDraft,
} from '@/sync/domains/state/newSessionCheckoutDraft';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { generateWorktreeName } from '@/utils/worktree/generateWorktreeName';

export function useNewSessionCheckoutSelectionState(params: Readonly<{
    persistedDraft: unknown;
    tempSessionData?: unknown;
    selectedMachineId: string | null;
    selectedPath: string;
    repoScmSnapshot: ScmWorkingSnapshot | null;
    defaultCheckoutMode: 'current_path' | 'git_worktree';
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

    const [checkoutCreationDraft, setCheckoutCreationDraft] = React.useState<NewSessionCheckoutCreationDraft | null>(() => {
        return initialCheckoutSelection.checkoutCreationDraft;
    });
    const [checkoutSelectionExplicit, setCheckoutSelectionExplicit] = React.useState(initialCheckoutSelection.explicit);
    const setExplicitCheckoutCreationDraft = React.useCallback<React.Dispatch<React.SetStateAction<NewSessionCheckoutCreationDraft | null>>>((next) => {
        setCheckoutSelectionExplicit(true);
        setCheckoutCreationDraft(next);
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
        shouldReconcileInitialHydratedCheckoutCreationDraftRef.current = false;
        setCheckoutCreationDraft(initialCheckoutSelection.checkoutCreationDraft);
        setCheckoutSelectionExplicit(initialCheckoutSelection.explicit);
    }, [
        initialCheckoutSelection.checkoutCreationDraft,
        initialCheckoutSelection.explicit,
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
            setCheckoutCreationDraft(null);
        }
    }, [
        checkoutCreationDraft,
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
        if (checkoutCreationDraft === null) {
            return;
        }
        shouldReconcileInitialHydratedCheckoutCreationDraftRef.current = false;
        setCheckoutCreationDraft(null);
    }, [checkoutCreationDraft, params.selectedMachineId, params.selectedPath]);

    React.useEffect(() => {
        if (checkoutSelectionExplicit || params.repoScmSnapshot === null || checkoutCreationDraft !== null) return;
        if (
            params.defaultCheckoutMode !== 'git_worktree'
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
        checkoutSelectionExplicit,
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
