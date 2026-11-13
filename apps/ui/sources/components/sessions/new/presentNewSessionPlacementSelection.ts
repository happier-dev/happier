import type { PluginUiSessionPlacementCandidateV1 } from '@happier-dev/protocol/plugins/ui';
import { SelectionList, SELECTION_LIST_MODAL_MAX_HEIGHT, resolveSelectionListModalHeightBehavior } from '@/components/ui/selectionList';
import type { PopoverAnchor } from '@/components/ui/popover';
import { Modal } from '@/modal';
import { createDeferredOnce } from '@/modal/async/createDeferredOnce';
import { createAnchoredPickerChrome } from '@/modal/components/card/anchoredSheetChrome';
import { t } from '@/text';
import { createNewSessionPlacementSelectionStep } from './newSessionPlacementSelectionStep';
import { readSessionPlacementCandidateRows } from './useSessionPlacementCandidateRows';

/** No-invoke presentation of New Session's existing saved-project picker. */
export function presentNewSessionPlacementSelection(
    candidates: readonly PluginUiSessionPlacementCandidateV1[],
    anchor?: PopoverAnchor,
) {
    const deferred = createDeferredOnce<PluginUiSessionPlacementCandidateV1 | null>();
    let modalId = '';
    let closed = false;
    const settle = (candidate: PluginUiSessionPlacementCandidateV1 | null) => {
        if (closed) return;
        closed = true;
        deferred.resolve(candidate);
        if (modalId) Modal.hide(modalId);
    };
    const close = () => settle(null);
    modalId = Modal.show({
        component: SelectionList,
        props: {
            // The picker lives for seconds, so what the Machines say as it opens is enough.
            rootStep: createNewSessionPlacementSelectionStep({ rows: readSessionPlacementCandidateRows(candidates), onSelect: settle }),
            onSelect: () => {},
            onRequestClose: close,
            selectedOptionId: null,
            maxHeight: SELECTION_LIST_MODAL_MAX_HEIGHT,
            heightBehavior: resolveSelectionListModalHeightBehavior(),
        },
        chrome: createAnchoredPickerChrome({ title: t('newSession.selectWorkingDirectoryTitle'), anchor }),
        onRequestClose: close,
        onHostUnmount: close,
        closeOnBackdrop: true,
    });
    if (!modalId) close();
    else if (closed) Modal.hide(modalId);
    return { result: deferred.promise, close };
}
