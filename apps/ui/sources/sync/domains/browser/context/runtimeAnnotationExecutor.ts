import {
    BrowserAnnotationStrokeV1Schema,
    BrowserAnnotationStyleIntentV1Schema,
    BrowserAnnotationTargetV1Schema,
    type ActionExecuteResult,
    type BrowserAnnotationStrokeV1,
    type BrowserAnnotationStyleIntentV1,
    type BrowserAnnotationTargetV1,
    type RuntimeActionIdV1,
} from '@happier-dev/protocol';

import type {
    BrowserAnnotationViewportRect,
    BrowserContextState,
    BrowserContextUnavailableReason,
} from './types';

/**
 * The seven `browser.context.annotation.*` runtime actions are UI-state mutations against the
 * canonical `BrowserContextState` reducer (start/cancel the mode machine, capture a region/element
 * draft, edit comment/stroke/style intent). They are NOT a daemon-producer dispatch — the live
 * pixels flow through the in-app capture provider + attachment system. This leaf validates the
 * action input, then delegates to the adapter, which owns the actual reducer call + composer attach
 * through the existing `activeViewAttachment` owners. Mirrors the recording-attach executor pattern
 * so every annotation action reaches the `ActionExecutor.execute` front door (FINALIZATION-PLAN
 * §2.3/§3.2/§12.20): the BrowserShell toolbar AND an agent dispatch through exactly one path.
 */
export type BrowserAnnotationRuntimeActionId = Extract<
    RuntimeActionIdV1,
    `browser.context.annotation.${string}`
>;

export type BrowserAnnotationAdapterRequest =
    | Readonly<{ kind: 'start' }>
    | Readonly<{ kind: 'cancel' }>
    // `target` is optional: when omitted, the capture provider's own region (full-page snapshot) is
    // used; when supplied (a marquee selection), it overrides the provider target.
    | Readonly<{ kind: 'captureRegion'; target?: Extract<BrowserAnnotationTargetV1, { kind: 'region' }>; comment?: string; styleIntent?: BrowserAnnotationStyleIntentV1; stroke?: BrowserAnnotationStrokeV1 }>
    // `target` is required: the element-picker supplies the selector path / accessible name.
    | Readonly<{ kind: 'captureElement'; target: Extract<BrowserAnnotationTargetV1, { kind: 'element' }>; comment?: string; styleIntent?: BrowserAnnotationStyleIntentV1; stroke?: BrowserAnnotationStrokeV1 }>
    | Readonly<{ kind: 'attachComment'; contextId: string; comment: string }>
    | Readonly<{ kind: 'attachStroke'; contextId: string; stroke: BrowserAnnotationStrokeV1 }>
    | Readonly<{ kind: 'attachStyleIntent'; contextId: string; styleIntent: BrowserAnnotationStyleIntentV1 }>
    // ANNO-1 editor-session DRAFT authoring actions (Select / Region / Draw / Erase / comment). These
    // accumulate a multi-target draft in the reducer; they are NOT a per-capture commit. The overlay
    // dispatches these directly through the same adapter (no parallel reducer).
    | Readonly<{ kind: 'addDraftTarget'; target: BrowserAnnotationDraftTargetInput }>
    | Readonly<{ kind: 'addDraftRegion'; rect: BrowserAnnotationViewportRect }>
    | Readonly<{ kind: 'addDraftStroke'; stroke: BrowserAnnotationDraftStrokeInput }>
    | Readonly<{ kind: 'removeDraftTarget'; draftId: string }>
    | Readonly<{ kind: 'setDraftComment'; comment: string | null }>
    // Attach: capture the union crop ONCE and commit the draft into grouped context items.
    | Readonly<{ kind: 'attachDraft' }>;

export type BrowserAnnotationDraftTargetInput = Readonly<{
    kind: 'element';
    selectorPath: string;
    accessibleName?: string;
    rect?: BrowserAnnotationViewportRect;
}>;

export type BrowserAnnotationDraftStrokeInput = Readonly<{
    shape: BrowserAnnotationStrokeV1['shape'];
    points: readonly Readonly<{ x: number; y: number }>[];
    colorToken?: string;
    widthPx?: number;
}>;

export type BrowserAnnotationAdapterResult =
    | Readonly<{ status: 'started'; state: BrowserContextState }>
    | Readonly<{ status: 'cancelled'; state: BrowserContextState }>
    | Readonly<{ status: 'captured'; state: BrowserContextState; attachmentId: string; contextId: string }>
    | Readonly<{ status: 'updated'; state: BrowserContextState; contextId: string }>
    | Readonly<{ status: 'draftUpdated'; state: BrowserContextState }>
    | Readonly<{ status: 'committed'; state: BrowserContextState; annotationId: string; itemIds: readonly string[] }>
    | Readonly<{ status: 'unavailable'; reason: BrowserContextUnavailableReason | string }>;

/**
 * Owns the UI-side annotation reducer mutation. The concrete adapter is constructed where the
 * live view + capabilities + capture provider + `onStateChange` are in scope (BrowserShell host).
 */
