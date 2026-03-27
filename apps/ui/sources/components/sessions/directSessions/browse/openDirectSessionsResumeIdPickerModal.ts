import type { DirectSessionsBrowseScopeLock } from './DirectSessionsBrowseScreen';
import { DirectSessionsResumeIdPickerModal } from './DirectSessionsResumeIdPickerModal';

import { Modal } from '@/modal';
import { createDeferredOnce } from '@/modal/async/createDeferredOnce';

export async function openDirectSessionsResumeIdPickerModal(params: Readonly<{
    lockScope: DirectSessionsBrowseScopeLock;
    title?: string;
}>): Promise<string | null> {
    const deferred = createDeferredOnce<string | null>();
    Modal.show({
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
            layout: 'fill',
            dimensions: {
                width: 560,
                maxHeightRatio: 0.92,
                size: 'md',
            },
        },
        closeOnBackdrop: true,
    });
    return await deferred.promise;
}
