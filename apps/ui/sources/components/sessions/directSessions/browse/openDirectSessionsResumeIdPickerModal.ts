import type { DirectSessionsBrowseScopeLock } from './DirectSessionsBrowseScreen';
import { DirectSessionsResumeIdPickerModal } from './DirectSessionsResumeIdPickerModal';

import { Modal } from '@/modal';
import { createDeferredOnce } from '@/modal/async/createDeferredOnce';
import type { ModalPortalTarget } from '@/modal/portal/ModalPortalTarget';

export async function openDirectSessionsResumeIdPickerModal(params: Readonly<{
    lockScope: DirectSessionsBrowseScopeLock;
    title?: string;
    webPortalTarget?: ModalPortalTarget;
}>): Promise<string | null> {
    const deferred = createDeferredOnce<string | null>();
    Modal.show({
        webPortalTarget: params.webPortalTarget ?? null,
        component: DirectSessionsResumeIdPickerModal,
        props: {
            lockScope: params.lockScope,
            onResolve: deferred.resolve,
        },
        onRequestClose: () => deferred.resolve(null),
        chrome: {
            kind: 'card',
            title: params.title,
            testID: 'resume-id-browse-modal',
            dimensions: {
                width: 720,
                maxHeightRatio: 0.96,
                size: 'lg',
                viewportMargin: { horizontal: 12, vertical: 12 },
            },
        },
        closeOnBackdrop: true,
    });
    return await deferred.promise;
}
