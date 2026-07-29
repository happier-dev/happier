import type { BrowserScreenshotMediaReferenceV1 } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import {
    addBrowserAnnotationDraftRegion,
    addBrowserAnnotationDraftTarget,
    commitBrowserAnnotationDraft,
    readBrowserAnnotationDraft,
    setBrowserAnnotationDraftComment,
} from './annotationDraft';
import { selectBrowserAnnotationGroups } from './selectors';
import { createBrowserContextState } from './state';
import type { BrowserContextState } from './types';

const media: BrowserScreenshotMediaReferenceV1 = {
    mediaId: 'media_union_crop_1',
    mediaKind: 'image',
    width: 260,
    height: 110,
    sizeBytes: 4096,
};

function seedThreeTargetDraft(state: BrowserContextState, viewId: string, browserSessionId: string) {
    const key = { browserSessionId, viewId, navigationGeneration: 1 } as const;
    let next = addBrowserAnnotationDraftTarget(state, {
        ...key,
        nowMs: 10,
        target: { kind: 'element', selectorPath: '#a', rect: { x: 0, y: 0, width: 20, height: 20 } },
    });
    next = addBrowserAnnotationDraftTarget(next, {
        ...key,
        nowMs: 11,
        target: { kind: 'element', selectorPath: '#b', rect: { x: 90, y: 40, width: 30, height: 30 } },
    });
    next = addBrowserAnnotationDraftRegion(next, { ...key, nowMs: 12, rect: { x: 190, y: 70, width: 60, height: 40 } });
    next = setBrowserAnnotationDraftComment(next, { viewId, comment: 'needs spacing' });
    return next;
}

describe('annotation grouping selector + multi-tab isolation', () => {
    it('renders exactly one group per annotationId for a multi-target commit (ANNO-4)', () => {
        let state = seedThreeTargetDraft(createBrowserContextState(), 'view_1', 'sess_1');
        const committed = commitBrowserAnnotationDraft({
            state,
            browserSessionId: 'sess_1',
            viewId: 'view_1',
            navigationGeneration: 1,
            adapterKind: 'localPreview',
            media,
            capturedAtMs: 100,
        });
        expect(committed.status).toBe('committed');
        if (committed.status !== 'committed') return;
        state = committed.state;

        const groups = selectBrowserAnnotationGroups(state);
        expect(groups).toHaveLength(1);
        expect(groups[0].annotationId).toBe(committed.annotationId);
        expect(groups[0].mediaId).toBe('media_union_crop_1');
        expect(groups[0].comment).toBe('needs spacing');
        // The single group maps back to all 3 member items → atomic clear/delete + one media release.
        expect(groups[0].contextIds).toHaveLength(3);
        expect(new Set(groups[0].contextIds)).toEqual(new Set(committed.itemIds));
    });

    it('isolates annotation drafts + committed groups across two views/tabs (ANNO-7 isolation)', () => {
        let state = createBrowserContextState();
        // Draft on view_1, commit it.
        state = seedThreeTargetDraft(state, 'view_1', 'sess_1');
        const committedA = commitBrowserAnnotationDraft({
            state,
            browserSessionId: 'sess_1',
            viewId: 'view_1',
            navigationGeneration: 1,
            adapterKind: 'localPreview',
            media,
            capturedAtMs: 100,
        });
        if (committedA.status !== 'committed') throw new Error('expected commit');
        state = committedA.state;

        // A second tab/view starts its own draft — it must not see view_1's draft, and committing
        // view_1 left view_2's draft untouched.
        state = addBrowserAnnotationDraftTarget(state, {
            browserSessionId: 'sess_2',
            viewId: 'view_2',
            navigationGeneration: 1,
            nowMs: 200,
            target: { kind: 'element', selectorPath: '#z', rect: { x: 1, y: 1, width: 5, height: 5 } },
        });

        // view_1's draft was cleared by its commit; view_2 owns an independent draft.
        expect(readBrowserAnnotationDraft(state, 'view_1')).toBeNull();
        expect(readBrowserAnnotationDraft(state, 'view_2')?.targets).toHaveLength(1);

        // Groups are keyed by annotationId; the second view has no committed group yet.
        const groups = selectBrowserAnnotationGroups(state);
        expect(groups).toHaveLength(1);
        expect(groups[0].sourceViewId).toBe('view_1');
    });
});
