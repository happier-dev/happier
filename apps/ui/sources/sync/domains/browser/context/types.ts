import type {
    BrowserAdapterCapabilitiesV1} from '@happier-dev/protocol/browser/adapters/v1';
import type {
    BrowserContextAnnotationElementV2,
    BrowserContextItemV1,
    BrowserContextKindV1,
    BrowserContextLifecycleStateV1,
    BrowserScreenshotMediaReferenceV1} from '@happier-dev/protocol/browser/context/v1';
import type {
    BrowserContextCapabilities} from '@happier-dev/protocol/features/payload/capabilities/browserCapabilities';
import type {
    BrowserContextPrivacyState} from '@happier-dev/protocol/browser/context/privacy';
import type {
    BrowserDiagnosticsElementPickerResultV1,
} from '@happier-dev/protocol/browser/diagnostics/v1';
import type {
    BrowserViewTargetV1,
} from '@happier-dev/protocol/browser/target/v1';

import type { ImageMarksDocumentV1 } from '@happier-dev/protocol';
import type { ImageAnnotationSource } from '@/components/ui/media/annotation/types';
import type { BrowserAnnotationViewportCaptureResult } from './captureProvider';

export type { BrowserContextPrivacyState } from '@happier-dev/protocol/browser/context/privacy';

export type BrowserContextUnavailableReasonCode =
    | 'browser_context_disabled'
    | 'browser_context_capability_unavailable'
    | 'browser_context_kind_unavailable'
    | 'browser_context_adapter_unavailable'
    | 'browser_context_attachment_uploads_disabled'
    | 'browser_context_diagnostics_disabled'
    | 'browser_context_sensitive_origin'
    | 'browser_context_sensitive_fields_present'
    | 'browser_context_ephemeral_only'
    | 'browser_context_annotation_inactive'
    | 'browser_context_annotation_stale'
    | 'browser_context_annotation_capture_unavailable'
    | 'browser_context_annotation_iframe_capture_unavailable'
    | 'browser_context_annotation_capture_failed'
    | 'browser_context_view_unavailable'
    | 'browser_context_item_missing'
    | 'browser_context_item_unavailable';

export type BrowserContextUnavailableReason = Readonly<{
    lifecycleState: BrowserContextLifecycleStateV1;
    reasonCode: BrowserContextUnavailableReasonCode;
    message: string;
}>;

export type BrowserContextState = Readonly<{
    itemsById: Readonly<Record<string, BrowserContextItemV1>>;
    itemOrder: readonly string[];
    attachmentsById: Readonly<Record<string, BrowserContextComposerAttachmentRecord>>;
    attachmentOrder: readonly string[];
    navigationGenerationByViewId: Readonly<Record<string, number>>;
    activeAnnotationByViewId: Readonly<Record<string, BrowserAnnotationModeState>>;
    /** The frozen viewport, shared marks document and browser source facts, keyed by view. */
    annotationDraftByViewId: Readonly<Record<string, BrowserFrozenAnnotationDraft>>;
}>;

/** One frozen picture and one canonical image-space document for the browser host. */
export type BrowserFrozenAnnotationDraft = Readonly<{
    annotationId: string;
    browserSessionId: string;
    viewId: string;
    navigationGeneration: number;
    status: 'authoring';
    createdAtMs: number;
    updatedAtMs: number;
    source: ImageAnnotationSource;
    capture: Extract<BrowserAnnotationViewportCaptureResult, { status: 'captured' }>['capture'];
    dispose?: () => void | Promise<void>;
    document: ImageMarksDocumentV1;
    elements: Readonly<Record<string, Omit<BrowserContextAnnotationElementV2, 'markId'>>>;
    pageUrl?: string;
    pageTitle?: string;
    comment?: string;
}>;

export type BrowserContextComposerAttachmentRecord = Readonly<{
    attachmentId: string;
    contextId: string;
}>;

export type BrowserAnnotationModeState = Readonly<{
    browserSessionId: string;
    viewId: string;
    navigationGeneration: number;
    startedAtMs: number;
}>;

export type BrowserContextPageCaptureState = Readonly<{
    url?: string | null;
    title?: string | null;
    faviconUrl?: string | null;
    navigationGeneration: number;
    capturedAtMs: number;
    privacyState?: BrowserContextPrivacyState | null;
}>;

export type BrowserPageReferenceCaptureInput = Readonly<{
    state: BrowserContextState;
    browserContextEnabled: boolean;
    contextCapabilities: BrowserContextCapabilities;
    adapterCapabilities: BrowserAdapterCapabilitiesV1;
    viewId: string;
    target: BrowserViewTargetV1;
    page: BrowserContextPageCaptureState;
    contextId?: string;
}>;

