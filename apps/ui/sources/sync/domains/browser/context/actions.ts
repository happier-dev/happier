import { BROWSER_CONTEXT_SELECTION_MAX_CHARS, BROWSER_CONTEXT_SUMMARY_MAX_CHARS, BrowserContextItemV1Schema, type BrowserContextItemV1, type BrowserContextKindV1 } from '@happier-dev/protocol/browser/context/v1';
import { resolveBrowserContextPrivacyDenial } from '@happier-dev/protocol/browser/context/privacy';
import { stripBrowserDiagnosticUrlValues } from '@happier-dev/protocol/browser/diagnostics/egress/url';
import type { BrowserDiagnosticFidelityV1 } from '@happier-dev/protocol/browser/diagnostics/v1';
import type { BrowserViewTargetV1 } from '@happier-dev/protocol/browser/target/v1';

import type {
    BrowserContextCaptureResult,
    BrowserContextKindAvailabilityInput,
    BrowserContextState,
    BrowserContextUnavailableReason,
    BrowserContextUnavailableReasonCode,
    BrowserAnnotationModeResult,
    BrowserAnnotationModeStartInput,
    BrowserPageReferenceCaptureInput,
    BrowserScreenshotReferenceCaptureInput,
    BrowserSelectedElementCaptureInput,
    BrowserSummaryContextCaptureInput,
    BrowserTextSelectionCaptureInput,
} from './types';

const CONTEXT_ID_PREFIX = 'browser_context';
const MEDIA_BACKED_CONTEXT_KINDS = new Set<BrowserContextKindV1>([
    'browserScreenshot',
    'browserAnnotation',
]);

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
    const denial = resolveBrowserContextPrivacyDenial(privacyState);
    if (!denial) return null;
    switch (denial.lifecycleState) {
        case 'sensitiveOrigin':
            return unavailableReason(
                denial.reasonCode,
                denial.lifecycleState,
                'Browser context is unavailable for sensitive origins.',
            );
        case 'sensitiveFieldsPresent':
            return unavailableReason(
                denial.reasonCode,
                denial.lifecycleState,
                'Browser context is unavailable while sensitive fields are present.',
            );
        case 'ephemeralOnly':
            return unavailableReason(
                denial.reasonCode,
                denial.lifecycleState,
                'Browser context is unavailable for private or ephemeral browser profiles.',
            );
    }
}

export function resolveBrowserContextKindAvailability(
    input: BrowserContextKindAvailabilityInput,
): BrowserContextUnavailableReason | null {
    if (!input.contextCapabilities.available) {
        return unavailableReason(
            'browser_context_capability_unavailable',
            'policyDenied',
            input.contextCapabilities.disabledReasons[0] ?? 'Browser context capability is unavailable.',
        );
    }

    const privacyReason = resolvePrivacyReason(input.privacyState);
    if (privacyReason) return privacyReason;

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
    return value ? stripBrowserDiagnosticUrlValues(value) || undefined : undefined;
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

export function upsertContextItem(state: BrowserContextState, item: BrowserContextState['itemsById'][string]): BrowserContextState {
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
        BROWSER_CONTEXT_SELECTION_MAX_CHARS,
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

export function captureBrowserSummaryContext(
    input: BrowserSummaryContextCaptureInput,
): BrowserContextCaptureResult {
    const unavailable = resolveBrowserContextKindAvailability({
        browserContextEnabled: input.browserContextEnabled,
        browserDiagnosticsEnabled: input.browserDiagnosticsEnabled,
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
        BROWSER_CONTEXT_SUMMARY_MAX_CHARS,
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
        ...(input.pickerResult.componentName ? { componentName: input.pickerResult.componentName } : {}),
        ...(input.pickerResult.sourceLocation ? { sourceLocation: input.pickerResult.sourceLocation } : {}),
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


export type { BrowserViewTargetV1 };
