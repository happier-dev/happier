import type {
    BrowserDiagnosticFidelityV1,
    BrowserEvidenceSessionMediaReferenceV1,
    BrowserRecordingCapabilities,
    BrowserRecordingCaptureKindV1,
    BrowserRecordingOutcomeReasonV1,
    BrowserRecordingPolicyStateV1,
    BrowserRecordingRetentionClassV1,
    BrowserRecordingSessionV1,
    BrowserViewTargetKindV1,
    BrowserRenderEngineKindV1,
    BrowserSemanticAdapterKindV1,
} from '@happier-dev/protocol';

export type BrowserRecordingUnavailableReasonCode =
    | 'browser_recording_disabled'
    | 'browser_recording_capability_unavailable'
    | 'browser_recording_adapter_unavailable'
    | 'browser_recording_capture_unavailable'
    | 'browser_recording_mime_unavailable'
    | 'browser_recording_retention_unavailable'
    | 'browser_recording_permission_denied'
    | 'browser_recording_already_active'
    | 'browser_recording_missing'
    | 'browser_recording_not_finalized'
    | 'browser_recording_media_missing'
    | 'browser_recording_attachments_disabled'
    | 'browser_recording_attachment_uploads_disabled'
    | 'browser_recording_session_media_policy_denied'
    | 'browser_recording_context_policy_denied';

export type BrowserRecordingUnavailableReason = Readonly<{
    reasonCode: BrowserRecordingUnavailableReasonCode;
    policyState: BrowserRecordingPolicyStateV1;
    message: string;
}>;

export type BrowserRecordingState = Readonly<{
    sessionsById: Readonly<Record<string, BrowserRecordingSessionV1>>;
    sessionOrder: readonly string[];
    activeRecordingIdByViewId: Readonly<Record<string, string>>;
    attachmentsById: Readonly<Record<string, BrowserRecordingComposerAttachmentRecord>>;
    attachmentOrder: readonly string[];
}>;

export type BrowserRecordingComposerAttachmentRecord = Readonly<{
    attachmentId: string;
    recordingId: string;
    mediaRef: BrowserEvidenceSessionMediaReferenceV1;
}>;

export type BrowserRecordingStartInput = Readonly<{
    state: BrowserRecordingState;
    browserRecordingEnabled: boolean;
    recordingCapabilities: BrowserRecordingCapabilities;
    browserSessionId: string;
    viewId: string;
    profileId: string;
    targetKind: BrowserViewTargetKindV1;
    adapterKind: BrowserSemanticAdapterKindV1;
    renderEngineKind: BrowserRenderEngineKindV1;
    captureKind: BrowserRecordingCaptureKindV1;
    fidelity: BrowserDiagnosticFidelityV1;
    startedAtMs: number;
    navigationGeneration: number;
    mimeType: string;
    retentionClass: BrowserRecordingRetentionClassV1;
    policyState?: BrowserRecordingPolicyStateV1;
    captureSourceAvailable?: boolean;
    recordingId?: string;
}>;

export type BrowserRecordingStartResult =
    | Readonly<{
        status: 'started';
        state: BrowserRecordingState;
        recordingId: string;
      }>
    | Readonly<{
        status: 'unavailable';
        state: BrowserRecordingState;
        reason: BrowserRecordingUnavailableReason;
      }>;

export type BrowserRecordingLifecycleEvent = 'hidden' | 'parked' | 'suspended' | 'hostLost' | 'closed';

export type BrowserRecordingLifecycleResult =
    | Readonly<{
        status: 'updated';
        state: BrowserRecordingState;
        recording: BrowserRecordingSessionV1;
      }>
    | Readonly<{
        status: 'unavailable';
        state: BrowserRecordingState;
        reason: BrowserRecordingUnavailableReason;
      }>;

export type BrowserRecordingFinalizeInput = Readonly<{
    recordingId: string;
    stoppedAtMs: number;
    navigationGenerationEnd: number;
    durationMs: number;
    byteSize: number;
    frameCount: number;
    fps: number;
    mediaRef: BrowserEvidenceSessionMediaReferenceV1;
    expiresAtMs?: number;
}>;

export type BrowserRecordingFinalizeResult =
    | Readonly<{
        status: 'finalized';
        state: BrowserRecordingState;
        recording: BrowserRecordingSessionV1;
      }>
    | Readonly<{
        status: 'unavailable';
        state: BrowserRecordingState;
        reason: BrowserRecordingUnavailableReason;
      }>;

export type BrowserRecordingCleanupResult = Readonly<{
    state: BrowserRecordingState;
    discardedRecordingIds: readonly string[];
}>;

export type BrowserRecordingAttachmentInput = Readonly<{
    recordingId: string;
    attachmentId: string;
    browserRecordingEnabled: boolean;
    browserRecordingAttachmentsEnabled: boolean;
    attachmentsUploadsEnabled: boolean;
    sessionMediaPolicyAllowed: boolean;
    browserContextPolicyAllowed: boolean;
}>;

export type BrowserRecordingAttachResult =
    | Readonly<{
        status: 'attached';
        state: BrowserRecordingState;
        attachmentId: string;
      }>
    | Readonly<{
        status: 'unavailable';
        state: BrowserRecordingState;
        reason: BrowserRecordingUnavailableReason;
      }>;

export type BrowserRecordingAvailabilityInput = Readonly<{
    browserRecordingEnabled: boolean;
    recordingCapabilities: BrowserRecordingCapabilities;
    adapterKind: BrowserSemanticAdapterKindV1;
    renderEngineKind?: BrowserRenderEngineKindV1;
    captureKind: BrowserRecordingCaptureKindV1;
    mimeType: string;
    retentionClass: BrowserRecordingRetentionClassV1;
    policyState?: BrowserRecordingPolicyStateV1;
    captureSourceAvailable?: boolean;
}>;
