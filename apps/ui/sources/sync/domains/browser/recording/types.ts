import type {
    BrowserRecordingCaptureKindV1,
    BrowserRecordingPolicyStateV1,
    BrowserRecordingRetentionClassV1,
    BrowserRecordingSessionV1} from '@happier-dev/protocol/browser/recording/v1';
import type {
    BrowserRecordingCapabilities} from '@happier-dev/protocol/features/payload/capabilities/browserCapabilities';
import type {
    BrowserRenderEngineKindV1,
    BrowserSemanticAdapterKindV1,
} from '@happier-dev/protocol/browser/adapters/kinds';

export type BrowserRecordingUnavailableReasonCode =
    | 'browser_recording_disabled'
    | 'browser_recording_capability_unavailable'
    | 'browser_recording_adapter_unavailable'
    | 'browser_recording_capture_unavailable'
    | 'browser_recording_mime_unavailable'
    | 'browser_recording_retention_unavailable'
    | 'browser_recording_permission_denied'
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
