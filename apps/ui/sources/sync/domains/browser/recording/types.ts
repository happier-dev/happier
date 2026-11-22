import type {
    BrowserRecordingPolicyStateV1,
    BrowserRecordingSessionV1} from '@happier-dev/protocol/browser/recording/v1';
import type { BrowserRecordingAvailabilityReason } from '@happier-dev/protocol/browser/recording/captureProfiles';
export type { BrowserRecordingAvailabilityInput } from '@happier-dev/protocol/browser/recording/captureProfiles';

export type BrowserRecordingUnavailableReasonCode =
    | BrowserRecordingAvailabilityReason['reasonCode']
    | 'browser_recording_missing'
    | 'browser_recording_not_finalized'
    | 'browser_recording_media_missing'
    | 'browser_recording_attachments_disabled'
    | 'browser_recording_attachment_uploads_disabled'
    | 'browser_recording_session_media_policy_denied'
    | 'browser_recording_context_policy_denied'
    // The Machine's video encoder, shared with Computer recording (daemon encoderFailure.ts).
    | 'encoder_unavailable'
    | 'encoder_failed';

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
