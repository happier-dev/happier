import type { SessionHandoffStatus } from '@happier-dev/protocol';
import { Modal } from '@/modal';

import { SessionHandoffProgressModal } from './SessionHandoffProgressModal';

export function openSessionHandoffProgressModal(params?: Readonly<{
    title?: string;
    message?: string;
    status?: SessionHandoffStatus;
}>): string {
    return Modal.show({
        component: SessionHandoffProgressModal,
        props: {
            ...(params?.title ? { title: params.title } : {}),
            ...(params?.message ? { message: params.message } : {}),
            ...(params?.status ? { status: params.status } : {}),
        },
        closeOnBackdrop: false,
    });
}
