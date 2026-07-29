import {
    BrowserContextItemV1Schema,
    type BrowserAnnotationStrokeV1,
    type BrowserAnnotationStyleIntentV1,
    type BrowserContextItemV1,
    type BrowserContextKindV1,
    type BrowserDiagnosticFidelityV1,
    type BrowserViewTargetV1,
} from '@happier-dev/protocol';

import type {
    BrowserContextCaptureResult,
    BrowserContextKindAvailabilityInput,
    BrowserContextState,
    BrowserContextUnavailableReason,
    BrowserContextUnavailableReasonCode,
    BrowserAnnotationCaptureInput,
    BrowserAnnotationCommentUpdateResult,
    BrowserAnnotationModeResult,
    BrowserAnnotationModeStartInput,
    BrowserPageReferenceCaptureInput,
    BrowserScreenshotReferenceCaptureInput,
    BrowserSelectedElementCaptureInput,
    BrowserSummaryContextCaptureInput,
    BrowserSummaryContextKind,
    BrowserTextSelectionCaptureInput,
} from './types';

const CONTEXT_ID_PREFIX = 'browser_context';
const TEXT_SELECTION_SCHEMA_MAX_CHARS = 2048;
const SUMMARY_SCHEMA_MAX_CHARS = 8192;
const DIAGNOSTICS_DERIVED_CONTEXT_KINDS = new Set<BrowserContextKindV1>([
    'browserNetworkSummary',
    'browserConsoleSummary',
    'browserSelectedElement',
]);
const MEDIA_BACKED_CONTEXT_KINDS = new Set<BrowserContextKindV1>([
    'browserScreenshot',
    'browserAnnotation',
]);
const BROWSER_ANNOTATION_COMMENT_MAX_CHARS = 2048;

function unavailableReason(
    reasonCode: BrowserContextUnavailableReasonCode,
    lifecycleState: BrowserContextUnavailableReason['lifecycleState'],
    message: string,
): BrowserContextUnavailableReason {
    return { reasonCode, lifecycleState, message };
}

function resolvePrivacyReason(
    privacyState: BrowserContextKindAvailabilityInput['privacyState'],
): BrowserContextUnavailableReason | null {
    switch (privacyState) {
        case 'sensitiveOrigin':
            return unavailableReason(
                'browser_context_sensitive_origin',
                'sensitiveOrigin',
                'Browser context is unavailable for sensitive origins.',
            );
        case 'sensitiveFieldsPresent':
            return unavailableReason(
                'browser_context_sensitive_fields_present',
                'sensitiveFieldsPresent',
                'Browser context is unavailable while sensitive fields are present.',
            );
        case 'ephemeralOnly':
            return unavailableReason(
                'browser_context_ephemeral_only',
                'ephemeralOnly',
                'Browser context is unavailable for private or ephemeral browser profiles.',
            );
        case null:
        case undefined:
            return null;
    }
}

