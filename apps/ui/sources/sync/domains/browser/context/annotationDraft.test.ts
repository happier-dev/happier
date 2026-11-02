import { describe, expect, it, vi } from 'vitest';
import { closeBrowserAnnotationView, startBrowserAnnotationDraft } from './annotationDraft';
import { createBrowserContextState } from './state';

const VIEW = { browserSessionId: 'sess_1', viewId: 'view_1', navigationGeneration: 3 } as const;

describe('frozen annotation view lifetime', () => {
    it('releases only the closed view once and keeps the other tab draft', () => {
        const disposeClosed = vi.fn();
        const disposeOther = vi.fn();
        const source = { uri: 'blob:frozen', width: 40, height: 30, scale: 1 };
        const capture = { bytes: new Uint8Array([1]), mimeType: 'image/png' as const, width: 40, height: 30, sizeBytes: 1 };
        let state = startBrowserAnnotationDraft(createBrowserContextState(), { ...VIEW, source, capture, nowMs: 100, dispose: disposeClosed });
        state = startBrowserAnnotationDraft(state, { ...VIEW, viewId: 'other_tab', source, capture, nowMs: 100, dispose: disposeOther });
        const other = state.annotationDraftByViewId.other_tab;
        expect(closeBrowserAnnotationView(state, { browserSessionId: 'another_session', viewId: VIEW.viewId })).toBe(state);
        expect(closeBrowserAnnotationView(state, { ...VIEW, viewId: 'unrelated_tab' })).toBe(state);
        const closed = closeBrowserAnnotationView(state, VIEW);
        expect(disposeClosed).toHaveBeenCalledTimes(1);
        expect(disposeOther).not.toHaveBeenCalled();
        expect(closed.annotationDraftByViewId[VIEW.viewId]).toBeUndefined();
        expect(closed.annotationDraftByViewId.other_tab).toBe(other);
        expect(closeBrowserAnnotationView(closed, VIEW)).toBe(closed);
        expect(disposeClosed).toHaveBeenCalledTimes(1);
    });
});
