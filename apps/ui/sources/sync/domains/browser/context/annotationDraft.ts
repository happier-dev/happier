import { type BrowserScreenshotMediaReferenceV1 } from '@happier-dev/protocol/browser/context/v1';
import { stripBrowserDiagnosticUrlValues } from '@happier-dev/protocol/browser/diagnostics/egress/url';
import type { BrowserDiagnosticFidelityV1 } from '@happier-dev/protocol/browser/diagnostics/v1';
import type { BrowserSemanticAdapterKindV1 } from '@happier-dev/protocol/browser/adapters/kinds';
import { applyImageMarksOperations, type ImageMarkColorV1, type ImageMarksDocumentV1, type ImageMarksOperationV1 } from '@happier-dev/protocol/sessions/media/imageMarksV1';
import { BrowserContextAnnotationItemV2Schema } from '@happier-dev/protocol/browser/context/v1';
import type { ImageAnnotationSource } from '@/components/ui/media/annotation/types';
import type { BrowserAnnotationViewportCaptureResult } from './captureProvider';
import type { BrowserAnnotationPickedElement } from './elementPickerAnnotationBridge';
import type { BrowserFrozenAnnotationDraft } from './types';

import { cancelBrowserAnnotationMode, upsertContextItem } from './actions';
import type {
    BrowserContextState,
    BrowserContextUnavailableReason,
} from './types';

type DraftViewKey = Readonly<{
    browserSessionId: string;
    viewId: string;
    navigationGeneration: number;
}>;

let draftSequence = 0;
function nextDraftId(prefix: string): string {
    draftSequence += 1;
    return `${prefix}_${draftSequence}`;
}

export function startBrowserAnnotationDraft(state: BrowserContextState, input: DraftViewKey & Readonly<{
    source: ImageAnnotationSource; capture: Extract<BrowserAnnotationViewportCaptureResult, { status: 'captured' }>['capture'];
    pageUrl?: string; pageTitle?: string; nowMs: number; dispose?: () => void | Promise<void>;
}>): BrowserContextState {
    return withDraft(state, {
        ...input, annotationId: nextDraftId('browser_annotation'), status: 'authoring',
        createdAtMs: input.nowMs, updatedAtMs: input.nowMs,
        document: { v: 1, image: { width: input.source.width, height: input.source.height, scale: input.source.scale }, marks: [] },
        elements: {}, ...(input.pageUrl ? { pageUrl: stripBrowserDiagnosticUrlValues(input.pageUrl) } : {}),
    });
}

export function readFrozenBrowserAnnotationDraft(state: BrowserContextState, viewId: string): BrowserFrozenAnnotationDraft | null {
    return state.annotationDraftByViewId[viewId] ?? null;
}

export function disposeBrowserAnnotationDraft(draft: BrowserFrozenAnnotationDraft): void {
    void Promise.resolve(draft.dispose?.()).catch(() => {});
}

export function disposeAllBrowserAnnotationDrafts(state: BrowserContextState): void {
    for (const draft of Object.values(state.annotationDraftByViewId)) disposeBrowserAnnotationDraft(draft);
}

export function updateBrowserAnnotationDocument(state: BrowserContextState, input: Readonly<{ viewId: string; document: ImageMarksDocumentV1 }>): BrowserContextState {
    const draft = readFrozenBrowserAnnotationDraft(state, input.viewId);
    if (!draft || draft.document === input.document) return state;
    // Source facts survive deletion so Undo can restore an element without another page query.
    return withDraft(state, { ...draft, document: input.document });
}

export function applyBrowserAnnotationOperations(state: BrowserContextState, input: Readonly<{ viewId: string; operations: readonly ImageMarksOperationV1[] }>): BrowserContextState {
    const draft = readFrozenBrowserAnnotationDraft(state, input.viewId);
    return draft ? updateBrowserAnnotationDocument(state, { viewId: input.viewId,
        document: applyImageMarksOperations(draft.document, input.operations) }) : state;
}

export function addBrowserAnnotationElement(state: BrowserContextState, input: Readonly<{
    viewId: string; markId: string; element: BrowserAnnotationPickedElement; color: ImageMarkColorV1;
}>): BrowserContextState {
    const draft = readFrozenBrowserAnnotationDraft(state, input.viewId);
    if (!draft) return state;
    const { rect, label, role: _role, ...facts } = input.element;
    const document = applyImageMarksOperations(draft.document, [{ kind: 'mark.add', mark: {
        id: input.markId, kind: 'element', rect, label, color: input.color,
    } }]);
    return withDraft(state, { ...draft, document, elements: { ...draft.elements, [input.markId]: facts } });
}