export function resolveBrowserContextKindAvailability(
    input: BrowserContextKindAvailabilityInput,
): BrowserContextUnavailableReason | null {
    if (!input.browserContextEnabled) {
        return unavailableReason(
            'browser_context_disabled',
            'policyDenied',
            'Browser context capture is disabled.',
        );
    }

    if (!input.contextCapabilities.enabled || !input.contextCapabilities.available) {
        return unavailableReason(
            'browser_context_capability_unavailable',
            'policyDenied',
            input.contextCapabilities.disabledReasons[0] ?? 'Browser context capability is unavailable.',
        );
    }

    const privacyReason = resolvePrivacyReason(input.privacyState);
    if (privacyReason) return privacyReason;

    if (DIAGNOSTICS_DERIVED_CONTEXT_KINDS.has(input.kind) && input.browserDiagnosticsEnabled !== true) {
        return unavailableReason(
            'browser_context_diagnostics_disabled',
            'policyDenied',
            'Browser diagnostics must be enabled to capture this context kind.',
        );
    }

    if (
        MEDIA_BACKED_CONTEXT_KINDS.has(input.kind)
        && input.contextCapabilities.screenshot.requiresAttachmentUploads
        && input.attachmentsUploadsEnabled !== true
    ) {
        return unavailableReason(
            'browser_context_attachment_uploads_disabled',
            'policyDenied',
            'Browser media context requires attachment uploads to be enabled.',
        );
    }

    if (MEDIA_BACKED_CONTEXT_KINDS.has(input.kind) && !input.contextCapabilities.screenshot.supported) {
        return unavailableReason(
            'browser_context_kind_unavailable',
            'policyDenied',
            'Browser media context is not supported by host policy.',
        );
    }

    if (!input.contextCapabilities.supportedContextKinds.includes(input.kind)) {
        return unavailableReason(
            'browser_context_kind_unavailable',
            'policyDenied',
            'Browser context kind is not enabled by host policy.',
        );
    }

    if (!input.contextCapabilities.supportedAdapterKinds.includes(input.adapterCapabilities.adapterKind)) {
        return unavailableReason(
            'browser_context_adapter_unavailable',
            'adapterUnavailable',
            'Browser context is unavailable for this adapter.',
        );
    }

    if (!input.adapterCapabilities.contextKinds.includes(input.kind)) {
        return unavailableReason(
            'browser_context_adapter_unavailable',
            'adapterUnavailable',
            'Browser adapter cannot capture this context kind.',
        );
    }

    return null;
}

function sanitizeContextIdSegment(value: string): string {
    const sanitized = value.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
    return sanitized.length > 0 ? sanitized.slice(0, 72) : 'view';
}

function buildContextId(input: BrowserPageReferenceCaptureInput): string {
    if (input.contextId) return input.contextId;
    return buildContextIdFromParts({
        viewId: input.viewId,
        kind: 'browserPageReference',
        navigationGeneration: input.page.navigationGeneration,
        capturedAtMs: input.page.capturedAtMs,
    });
}

function buildContextIdFromParts(input: Readonly<{
    viewId: string;
    kind: BrowserContextKindV1;
    navigationGeneration: number;
    capturedAtMs: number;
    contextId?: string;
}>): string {
    if (input.contextId) return input.contextId;
    return [
        CONTEXT_ID_PREFIX,
        sanitizeContextIdSegment(input.viewId),
        sanitizeContextIdSegment(input.kind),
        input.navigationGeneration,
        input.capturedAtMs,
    ].join('_');
}

