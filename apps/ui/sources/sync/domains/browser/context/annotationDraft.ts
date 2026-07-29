import {
    BrowserContextItemV1Schema,
    type BrowserAnnotationStrokeV1,
    type BrowserContextItemV1,
    type BrowserDiagnosticFidelityV1,
    type BrowserScreenshotMediaReferenceV1,
    type BrowserSemanticAdapterKindV1,
} from '@happier-dev/protocol';

import {
    resolveAnnotationCropClip,
    strokeViewportBounds,
    unionViewportRects,
    type AnnotationCropClip,
    type AnnotationViewportRect,
} from './annotationCropGeometry';
import { cancelBrowserAnnotationMode } from './actions';
import type {
    BrowserAnnotationDraftElementTarget,
    BrowserAnnotationDraftRegionTarget,
    BrowserAnnotationDraftStroke,
    BrowserAnnotationEditorDraft,
    BrowserAnnotationViewportRect,
    BrowserContextState,
    BrowserContextUnavailableReason,
} from './types';

const COMMENT_MAX_CHARS = 2048;

type DraftViewKey = Readonly<{
    browserSessionId: string;
    viewId: string;
    navigationGeneration: number;
}>;

type BrowserAnnotationCommittedTarget =
    | Readonly<{
        kind: 'element';
        selectorPath: string;
        accessibleName?: string;
        rect?: BrowserAnnotationViewportRect;
      }>
    | Readonly<{
        kind: 'region';
        rect: BrowserAnnotationViewportRect;
      }>;

let draftSequence = 0;
function nextDraftId(prefix: string): string {
    draftSequence += 1;
    return `${prefix}_${draftSequence}`;
}

function normalizeComment(value: string | null | undefined): string | undefined {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    if (trimmed.length === 0) return undefined;
    return trimmed.slice(0, COMMENT_MAX_CHARS);
}

/**
 * Returns the live draft for a view, or a fresh authoring draft pinned to the supplied navigation
 * generation. If an existing draft is for an OLDER navigation it is reset (a navigation invalidates
 * the in-flight session); a draft for the same generation is reused so accumulation continues.
 */
function resolveAuthoringDraft(
    state: BrowserContextState,
    key: DraftViewKey,
    nowMs: number,
): BrowserAnnotationEditorDraft {
    const existing = state.annotationDraftByViewId[key.viewId];
    if (
        existing
        && existing.browserSessionId === key.browserSessionId
        && existing.navigationGeneration === key.navigationGeneration
    ) {
        return existing;
    }
    // A comment-first placeholder (seeded by `setDraftComment` before any geometry: empty marks +
    // unset session) is ADOPTED by the first geometric add — it carries the live session/generation
    // and KEEPS the comment, rather than being treated as a stale draft and reset.
    const isPlaceholder = existing
        && existing.browserSessionId === ''
        && existing.targets.length === 0
        && existing.regions.length === 0
        && existing.strokes.length === 0;
    if (existing && isPlaceholder) {
        return {
            ...existing,
            browserSessionId: key.browserSessionId,
            navigationGeneration: key.navigationGeneration,
            createdAtMs: existing.createdAtMs || nowMs,
        };
    }
    return {
        annotationId: nextDraftId('browser_annotation'),
        browserSessionId: key.browserSessionId,
        viewId: key.viewId,
        navigationGeneration: key.navigationGeneration,
        status: 'authoring',
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
        targets: [],
        regions: [],
        strokes: [],
    };
}

function withDraft(
    state: BrowserContextState,
    draft: BrowserAnnotationEditorDraft,
): BrowserContextState {
    return {
        ...state,
        // Advance the view's navigation generation to the draft's (mirrors `startBrowserAnnotationMode`)
        // so a same-generation `markBrowserContextViewNavigation` is a no-op that preserves the draft,
        // and only a real generation increment clears it (ANNO-5).
        navigationGenerationByViewId: {
            ...state.navigationGenerationByViewId,
            [draft.viewId]: Math.max(
                state.navigationGenerationByViewId[draft.viewId] ?? 0,
                draft.navigationGeneration,
            ),
        },
        annotationDraftByViewId: {
            ...state.annotationDraftByViewId,
            [draft.viewId]: draft,
        },
    };
}

export function readBrowserAnnotationDraft(
    state: BrowserContextState,
    viewId: string,
): BrowserAnnotationEditorDraft | null {
    return state.annotationDraftByViewId[viewId] ?? null;
}