export type BrowserScreenshotReferenceCaptureInput = Readonly<{
    state: BrowserContextState;
    browserContextEnabled: boolean;
    attachmentsUploadsEnabled?: boolean;
    contextCapabilities: BrowserContextCapabilities;
    adapterCapabilities: BrowserAdapterCapabilitiesV1;
    viewId: string;
    navigationGeneration: number;
    capturedAtMs: number;
    media: BrowserScreenshotMediaReferenceV1;
    privacyState?: BrowserContextPrivacyState | null;
    contextId?: string;
}>;

export type BrowserTextSelectionCaptureInput = Readonly<{
    state: BrowserContextState;
    browserContextEnabled: boolean;
    contextCapabilities: BrowserContextCapabilities;
    adapterCapabilities: BrowserAdapterCapabilitiesV1;
    viewId: string;
    navigationGeneration: number;
    capturedAtMs: number;
    text: string;
    privacyState?: BrowserContextPrivacyState | null;
    contextId?: string;
}>;

export type BrowserSummaryContextKind = Extract<
    BrowserContextKindV1,
    | 'browserPageTextSummary'
    | 'browserDomSnapshotSummary'
    | 'browserNetworkSummary'
    | 'browserConsoleSummary'
>;

export type BrowserSummaryContextCaptureInput = Readonly<{
    state: BrowserContextState;
    browserContextEnabled: boolean;
    browserDiagnosticsEnabled?: boolean;
    contextCapabilities: BrowserContextCapabilities;
    adapterCapabilities: BrowserAdapterCapabilitiesV1;
    viewId: string;
    navigationGeneration: number;
    capturedAtMs: number;
    kind: BrowserSummaryContextKind;
    summary: string;
    privacyState?: BrowserContextPrivacyState | null;
    contextId?: string;
}>;

export type BrowserSelectedElementCaptureInput = Readonly<{
    state: BrowserContextState;
    browserContextEnabled: boolean;
    browserDiagnosticsEnabled?: boolean;
    contextCapabilities: BrowserContextCapabilities;
    adapterCapabilities: BrowserAdapterCapabilitiesV1;
    capturedAtMs: number;
    pickerResult: BrowserDiagnosticsElementPickerResultV1;
    privacyState?: BrowserContextPrivacyState | null;
    contextId?: string;
}>;

export type BrowserAnnotationCaptureRequest = Readonly<{
    browserSessionId: string;
    viewId: string;
    navigationGeneration: number;
    capturedAtMs: number;
    adapterKind: BrowserAdapterCapabilitiesV1['adapterKind'];
    browserTarget: BrowserViewTargetV1;
    currentUrl?: string | null;
    title?: string | null;
    securityOrigin?: string | null;
}>;

export type BrowserAnnotationCaptureProvider = Readonly<{
    available: boolean;
    captureViewport(request: BrowserAnnotationCaptureRequest): Promise<BrowserAnnotationViewportCaptureResult>;
}>;

export type BrowserAnnotationModeStartInput = Readonly<{
    browserContextEnabled: boolean;
    attachmentsUploadsEnabled?: boolean;
    contextCapabilities: BrowserContextCapabilities;
    adapterCapabilities: BrowserAdapterCapabilitiesV1;
    browserSessionId: string;
    viewId: string;
    navigationGeneration: number;
    startedAtMs: number;
    privacyState?: BrowserContextPrivacyState | null;
}>;

export type BrowserAnnotationModeResult =
    | Readonly<{
        status: 'started';
        state: BrowserContextState;
      }>
    | Readonly<{
        status: 'unavailable';
        state: BrowserContextState;
        reason: BrowserContextUnavailableReason;
      }>;

export type BrowserContextCaptureResult =
    | Readonly<{
        status: 'captured';
        state: BrowserContextState;
        itemId: string;
      }>
    | Readonly<{
        status: 'unavailable';
        state: BrowserContextState;
        reason: BrowserContextUnavailableReason;
      }>;

export type AttachBrowserContextToComposerInput = Readonly<{
    attachmentId: string;
    contextId: string;
}>;

export type BrowserContextAttachResult =
    | Readonly<{
        status: 'attached';
        state: BrowserContextState;
        attachmentId: string;
      }>
    | Readonly<{
        status: 'unavailable';
        state: BrowserContextState;
        reason: BrowserContextUnavailableReason;
      }>;

export type BrowserContextNavigationInput = Readonly<{
    viewId: string;
    navigationGeneration: number;
}>;

export type BrowserContextKindAvailabilityInput = Readonly<{
    browserContextEnabled: boolean;
    attachmentsUploadsEnabled?: boolean;
    contextCapabilities: BrowserContextCapabilities;
    adapterCapabilities: BrowserAdapterCapabilitiesV1;
    kind: BrowserContextKindV1;
    browserDiagnosticsEnabled?: boolean;
    privacyState?: BrowserContextPrivacyState | null;
}>;
