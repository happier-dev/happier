import * as React from 'react';
import {
    resolveNewSessionCheckoutChipModel,
    type NewSessionCheckoutChipModel,
} from '@/components/sessions/new/modules/newSessionCheckoutChipModel';
import {
    readPersistedNewSessionCheckoutDraft,
    type NewSessionCheckoutCreationDraft,
} from '@/sync/domains/state/newSessionCheckoutDraft';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';

type HydratedCheckoutAuthoringDraft = Readonly<{
    checkoutCreationDraft?: NewSessionCheckoutCreationDraft | null;
}>;

export function useNewSessionCheckoutSelectionState(params: Readonly<{
    persistedDraft: unknown;
    hydratedTempAuthoringDraft: HydratedCheckoutAuthoringDraft | null;
    hydratedPersistedAuthoringDraft: HydratedCheckoutAuthoringDraft | null;
    selectedMachineId: string | null;
    selectedPath: string;
    repoScmSnapshot: ScmWorkingSnapshot | null;
    autoOpenWorktreePickerKey?: string | null;
}>): Readonly<{
    checkoutCreationDraft: NewSessionCheckoutCreationDraft | null;
    setCheckoutCreationDraft: React.Dispatch<React.SetStateAction<NewSessionCheckoutCreationDraft | null>>;
    checkoutPickerOpen: boolean;
    setCheckoutPickerOpen: React.Dispatch<React.SetStateAction<boolean>>;
    pendingGitWorktreeBaseRefRef: React.MutableRefObject<string | null>;
    pendingGitWorktreeSourceKindRef: React.MutableRefObject<'current' | 'local' | 'remote'>;
    shouldReconcileInitialHydratedCheckoutCreationDraftRef: React.MutableRefObject<boolean>;
    checkoutChipModel: NewSessionCheckoutChipModel;
}> {
    const persistedDraftRecord = React.useMemo<Record<string, unknown>>(() => {
        return params.persistedDraft && typeof params.persistedDraft === 'object' && !Array.isArray(params.persistedDraft)
            ? params.persistedDraft as Record<string, unknown>
            : {};
    }, [params.persistedDraft]);

    const initialCheckoutDraft = React.useMemo(() => {
        const checkoutDraft = readPersistedNewSessionCheckoutDraft({
            ...persistedDraftRecord,
            checkoutCreationDraft: params.hydratedTempAuthoringDraft?.checkoutCreationDraft ?? params.hydratedPersistedAuthoringDraft?.checkoutCreationDraft,
        });
        return checkoutDraft;
    }, [
        params.hydratedPersistedAuthoringDraft?.checkoutCreationDraft,
        params.hydratedTempAuthoringDraft?.checkoutCreationDraft,
        persistedDraftRecord,
    ]);

    const [checkoutCreationDraft, setCheckoutCreationDraft] = React.useState<NewSessionCheckoutCreationDraft | null>(() => {
        return initialCheckoutDraft.checkoutCreationDraft;
    });
    const hasAppliedCheckoutDraftEffectRef = React.useRef(false);
    const shouldReconcileInitialHydratedCheckoutCreationDraftRef = React.useRef(initialCheckoutDraft.checkoutCreationDraft !== null);
    const [checkoutPickerOpen, setCheckoutPickerOpen] = React.useState(false);
    const pendingGitWorktreeBaseRefRef = React.useRef<string | null>(null);
    const pendingGitWorktreeSourceKindRef = React.useRef<'current' | 'local' | 'remote'>('current');
    const previousSelectionKeyRef = React.useRef<string | null>(null);
    const lastAutoOpenWorktreePickerKeyRef = React.useRef<string | null>(null);

    React.useEffect(() => {
        if (!hasAppliedCheckoutDraftEffectRef.current) {
            hasAppliedCheckoutDraftEffectRef.current = true;
            return;
        }
        shouldReconcileInitialHydratedCheckoutCreationDraftRef.current = false;
        setCheckoutCreationDraft(initialCheckoutDraft.checkoutCreationDraft);
    }, [
        initialCheckoutDraft.checkoutCreationDraft,
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
        setCheckoutCreationDraft,
        checkoutPickerOpen,
        setCheckoutPickerOpen,
        pendingGitWorktreeBaseRefRef,
        pendingGitWorktreeSourceKindRef,
        shouldReconcileInitialHydratedCheckoutCreationDraftRef,
        checkoutChipModel,
    };
}
