import type { DirectSessionsBrowseScopeLock } from './DirectSessionsBrowseScreen';
import { DirectSessionsResumeIdPickerModal } from './DirectSessionsResumeIdPickerModal';

import { Modal } from '@/modal';

export async function openDirectSessionsResumeIdPickerModal(params: Readonly<{
    lockScope: DirectSessionsBrowseScopeLock;
    title?: string;
}>): Promise<string | null> {
    return await new Promise<string | null>((resolve) => {
        Modal.show({
            component: DirectSessionsResumeIdPickerModal,
            props: {
                lockScope: params.lockScope,
                onResolve: (value: string | null) => resolve(value),
            },
            onRequestClose: () => resolve(null),
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
    });
}
