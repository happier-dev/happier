import { Modal } from '@/modal';
import { createAnchoredSheetChrome } from '@/modal/components/card/anchoredSheetChrome';
import type { PopoverAnchor } from '@/components/ui/popover';

import { ActionInputFormModal } from './ActionInputFormModal';
import type { ActionInputForm, ActionInputFormSubmissionResult } from './actionInputForm';
import type { InputTypePickerHostContext } from '@/components/sessions/actions/InputTypePickerHostProvider';

type AnyActionInputForm = ActionInputForm<
    ActionInputFormSubmissionResult,
    string,
    string
>;

/** Presents one transient normalized form; dispatch and persistence stay with its submit owner. */
export function presentActionInputForm(params: Readonly<{
    form: AnyActionInputForm;
    signal?: AbortSignal;
    pickerContext?: InputTypePickerHostContext;
    actionId?: string;
    anchor?: PopoverAnchor;
}>): void {
    let modalId = '';
    let retired = false;
    let detachFormRetirement: (() => void) | null = null;
    const onAbort = () => retire();
    const detachAbort = () => params.signal?.removeEventListener('abort', onAbort);
    const retire = () => {
        if (retired) return;
        retired = true;
        detachAbort();
        detachFormRetirement?.();
        detachFormRetirement = null;
        params.form.retire();
        if (modalId) Modal.hide(modalId);
    };
    const cancel = () => {
        params.form.cancel();
        retire();
    };

    if (params.signal?.aborted) {
        retire();
        return;
    }
    params.signal?.addEventListener('abort', onAbort, { once: true });
    modalId = Modal.show({
        component: ActionInputFormModal,
        props: {
            form: params.form,
            pickerContext: params.pickerContext,
            actionId: params.actionId,
            anchor: params.anchor,
            onRetire: retire,
        },
        onRequestClose: cancel,
        onHostUnmount: retire,
        closeOnBackdrop: true,
        chrome: createAnchoredSheetChrome({
            title: params.form.presentation.inputHints.title ?? params.form.presentation.title,
            subtitle: params.form.presentation.inputHints.description ?? params.form.presentation.description ?? undefined,
            anchor: params.anchor,
        }),
    });
    const unsubscribeFormRetirement = params.form.subscribe(() => {
        if (params.form.isRetired()) retire();
    });
    if (retired) unsubscribeFormRetirement();
    else detachFormRetirement = unsubscribeFormRetirement;
    if (!modalId || params.signal?.aborted || params.form.isRetired()) retire();
}
