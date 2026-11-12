import { Modal } from '@/modal';
import { createAnchoredPickerChrome } from '@/modal/components/card/anchoredSheetChrome';
import type { PopoverAnchor } from '@/components/ui/popover';

import { createDeferredOnce } from '@/modal/async/createDeferredOnce';
import { t } from '@/text';

import { TranscriptSendToSessionModal } from './TranscriptSendToSessionModal';
import type { SendTranscriptSelectionDestination } from './sendTranscriptSelectionToSession';

/**
 * No-invoke selection mode of the incumbent Home-scoped native Session picker: a reference by default,
 * or a destination for Session records (excluding its source, editable Sessions only).
 */
export function presentSessionAddressSelection(serverId: string, anchor?: PopoverAnchor,
    destination?: Readonly<{ excludedSessionId: string; capability: 'editSessionRecords'; title: string }>) {
    const deferred = createDeferredOnce<SendTranscriptSelectionDestination | null>();
    let modalId = '';
    let closed = false;
    const settle = (selection: SendTranscriptSelectionDestination | null) => {
        if (closed) return;
        closed = true;
        deferred.resolve(selection);
        if (modalId) Modal.hide(modalId);
    };
    const close = () => settle(null);
    modalId = Modal.show({
        component: TranscriptSendToSessionModal,
        props: { selectionOnly: true, sourceServerId: serverId, onResolve: settle, ...(destination ? { destination } : {}) },
        onRequestClose: close,
        onHostUnmount: close,
        closeOnBackdrop: true,
        chrome: createAnchoredPickerChrome({ title: destination?.title ?? t('sessionGettingStarted.title.selectSession'), anchor }),
    });
    if (!modalId) close();
    else if (closed) Modal.hide(modalId);
    return { result: deferred.promise, close };
}
