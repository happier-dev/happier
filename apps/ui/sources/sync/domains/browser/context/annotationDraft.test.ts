import type { BrowserScreenshotMediaReferenceV1 } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import {
    addBrowserAnnotationDraftRegion,
    addBrowserAnnotationDraftStroke,
    addBrowserAnnotationDraftTarget,
    commitBrowserAnnotationDraft,
    countBrowserAnnotationDraftMarks,
    readBrowserAnnotationDraft,
    removeBrowserAnnotationDraftTarget,
    resolveBrowserAnnotationDraftCropClip,
    setBrowserAnnotationDraftComment,
} from './annotationDraft';
import { createBrowserContextState, markBrowserContextViewNavigation } from './state';
import type { BrowserContextState } from './types';

const VIEW = { browserSessionId: 'sess_1', viewId: 'view_1', navigationGeneration: 3 } as const;

function seedTwoElementsRegionStrokeComment(initial?: BrowserContextState) {
    let state = initial ?? createBrowserContextState();
    state = addBrowserAnnotationDraftTarget(state, {
        ...VIEW,
        nowMs: 100,
        target: { kind: 'element', selectorPath: '#a', accessibleName: 'Alpha', rect: { x: 10, y: 10, width: 20, height: 20 } },
    });
    state = addBrowserAnnotationDraftTarget(state, {
        ...VIEW,
        nowMs: 110,
        target: { kind: 'element', selectorPath: '#b', rect: { x: 100, y: 50, width: 30, height: 30 } },
    });
    state = addBrowserAnnotationDraftRegion(state, {
        ...VIEW,
        nowMs: 120,
        rect: { x: 200, y: 80, width: 60, height: 40 },
    });
    state = addBrowserAnnotationDraftStroke(state, {
        ...VIEW,
        nowMs: 130,
        stroke: { shape: 'freehand', points: [{ x: 20, y: 20 }, { x: 240, y: 110 }] },
    });
    state = setBrowserAnnotationDraftComment(state, { viewId: VIEW.viewId, comment: '  needs spacing  ' });
    return state;
}

const media: BrowserScreenshotMediaReferenceV1 = {
    mediaId: 'media_union_crop_1',
    mediaKind: 'image',
    width: 260,
    height: 110,
    sizeBytes: 4096,
};

