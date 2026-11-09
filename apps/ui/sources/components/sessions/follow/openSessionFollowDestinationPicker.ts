import type { SessionFollowSourceKeyPreparationWaitingReasonV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowSourceKeyPreparationV1';

import type { FocusReturnRef } from '@/keyboard/focusReturn';
import { Modal } from '@/modal';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';

import { SessionFollowDestinationPickerModal } from './SessionFollowDestinationPickerModal';

export type SessionFollowSourcePreparationChange = Readonly<{
    sourceSessionId: string;
    destinationSessionId: string;
    preparation: 'waiting' | 'prepared';
    /**
     * The Protocol waiting reason the preparation actually returned, when one exists.
     * Absent while the first attempt is still queued; consumers must not invent one.
     */
    reason?: SessionFollowSourceKeyPreparationWaitingReasonV1;
}>;

export function openSessionFollowDestinationPicker(
    source: SessionAddress,
    focusReturnRef?: FocusReturnRef,
): void {
    Modal.show({
        component: SessionFollowDestinationPickerModal,
        props: { source },
        closeOnBackdrop: true,
        focusReturnRef,
    });
}

export function openSessionFollowSourcePicker(
    destination: SessionAddress,
    focusReturnRef?: FocusReturnRef,
    onChanged?: (change?: SessionFollowSourcePreparationChange) => void | Promise<void>,
): void {
    Modal.show({
        component: SessionFollowDestinationPickerModal,
        props: { destination, onChanged },
        closeOnBackdrop: true,
        focusReturnRef,
    });
}
