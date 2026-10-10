import * as React from 'react';

import { Modal } from '@/modal';
import { t } from '@/text';
import {
    runUnsavedChangesGuard,
    type ActiveUnsavedChangesGuard,
} from '@/utils/navigation/runGuardedNavigation';
import { useUnsavedChangesBeforeRemoveGuard } from '@/utils/navigation/useUnsavedChangesBeforeRemoveGuard';
import { promptUnsavedChangesAlert } from '@/utils/ui/promptUnsavedChangesAlert';

type NavigationDispatcher = Readonly<{ dispatch?: (action: unknown) => void }>;

/**
 * One unsaved-draft departure contract for an authoring page.
 *
 * Cancel, native/hardware Back, the shell's own navigation and a browser unload
 * are the same decision about the same dirty draft, and each authoring host was
 * re-deriving it: the canonical copy keys, the discard/save wiring, the
 * intercepted-action continuation and the Cancel runner. This binds a host's
 * dirty state to the existing guard owners once so the decision has a single
 * shape, and returns explicit departure and Back entry points for that page.
 * A host may pop on Back while explicit Discard returns to a fixed destination;
 * both continuations still run through this same dirty decision.
 *
 * It owns no draft: `isDirty`, `onDiscard` and `onSave` stay with the host that
 * knows what changed and how to commit it. `continueOnSave` is deliberately
 * fixed to `false` because a save owner decides where the person goes next, and
 * a refused save must never navigate away from work it did not persist.
 */
export function useUnsavedDraftNavigationGuard(params: Readonly<{
    navigation: unknown;
    isDirty: boolean;
    /** Clears the host's own dirty bookkeeping once the person discards. */
    onDiscard?: () => void;
    /** Commits through the host's canonical save owner; `false` keeps the page. */
    onSave?: () => boolean | Promise<boolean>;
    /** Where an allowed departure goes when no intercepted action was supplied. */
    onLeave?: () => void;
    /** Back/history may pop an existing entry while an explicit discard has a fixed destination. */
    onBack?: () => void;
    tag: string;
}>): Readonly<{ requestLeave: () => void; requestBack: () => void; allowSavedNavigation: () => void }> {
    const { isDirty, navigation, onDiscard, onLeave, onBack = onLeave, onSave, tag } = params;
    const isDirtyRef = React.useRef(isDirty);
    isDirtyRef.current = isDirty;
    const ignoreRef = React.useRef(false);

    const requestDecision = React.useCallback(() => promptUnsavedChangesAlert(
        (title, message, buttons) => Modal.alert(title, message, buttons),
        {
            title: t('common.discardChanges'),
            message: t('common.unsavedChangesWarning'),
            discardText: t('common.discard'),
            ...(onSave ? { saveText: t('common.save') } : {}),
            keepEditingText: t('common.keepEditing'),
        },
    ), [onSave]);
    const discard = React.useCallback(() => {
        isDirtyRef.current = false;
        onDiscard?.();
    }, [onDiscard]);
    const continueNavigation = React.useCallback((action: unknown) => {
        const type = action && typeof action === 'object' && 'type' in action ? action.type : null;
        if (onBack && (type === 'GO_BACK' || type === 'POP' || type === 'POP_TO_TOP')) {
            onBack();
            return;
        }
        const dispatch = (navigation as NavigationDispatcher | null)?.dispatch;
        if (action && typeof dispatch === 'function') {
            dispatch(action);
            return;
        }
        onLeave?.();
    }, [navigation, onBack, onLeave]);

    const guard = React.useMemo<ActiveUnsavedChangesGuard>(() => ({
        isDirtyRef,
        ignoreRef,
        requestDecision,
        onDiscard: discard,
        onSave,
        continueOnSave: false,
        onHistoryLeave: onBack,
        tag,
    }), [discard, onBack, onSave, requestDecision, tag]);

    useUnsavedChangesBeforeRemoveGuard({
        isDirty,
        isDirtyRef,
        ignoreRef,
        requestDecision,
        onDiscard: discard,
        onSave,
        continueOnSave: false,
        onHistoryLeave: onBack,
        onContinue: continueNavigation,
        tag,
    });

    const requestLeave = React.useCallback(() => {
        void runUnsavedChangesGuard(guard, () => onLeave?.());
    }, [guard, onLeave]);

    const requestBack = React.useCallback(() => {
        void runUnsavedChangesGuard(guard, () => onBack?.());
    }, [guard, onBack]);

    const allowSavedNavigation = React.useCallback(() => {
        ignoreRef.current = true;
        isDirtyRef.current = false;
    }, []);

    return React.useMemo(() => ({ requestLeave, requestBack, allowSavedNavigation }), [requestLeave, requestBack, allowSavedNavigation]);
}