/**
 * ANNO-3: resolve the device-pixel union-of-targets crop for a draft, so the capture seam can clip
 * the captured media to exactly the marked region (element rects + region marks + stroke bounds)
 * rather than persisting the whole page. Delegates the coordinate math to the single canonical
 * `resolveAnnotationCropClip` owner (CSS viewport px → page px → device px, clamped). Returns null
 * when there is no draft / no geometry (full-frame fallback) so a clip is only requested when there
 * is a real union to crop to.
 *
 * The editor records geometry in CSS viewport coordinates relative to the captured view; the desktop
 * Wry snapshot captures that same viewport, so we keep viewport coordinates (scroll = 0) and rely on
 * the native seam to clamp the device clip to the real buffer bounds (the surface here is left
 * unbounded; clamping is authoritative at the engine).
 */
export function resolveBrowserAnnotationDraftCropClip(
    draft: BrowserAnnotationEditorDraft,
    viewport: Readonly<{ devicePixelRatio: number }>,
): AnnotationCropClip | null {
    const targets: AnnotationViewportRect[] = [];
    for (const target of draft.targets) {
        if (target.rect) targets.push(toViewportRect(target.rect));
    }
    for (const region of draft.regions) {
        targets.push(toViewportRect(region.rect));
    }
    const strokes = draft.strokes.map((stroke) => stroke.points);
    const resolved = resolveAnnotationCropClip({
        targets,
        strokes,
        viewport: {
            scrollX: 0,
            scrollY: 0,
            devicePixelRatio: viewport.devicePixelRatio > 0 ? viewport.devicePixelRatio : 1,
            // Unbounded: the engine producer clamps the device clip to the real captured buffer.
            surface: { width: Number.MAX_SAFE_INTEGER, height: Number.MAX_SAFE_INTEGER },
        },
    });
    return resolved.status === 'clip' ? resolved : null;
}

export function countBrowserAnnotationDraftMarks(
    state: BrowserContextState,
    viewId: string,
): number {
    const draft = state.annotationDraftByViewId[viewId];
    if (!draft) return 0;
    return draft.targets.length + draft.regions.length + draft.strokes.length;
}

export function addBrowserAnnotationDraftTarget(
    state: BrowserContextState,
    input: DraftViewKey & Readonly<{
        nowMs: number;
        target: Readonly<{
            kind: 'element';
            selectorPath: string;
            accessibleName?: string;
            rect?: BrowserAnnotationViewportRect;
        }>;
    }>,
): BrowserContextState {
    const base = resolveAuthoringDraft(state, input, input.nowMs);
    const target: BrowserAnnotationDraftElementTarget = {
        draftId: nextDraftId('target'),
        kind: 'element',
        selectorPath: input.target.selectorPath,
        ...(input.target.accessibleName ? { accessibleName: input.target.accessibleName } : {}),
        ...(input.target.rect ? { rect: input.target.rect } : {}),
        addedAtMs: input.nowMs,
    };
    return withDraft(state, {
        ...base,
        targets: [...base.targets, target],
        updatedAtMs: input.nowMs,
    });
}

export function addBrowserAnnotationDraftRegion(
    state: BrowserContextState,
    input: DraftViewKey & Readonly<{ nowMs: number; rect: BrowserAnnotationViewportRect }>,
): BrowserContextState {
    const base = resolveAuthoringDraft(state, input, input.nowMs);
    const region: BrowserAnnotationDraftRegionTarget = {
        draftId: nextDraftId('region'),
        kind: 'region',
        rect: input.rect,
        addedAtMs: input.nowMs,
    };
    return withDraft(state, {
        ...base,
        regions: [...base.regions, region],
        updatedAtMs: input.nowMs,
    });
}

export function addBrowserAnnotationDraftStroke(
    state: BrowserContextState,
    input: DraftViewKey & Readonly<{
        nowMs: number;
        stroke: Readonly<{
            shape: BrowserAnnotationStrokeV1['shape'];
            points: readonly Readonly<{ x: number; y: number }>[];
            colorToken?: string;
            widthPx?: number;
        }>;
    }>,
): BrowserContextState {
    const base = resolveAuthoringDraft(state, input, input.nowMs);
    const stroke: BrowserAnnotationDraftStroke = {
        draftId: nextDraftId('stroke'),
        kind: 'stroke',
        shape: input.stroke.shape,
        points: input.stroke.points,
        ...(input.stroke.colorToken ? { colorToken: input.stroke.colorToken } : {}),
        ...(input.stroke.widthPx ? { widthPx: input.stroke.widthPx } : {}),
        addedAtMs: input.nowMs,
    };
    return withDraft(state, {
        ...base,
        strokes: [...base.strokes, stroke],
        updatedAtMs: input.nowMs,
    });
}

