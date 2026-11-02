import { describe, expect, it } from 'vitest';
import { applyImageMarksOperations } from '@happier-dev/protocol';
import * as drafts from './annotationDraft';
import { createBrowserContextState, markBrowserContextViewNavigation } from './state';

const view = { browserSessionId: 'browser_1', viewId: 'view_1', navigationGeneration: 2 };
const source = { uri: 'data:image/png;base64,fixture', width: 1200, height: 800, scale: 2 };
const capture = { bytes: new Uint8Array([1, 2]), mimeType: 'image/png' as const, width: 1200, height: 800, sizeBytes: 2 };

describe('frozen browser annotation draft', () => {
    it('records picker facts without creating a second canvas mark', () => {
        let state = drafts.startBrowserAnnotationDraft(createBrowserContextState(), { ...view, source, capture, nowMs: 1 });
        const document = drafts.readFrozenBrowserAnnotationDraft(state, view.viewId)!.document;
        state = drafts.recordBrowserAnnotationElement(state, { viewId: view.viewId, markId: 'pay', element: {
            rect: { x: 10, y: 20, width: 30, height: 40 }, label: 'Pay', role: 'button', selectorPath: '#pay', componentName: 'PayButton',
        } });
        const draft = drafts.readFrozenBrowserAnnotationDraft(state, view.viewId)!;
        expect(draft.document).toBe(document);
        expect(draft.elements.pay).toEqual({ selectorPath: '#pay', componentName: 'PayButton' });
    });
    it('keeps one image-space document and element facts through edit/undo, then commits one comment-free item', () => {
        let state = drafts.startBrowserAnnotationDraft(createBrowserContextState(), { ...view, source, capture,
            pageUrl: 'https://shop.example/checkout?cart=private', pageTitle: 'Checkout', nowMs: 1 });
        state = drafts.addBrowserAnnotationElement(state, { viewId: view.viewId, markId: 'pay', color: 'blue', element: {
            rect: { x: 40, y: 60, width: 200, height: 80 }, label: 'Pay', role: 'button', selectorPath: '#pay',
            componentName: 'PayButton', sourceLocation: { file: 'src/Pay.tsx', line: 8 },
        } });
        const picked = drafts.readFrozenBrowserAnnotationDraft(state, view.viewId)!;
        expect(picked.document.marks).toEqual([{ id: 'pay', kind: 'element', color: 'blue', label: 'Pay',
            rect: { x: 40, y: 60, width: 200, height: 80 } }]);
        const edited = applyImageMarksOperations(picked.document, [{ kind: 'mark.add', mark: {
            id: 'secret', kind: 'blur', rect: { x: 300, y: 100, width: 160, height: 40 }, size: 'm',
        } }]);
        state = drafts.updateBrowserAnnotationDocument(state, { viewId: view.viewId, document: edited });
        expect(drafts.updateBrowserAnnotationDocument(state, { viewId: view.viewId, document: edited })).toBe(state);
        state = drafts.setBrowserAnnotationDraftComment(state, { viewId: view.viewId, comment: 'Fix this please' });
        state = drafts.updateBrowserAnnotationDocument(state, { viewId: view.viewId,
            document: applyImageMarksOperations(edited, [{ kind: 'mark.remove', id: 'pay' }]) });
        state = drafts.updateBrowserAnnotationDocument(state, { viewId: view.viewId, document: edited });
        const committed = drafts.commitBrowserAnnotationDraft({ state, ...view, adapterKind: 'externalUrl', capturedAtMs: 9,
            imageRef: { mediaId: 'flattened_1', mediaKind: 'image', width: 1200, height: 800, sizeBytes: 10 } });
        if (committed.status !== 'committed') throw new Error('expected frozen draft commit');
        expect(committed.itemIds).toHaveLength(1);
        const item = committed.state.itemsById[committed.itemIds[0]];
        expect(item).toMatchObject({ kind: 'browserAnnotation', imageRef: { mediaId: 'flattened_1' }, marks: edited,
            elements: [{ markId: 'pay', selectorPath: '#pay', componentName: 'PayButton', sourceLocation: { file: 'src/Pay.tsx', line: 8 } }],
            pageTitle: 'Checkout', pageUrl: 'https://shop.example/checkout' });
        for (const key of ['comment', 'media', 'target', 'stroke', 'styleIntent']) expect(item).not.toHaveProperty(key);
        expect(drafts.readFrozenBrowserAnnotationDraft(committed.state, view.viewId)).toBeNull();
        expect(picked.source).toBe(source);
        expect(picked.capture).toBe(capture);
    });

    it('preserves the captured page across navigation and exposes it as stale at commit', () => {
        let state = drafts.startBrowserAnnotationDraft(createBrowserContextState(), { ...view, source, capture, nowMs: 1 });
        const frozen = drafts.readFrozenBrowserAnnotationDraft(state, view.viewId);
        state = markBrowserContextViewNavigation(state, { viewId: view.viewId, navigationGeneration: 3 });
        expect(drafts.readFrozenBrowserAnnotationDraft(state, view.viewId)).toBe(frozen);
        const committed = drafts.commitBrowserAnnotationDraft({ state, ...view, adapterKind: 'externalUrl', capturedAtMs: 9,
            imageRef: { mediaId: 'flattened_1', mediaKind: 'image', width: 1200, height: 800, sizeBytes: 10 } });
        expect(committed.status).toBe('committed');
        if (committed.status === 'committed') expect(committed.state.navigationGenerationByViewId[view.viewId]).toBe(3);
    });
});
