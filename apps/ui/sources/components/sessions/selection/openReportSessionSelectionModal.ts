import { Modal } from '@/modal';
import { createDeferredOnce } from '@/modal/async/createDeferredOnce';
import type { ModalPortalTarget } from '@/modal/portal/ModalPortalTarget';
import { t } from '@/text';

import { ReportSessionSelectionModal, type ReportSessionSelection } from './ReportSessionSelectionModal';
import {
    SESSION_SELECTION_MODAL_DEFAULT_MAX_HEIGHT_RATIO,
    SESSION_SELECTION_MODAL_SIZE,
    SESSION_SELECTION_MODAL_WIDTH,
} from './resolveSessionSelectionModalLayout';

export async function openReportSessionSelectionModal(params: Readonly<{
    allowNoSession?: boolean;
    webPortalTarget?: ModalPortalTarget | null;
}> = {}): Promise<ReportSessionSelection> {
    const deferred = createDeferredOnce<ReportSessionSelection>();
    Modal.show({
        webPortalTarget: params.webPortalTarget ?? null,
        component: ReportSessionSelectionModal,
        props: { allowNoSession: params.allowNoSession, onResolve: deferred.resolve },
        onRequestClose: () => deferred.resolve(undefined),
        chrome: {
            kind: 'card',
            title: t('bugReports.sessionPickerTitle'),
            testID: 'report-session-selection-modal',
            layout: 'fill',
            dimensions: {
                width: SESSION_SELECTION_MODAL_WIDTH,
                maxHeightRatio: SESSION_SELECTION_MODAL_DEFAULT_MAX_HEIGHT_RATIO,
                size: SESSION_SELECTION_MODAL_SIZE,
            },
        },
        closeOnBackdrop: true,
    });
    return await deferred.promise;
}
