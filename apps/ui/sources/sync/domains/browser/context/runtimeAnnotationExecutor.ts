import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { RuntimeActionIdV1 } from '@happier-dev/protocol/actions/actionIds';
import type { ImageMarksDocumentV1, ImageMarksOperationV1 } from '@happier-dev/protocol';
import type { ImageAnnotationSource } from '@/components/ui/media/annotation/types';
import type { BrowserDiagnosticsElementPickerResultV1 } from '@happier-dev/protocol/browser/diagnostics/v1';

import type {
    BrowserContextState,
    BrowserContextUnavailableReason,
} from './types';
import { selectBrowserContextComposerAttachments } from './selectors';

/** Mounted browser Actions mutate the one frozen draft through its owning adapter. */
export type BrowserAnnotationRuntimeActionId = Extract<
    RuntimeActionIdV1,
    `browser.context.annotation.${string}` | 'browser.context.attachToComposer'
>;

export type BrowserAnnotationAdapterRequest =
    | Readonly<{ kind: 'start' }>
    | Readonly<{ kind: 'cancel' }>
    | Readonly<{ kind: 'attachPageReference' }>
    | Readonly<{ kind: 'setDraftComment'; comment: string | null }>
    | Readonly<{ kind: 'attachDraft' }>;

export type BrowserAnnotationAdapterResult =
    | Readonly<{ status: 'started'; state: BrowserContextState }>
    | Readonly<{ status: 'cancelled'; state: BrowserContextState }>
    | Readonly<{ status: 'captured'; state: BrowserContextState; attachmentId: string; contextId: string }>
    | Readonly<{ status: 'draftUpdated'; state: BrowserContextState }>
    | Readonly<{ status: 'committed'; state: BrowserContextState; annotationId: string; itemIds: readonly string[] }>
    | Readonly<{ status: 'attached'; state: BrowserContextState; attachmentId: string }>
    | Readonly<{ status: 'unavailable'; reason: BrowserContextUnavailableReason | string }>;

/**
 * Owns the UI-side annotation reducer mutation. The concrete adapter is constructed where the
 * live view + capabilities + capture provider + `onStateChange` are in scope (BrowserShell host).
 */
export type BrowserContextAnnotationAdapter = Readonly<{
    dispatch(request: BrowserAnnotationAdapterRequest, target?: BrowserAnnotationDispatchTarget): Promise<BrowserAnnotationAdapterResult> | BrowserAnnotationAdapterResult;
    readFrozenDraft?: () => Readonly<{ source: ImageAnnotationSource; document: ImageMarksDocumentV1 }> | null;
    applyOperations?: (input: Readonly<{ operations?: readonly ImageMarksOperationV1[]; reset?: boolean }>) => Promise<boolean>;
    captureSelectedElement?: (pickerResult: BrowserDiagnosticsElementPickerResultV1) => Extract<BrowserAnnotationAdapterResult, { status: 'captured' | 'unavailable' }> | Promise<Extract<BrowserAnnotationAdapterResult, { status: 'captured' | 'unavailable' }>>;
}>;

export type BrowserAnnotationDispatchTarget = Readonly<{
    browserSessionId: string;
    viewId: string;
    navigationGeneration?: number;
    signal?: AbortSignal;
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
    { actionId: 'browser.context.annotation.attachDraft', kind: 'attachDraft' },
    { actionId: 'browser.context.annotation.setDraftComment', kind: 'setDraftComment' },
    { actionId: 'browser.context.attachToComposer', kind: 'attachPageReference' },
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
): actionId is Extract<BrowserAnnotationRuntimeActionId, `browser.context.annotation.${string}`> {
    return actionId !== 'browser.context.attachToComposer' && ANNOTATION_ACTION_KINDS.has(actionId);
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
        case 'attachDraft':
            return { kind: 'attachDraft' };
        case 'attachPageReference':
            return record.source === 'activePage' ? { kind: 'attachPageReference' } : null;
        case 'setDraftComment':
            return record.comment === null || typeof record.comment === 'string'
                ? { kind, comment: record.comment } : null;
        default:
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
    if (result.status === 'draftUpdated') {
        return { v: 1, actionId, status: result.status };
    }
    if (result.status === 'committed') {
        return { v: 1, actionId, status: 'committed', annotationId: result.annotationId, itemIds: result.itemIds };
    }
    if (result.status === 'attached') {
        return selectBrowserContextComposerAttachments(result.state).find(attachment => attachment.attachmentId === result.attachmentId)
            ?? disabledResult('browser_context_item_missing');
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
): (actionId: BrowserAnnotationRuntimeActionId, rawInput: unknown, signal?: AbortSignal) => Promise<unknown> {
    return async (actionId, rawInput, signal) => {
        const record = readRecord(rawInput);
        if (!record) return invalidParametersResult;
        const browserSessionId = readString(record, 'browserSessionId');
        const viewId = readString(record, 'viewId');
        if (!browserSessionId || !viewId) return invalidParametersResult;

        const request = buildRequest(actionId, record);
        if (!request) return invalidParametersResult;
        const navigationGeneration = record.navigationGeneration;
        if ((request.kind === 'attachDraft' || request.kind === 'attachPageReference'
            || request.kind === 'setDraftComment')
            && (typeof navigationGeneration !== 'number' || !Number.isInteger(navigationGeneration) || navigationGeneration < 0)) {
            return invalidParametersResult;
        }

        const adapter = input.adapter ?? input.resolveAdapter?.({ browserSessionId, viewId }) ?? null;
        if (!adapter) {
            return disabledResult('browser_context_annotation_unavailable');
        }

        const result = await adapter.dispatch(request, {
            browserSessionId, viewId,
            ...(typeof navigationGeneration === 'number' ? { navigationGeneration } : {}),
            ...(signal ? { signal } : {}),
        });
        return serializeResult(actionId, result);
    };
}
