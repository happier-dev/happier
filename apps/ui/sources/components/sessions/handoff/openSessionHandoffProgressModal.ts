import { Modal } from '@/modal';

import { SessionHandoffProgressModal } from './SessionHandoffProgressModal';

export function openSessionHandoffProgressModal(params?: Readonly<{
    title?: string;
    message?: string;
}>): string {
    return Modal.show({
        component: SessionHandoffProgressModal,
        props: {
            ...(params?.title ? { title: params.title } : {}),
            ...(params?.message ? { message: params.message } : {}),
        },
        closeOnBackdrop: false,
    });
}
