import type { BrowserScreenshotMediaReferenceV1 } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import {
  addBrowserAnnotationDraftRegion,
  addBrowserAnnotationDraftStroke,
  addBrowserAnnotationDraftTarget,
  commitBrowserAnnotationDraft,
  countBrowserAnnotationDraftMarks,
  readBrowserAnnotationDraft,
  resolveBrowserAnnotationDraftCropClip,
  setBrowserAnnotationDraftComment,
} from '../../../../apps/ui/sources/sync/domains/browser/context/annotationDraft';
import { selectBrowserAnnotationGroups } from '../../../../apps/ui/sources/sync/domains/browser/context/selectors';
import { createBrowserContextState } from '../../../../apps/ui/sources/sync/domains/browser/context/state';
import type { BrowserContextState } from '../../../../apps/ui/sources/sync/domains/browser/context/types';

type BrowserAnnotationDraftCropClip = NonNullable<ReturnType<typeof resolveBrowserAnnotationDraftCropClip>>;

/**
 * §23 ANNO-7 (LANE-ANNOTATION, T3-parity in-page annotation editor) — the lane-gating E2E.
 *
 * Drives the REAL assembled annotation adapter path: the canonical multi-target DRAFT reducer
 * (`annotationDraft`), the canonical crop geometry (`resolveBrowserAnnotationDraftCropClip` →
 * `resolveAnnotationCropClip`), the grouped commit (`commitBrowserAnnotationDraft`) and the grouping
 * selector (`selectBrowserAnnotationGroups`). No internal mocks: the only system boundary is the
 * engine-native capture producer (desktop Wry / CDP `Page.captureScreenshot({clip})`), which is
 * represented by the cropped media reference it would yield — the LIVE pixel capture is exercised
 * separately on real hardware (QA-DESIGN argent pass on the Wry build).
 *
 * Acceptance (ANNO-3/ANNO-4/ANNO-7):
 *   (a) capture 2 elements + 1 region + 1 stroke + a comment → ONE cropped media artifact whose
 *       dims are the UNION crop (NOT the full page), DPR-aware;
 *   (b) grouped attach → exactly ONE annotation group carrying the comment + the shared mediaId and
   *       all member items (one per visible mark) under one annotationId;
 *   (c) multi-tab isolation: a second view's draft/commit never leaks into the first view.
 */

const VIEW_A = 'view_tab_a';
const VIEW_B = 'view_tab_b';
const SESSION_A = 'browser_session_a';
const SESSION_B = 'browser_session_b';
const NAV_GEN = 1;
const DEVICE_PIXEL_RATIO = 2;

// A full-page surface, used only to prove the crop is strictly smaller than the page.
const PAGE_WIDTH = 1280;
const PAGE_HEIGHT = 800;

// The marked geometry (CSS viewport px). Union bounding box = { x:0, y:0, w:250, h:110 }.
const ELEMENT_A_RECT = { x: 0, y: 0, width: 20, height: 20 } as const;
const ELEMENT_B_RECT = { x: 90, y: 40, width: 30, height: 30 } as const;
const REGION_RECT = { x: 190, y: 70, width: 60, height: 40 } as const;
// Stroke points fall INSIDE the region so they do not extend the union.
const STROKE_POINTS = [{ x: 200, y: 90 }, { x: 225, y: 100 }] as const;

const UNION_CSS = { x: 0, y: 0, width: 250, height: 110 } as const;

function seedMultiTargetDraft(
  state: BrowserContextState,
  params: Readonly<{ viewId: string; browserSessionId: string; comment: string }>,
): BrowserContextState {
  const key = { browserSessionId: params.browserSessionId, viewId: params.viewId, navigationGeneration: NAV_GEN } as const;
  let next = addBrowserAnnotationDraftTarget(state, {
    ...key,
    nowMs: 10,
    target: { kind: 'element', selectorPath: '#header-cta', rect: ELEMENT_A_RECT },
  });
  next = addBrowserAnnotationDraftTarget(next, {
    ...key,
    nowMs: 11,
    target: { kind: 'element', selectorPath: '#nav-link', rect: ELEMENT_B_RECT },
  });
  next = addBrowserAnnotationDraftRegion(next, { ...key, nowMs: 12, rect: REGION_RECT });
  next = addBrowserAnnotationDraftStroke(next, {
    ...key,
    nowMs: 13,
    stroke: { shape: 'freehand', points: [...STROKE_POINTS] },
  });
  next = setBrowserAnnotationDraftComment(next, { viewId: params.viewId, comment: params.comment });
  return next;
}

/** The cropped media the engine producer would yield, clipped to the union device-px rect. */
function croppedMediaForClip(mediaId: string, clip: BrowserAnnotationDraftCropClip): BrowserScreenshotMediaReferenceV1 {
  return {
    mediaId,
    mediaKind: 'image',
    width: clip.devicePageRect.width,
    height: clip.devicePageRect.height,
    sizeBytes: 4096,
  };
}