export type BrowserContextAnnotationAdapter = Readonly<{
    dispatch(request: BrowserAnnotationAdapterRequest): Promise<BrowserAnnotationAdapterResult> | BrowserAnnotationAdapterResult;
}>;

export type CreateBrowserAnnotationRuntimeExecutorInput = Readonly<{
    adapter?: BrowserContextAnnotationAdapter | null;
    resolveAdapter?: (
        input: Readonly<{ browserSessionId: string; viewId: string }>,
    ) => BrowserContextAnnotationAdapter | null | undefined;
}>;

type BrowserAnnotationFailure = Extract<ActionExecuteResult, Readonly<{ ok: false }>>;

const invalidParametersResult = {
    ok: false,
    errorCode: 'invalid_parameters',
    error: 'invalid_parameters',
} as const satisfies BrowserAnnotationFailure;

function disabledResult(reason: string): BrowserAnnotationFailure {
    return {
        ok: false,
        errorCode: 'runtime_action_disabled',
        error: `runtime_action_disabled:browser:${reason}`,
    };
}

const ANNOTATION_RUNTIME_ACTIONS = [
    { actionId: 'browser.context.annotation.start', kind: 'start' },
    { actionId: 'browser.context.annotation.cancel', kind: 'cancel' },
    { actionId: 'browser.context.annotation.captureRegion', kind: 'captureRegion' },
    { actionId: 'browser.context.annotation.captureElement', kind: 'captureElement' },
    { actionId: 'browser.context.annotation.attachComment', kind: 'attachComment' },
    { actionId: 'browser.context.annotation.attachStroke', kind: 'attachStroke' },
    { actionId: 'browser.context.annotation.attachStyleIntent', kind: 'attachStyleIntent' },
] as const satisfies readonly Readonly<{
    actionId: BrowserAnnotationRuntimeActionId;
    kind: BrowserAnnotationAdapterRequest['kind'];
}>[];

type BrowserAnnotationRuntimeAdapterRequestKind = typeof ANNOTATION_RUNTIME_ACTIONS[number]['kind'];

const ANNOTATION_ACTION_KINDS: ReadonlyMap<RuntimeActionIdV1, BrowserAnnotationRuntimeAdapterRequestKind> = new Map(
    ANNOTATION_RUNTIME_ACTIONS.map((entry) => [entry.actionId, entry.kind] as const),
);

export function resolveBrowserAnnotationRuntimeActionIdForRequest(
    request: BrowserAnnotationAdapterRequest,
): BrowserAnnotationRuntimeActionId | null {
    return ANNOTATION_RUNTIME_ACTIONS.find((entry) => entry.kind === request.kind)?.actionId ?? null;
}

export function isBrowserAnnotationRuntimeAction(
    actionId: RuntimeActionIdV1,
): actionId is BrowserAnnotationRuntimeActionId {
    return ANNOTATION_ACTION_KINDS.has(actionId);
}

function readString(record: Readonly<Record<string, unknown>>, key: string): string | undefined {
    const value = record[key];
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Readonly<Record<string, unknown>>
        : null;
}

// Tri-state parse outcome so the executor can distinguish three structurally distinct cases at the
// chokepoint (the actionSpec input schema `.passthrough()`es `target`/`stroke` precisely so this leaf
// validates them — see actionSpecs.ts RuntimeBrowserContextActionInputSchema):
//   - absent       → { ok: true } (no value): valid when the field is optional, missing when required
//   - present+valid → { ok: true, value }: structurally validated against the canonical context schema
//   - present+invalid → { ok: false }: a contract violation → the whole request is rejected
// This closes ANNO-4(a): the prior `as unknown as` cast forwarded malformed target/stroke straight to
// the adapter (a contract lie vs the actionSpec promise of structural validation).
type FieldOutcome<T> = Readonly<{ ok: true; value?: T }> | Readonly<{ ok: false }>;

function parseOptionalTarget(record: Readonly<Record<string, unknown>>): FieldOutcome<BrowserAnnotationTargetV1> {
    if (record.target === undefined || record.target === null) return { ok: true };
    const parsed = BrowserAnnotationTargetV1Schema.safeParse(record.target);
    return parsed.success ? { ok: true, value: parsed.data } : { ok: false };
}

function parseOptionalStroke(record: Readonly<Record<string, unknown>>): FieldOutcome<BrowserAnnotationStrokeV1> {
    if (record.stroke === undefined || record.stroke === null) return { ok: true };
    const parsed = BrowserAnnotationStrokeV1Schema.safeParse(record.stroke);
    return parsed.success ? { ok: true, value: parsed.data } : { ok: false };
}

function parseOptionalStyleIntent(record: Readonly<Record<string, unknown>>): FieldOutcome<BrowserAnnotationStyleIntentV1> {
    if (record.styleIntent === undefined || record.styleIntent === null) return { ok: true };
    const parsed = BrowserAnnotationStyleIntentV1Schema.safeParse(record.styleIntent);
    return parsed.success ? { ok: true, value: parsed.data } : { ok: false };
}