describe('annotationDraft reducer (editor session)', () => {
    it('accumulates targets/regions/strokes/comment under a per-view draft', () => {
        const state = seedTwoElementsRegionStrokeComment();
        const draft = readBrowserAnnotationDraft(state, VIEW.viewId);
        expect(draft).not.toBeNull();
        expect(draft?.targets).toHaveLength(2);
        expect(draft?.regions).toHaveLength(1);
        expect(draft?.strokes).toHaveLength(1);
        expect(draft?.comment).toBe('needs spacing');
        expect(draft?.navigationGeneration).toBe(3);
        // ≥1 mark gate: 2 element targets + 1 region + 1 stroke = 4 attachable marks.
        expect(countBrowserAnnotationDraftMarks(state, VIEW.viewId)).toBe(4);
    });

    it('resolves the device-pixel union-of-targets crop clip from the draft (ANNO-3)', () => {
        const state = seedTwoElementsRegionStrokeComment();
        const draft = readBrowserAnnotationDraft(state, VIEW.viewId);
        expect(draft).not.toBeNull();
        // Union of element rects {10,10,20,20}+{100,50,30,30}, region {200,80,60,40} and stroke
        // points (20,20)/(240,110): css {10,10,250,110}. × DPR 2 → device {20,20,500,220}.
        const clip = resolveBrowserAnnotationDraftCropClip(draft!, { devicePixelRatio: 2 });
        expect(clip).toMatchObject({
            cssViewportRect: { x: 10, y: 10, width: 250, height: 110 },
            cssPageRect: { x: 10, y: 10, width: 250, height: 110 },
            devicePageRect: { x: 20, y: 20, width: 500, height: 220 },
            scale: 2,
        });
    });

    it('returns null crop clip when the draft has no geometry (full-frame fallback)', () => {
        let state = createBrowserContextState();
        state = setBrowserAnnotationDraftComment(state, { viewId: VIEW.viewId, comment: 'comment only' });
        const draft = readBrowserAnnotationDraft(state, VIEW.viewId);
        expect(draft).not.toBeNull();
        expect(resolveBrowserAnnotationDraftCropClip(draft!, { devicePixelRatio: 2 })).toBeNull();
    });

    it('removes a single draft target by id without touching the rest', () => {
        let state = seedTwoElementsRegionStrokeComment();
        const draft = readBrowserAnnotationDraft(state, VIEW.viewId);
        const firstId = draft!.targets[0].draftId;
        state = removeBrowserAnnotationDraftTarget(state, { viewId: VIEW.viewId, draftId: firstId });
        const next = readBrowserAnnotationDraft(state, VIEW.viewId);
        expect(next?.targets).toHaveLength(1);
        expect(next?.targets[0].selectorPath).toBe('#b');
        expect(next?.regions).toHaveLength(1);
    });

    it('resets the draft when an add arrives for a newer navigation generation', () => {
        let state = seedTwoElementsRegionStrokeComment();
        state = addBrowserAnnotationDraftRegion(state, {
            ...VIEW,
            navigationGeneration: 4,
            nowMs: 200,
            rect: { x: 5, y: 5, width: 10, height: 10 },
        });
        const draft = readBrowserAnnotationDraft(state, VIEW.viewId);
        expect(draft?.navigationGeneration).toBe(4);
        expect(draft?.targets).toHaveLength(0);
        expect(draft?.regions).toHaveLength(1);
        expect(draft?.comment).toBeUndefined();
    });

    it('adopts a comment-first placeholder draft on the first geometric add (keeps the comment)', () => {
        let state = setBrowserAnnotationDraftComment(createBrowserContextState(), {
            viewId: VIEW.viewId,
            comment: 'comment first',
        });
        state = addBrowserAnnotationDraftRegion(state, {
            ...VIEW,
            nowMs: 50,
            rect: { x: 1, y: 1, width: 10, height: 10 },
        });
        const draft = readBrowserAnnotationDraft(state, VIEW.viewId);
        expect(draft?.comment).toBe('comment first');
        expect(draft?.navigationGeneration).toBe(3);
        expect(draft?.browserSessionId).toBe('sess_1');
        expect(draft?.regions).toHaveLength(1);
    });

    it('clears the draft on navigation generation increment (ANNO-5)', () => {
        const seeded = seedTwoElementsRegionStrokeComment();
        const navigated = markBrowserContextViewNavigation(seeded, {
            viewId: VIEW.viewId,
            navigationGeneration: 4,
        });
        expect(readBrowserAnnotationDraft(navigated, VIEW.viewId)).toBeNull();
    });

    it('preserves the draft across a no-op navigation mark at the same generation (resize/remount)', () => {
        const seeded = seedTwoElementsRegionStrokeComment();
        const sameGen = markBrowserContextViewNavigation(seeded, {
            viewId: VIEW.viewId,
            navigationGeneration: 3,
        });
        expect(readBrowserAnnotationDraft(sameGen, VIEW.viewId)?.targets).toHaveLength(2);
    });

    describe('commitBrowserAnnotationDraft', () => {
        it('commits the session into N grouped items sharing one annotationId + one media', () => {
            const state = seedTwoElementsRegionStrokeComment();
            const result = commitBrowserAnnotationDraft({
                state,
                ...VIEW,
                adapterKind: 'localPreview',
                media,
                capturedAtMs: 500,
            });
            expect(result.status).toBe('committed');
            if (result.status !== 'committed') return;

            const items = result.itemIds.map((id) => result.state.itemsById[id]);
            // 2 elements + 1 region + 1 stroke = 4 grouped items.
            expect(items).toHaveLength(4);
            const annotationIds = new Set(items.map((i) => (i.kind === 'browserAnnotation' ? i.annotationId : 'x')));
            expect(annotationIds.size).toBe(1);
            expect([...annotationIds][0]).toBe(result.annotationId);
            const mediaIds = new Set(items.map((i) => (i.kind === 'browserAnnotation' ? i.media.mediaId : 'x')));
            expect(mediaIds).toEqual(new Set(['media_union_crop_1']));
            // Comment present on every grouped item (one logical annotation).
            for (const item of items) {
                expect(item.kind === 'browserAnnotation' && item.comment).toBe('needs spacing');
            }
            // The stroke (normalized [0,1]) lands on at least one grouped item.
            expect(items.some((i) => i.kind === 'browserAnnotation' && i.stroke)).toBe(true);
            // The draft + active mode are cleared after commit.
            expect(readBrowserAnnotationDraft(result.state, VIEW.viewId)).toBeNull();
        });

        it('fails closed when the draft has no targets', () => {
            const state = setBrowserAnnotationDraftComment(createBrowserContextState(), {
                viewId: VIEW.viewId,
                comment: 'orphan',
            });
            const result = commitBrowserAnnotationDraft({
                state,
                ...VIEW,
                adapterKind: 'localPreview',
                media,
                capturedAtMs: 500,
            });
            expect(result.status).toBe('unavailable');
        });
    });
});