describe('core e2e: ANNO-7 multi-target cropped annotation attach + multi-tab isolation (LANE-ANNOTATION)', () => {
  it('crops to the DPR-aware union of 2 elements + 1 region + 1 stroke (not the full page) and groups into ONE annotation', () => {
    let state = seedMultiTargetDraft(createBrowserContextState(), {
      viewId: VIEW_A,
      browserSessionId: SESSION_A,
      comment: 'tighten the hero spacing',
    });

    // 2 element marks + 1 region mark + 1 stroke mark are all attachable marks.
    expect(countBrowserAnnotationDraftMarks(state, VIEW_A)).toBe(4);

    // The REAL crop geometry: union × DPR in devicePageRect, a strict sub-rect of the page.
    const draft = readBrowserAnnotationDraft(state, VIEW_A);
    expect(draft).not.toBeNull();
    if (!draft) return;
    const clip = resolveBrowserAnnotationDraftCropClip(draft, { devicePixelRatio: DEVICE_PIXEL_RATIO });
    expect(clip).not.toBeNull();
    if (!clip) return;
    expect(clip.devicePageRect.width).toBe(UNION_CSS.width * DEVICE_PIXEL_RATIO); // 500
    expect(clip.devicePageRect.height).toBe(UNION_CSS.height * DEVICE_PIXEL_RATIO); // 220
    // Crop is strictly smaller than the full page surface.
    expect(clip.devicePageRect.width).toBeLessThan(PAGE_WIDTH);
    expect(clip.devicePageRect.height).toBeLessThan(PAGE_HEIGHT);

    // The capture producer yields ONE media clipped to that union rect; commit groups the draft.
    const media = croppedMediaForClip('media_union_crop_a', clip);
    const committed = commitBrowserAnnotationDraft({
      state,
      browserSessionId: SESSION_A,
      viewId: VIEW_A,
      navigationGeneration: NAV_GEN,
      adapterKind: 'localPreview',
      media,
      capturedAtMs: 100,
    });
    expect(committed.status).toBe('committed');
    if (committed.status !== 'committed') return;
    state = committed.state;
    // One item per visible mark, all under one annotationId.
    expect(committed.itemIds).toHaveLength(4);

    // Exactly ONE group (card) carrying the comment + the SHARED cropped media.
    const groups = selectBrowserAnnotationGroups(state);
    expect(groups).toHaveLength(1);
    expect(groups[0].annotationId).toBe(committed.annotationId);
    expect(groups[0].comment).toBe('tighten the hero spacing');
    expect(groups[0].mediaId).toBe('media_union_crop_a');

    // The committed draft is cleared (no residual authoring state on the captured view).
    expect(readBrowserAnnotationDraft(state, VIEW_A)).toBeNull();
  });

  it('isolates a second tab: view B draft/commit never leaks into view A', () => {
    let state = seedMultiTargetDraft(createBrowserContextState(), {
      viewId: VIEW_A,
      browserSessionId: SESSION_A,
      comment: 'view A note',
    });
    // Commit view A first.
    const draftA = readBrowserAnnotationDraft(state, VIEW_A)!;
    const clipA = resolveBrowserAnnotationDraftCropClip(draftA, { devicePixelRatio: DEVICE_PIXEL_RATIO })!;
    const committedA = commitBrowserAnnotationDraft({
      state,
      browserSessionId: SESSION_A,
      viewId: VIEW_A,
      navigationGeneration: NAV_GEN,
      adapterKind: 'localPreview',
      media: croppedMediaForClip('media_view_a', clipA),
      capturedAtMs: 100,
    });
    expect(committedA.status).toBe('committed');
    if (committedA.status !== 'committed') return;
    state = committedA.state;

    // Now author a DRAFT in view B. It must NOT appear under view A.
    state = seedMultiTargetDraft(state, { viewId: VIEW_B, browserSessionId: SESSION_B, comment: 'view B note' });
    expect(readBrowserAnnotationDraft(state, VIEW_B)).not.toBeNull();
    expect(readBrowserAnnotationDraft(state, VIEW_A)).toBeNull(); // view A draft stays cleared
    expect(countBrowserAnnotationDraftMarks(state, VIEW_A)).toBe(0);
    expect(countBrowserAnnotationDraftMarks(state, VIEW_B)).toBe(4);

    // Commit view B; it yields a SEPARATE group with a distinct annotationId + media.
    const draftB = readBrowserAnnotationDraft(state, VIEW_B)!;
    const clipB = resolveBrowserAnnotationDraftCropClip(draftB, { devicePixelRatio: DEVICE_PIXEL_RATIO })!;
    const committedB = commitBrowserAnnotationDraft({
      state,
      browserSessionId: SESSION_B,
      viewId: VIEW_B,
      navigationGeneration: NAV_GEN,
      adapterKind: 'localPreview',
      media: croppedMediaForClip('media_view_b', clipB),
      capturedAtMs: 200,
    });
    expect(committedB.status).toBe('committed');
    if (committedB.status !== 'committed') return;
    state = committedB.state;

    const groups = selectBrowserAnnotationGroups(state);
    expect(groups).toHaveLength(2);
    const annotationIds = new Set(groups.map((g) => g.annotationId));
    const mediaIds = new Set(groups.map((g) => g.mediaId));
    expect(annotationIds.size).toBe(2);
    expect(mediaIds.has('media_view_a')).toBe(true);
    expect(mediaIds.has('media_view_b')).toBe(true);
    // The comments did not bleed across tabs.
    const byMedia = new Map(groups.map((g) => [g.mediaId, g.comment]));
    expect(byMedia.get('media_view_a')).toBe('view A note');
    expect(byMedia.get('media_view_b')).toBe('view B note');
  });
});