function buildRequest(
    actionId: BrowserAnnotationRuntimeActionId,
    record: Readonly<Record<string, unknown>>,
): BrowserAnnotationAdapterRequest | null {
    const kind = ANNOTATION_ACTION_KINDS.get(actionId);
    if (!kind) return null;
    switch (kind) {
        case 'start':
            return { kind: 'start' };
        case 'cancel':
            return { kind: 'cancel' };
        case 'captureRegion': {
            // A present target/stroke/styleIntent must be structurally valid; absent is allowed (the
            // capture provider's full-page snapshot). A present-but-malformed field → reject.
            const target = parseOptionalTarget(record);
            const stroke = parseOptionalStroke(record);
            const styleIntent = parseOptionalStyleIntent(record);
            if (!target.ok || !stroke.ok || !styleIntent.ok) return null;
            // Region capture only accepts a region target (or none); reject a non-region target.
            if (target.value && target.value.kind !== 'region') return null;
            const comment = readString(record, 'comment');
            return {
                kind: 'captureRegion',
                ...(target.value ? { target: target.value } : {}),
                ...(comment ? { comment } : {}),
                ...(styleIntent.value ? { styleIntent: styleIntent.value } : {}),
                ...(stroke.value ? { stroke: stroke.value } : {}),
            };
        }
        case 'captureElement': {
            const target = parseOptionalTarget(record);
            const stroke = parseOptionalStroke(record);
            const styleIntent = parseOptionalStyleIntent(record);
            if (!target.ok || !stroke.ok || !styleIntent.ok) return null;
            // Element capture requires a valid element target.
            if (!target.value || target.value.kind !== 'element') return null;
            const comment = readString(record, 'comment');
            return {
                kind: 'captureElement',
                target: target.value,
                ...(comment ? { comment } : {}),
                ...(styleIntent.value ? { styleIntent: styleIntent.value } : {}),
                ...(stroke.value ? { stroke: stroke.value } : {}),
            };
        }
        case 'attachComment': {
            const contextId = readString(record, 'contextId');
            const comment = readString(record, 'comment');
            if (!contextId || !comment) return null;
            return { kind: 'attachComment', contextId, comment };
        }
        case 'attachStroke': {
            const contextId = readString(record, 'contextId');
            const stroke = parseOptionalStroke(record);
            if (!contextId || !stroke.ok || !stroke.value) return null;
            return { kind: 'attachStroke', contextId, stroke: stroke.value };
        }
        case 'attachStyleIntent': {
            const contextId = readString(record, 'contextId');
            const styleIntent = parseOptionalStyleIntent(record);
            if (!contextId || !styleIntent.ok || !styleIntent.value) return null;
            return { kind: 'attachStyleIntent', contextId, styleIntent: styleIntent.value };
        }
        default:
            // The editor-session DRAFT request kinds (addDraftTarget/addDraftRegion/addDraftStroke/
            // removeDraftTarget/setDraftComment/attachDraft) are dispatched directly by the in-page
            // overlay, never produced from a runtime action id, so they are not built here.
            return null;
    }
}

function serializeResult(
    actionId: BrowserAnnotationRuntimeActionId,
    result: BrowserAnnotationAdapterResult,
): unknown {
    if (result.status === 'unavailable') {
        const reason = typeof result.reason === 'string' ? result.reason : result.reason.reasonCode;
        return disabledResult(reason);
    }
    if (result.status === 'captured') {
        return {
            v: 1,
            actionId,
            status: 'captured',
            contextId: result.contextId,
            attachmentId: result.attachmentId,
        };
    }
    if (result.status === 'updated') {
        return { v: 1, actionId, status: 'updated', contextId: result.contextId };
    }
    return { v: 1, actionId, status: result.status };
}

/**
 * Builds the runtime executor leaf for the `browser.context.annotation.*` family. Returns a
 * function over the raw (spec-parsed) input that resolves the adapter and serializes the canonical
 * accepted/disabled result.
 */
export function createBrowserAnnotationRuntimeExecutor(
    input: CreateBrowserAnnotationRuntimeExecutorInput,
): (actionId: BrowserAnnotationRuntimeActionId, rawInput: unknown) => Promise<unknown> {
    return async (actionId, rawInput) => {
        const record = readRecord(rawInput);
        if (!record) return invalidParametersResult;
        const browserSessionId = readString(record, 'browserSessionId');
        const viewId = readString(record, 'viewId');
        if (!browserSessionId || !viewId) return invalidParametersResult;

        const request = buildRequest(actionId, record);
        if (!request) return invalidParametersResult;

        const adapter = input.adapter ?? input.resolveAdapter?.({ browserSessionId, viewId }) ?? null;
        if (!adapter) {
            return disabledResult('browser_context_annotation_unavailable');
        }

        const result = await adapter.dispatch(request);
        return serializeResult(actionId, result);
    };
}
