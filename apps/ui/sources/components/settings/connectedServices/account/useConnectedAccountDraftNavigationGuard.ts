import * as React from 'react';

import { Modal } from '@/modal';
import {
    type ActiveUnsavedChangesGuard,
} from '@/utils/navigation/runGuardedNavigation';
import { useActiveUnsavedChangesGuard } from '@/utils/navigation/useActiveUnsavedChangesGuard';
import { useUnsavedChangesBeforeRemoveGuard } from '@/utils/navigation/useUnsavedChangesBeforeRemoveGuard';
import { t } from '@/text';
import { promptUnsavedChangesAlert } from '@/utils/ui/promptUnsavedChangesAlert';

type NavigationDispatcher = Readonly<{
    dispatch?: (action: unknown) => void;
}>;

/**
 * Binds one Connected Account form draft to the existing navigation guards.
 *
 * The shared guards remain the only decision-maker for Back, shell/sidebar,
 * browser-unload, and target navigation. This adapter only owns the local
 * draft reset and save callback for a form instance.
 */
export function useConnectedAccountDraftNavigationGuard(input: Readonly<{
    navigation: unknown;
    isDirty: boolean;
    onDiscard: () => void;
    onSave: () => boolean | Promise<boolean>;
    tag: string;
}>): void {
    const isDirtyRef = React.useRef(input.isDirty);
    isDirtyRef.current = input.isDirty;

    const requestDecision = React.useCallback(() => promptUnsavedChangesAlert(
        (title, message, buttons) => Modal.alert(title, message, buttons),
        {
            title: t('common.discardChanges'),
            message: t('common.unsavedChangesWarning'),
            discardText: t('common.discard'),
            saveText: t('common.save'),
            keepEditingText: t('common.keepEditing'),
        },
    ), []);
    const discard = React.useCallback(() => {
        input.onDiscard();
        isDirtyRef.current = false;
    }, [input.onDiscard]);
    const save = React.useCallback(async (): Promise<boolean> => {
        const saved = await input.onSave();
        if (saved) isDirtyRef.current = false;
        return saved;
    }, [input.onSave]);
    const continueNavigation = React.useCallback((action: unknown) => {
        (input.navigation as NavigationDispatcher | null)?.dispatch?.(action);
    }, [input.navigation]);
    const activeGuard = React.useMemo<ActiveUnsavedChangesGuard>(() => ({
        isDirtyRef,
        requestDecision,
        onDiscard: discard,
        onSave: save,
        tag: input.tag,
    }), [discard, input.tag, requestDecision, save]);

    useUnsavedChangesBeforeRemoveGuard({
        isDirty: input.isDirty,
        isDirtyRef,
        requestDecision,
        onDiscard: discard,
        onSave: save,
        onContinue: continueNavigation,
        tag: input.tag,
    });
    useActiveUnsavedChangesGuard({
        navigation: input.navigation,
        guard: activeGuard,
        enabled: input.isDirty,
    });
}
