import { Modal } from '@/modal';
import { createDeferredOnce } from '@/modal/async/createDeferredOnce';
import type { ModalPortalTarget } from '@/modal/portal/ModalPortalTarget';
import { t } from '@/text';

import { TranscriptSendToSessionModal } from './TranscriptSendToSessionModal';
import {
    TRANSCRIPT_SEND_TO_SESSION_MODAL_DEFAULT_MAX_HEIGHT_RATIO,
    TRANSCRIPT_SEND_TO_SESSION_MODAL_SIZE,
    TRANSCRIPT_SEND_TO_SESSION_MODAL_WIDTH,
} from './resolveTranscriptSendToSessionModalLayout';
import type { SendTranscriptSelectionDestination } from './sendTranscriptSelectionToSession';

export async function openTranscriptSendToSessionModal(params: Readonly<{
    sourceSessionId: string;
    sourceServerId: string;
    previewText: string;
    webPortalTarget?: ModalPortalTarget | null;
}>): Promise<SendTranscriptSelectionDestination | null> {
    const deferred = createDeferredOnce<SendTranscriptSelectionDestination | null>();
    Modal.show({
        webPortalTarget: params.webPortalTarget ?? null,
        component: TranscriptSendToSessionModal,
        props: {
            sourceSessionId: params.sourceSessionId,
            sourceServerId: params.sourceServerId,
            previewText: params.previewText,
            onResolve: deferred.resolve,
        },
        onRequestClose: () => deferred.resolve(null),
        chrome: {
            kind: 'card',
            title: t('transcript.selection.sendTo.modalTitle'),
            testID: 'transcript-send-to-session-modal',
            dimensions: {
                width: TRANSCRIPT_SEND_TO_SESSION_MODAL_WIDTH,
                maxHeightRatio: TRANSCRIPT_SEND_TO_SESSION_MODAL_DEFAULT_MAX_HEIGHT_RATIO,
                size: TRANSCRIPT_SEND_TO_SESSION_MODAL_SIZE,
            },
        },
        closeOnBackdrop: true,
    });
    return await deferred.promise;
}
