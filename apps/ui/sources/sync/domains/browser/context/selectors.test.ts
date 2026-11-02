import { BrowserContextAnnotationItemV2Schema } from '@happier-dev/protocol/browser/context/v1';
import { describe, expect, it } from 'vitest';

import { selectBrowserContextComposerAttachments } from './selectors';
import { attachBrowserContextToComposer, createBrowserContextState, markBrowserContextViewNavigation } from './state';
import type { BrowserContextState } from './types';

function annotation(contextId: string, sourceViewId: string, annotationId = contextId) {
    return BrowserContextAnnotationItemV2Schema.parse({
        v: 1,
        contextId,
        sourceViewId,
        sourceAdapterKind: 'localPreview',
        fidelity: 'previewProxy',
        capturedAtMs: 100,
        navigationGeneration: 1,
        lifecycleState: 'available',
        redactionLevel: 'metadataOnly',
        kind: 'browserAnnotation',
        annotationId,
        browserSessionId: 'browser_1',
        imageRef: { mediaId: `flattened_${contextId}`, mediaKind: 'image', width: 260, height: 110, sizeBytes: 4096 },
        marks: {
            v: 1,
            image: { width: 260, height: 110, scale: 2 },
            marks: [{ id: 'element_1', kind: 'element', rect: { x: 0, y: 0, width: 20, height: 20 }, label: 'Submit', color: 'red' }],
        },
        elements: [{
            markId: 'element_1',
            selectorPath: '#submit',
            accessibleName: 'Submit',
            componentName: 'Checkout',
            sourceLocation: { file: 'src/Checkout.tsx', line: 12, column: 4 },
        }],
        pageTitle: 'Checkout',
        pageUrl: 'https://shop.example/checkout',
    });
}

function attach(state: BrowserContextState, contextId: string) {
    const result = attachBrowserContextToComposer(state, { attachmentId: `attachment_${contextId}`, contextId });
    if (result.status !== 'attached') throw new Error('fixture context could not be attached');
    return result.state;
}

describe('browser context composer attachments', () => {
    it('reads only selected context records when building composer attachments', () => {
        const selected = annotation('selected', 'view_1');
        const unselected = annotation('unselected', 'view_2');
        let unselectedReads = 0;
        const state = attach({
            ...createBrowserContextState(),
            itemsById: {
                selected,
                get unselected() { unselectedReads += 1; return unselected; },
            },
            itemOrder: ['selected', 'unselected'],
        }, 'selected');

        expect(selectBrowserContextComposerAttachments(state)[0]?.structuredBlock).toMatchObject({ imageRef: selected.imageRef });
        expect(unselectedReads).toBe(0);
    });

    it('projects one marks document with source facts per selected annotation without regrouping it', () => {
        const first = annotation('context_1', 'view_1', 'annotation_shared');
        const second = annotation('context_2', 'view_2', 'annotation_shared');
        let state: BrowserContextState = {
            ...createBrowserContextState(),
            itemsById: { context_1: first, context_2: second },
            itemOrder: ['context_1', 'context_2'],
        };
        state = attach(attach(state, 'context_1'), 'context_2');

        const attachments = selectBrowserContextComposerAttachments(state);
        expect(attachments).toHaveLength(2);
        for (const [index, item] of [first, second].entries()) {
            expect(attachments[index]?.structuredBlock).toEqual({
                v: 2,
                kind: 'browser.annotation.v2',
                annotationId: item.annotationId,
                browserSessionId: item.browserSessionId,
                sourceViewId: item.sourceViewId,
                contextIds: [item.contextId],
                imageRef: item.imageRef,
                marks: item.marks,
                elements: item.elements,
                pageUrl: item.pageUrl,
                pageTitle: item.pageTitle,
            });
        }
    });

    it('retains the committed marks and identifies only the navigated view as stale', () => {
        const first = annotation('context_1', 'view_1');
        const second = annotation('context_2', 'view_2');
        const state = attach(attach({
            ...createBrowserContextState(),
            itemsById: { context_1: first, context_2: second },
            itemOrder: ['context_1', 'context_2'],
        }, 'context_1'), 'context_2');
        const navigated = markBrowserContextViewNavigation(state, { viewId: 'view_1', navigationGeneration: 2 });

        const attachments = selectBrowserContextComposerAttachments(navigated);
        expect(attachments[0]).toMatchObject({ state: 'navigationStale', requiresReconfirmBeforeSend: true, structuredBlock: { marks: first.marks } });
        expect(attachments[1]).toMatchObject({ state: 'available', requiresReconfirmBeforeSend: false, structuredBlock: { marks: second.marks } });
    });
});
