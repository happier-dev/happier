import { SharedSavedSecretReferenceSelectionV1Schema, type SharedSavedSecretReferenceSelectionV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';

import { Modal } from '@/modal';
import { createAnchoredPickerChrome } from '@/modal/components/card/anchoredSheetChrome';
import type { PopoverAnchor } from '@/components/ui/popover/_types';
import { t } from '@/text';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { SavedSecretPickerModal } from './SavedSecretPickerModal';

/**
 * The one saved-secret picker: an anchored glass sheet at the control that opened it (a bottom sheet on phones),
 * search and rows. It returns only a current exact reference or cancellation.
 */
export function presentSavedSecretReferencePicker(input: Readonly<{
    accountLifetime: ActiveServerAccountScopeLifetime;
    selected?: unknown;
    signal: AbortSignal;
    isCurrent: () => boolean;
    /** The control that opened it; without one the sheet centres. */
    anchor?: PopoverAnchor;
}>): Promise<SharedSavedSecretReferenceSelectionV1 | null> {
    if (input.signal.aborted || !input.accountLifetime.isCurrent() || !input.isCurrent()) return Promise.resolve(null);
    return new Promise(resolve => {
        let modalId = '';
        let settled = false;
        let detachLifetime = () => {};
        const finish = (selection: SharedSavedSecretReferenceSelectionV1 | null) => {
            if (settled) return;
            settled = true;
            input.signal.removeEventListener('abort', cancel);
            detachLifetime();
            const current = !input.signal.aborted && input.accountLifetime.isCurrent() && input.isCurrent();
            resolve(current ? selection : null);
            if (modalId) Modal.hide(modalId);
        };
        const cancel = () => finish(null);
        const lifetime = input.accountLifetime.onRetire(cancel);
        detachLifetime = () => lifetime.dispose();
        if (settled) { lifetime.dispose(); return; }
        if (input.signal.aborted) { cancel(); return; }
        input.signal.addEventListener('abort', cancel, { once: true });
        const selected = SharedSavedSecretReferenceSelectionV1Schema.safeParse(input.selected);
        modalId = Modal.show({
            component: SavedSecretPickerModal,
            props: {
                scope: input.accountLifetime.scope,
                referenceSelection: {
                    selected: selected.success ? selected.data : null,
                    onSelect: (selection: SharedSavedSecretReferenceSelectionV1) => {
                        const parsed = SharedSavedSecretReferenceSelectionV1Schema.safeParse(selection);
                        if (parsed.success) finish(parsed.data);
                    },
                },
            },
            chrome: {
                ...createAnchoredPickerChrome({
                    title: t('connectedServicesSettings.manualUseSavedSecret'),
                    testID: 'saved-secret-picker-sheet',
                    anchor: input.anchor,
                }),
                // The list scrolls under its search inside the sheet's bound.
                bodyScroll: 'none',
            },
            onRequestClose: cancel,
            onHostUnmount: cancel,
            closeOnBackdrop: true,
        });
        if (!modalId || input.signal.aborted || !input.accountLifetime.isCurrent() || !input.isCurrent()) cancel();
        if (settled && modalId) Modal.hide(modalId);
    });
}