export function removeBrowserAnnotationDraftTarget(
    state: BrowserContextState,
    input: Readonly<{ viewId: string; draftId: string }>,
): BrowserContextState {
    const draft = state.annotationDraftByViewId[input.viewId];
    if (!draft) return state;
    const targets = draft.targets.filter((target) => target.draftId !== input.draftId);
    const regions = draft.regions.filter((region) => region.draftId !== input.draftId);
    const strokes = draft.strokes.filter((stroke) => stroke.draftId !== input.draftId);
    if (
        targets.length === draft.targets.length
        && regions.length === draft.regions.length
        && strokes.length === draft.strokes.length
    ) {
        return state;
    }
    return withDraft(state, { ...draft, targets, regions, strokes });
}

export function setBrowserAnnotationDraftComment(
    state: BrowserContextState,
    input: Readonly<{ viewId: string; comment: string | null | undefined }>,
): BrowserContextState {
    const existing = state.annotationDraftByViewId[input.viewId];
    const comment = normalizeComment(input.comment);
    // Setting a comment with no in-flight draft seeds an authoring draft so a comment-first flow is
    // supported; the navigation generation is unknown here, so it defaults to 0 and is reconciled by
    // the next geometric add (which carries the live generation).
    const base: BrowserAnnotationEditorDraft = existing ?? {
        annotationId: nextDraftId('browser_annotation'),
        browserSessionId: '',
        viewId: input.viewId,
        navigationGeneration: 0,
        status: 'authoring',
        createdAtMs: 0,
        updatedAtMs: 0,
        targets: [],
        regions: [],
        strokes: [],
    };
    const { comment: _previous, ...withoutComment } = base;
    return withDraft(state, {
        ...withoutComment,
        ...(comment ? { comment } : {}),
    });
}

export function clearBrowserAnnotationDraft(
    state: BrowserContextState,
    input: Readonly<{ viewId: string }>,
): BrowserContextState {
    if (!state.annotationDraftByViewId[input.viewId]) return state;
    const { [input.viewId]: _removed, ...annotationDraftByViewId } = state.annotationDraftByViewId;
    return { ...state, annotationDraftByViewId };
}

export type CommitBrowserAnnotationDraftInput = DraftViewKey & Readonly<{
    state: BrowserContextState;
    adapterKind: BrowserSemanticAdapterKindV1;
    media: BrowserScreenshotMediaReferenceV1;
    capturedAtMs: number;
    /** Capture fidelity for the engine that produced the crop (defaults to `injectedPage`). */
    fidelity?: BrowserDiagnosticFidelityV1;
    pageUrl?: string | null;
    pageTitle?: string | null;
}>;

export type CommitBrowserAnnotationDraftResult =
    | Readonly<{
        status: 'committed';
        state: BrowserContextState;
        annotationId: string;
        itemIds: readonly string[];
      }>
    | Readonly<{
        status: 'unavailable';
        state: BrowserContextState;
        reason: BrowserContextUnavailableReason;
      }>;

function unavailable(
    state: BrowserContextState,
    reasonCode: BrowserContextUnavailableReason['reasonCode'],
    message: string,
): CommitBrowserAnnotationDraftResult {
    return {
        status: 'unavailable',
        state,
        reason: { reasonCode, lifecycleState: 'captureFailed', message },
    };
}

