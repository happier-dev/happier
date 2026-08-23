import type {
    BrowserAdapterCapabilitiesV1,
    BrowserAnnotationStrokeV1,
    BrowserAnnotationStyleIntentV1,
    BrowserAnnotationTargetV1,
    BrowserContextCapabilities,
    BrowserContextItemV1,
    BrowserContextKindV1,
    BrowserContextLifecycleStateV1,
    BrowserDiagnosticsElementPickerResultV1,
    BrowserDiagnosticsElementSourceLocationV1,
    BrowserScreenshotMediaReferenceV1,
    BrowserViewTargetV1,
} from '@happier-dev/protocol';

import type { AnnotationCropClip, AnnotationViewportRect } from './annotationCropGeometry';

export type BrowserContextPrivacyState = Extract<
    BrowserContextLifecycleStateV1,
    'sensitiveOrigin' | 'sensitiveFieldsPresent' | 'ephemeralOnly'
>;

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
    /**
     * ANNO-1/ANNO-5: the per-view EDITOR-SESSION annotation draft accumulated by the in-page editor
     * (Select/Region/Draw/Erase + comment) before Attach. Distinct from the single-capture
     * `BrowserAnnotationDraftInput` — this multi-target draft is committed at Attach into N grouped
     * `browserAnnotation` items sharing one annotationId + one cropped media. Keyed by viewId and
     * pinned to a `navigationGeneration` so a navigation clears it (no cross-page leak).
     */
    annotationDraftByViewId: Readonly<Record<string, BrowserAnnotationEditorDraft>>;
}>;

/** A geometric rect in CSS viewport coordinates (origin = current scroll position). */
export type BrowserAnnotationViewportRect = Readonly<{
    x: number;
    y: number;
    width: number;
    height: number;
}>;

export type BrowserAnnotationDraftElementTarget = Readonly<{
    draftId: string;
    kind: 'element';
    selectorPath: string;
    accessibleName?: string;
    /** Bounding rect in CSS viewport px, used for the union crop. */
    rect?: BrowserAnnotationViewportRect;
    /**
     * UB-7. The component that rendered the picked node and the file it came from, carried through
     * from the element picker so an attached element tells the agent where to edit, not only where
     * to look. Absent when the engine cannot supply them (non-React page, production build).
     */
    componentName?: string;
    sourceLocation?: BrowserDiagnosticsElementSourceLocationV1;
    addedAtMs: number;
}>;

export type BrowserAnnotationDraftRegionTarget = Readonly<{
    draftId: string;
    kind: 'region';
    /** Marquee rect in CSS viewport px. */
    rect: BrowserAnnotationViewportRect;
    addedAtMs: number;
}>;

export type BrowserAnnotationDraftStroke = Readonly<{
    draftId: string;
    kind: 'stroke';
    shape: BrowserAnnotationStrokeV1['shape'];
    /** Freehand/vector points in CSS viewport px. Normalized to the crop at commit time. */
    points: readonly Readonly<{ x: number; y: number }>[];
    colorToken?: string;
    widthPx?: number;
    addedAtMs: number;
}>;

/**
 * The accumulated multi-target editor session. `targets`/`regions` are the marked elements/regions;
 * `strokes` are freehand overlays; `comment` is the shared annotation note. `annotationId` is the
 * group key every committed item shares so the composer + agent turn render exactly one card.
 */
export type BrowserAnnotationEditorDraft = Readonly<{
    annotationId: string;
    browserSessionId: string;
    viewId: string;
    navigationGeneration: number;
    status: 'authoring';
    createdAtMs: number;
    updatedAtMs: number;
    targets: readonly BrowserAnnotationDraftElementTarget[];
    regions: readonly BrowserAnnotationDraftRegionTarget[];
    strokes: readonly BrowserAnnotationDraftStroke[];
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

export type BrowserAnnotationCaptureInput = Readonly<{
    state: BrowserContextState;
    browserContextEnabled: boolean;
    browserDiagnosticsEnabled?: boolean;
    attachmentsUploadsEnabled?: boolean;
    contextCapabilities: BrowserContextCapabilities;
    adapterCapabilities: BrowserAdapterCapabilitiesV1;
    browserSessionId: string;
    viewId: string;
    navigationGeneration: number;
    capturedAtMs: number;
    media: BrowserScreenshotMediaReferenceV1;
    target: BrowserAnnotationTargetV1;
    comment?: string | null;
    styleIntent?: BrowserAnnotationStyleIntentV1 | null;
    stroke?: BrowserAnnotationStrokeV1 | null;
    pageUrl?: string | null;
    pageTitle?: string | null;
    privacyState?: BrowserContextPrivacyState | null;
    contextId?: string;
}>;

export type BrowserAnnotationDraftInput = Readonly<{
    media: BrowserScreenshotMediaReferenceV1;
    target: BrowserAnnotationTargetV1;
    comment?: string | null;
    styleIntent?: BrowserAnnotationStyleIntentV1 | null;
    stroke?: BrowserAnnotationStrokeV1 | null;
    pageUrl?: string | null;
    pageTitle?: string | null;
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
    /**
     * ANNO-3 full crop contract. CDP consumes `cssPageRect + scale`; Wry consumes
     * `devicePageRect`. Absent means full-frame capture.
     */
    cropClip?: AnnotationCropClip;
    /**
     * Legacy Wry clip field retained for older producers; new producers should use `cropClip`.
     */
    cropRect?: AnnotationViewportRect;
}>;

export type BrowserAnnotationCaptureProviderResult =
    | Readonly<{
        status: 'captured';
        browserSessionId: string;
        viewId: string;
        navigationGeneration: number;
        capturedAtMs?: number;
      } & BrowserAnnotationDraftInput>
    | Readonly<{
        status: 'unavailable';
        reason?: BrowserContextUnavailableReason;
      }>;

export type BrowserAnnotationCaptureProvider = Readonly<{
    available: boolean;
    captureAnnotation: (
        request: BrowserAnnotationCaptureRequest,
    ) => BrowserAnnotationCaptureProviderResult | Promise<BrowserAnnotationCaptureProviderResult>;
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

export type BrowserAnnotationCommentUpdateResult =
    | Readonly<{
        status: 'updated';
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
