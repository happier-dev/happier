import { countBlurMarks, type ImageMarksDocumentV1 } from '@happier-dev/protocol/sessions/media/imageMarksV1';

export type CaptureDisclosureState = Readonly<{
    included: boolean;
    blurCount: number;
    warning: 'unseen' | 'pending' | 'acknowledged';
    showBlurCallout: boolean;
    restoreAtBlurCount: number | null;
}>;

export type CaptureDisclosureEvent =
    | Readonly<{ type: 'document'; blurCount: number; cause: 'edit' | 'undo' | 'redo' }>
    | Readonly<{ type: 'toggle'; included: boolean }>
    | Readonly<{ type: 'warning'; include: boolean }>
    | Readonly<{ type: 'input' }>;

export function createCaptureDisclosureState(included: boolean, blurCount = 0): CaptureDisclosureState {
    return { included: included && blurCount === 0, blurCount, warning: 'unseen', showBlurCallout: false, restoreAtBlurCount: null };
}

/** Shared by window text and include-video; history remains owned by the annotator. */
export function reduceCaptureDisclosure(state: CaptureDisclosureState, event: CaptureDisclosureEvent): CaptureDisclosureState {
    switch (event.type) {
        case 'input':
            return state.showBlurCallout ? { ...state, showBlurCallout: false } : state;
        case 'warning':
            if (state.warning !== 'pending') return state;
            // Only Include acknowledges disclosure; declining cannot authorize a later enable.
            return { ...state, included: event.include, warning: event.include ? 'acknowledged' : 'unseen',
                showBlurCallout: false, restoreAtBlurCount: null };
        case 'toggle':
            if (event.included && state.blurCount > 0 && state.warning === 'unseen') {
                return { ...state, included: false, warning: 'pending', showBlurCallout: false, restoreAtBlurCount: null };
            }
            if (event.included && state.warning === 'pending') return state;
            if (event.included === state.included && !state.showBlurCallout && state.restoreAtBlurCount === null) return state;
            return { ...state, included: event.included, showBlurCallout: false, restoreAtBlurCount: null };
        case 'document': {
            if (event.blurCount === state.blurCount) return state;
            if (event.blurCount > state.blurCount) {
                return { ...state, blurCount: event.blurCount, included: false,
                    restoreAtBlurCount: state.included ? state.blurCount : state.restoreAtBlurCount,
                    showBlurCallout: state.included };
            }
            const restore = event.cause === 'undo' && state.restoreAtBlurCount !== null && event.blurCount <= state.restoreAtBlurCount;
            return { ...state, blurCount: event.blurCount, included: restore || state.included,
                restoreAtBlurCount: event.cause !== 'undo' || restore ? null : state.restoreAtBlurCount,
                showBlurCallout: false };
        }
    }
}

export function captureDisclosureIsAmber(state: CaptureDisclosureState): boolean {
    return state.included && state.blurCount > 0 && state.warning === 'acknowledged';
}

/** Hosts pass the annotator's committed document rather than duplicating blur classification. */
export function reduceCaptureDisclosureDocument(
    state: CaptureDisclosureState,
    document: ImageMarksDocumentV1,
    cause: 'edit' | 'undo' | 'redo',
): CaptureDisclosureState {
    return reduceCaptureDisclosure(state, { type: 'document', blurCount: countBlurMarks(document), cause });
}
