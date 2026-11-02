import type {
    AttachBrowserContextToComposerInput,
    BrowserContextAttachResult,
    BrowserContextNavigationInput,
    BrowserContextState,
    BrowserContextUnavailableReason,
} from './types';

function createUnavailableReason(
    reasonCode: BrowserContextUnavailableReason['reasonCode'],
    lifecycleState: BrowserContextUnavailableReason['lifecycleState'],
    message: string,
): BrowserContextUnavailableReason {
    return { reasonCode, lifecycleState, message };
}

export function createBrowserContextState(): BrowserContextState {
    return {
        itemsById: {},
        itemOrder: [],
        attachmentsById: {},
        attachmentOrder: [],
        navigationGenerationByViewId: {},
        activeAnnotationByViewId: {},
        annotationDraftByViewId: {},
    };
}

export function attachBrowserContextToComposer(
    state: BrowserContextState,
    input: AttachBrowserContextToComposerInput,
): BrowserContextAttachResult {
    const item = state.itemsById[input.contextId];
    if (!item) {
        return {
            status: 'unavailable',
            state,
            reason: createUnavailableReason(
                'browser_context_item_missing',
                'adapterUnavailable',
                'Browser context item is no longer available.',
            ),
        };
    }
    if (item.lifecycleState !== 'available') {
        return {
            status: 'unavailable',
            state,
            reason: createUnavailableReason(
                'browser_context_item_unavailable',
                item.lifecycleState,
                item.disabledReason ?? 'Browser context item is not attachable.',
            ),
        };
    }

    const exists = state.attachmentsById[input.attachmentId] !== undefined;
    return {
        status: 'attached',
        state: {
            ...state,
            attachmentsById: {
                ...state.attachmentsById,
                [input.attachmentId]: {
                    attachmentId: input.attachmentId,
                    contextId: input.contextId,
                },
            },
            attachmentOrder: exists ? state.attachmentOrder : [...state.attachmentOrder, input.attachmentId],
        },
        attachmentId: input.attachmentId,
    };
}

export function removeBrowserContextComposerAttachment(
    state: BrowserContextState,
    input: Readonly<{ attachmentId: string }>,
): BrowserContextState {
    if (!state.attachmentsById[input.attachmentId]) {
        return state;
    }

    const { [input.attachmentId]: _removed, ...attachmentsById } = state.attachmentsById;
    return {
        ...state,
        attachmentsById,
        attachmentOrder: state.attachmentOrder.filter((attachmentId) => attachmentId !== input.attachmentId),
    };
}

export function markBrowserContextViewNavigation(
    state: BrowserContextState,
    input: BrowserContextNavigationInput,
): BrowserContextState {
    const current = state.navigationGenerationByViewId[input.viewId] ?? 0;
    if (input.navigationGeneration <= current) return state;

    return {
        ...state,
        navigationGenerationByViewId: {
            ...state.navigationGenerationByViewId,
            [input.viewId]: input.navigationGeneration,
        },
    };
}

export {
    captureBrowserPageReference,
    captureBrowserScreenshotReference,
    captureBrowserSelectedElement,
    captureBrowserSummaryContext,
    captureBrowserTextSelection,
    cancelBrowserAnnotationMode,
    resolveBrowserContextKindAvailability,
    startBrowserAnnotationMode,
} from './actions';
export { selectBrowserContextComposerAttachments } from './selectors';
export type {
    BrowserAnnotationModeResult,
    BrowserContextAttachResult,
    BrowserContextCaptureResult,
    BrowserContextState,
    BrowserContextUnavailableReason,
} from './types';
