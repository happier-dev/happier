import * as React from 'react';

import { Modal, type CustomModalComponentType, type CustomModalInjectedProps } from '@/modal';
import type { FocusReturnRef } from '@/keyboard/focusReturn';

/**
 * One lifecycle for a workflow surface presented as a canonical modal card.
 *
 * Run detail presents two things this way — the Run-now input sheet, and on
 * compact layouts the selected invocation — and both need the same contract:
 * the caller stays the owner of the props, the sheet is shown once, updated in
 * place while it stays open, taken down when its intent ends, and never left
 * mounted after a route change. Keeping that in one place is what stops the
 * two from drifting into similar-but-different modal handling.
 *
 * `identity` names the thing the sheet is about. A different identity is a
 * different review, so the sheet is reopened fresh rather than updated — the
 * modal equivalent of a React `key`.
 */
export function useWorkflowCardModal<C extends CustomModalComponentType<any>>(params: Readonly<{
    open: boolean;
    component: C;
    /** Props, or `null` while the content they describe is unread; null closes the sheet. */
    props: Omit<React.ComponentProps<C>, keyof CustomModalInjectedProps> | null;
    identity?: string | null;
    title: string;
    /** The card's one-line purpose under its title (07 S22's Create with an agent). */
    subtitle?: string;
    testID: string;
    onRequestClose?: () => void;
    focusReturnRef?: FocusReturnRef;
}>): void {
    const { open, component, props, identity, title, subtitle, testID, onRequestClose, focusReturnRef } = params;
    const modalRef = React.useRef<Readonly<{ id: string; identity: string | null | undefined }> | null>(null);
    // The closing intent belongs to the latest render, but the sheet is shown
    // once: reading it through a ref keeps a stale callback out of the modal
    // without reopening the sheet every time the callback identity changes.
    const onRequestCloseRef = React.useRef(onRequestClose);
    onRequestCloseRef.current = onRequestClose;

    React.useEffect(() => {
        const current = modalRef.current;
        if (!open || props === null) {
            if (current !== null) {
                Modal.hide(current.id);
                modalRef.current = null;
            }
            return;
        }
        if (current !== null && current.identity === identity) {
            Modal.update(current.id, props);
            return;
        }
        if (current !== null) Modal.hide(current.id);
        const id = Modal.show<C>({
            component,
            props,
            onRequestClose: () => onRequestCloseRef.current?.(),
            closeOnBackdrop: true,
            ...(focusReturnRef === undefined ? {} : { focusReturnRef }),
            chrome: {
                kind: 'card',
                title,
                ...(subtitle === undefined ? {} : { subtitle }),
                testID,
                bodyScroll: 'auto',
                dimensions: { width: 520, maxHeightRatio: 0.92, size: 'md' },
            },
        });
        modalRef.current = { id, identity };
    }, [component, focusReturnRef, identity, open, props, subtitle, testID, title]);

    // A route change while the sheet is up must not leave it mounted.
    React.useEffect(() => () => {
        if (modalRef.current !== null) {
            Modal.hide(modalRef.current.id);
            modalRef.current = null;
        }
    }, []);
}
