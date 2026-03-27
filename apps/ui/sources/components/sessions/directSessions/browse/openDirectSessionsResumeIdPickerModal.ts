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
                title: params.title,
                onResolve: (value: string | null) => resolve(value),
                onRequestClose: () => resolve(null),
            },
            closeOnBackdrop: true,
        });
    });
}
