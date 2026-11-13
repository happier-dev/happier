import { Modal } from '@/modal';
import { createDeferredOnce } from '@/modal/async/createDeferredOnce';
import type { ModalPortalTarget } from '@/modal/portal/ModalPortalTarget';
import { t } from '@/text';
import {
  SESSION_SELECTION_MODAL_DEFAULT_MAX_HEIGHT_RATIO,
  SESSION_SELECTION_MODAL_SIZE,
  SESSION_SELECTION_MODAL_WIDTH,
} from '@/components/sessions/selection/resolveSessionSelectionModalLayout';

import {
  PromptRuntimePreviewSessionSelectionModal,
  type PromptRuntimePreviewSessionSelection,
} from './PromptRuntimePreviewSessionSelectionModal';

export async function openPromptRuntimePreviewSessionSelectionModal(params: Readonly<{
  webPortalTarget?: ModalPortalTarget | null;
}> = {}): Promise<PromptRuntimePreviewSessionSelection> {
  const deferred = createDeferredOnce<PromptRuntimePreviewSessionSelection>();
  Modal.show({
    webPortalTarget: params.webPortalTarget ?? null,
    component: PromptRuntimePreviewSessionSelectionModal,
    props: { onResolve: deferred.resolve },
    onRequestClose: () => deferred.resolve(undefined),
    chrome: {
      kind: 'card',
      title: t('promptLibrary.runtimePreviewSessionPickerTitle'),
      testID: 'prompt-runtime-preview-session-selection-modal',
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
