import type {
    BrowserDiagnosticFidelityV1,
    BrowserRecordingCapabilities,
    BrowserRecordingCaptureKindV1,
    BrowserRecordingPolicyStateV1,
    BrowserRecordingRetentionClassV1,
    BrowserRecordingSessionV1,
} from '@happier-dev/protocol';
import { resolveBrowserRecordingCaptureProfile } from '@happier-dev/protocol/browser/recording/captureProfiles';

import type { BrowserControlViewState } from '@/sync/domains/browser/control';
import {
    resolveBrowserRecordingAvailability,
    type BrowserRecordingState,
    type BrowserRecordingUnavailableReason,
} from '@/sync/domains/browser/recording';
import { t } from '@/text';

export type BrowserRecordingStartControlRequest = Readonly<{
    browserSessionId: string;
    viewId: string;
    profileId: string;
    target: BrowserControlViewState['target'];
    targetKind: BrowserControlViewState['target']['kind'];
    adapterKind: BrowserControlViewState['adapterKind'];
    renderEngineKind: BrowserControlViewState['engineKind'];
    captureKind: BrowserRecordingCaptureKindV1;
    fidelity: BrowserDiagnosticFidelityV1;
    navigationGeneration: number;
    mimeType: string;
    retentionClass: BrowserRecordingRetentionClassV1;
    policyState: BrowserRecordingPolicyStateV1;
}>;

export type BrowserRecordingControlInput = Readonly<{
    view: BrowserControlViewState | null;
    profileId: string | null;
    state: BrowserRecordingState;
    recordingCapabilities: BrowserRecordingCapabilities;
    enabled?: boolean;
    policyState?: BrowserRecordingPolicyStateV1;
    captureKind?: BrowserRecordingCaptureKindV1;
    fidelity?: BrowserDiagnosticFidelityV1;
    mimeType?: string;
    retentionClass?: BrowserRecordingRetentionClassV1;
    isCaptureSourceAvailable?: (input: Readonly<{
        view: BrowserControlViewState;
        captureKind: BrowserRecordingCaptureKindV1;
    }>) => boolean;
}>;

/**
 * The browser's recording decision for the focused view, in one place: is a recording running, and
 * if not, can one start (with the capture profile the view's engine can actually produce) or why not.
 *
 * Presentation is split by frequency: an idle recorder is a one-shot tool in the `⋯` menu, a running
 * one is the single capsule in the chrome (`BrowserRecordingCapsule`). Both read this, so the menu
 * and the capsule can never disagree about what is possible.
 */
export type BrowserRecordingControl = Readonly<{
    activeRecording: BrowserRecordingSessionV1 | null;
    unavailable: BrowserRecordingUnavailableReason | null;
    startRequest: BrowserRecordingStartControlRequest | null;
}>;

function findActiveRecording(
    state: BrowserRecordingState,
    view: BrowserControlViewState | null,
): BrowserRecordingSessionV1 | null {
    if (!view) return null;
    const recordingId = state.activeRecordingIdByViewId[view.viewId];
    return recordingId ? state.sessionsById[recordingId] ?? null : null;
}

function resolveCaptureSourceAvailable(input: BrowserRecordingControlInput): boolean | undefined {
    if (!input.view) return undefined;
    if (input.captureKind) {
        return input.isCaptureSourceAvailable?.({ view: input.view, captureKind: input.captureKind }) ?? false;
    }
    return (
        input.isCaptureSourceAvailable?.({ view: input.view, captureKind: 'nativeViewCapture' }) === true
        || input.isCaptureSourceAvailable?.({ view: input.view, captureKind: 'streamFrameCapture' }) === true
    );
}

export function resolveBrowserRecordingControl(input: BrowserRecordingControlInput): BrowserRecordingControl {
    const activeRecording = findActiveRecording(input.state, input.view);
    const view = input.view;
    const captureSourceAvailable = resolveCaptureSourceAvailable(input);
    const captureProfile = view
        ? resolveBrowserRecordingCaptureProfile({
            recordingCapabilities: input.recordingCapabilities,
            adapterKind: view.adapterKind,
            renderEngineKind: view.engineKind,
            captureKind: input.captureKind,
            mimeType: input.mimeType,
            retentionClass: input.retentionClass,
            captureSourceAvailable,
        })
        : null;
    const captureKind = captureProfile?.captureKind ?? input.captureKind ?? 'unavailable';
    const mimeType = captureProfile?.mimeType ?? input.mimeType ?? 'video/webm';
    const retentionClass = captureProfile?.retentionClass ?? input.retentionClass ?? 'preSend';
    const fidelity = input.fidelity
        ?? captureProfile?.fidelity
        ?? view?.adapterCapabilities.diagnosticsFidelityByFamily.screenshot
        ?? 'unavailable';
    const policyState = input.policyState ?? 'allowed';
    const unavailable: BrowserRecordingUnavailableReason | null = view && input.profileId
        ? resolveBrowserRecordingAvailability({
            browserRecordingEnabled: input.enabled !== false,
            recordingCapabilities: input.recordingCapabilities,
            adapterKind: view.adapterKind,
            renderEngineKind: view.engineKind,
            captureKind,
            mimeType,
            retentionClass,
            policyState,
            captureSourceAvailable,
        })
        : {
            reasonCode: 'browser_recording_capability_unavailable',
            policyState: 'captureUnavailable',
            message: t('browserRecording.status.noView'),
        };
    const startRequest = !activeRecording && !unavailable && view && input.profileId
        ? {
            browserSessionId: view.browserSessionId,
            viewId: view.viewId,
            profileId: input.profileId,
            target: view.target,
            targetKind: view.target.kind,
            adapterKind: view.adapterKind,
            renderEngineKind: view.engineKind,
            captureKind,
            fidelity,
            navigationGeneration: view.navigationGeneration,
            mimeType,
            retentionClass,
            policyState,
        } satisfies BrowserRecordingStartControlRequest
        : null;
    return { activeRecording, unavailable: activeRecording ? null : unavailable, startRequest };
}