function normalizeOptionalString(value: string | null | undefined): string | undefined {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeOptionalBoundedString(value: string | null | undefined, maxChars: number): string | undefined {
    const normalized = normalizeOptionalString(value);
    if (!normalized) return undefined;
    return normalized.slice(0, Math.max(0, maxChars));
}

function stripUrlValues(value: string | undefined): string | undefined {
    if (!value) return undefined;
    try {
        const parsed = new URL(value);
        return `${parsed.origin}${parsed.pathname}`;
    } catch {
        return value.split(/[?#]/, 1)[0] || undefined;
    }
}

function resolveOrigin(rawUrl: string | undefined): string | undefined {
    if (!rawUrl) return undefined;
    try {
        return new URL(rawUrl).origin;
    } catch {
        return undefined;
    }
}

function resolvePageReferenceFidelity(
    input: BrowserPageReferenceCaptureInput,
): BrowserDiagnosticFidelityV1 {
    return input.adapterCapabilities.diagnosticsFidelityByFamily.pageInfo ?? 'unavailable';
}

function resolveScreenshotFidelity(
    input: BrowserScreenshotReferenceCaptureInput,
): BrowserDiagnosticFidelityV1 {
    return input.adapterCapabilities.diagnosticsFidelityByFamily.screenshot ?? 'unavailable';
}

function resolveTextSelectionFidelity(
    input: BrowserTextSelectionCaptureInput,
): BrowserDiagnosticFidelityV1 {
    return input.adapterCapabilities.diagnosticsFidelityByFamily.elements ?? 'unavailable';
}

function resolveSelectedElementFidelity(
    input: BrowserSelectedElementCaptureInput,
): BrowserDiagnosticFidelityV1 {
    return input.adapterCapabilities.diagnosticsFidelityByFamily.elements ?? 'unavailable';
}

function resolveAnnotationFidelity(
    input: BrowserAnnotationCaptureInput,
): BrowserDiagnosticFidelityV1 {
    if (input.target.kind === 'element') {
        return input.adapterCapabilities.diagnosticsFidelityByFamily.elements
            ?? input.adapterCapabilities.diagnosticsFidelityByFamily.screenshot
            ?? 'unavailable';
    }
    return input.adapterCapabilities.diagnosticsFidelityByFamily.screenshot ?? 'unavailable';
}

function resolveSummaryFidelity(
    input: BrowserSummaryContextCaptureInput,
): BrowserDiagnosticFidelityV1 {
    switch (input.kind) {
        case 'browserNetworkSummary':
            return input.adapterCapabilities.diagnosticsFidelityByFamily.network ?? 'unavailable';
        case 'browserConsoleSummary':
            return input.adapterCapabilities.diagnosticsFidelityByFamily.console ?? 'unavailable';
        case 'browserDomSnapshotSummary':
        case 'browserPageTextSummary':
            return input.adapterCapabilities.diagnosticsFidelityByFamily.elements ?? 'unavailable';
    }
}

function truncateForContext(
    value: string,
    maxChars: number,
): Readonly<{ value: string; truncated: boolean }> {
    const normalized = value.trim();
    const boundedMax = Math.max(0, Math.floor(maxChars));
    return {
        value: normalized.slice(0, boundedMax),
        truncated: normalized.length > boundedMax,
    };
}

function buildPageReferenceItem(input: BrowserPageReferenceCaptureInput): BrowserContextItemV1 {
    const url = stripUrlValues(normalizeOptionalString(input.page.url));
    const title = normalizeOptionalString(input.page.title) ?? input.target.display?.title;
    const faviconUrl = stripUrlValues(normalizeOptionalString(input.page.faviconUrl));
    const item = {
        v: 1,
        contextId: buildContextId(input),
        kind: 'browserPageReference',
        sourceViewId: input.viewId,
        sourceAdapterKind: input.adapterCapabilities.adapterKind,
        fidelity: resolvePageReferenceFidelity(input),
        capturedAtMs: input.page.capturedAtMs,
        navigationGeneration: input.page.navigationGeneration,
        lifecycleState: 'available',
        redactionLevel: 'metadataOnly',
        targetId: input.target.targetId,
        targetKind: input.target.kind,
        display: input.target.display,
        url,
        title,
        faviconUrl,
        origin: resolveOrigin(url),
    } satisfies BrowserContextItemV1;

    return BrowserContextItemV1Schema.parse(item);
}

function upsertContextItem(state: BrowserContextState, item: BrowserContextItemV1): BrowserContextState {
    const exists = state.itemsById[item.contextId] !== undefined;
    return {
        ...state,
        itemsById: {
            ...state.itemsById,
            [item.contextId]: item,
        },
        itemOrder: exists ? state.itemOrder : [...state.itemOrder, item.contextId],
        navigationGenerationByViewId: {
            ...state.navigationGenerationByViewId,
            [item.sourceViewId]: Math.max(
                state.navigationGenerationByViewId[item.sourceViewId] ?? 0,
                item.navigationGeneration,
            ),
        },
    };
}

export function captureBrowserPageReference(input: BrowserPageReferenceCaptureInput): BrowserContextCaptureResult {
    const unavailable = resolveBrowserContextKindAvailability({
        browserContextEnabled: input.browserContextEnabled,
        contextCapabilities: input.contextCapabilities,
        adapterCapabilities: input.adapterCapabilities,
        kind: 'browserPageReference',
        privacyState: input.page.privacyState,
    });

    if (unavailable) {
        return {
            status: 'unavailable',
            state: input.state,
            reason: unavailable,
        };
    }

    const item = buildPageReferenceItem(input);
    return {
        status: 'captured',
        state: upsertContextItem(input.state, item),
        itemId: item.contextId,
    };
}

export function captureBrowserScreenshotReference(
    input: BrowserScreenshotReferenceCaptureInput,
): BrowserContextCaptureResult {
    const unavailable = resolveBrowserContextKindAvailability({
        browserContextEnabled: input.browserContextEnabled,
        attachmentsUploadsEnabled: input.attachmentsUploadsEnabled,
        contextCapabilities: input.contextCapabilities,
        adapterCapabilities: input.adapterCapabilities,
        kind: 'browserScreenshot',
        privacyState: input.privacyState,
    });

    if (unavailable) {
        return {
            status: 'unavailable',
            state: input.state,
            reason: unavailable,
        };
    }

    const item = BrowserContextItemV1Schema.parse({
        v: 1,
        contextId: buildContextIdFromParts({
            viewId: input.viewId,
            kind: 'browserScreenshot',
            navigationGeneration: input.navigationGeneration,
            capturedAtMs: input.capturedAtMs,
            contextId: input.contextId,
        }),
        kind: 'browserScreenshot',
        sourceViewId: input.viewId,
        sourceAdapterKind: input.adapterCapabilities.adapterKind,
        fidelity: resolveScreenshotFidelity(input),
        capturedAtMs: input.capturedAtMs,
        navigationGeneration: input.navigationGeneration,
        lifecycleState: 'available',
        redactionLevel: 'metadataOnly',
        media: input.media,
    });

    return {
        status: 'captured',
        state: upsertContextItem(input.state, item),
        itemId: item.contextId,
    };
}

export function captureBrowserTextSelection(
    input: BrowserTextSelectionCaptureInput,
): BrowserContextCaptureResult {
    const unavailable = resolveBrowserContextKindAvailability({
        browserContextEnabled: input.browserContextEnabled,
        contextCapabilities: input.contextCapabilities,
        adapterCapabilities: input.adapterCapabilities,
        kind: 'browserTextSelection',
        privacyState: input.privacyState,
    });

    if (unavailable) {
        return {
            status: 'unavailable',
            state: input.state,
            reason: unavailable,
        };
    }

    const truncated = truncateForContext(
        input.text,
        Math.min(input.contextCapabilities.text.maxSelectionChars, TEXT_SELECTION_SCHEMA_MAX_CHARS),
    );
    const item = BrowserContextItemV1Schema.parse({
        v: 1,
        contextId: buildContextIdFromParts({
            viewId: input.viewId,
            kind: 'browserTextSelection',
            navigationGeneration: input.navigationGeneration,
            capturedAtMs: input.capturedAtMs,
            contextId: input.contextId,
        }),
        kind: 'browserTextSelection',
        sourceViewId: input.viewId,
        sourceAdapterKind: input.adapterCapabilities.adapterKind,
        fidelity: resolveTextSelectionFidelity(input),
        capturedAtMs: input.capturedAtMs,
        navigationGeneration: input.navigationGeneration,
        lifecycleState: 'available',
        redactionLevel: 'summaryOnly',
        text: truncated.value,
        truncated: truncated.truncated,
    });

    return {
        status: 'captured',
        state: upsertContextItem(input.state, item),
        itemId: item.contextId,
    };
}

function requiresDiagnosticsForSummary(kind: BrowserSummaryContextKind): boolean {
    return kind === 'browserNetworkSummary' || kind === 'browserConsoleSummary';
}

export function captureBrowserSummaryContext(
    input: BrowserSummaryContextCaptureInput,
): BrowserContextCaptureResult {
    const unavailable = resolveBrowserContextKindAvailability({
        browserContextEnabled: input.browserContextEnabled,
        browserDiagnosticsEnabled: requiresDiagnosticsForSummary(input.kind)
            ? input.browserDiagnosticsEnabled
            : undefined,
        contextCapabilities: input.contextCapabilities,
        adapterCapabilities: input.adapterCapabilities,
        kind: input.kind,
        privacyState: input.privacyState,
    });

    if (unavailable) {
        return {
            status: 'unavailable',
            state: input.state,
            reason: unavailable,
        };
    }

    const truncated = truncateForContext(
        input.summary,
        Math.min(input.contextCapabilities.text.maxSummaryChars, SUMMARY_SCHEMA_MAX_CHARS),
    );
    const item = BrowserContextItemV1Schema.parse({
        v: 1,
        contextId: buildContextIdFromParts({
            viewId: input.viewId,
            kind: input.kind,
            navigationGeneration: input.navigationGeneration,
            capturedAtMs: input.capturedAtMs,
            contextId: input.contextId,
        }),
        kind: input.kind,
        sourceViewId: input.viewId,
        sourceAdapterKind: input.adapterCapabilities.adapterKind,
        fidelity: resolveSummaryFidelity(input),
        capturedAtMs: input.capturedAtMs,
        navigationGeneration: input.navigationGeneration,
        lifecycleState: 'available',
        redactionLevel: 'summaryOnly',
        summary: truncated.value,
        truncated: truncated.truncated,
    });

    return {
        status: 'captured',
        state: upsertContextItem(input.state, item),
        itemId: item.contextId,
    };
}

export function captureBrowserSelectedElement(
    input: BrowserSelectedElementCaptureInput,
): BrowserContextCaptureResult {
    const unavailable = resolveBrowserContextKindAvailability({
        browserContextEnabled: input.browserContextEnabled,
        browserDiagnosticsEnabled: input.browserDiagnosticsEnabled,
        contextCapabilities: input.contextCapabilities,
        adapterCapabilities: input.adapterCapabilities,
        kind: 'browserSelectedElement',
        privacyState: input.privacyState,
    });

    if (unavailable) {
        return {
            status: 'unavailable',
            state: input.state,
            reason: unavailable,
        };
    }

    if (input.pickerResult.status !== 'selected') {
        return {
            status: 'unavailable',
            state: input.state,
            reason: unavailableReason(
                'browser_context_item_unavailable',
                'captureFailed',
                'No selected browser element is available to attach.',
            ),
        };
    }

    const selectorPath = normalizeOptionalString(input.pickerResult.selectorPath)?.slice(0, 1024);
    if (!selectorPath) {
        return {
            status: 'unavailable',
            state: input.state,
            reason: unavailableReason(
                'browser_context_item_unavailable',
                'captureFailed',
                'Selected browser element did not include attachable selector metadata.',
            ),
        };
    }

    const accessibleName = normalizeOptionalString(input.pickerResult.accessibleName);
    const item = BrowserContextItemV1Schema.parse({
        v: 1,
        contextId: buildContextIdFromParts({
            viewId: input.pickerResult.viewId,
            kind: 'browserSelectedElement',
            navigationGeneration: input.pickerResult.navigationGeneration,
            capturedAtMs: input.capturedAtMs,
            contextId: input.contextId,
        }),
        kind: 'browserSelectedElement',
        sourceViewId: input.pickerResult.viewId,
        sourceAdapterKind: input.adapterCapabilities.adapterKind,
        fidelity: resolveSelectedElementFidelity(input),
        capturedAtMs: input.capturedAtMs,
        navigationGeneration: input.pickerResult.navigationGeneration,
        lifecycleState: 'available',
        redactionLevel: 'metadataOnly',
        selectorPath,
        ...(accessibleName ? { accessibleName } : {}),
        ...(input.pickerResult.rect ? { rect: input.pickerResult.rect } : {}),
    });

    return {
        status: 'captured',
        state: upsertContextItem(input.state, item),
        itemId: item.contextId,
    };
}

export function startBrowserAnnotationMode(
    state: BrowserContextState,
    input: BrowserAnnotationModeStartInput,
): BrowserAnnotationModeResult {
    const unavailable = resolveBrowserContextKindAvailability({
        browserContextEnabled: input.browserContextEnabled,
        attachmentsUploadsEnabled: input.attachmentsUploadsEnabled,
        contextCapabilities: input.contextCapabilities,
        adapterCapabilities: input.adapterCapabilities,
        kind: 'browserAnnotation',
        privacyState: input.privacyState,
    });

    if (unavailable) {
        return {
            status: 'unavailable',
            state,
            reason: unavailable,
        };
    }

    return {
        status: 'started',
        state: {
            ...state,
            navigationGenerationByViewId: {
                ...state.navigationGenerationByViewId,
                [input.viewId]: Math.max(
                    state.navigationGenerationByViewId[input.viewId] ?? 0,
                    input.navigationGeneration,
                ),
            },
            activeAnnotationByViewId: {
                ...(state.activeAnnotationByViewId ?? {}),
                [input.viewId]: {
                    browserSessionId: input.browserSessionId,
                    viewId: input.viewId,
                    navigationGeneration: input.navigationGeneration,
                    startedAtMs: input.startedAtMs,
                },
            },
        },
    };
}

export function cancelBrowserAnnotationMode(
    state: BrowserContextState,
    input: Readonly<{ viewId: string }>,
): BrowserContextState {
    const activeAnnotations = state.activeAnnotationByViewId ?? {};
    if (!activeAnnotations[input.viewId]) {
        return state;
    }
    const { [input.viewId]: _removed, ...activeAnnotationByViewId } = activeAnnotations;
    return {
        ...state,
        activeAnnotationByViewId,
    };
}

function resolveActiveAnnotationUnavailable(input: BrowserAnnotationCaptureInput): BrowserContextUnavailableReason | null {
    const active = (input.state.activeAnnotationByViewId ?? {})[input.viewId];
    if (!active || active.browserSessionId !== input.browserSessionId || active.viewId !== input.viewId) {
        return unavailableReason(
            'browser_context_annotation_inactive',
            'captureFailed',
            'Browser annotation mode is not active for this view.',
        );
    }
    if (active.navigationGeneration !== input.navigationGeneration) {
        return unavailableReason(
            'browser_context_annotation_stale',
            'navigationStale',
            'Browser annotation mode was started for an older navigation.',
        );
    }
    return null;
}

export function captureBrowserAnnotation(
    input: BrowserAnnotationCaptureInput,
): BrowserContextCaptureResult {
    const activeUnavailable = resolveActiveAnnotationUnavailable(input);
    if (activeUnavailable) {
        return {
            status: 'unavailable',
            state: input.state,
            reason: activeUnavailable,
        };
    }

    const unavailable = resolveBrowserContextKindAvailability({
        browserContextEnabled: input.browserContextEnabled,
        browserDiagnosticsEnabled: input.target.kind === 'element' ? input.browserDiagnosticsEnabled : undefined,
        attachmentsUploadsEnabled: input.attachmentsUploadsEnabled,
        contextCapabilities: input.contextCapabilities,
        adapterCapabilities: input.adapterCapabilities,
        kind: 'browserAnnotation',
        privacyState: input.privacyState,
    });

    if (unavailable) {
        return {
            status: 'unavailable',
            state: input.state,
            reason: unavailable,
        };
    }

    if (input.target.kind === 'element' && input.browserDiagnosticsEnabled !== true) {
        return {
            status: 'unavailable',
            state: input.state,
            reason: unavailableReason(
                'browser_context_diagnostics_disabled',
                'policyDenied',
                'Browser diagnostics must be enabled to capture element annotations.',
            ),
        };
    }

    const contextId = buildContextIdFromParts({
        viewId: input.viewId,
        kind: 'browserAnnotation',
        navigationGeneration: input.navigationGeneration,
        capturedAtMs: input.capturedAtMs,
        contextId: input.contextId,
    });
    const item = BrowserContextItemV1Schema.parse({
        v: 1,
        contextId,
        kind: 'browserAnnotation',
        sourceViewId: input.viewId,
        sourceAdapterKind: input.adapterCapabilities.adapterKind,
        fidelity: resolveAnnotationFidelity(input),
        capturedAtMs: input.capturedAtMs,
        navigationGeneration: input.navigationGeneration,
        lifecycleState: 'available',
        redactionLevel: 'metadataOnly',
        annotationId: `browser_annotation:${contextId}`,
        browserSessionId: input.browserSessionId,
        media: input.media,
        target: input.target,
        ...(input.styleIntent ? { styleIntent: input.styleIntent } : {}),
        ...(input.stroke ? { stroke: input.stroke } : {}),
        ...(normalizeOptionalBoundedString(input.comment, BROWSER_ANNOTATION_COMMENT_MAX_CHARS)
            ? { comment: normalizeOptionalBoundedString(input.comment, BROWSER_ANNOTATION_COMMENT_MAX_CHARS) }
            : {}),
        ...(stripUrlValues(normalizeOptionalString(input.pageUrl))
            ? { pageUrl: stripUrlValues(normalizeOptionalString(input.pageUrl)) }
            : {}),
        ...(normalizeOptionalBoundedString(input.pageTitle, 512)
            ? { pageTitle: normalizeOptionalBoundedString(input.pageTitle, 512) }
            : {}),
    });
    const stateWithItem = upsertContextItem(input.state, item);

    return {
        status: 'captured',
        state: cancelBrowserAnnotationMode(stateWithItem, { viewId: input.viewId }),
        itemId: item.contextId,
    };
}

type EditableAnnotationItem = Extract<BrowserContextItemV1, { kind: 'browserAnnotation' }>;

function resolveEditableAnnotationItem(
    state: BrowserContextState,
    contextId: string,
): EditableAnnotationItem | BrowserAnnotationCommentUpdateResult {
    const item = state.itemsById[contextId];
    if (!item) {
        return {
            status: 'unavailable',
            state,
            reason: unavailableReason(
                'browser_context_item_missing',
                'adapterUnavailable',
                'Browser annotation context item is no longer available.',
            ),
        };
    }
    if (item.kind !== 'browserAnnotation' || item.lifecycleState !== 'available') {
        return {
            status: 'unavailable',
            state,
            reason: unavailableReason(
                'browser_context_item_unavailable',
                item.lifecycleState,
                item.disabledReason ?? 'Browser annotation context item is not editable.',
            ),
        };
    }
    return item;
}

function commitAnnotationItemUpdate(
    state: BrowserContextState,
    contextId: string,
    nextItem: BrowserContextItemV1,
): BrowserAnnotationCommentUpdateResult {
    return {
        status: 'updated',
        state: {
            ...state,
            itemsById: {
                ...state.itemsById,
                [contextId]: nextItem,
            },
        },
    };
}

export function updateBrowserAnnotationComment(
    state: BrowserContextState,
    input: Readonly<{ contextId: string; comment: string | null | undefined }>,
): BrowserAnnotationCommentUpdateResult {
    const resolved = resolveEditableAnnotationItem(state, input.contextId);
    if ('status' in resolved) return resolved;

    const comment = normalizeOptionalBoundedString(input.comment, BROWSER_ANNOTATION_COMMENT_MAX_CHARS);
    const { comment: _previousComment, ...itemWithoutComment } = resolved;
    const nextItem = BrowserContextItemV1Schema.parse({
        ...itemWithoutComment,
        ...(comment ? { comment } : {}),
    });

    return commitAnnotationItemUpdate(state, input.contextId, nextItem);
}

export function updateBrowserAnnotationStroke(
    state: BrowserContextState,
    input: Readonly<{ contextId: string; stroke: BrowserAnnotationStrokeV1 | null | undefined }>,
): BrowserAnnotationCommentUpdateResult {
    const resolved = resolveEditableAnnotationItem(state, input.contextId);
    if ('status' in resolved) return resolved;

    const { stroke: _previousStroke, ...itemWithoutStroke } = resolved;
    const nextItem = BrowserContextItemV1Schema.parse({
        ...itemWithoutStroke,
        ...(input.stroke ? { stroke: input.stroke } : {}),
    });

    return commitAnnotationItemUpdate(state, input.contextId, nextItem);
}

export function updateBrowserAnnotationStyleIntent(
    state: BrowserContextState,
    input: Readonly<{ contextId: string; styleIntent: BrowserAnnotationStyleIntentV1 | null | undefined }>,
): BrowserAnnotationCommentUpdateResult {
    const resolved = resolveEditableAnnotationItem(state, input.contextId);
    if ('status' in resolved) return resolved;

    const { styleIntent: _previousStyleIntent, ...itemWithoutStyleIntent } = resolved;
    const nextItem = BrowserContextItemV1Schema.parse({
        ...itemWithoutStyleIntent,
        ...(input.styleIntent ? { styleIntent: input.styleIntent } : {}),
    });

    return commitAnnotationItemUpdate(state, input.contextId, nextItem);
}

export type { BrowserViewTargetV1 };