/** The open canvas owns the mark; picker source facts join the same draft without another mark. */
export function recordBrowserAnnotationElement(state: BrowserContextState, input: Readonly<{
    viewId: string; markId: string; element: BrowserAnnotationPickedElement;
}>): BrowserContextState {
    const draft = readFrozenBrowserAnnotationDraft(state, input.viewId);
    if (!draft) return state;
    const { rect: _rect, label: _label, role: _role, ...facts } = input.element;
    return withDraft(state, { ...draft, elements: { ...draft.elements, [input.markId]: facts } });
}

function withDraft(
    state: BrowserContextState,
    draft: BrowserFrozenAnnotationDraft,
): BrowserContextState {
    return {
        ...state,
        // Current navigation may advance while the frozen draft retains its captured generation.
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

export function setBrowserAnnotationDraftComment(
    state: BrowserContextState,
    input: Readonly<{ viewId: string; comment: string | null | undefined }>,
): BrowserContextState {
    const existing = state.annotationDraftByViewId[input.viewId];
    if (!existing) return state;
    const comment = input.comment ?? undefined;
    return existing.comment === comment ? state : withDraft(state, { ...existing, comment });
}

export function clearBrowserAnnotationDraft(
    state: BrowserContextState,
    input: Readonly<{ viewId: string }>,
): BrowserContextState {
    if (!state.annotationDraftByViewId[input.viewId]) return state;
    const { [input.viewId]: _removed, ...annotationDraftByViewId } = state.annotationDraftByViewId;
    return { ...state, annotationDraftByViewId };
}

/** Consume an admitted close fact without releasing sources retained by other tabs. */
export function closeBrowserAnnotationView(
    state: BrowserContextState,
    input: Readonly<{ browserSessionId: string; viewId: string }>,
): BrowserContextState {
    const draft = readFrozenBrowserAnnotationDraft(state, input.viewId);
    if (!draft || draft.browserSessionId !== input.browserSessionId) return state;
    disposeBrowserAnnotationDraft(draft);
    return clearBrowserAnnotationDraft(cancelBrowserAnnotationMode(state, input), input);
}

export type CommitBrowserAnnotationDraftInput = DraftViewKey & Readonly<{
    state: BrowserContextState;
    adapterKind: BrowserSemanticAdapterKindV1;
    imageRef: BrowserScreenshotMediaReferenceV1;
    draft?: BrowserFrozenAnnotationDraft;
    capturedAtMs: number;
    /** Capture fidelity for the engine that produced the frozen viewport. */
    fidelity?: BrowserDiagnosticFidelityV1;
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

/** Commit the frozen picture's marks and browser source facts as one context item. */
export function commitBrowserAnnotationDraft(
    input: CommitBrowserAnnotationDraftInput,
): CommitBrowserAnnotationDraftResult {
    const draft = input.draft ?? readFrozenBrowserAnnotationDraft(input.state, input.viewId);
    if (!draft) return unavailable(input.state, 'browser_context_annotation_inactive', 'No annotation draft to attach.');
    const contextId = `browser_context_${draft.annotationId}`;
    const item = BrowserContextAnnotationItemV2Schema.parse({
        v: 1, kind: 'browserAnnotation', contextId, sourceViewId: draft.viewId,
        sourceAdapterKind: input.adapterKind, fidelity: input.fidelity ?? 'injectedPage',
        capturedAtMs: input.capturedAtMs, navigationGeneration: draft.navigationGeneration,
        lifecycleState: 'available', redactionLevel: 'metadataOnly', annotationId: draft.annotationId,
        browserSessionId: draft.browserSessionId, imageRef: input.imageRef, marks: draft.document,
        elements: draft.document.marks.flatMap(mark => mark.kind === 'element' && draft.elements[mark.id]
            ? [{ markId: mark.id, ...draft.elements[mark.id] }] : []),
        ...(draft.pageUrl ? { pageUrl: draft.pageUrl } : {}), ...(draft.pageTitle ? { pageTitle: draft.pageTitle } : {}),
    });
    const next = clearBrowserAnnotationDraft(
        cancelBrowserAnnotationMode(upsertContextItem(input.state, item), { viewId: draft.viewId }),
        { viewId: draft.viewId },
    );
    return { status: 'committed', annotationId: draft.annotationId, itemIds: [contextId], state: next };
}