function toViewportRect(rect: BrowserAnnotationViewportRect): AnnotationViewportRect {
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

function toBrowserAnnotationViewportRect(rect: AnnotationViewportRect): BrowserAnnotationViewportRect {
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

function strokeBounds(stroke: BrowserAnnotationDraftStroke): BrowserAnnotationViewportRect | null {
    const bounds = strokeViewportBounds(stroke.points);
    return bounds ? toBrowserAnnotationViewportRect(bounds) : null;
}

function cropRelativeRect(
    rect: BrowserAnnotationViewportRect,
    origin: AnnotationViewportRect,
): BrowserAnnotationViewportRect {
    return {
        x: rect.x - origin.x,
        y: rect.y - origin.y,
        width: rect.width,
        height: rect.height,
    };
}

function clamp01(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.min(1, Math.max(0, value));
}

function normalizeStrokeToCrop(
    stroke: BrowserAnnotationDraftStroke,
    origin: AnnotationViewportRect,
): BrowserAnnotationStrokeV1 | null {
    const width = origin.width > 0 ? origin.width : 1;
    const height = origin.height > 0 ? origin.height : 1;
    const points = stroke.points
        .map((point) => ({
            x: clamp01((point.x - origin.x) / width),
            y: clamp01((point.y - origin.y) / height),
        }))
        .slice(0, 512);
    if (points.length === 0) return null;
    return {
        shape: stroke.shape,
        points,
        ...(stroke.colorToken ? { colorToken: stroke.colorToken } : {}),
        ...(stroke.widthPx ? { widthPx: stroke.widthPx } : {}),
    };
}

/**
 * ANNO-1/ANNO-2: commit the multi-target editor draft into N grouped `browserAnnotation` context
 * items. Every item shares the draft's `annotationId`, the single union-cropped `media`, and the
 * shared `comment` so the composer + agent turn render exactly ONE card per annotation. Every visible
 * editor mark yields one item: element marks keep element targets, region marks keep region targets,
 * and stroke marks become crop-relative region targets carrying the normalized vector stroke. The
 * draft + active mode are cleared on success.
 */
export function commitBrowserAnnotationDraft(
    input: CommitBrowserAnnotationDraftInput,
): CommitBrowserAnnotationDraftResult {
    const draft = input.state.annotationDraftByViewId[input.viewId];
    if (!draft) {
        return unavailable(input.state, 'browser_context_annotation_inactive', 'No annotation draft to attach.');
    }
    const marks: readonly (
        BrowserAnnotationDraftElementTarget
        | BrowserAnnotationDraftRegionTarget
        | BrowserAnnotationDraftStroke
    )[] = [...draft.targets, ...draft.regions, ...draft.strokes];
    if (marks.length === 0) {
        return unavailable(input.state, 'browser_context_annotation_inactive', 'Annotation draft has no marked items.');
    }

    const rects: AnnotationViewportRect[] = [];
    for (const target of draft.targets) {
        if (target.rect) rects.push(toViewportRect(target.rect));
    }
    for (const region of draft.regions) {
        rects.push(toViewportRect(region.rect));
    }
    for (const stroke of draft.strokes) {
        const bounds = strokeBounds(stroke);
        if (bounds) rects.push(toViewportRect(bounds));
    }
    // Union origin in viewport space; element marks without a rect fall back to the union origin so
    // their committed rect is crop-relative-consistent.
    const origin = unionViewportRects(rects) ?? { x: 0, y: 0, width: input.media.width, height: input.media.height };

    const comment = normalizeComment(draft.comment);
    const items: BrowserContextItemV1[] = [];
    marks.forEach((mark, index) => {
        const contextId = `browser_context_${draft.annotationId}_${index}`;
        let stroke: BrowserAnnotationStrokeV1 | null = null;
        let target: BrowserAnnotationCommittedTarget;
        if (mark.kind === 'element') {
            target = {
                kind: 'element' as const,
                selectorPath: mark.selectorPath,
                ...(mark.accessibleName ? { accessibleName: mark.accessibleName } : {}),
                ...(mark.rect ? { rect: cropRelativeRect(mark.rect, origin) } : {}),
            };
        } else if (mark.kind === 'region') {
            target = {
                kind: 'region' as const,
                rect: cropRelativeRect(mark.rect, origin),
            };
        } else {
            stroke = normalizeStrokeToCrop(mark, origin);
            const strokeTarget = strokeBounds(mark);
            if (!stroke || !strokeTarget) return;
            target = {
                kind: 'region' as const,
                rect: cropRelativeRect(strokeTarget, origin),
            };
        }
        const item = BrowserContextItemV1Schema.parse({
            v: 1,
            contextId,
            kind: 'browserAnnotation',
            sourceViewId: input.viewId,
            sourceAdapterKind: input.adapterKind,
            fidelity: input.fidelity ?? 'injectedPage',
            capturedAtMs: input.capturedAtMs,
            navigationGeneration: input.navigationGeneration,
            lifecycleState: 'available',
            redactionLevel: 'metadataOnly',
            annotationId: draft.annotationId,
            browserSessionId: draft.browserSessionId || input.browserSessionId,
            media: input.media,
            target,
            ...(comment ? { comment } : {}),
            ...(stroke ? { stroke } : {}),
            ...(input.pageUrl ? { pageUrl: input.pageUrl } : {}),
            ...(input.pageTitle ? { pageTitle: input.pageTitle } : {}),
        });
        items.push(item);
    });

    if (items.length === 0) {
        return unavailable(input.state, 'browser_context_annotation_inactive', 'Annotation draft has no attachable geometry.');
    }

    let nextState = input.state;
    const itemsById = { ...nextState.itemsById };
    const itemOrder = [...nextState.itemOrder];
    const navigationGenerationByViewId = { ...nextState.navigationGenerationByViewId };
    for (const item of items) {
        const exists = itemsById[item.contextId] !== undefined;
        itemsById[item.contextId] = item;
        if (!exists) itemOrder.push(item.contextId);
        navigationGenerationByViewId[item.sourceViewId] = Math.max(
            navigationGenerationByViewId[item.sourceViewId] ?? 0,
            item.navigationGeneration,
        );
    }
    nextState = { ...nextState, itemsById, itemOrder, navigationGenerationByViewId };
    nextState = clearBrowserAnnotationDraft(nextState, { viewId: input.viewId });
    nextState = cancelBrowserAnnotationMode(nextState, { viewId: input.viewId });

    return {
        status: 'committed',
        state: nextState,
        annotationId: draft.annotationId,
        itemIds: items.map((item) => item.contextId),
    };
}
