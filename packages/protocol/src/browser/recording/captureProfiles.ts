import type {
  BrowserRenderEngineKindV1,
  BrowserSemanticAdapterKindV1,
} from '../adapters/kinds.js';
import type { BrowserDiagnosticFidelityV1 } from '../diagnostics/v1.js';
import type {
  BrowserRecordingCaptureKindV1,
  BrowserRecordingPolicyStateV1,
  BrowserRecordingRetentionClassV1,
} from './v1.js';
import type { BrowserRecordingCapabilities } from '../../features/payload/capabilities/browserCapabilities.js';

export type BrowserRecordingCaptureProfile = Readonly<{
  captureKind: BrowserRecordingCaptureKindV1;
  adapterKinds: readonly BrowserSemanticAdapterKindV1[];
  renderEngineKinds?: readonly BrowserRenderEngineKindV1[];
  requiresCaptureSource?: boolean;
  mimeTypes: readonly string[];
  fidelity: BrowserDiagnosticFidelityV1;
}>;

export type ResolvedBrowserRecordingCaptureProfile = Readonly<{
  adapterKind: BrowserSemanticAdapterKindV1;
  captureKind: BrowserRecordingCaptureKindV1;
  mimeType: string;
  fidelity: BrowserDiagnosticFidelityV1;
  retentionClass: BrowserRecordingRetentionClassV1;
}>;

export type BrowserRecordingProfileUnavailableReason =
  | 'capability'
  | 'adapter'
  | 'engine'
  | 'capture'
  | 'mime'
  | 'source'
  | 'retention';

export const BROWSER_RECORDING_CAPTURE_PROFILES = [
  {
    captureKind: 'nativeViewCapture',
    adapterKinds: ['externalUrl'],
    renderEngineKinds: ['desktopWebView'],
    requiresCaptureSource: true,
    mimeTypes: ['image/png'],
    fidelity: 'nativeCallback',
  },
  {
    captureKind: 'cdpScreencast',
    adapterKinds: ['chromiumSidecar', 'streamedBrowserSurface'],
    mimeTypes: ['video/webm'],
    fidelity: 'cdp',
  },
  {
    captureKind: 'streamFrameCapture',
    adapterKinds: ['streamedBrowserSurface', 'simulatorPreview'],
    requiresCaptureSource: true,
    mimeTypes: ['video/webm'],
    fidelity: 'streamFrame',
  },
] as const satisfies readonly BrowserRecordingCaptureProfile[];

function profileSupportsAdapter(
  profile: BrowserRecordingCaptureProfile,
  adapterKind: BrowserSemanticAdapterKindV1,
): boolean {
  return profile.adapterKinds.includes(adapterKind);
}

function profileSupportsMimeType(
  profile: BrowserRecordingCaptureProfile,
  mimeType: string,
): boolean {
  return profile.mimeTypes.includes(mimeType);
}

function profileSupportsRenderEngine(
  profile: BrowserRecordingCaptureProfile,
  renderEngineKind?: BrowserRenderEngineKindV1,
): boolean {
  if (!profile.renderEngineKinds) return true;
  if (!renderEngineKind) return false;
  return profile.renderEngineKinds.includes(renderEngineKind);
}

function profileHasRequiredCaptureSource(
  profile: BrowserRecordingCaptureProfile,
  captureSourceAvailable?: boolean,
): boolean {
  return profile.requiresCaptureSource !== true || captureSourceAvailable === true;
}

export function listBrowserRecordingCaptureProfilesForAdapter(
  adapterKind: BrowserSemanticAdapterKindV1,
): readonly BrowserRecordingCaptureProfile[] {
  return BROWSER_RECORDING_CAPTURE_PROFILES.filter((profile) =>
    profileSupportsAdapter(profile, adapterKind),
  );
}

function capabilityEnabled(capabilities: BrowserRecordingCapabilities): boolean {
  return capabilities.enabled && capabilities.available;
}

function firstSupportedRetentionClass(
  capabilities: BrowserRecordingCapabilities,
  requestedRetentionClass?: BrowserRecordingRetentionClassV1,
): BrowserRecordingRetentionClassV1 | null {
  if (
    requestedRetentionClass
    && capabilities.supportedRetentionClasses.includes(requestedRetentionClass)
  ) {
    return requestedRetentionClass;
  }
  return capabilities.supportedRetentionClasses[0] ?? null;
}

function firstSupportedMimeType(
  capabilities: BrowserRecordingCapabilities,
  profile: BrowserRecordingCaptureProfile,
  requestedMimeType?: string,
): string | null {
  if (
    requestedMimeType
    && profileSupportsMimeType(profile, requestedMimeType)
    && capabilities.supportedMimeTypes.includes(requestedMimeType)
  ) {
    return requestedMimeType;
  }
  return profile.mimeTypes.find((mimeType) => capabilities.supportedMimeTypes.includes(mimeType)) ?? null;
}

export function resolveBrowserRecordingCaptureProfile(input: Readonly<{
  recordingCapabilities: BrowserRecordingCapabilities;
  adapterKind: BrowserSemanticAdapterKindV1;
  renderEngineKind?: BrowserRenderEngineKindV1;
  captureKind?: BrowserRecordingCaptureKindV1;
  mimeType?: string;
  retentionClass?: BrowserRecordingRetentionClassV1;
  captureSourceAvailable?: boolean;
}>): ResolvedBrowserRecordingCaptureProfile | null {
  const capabilities = input.recordingCapabilities;
  if (!capabilityEnabled(capabilities)) return null;
  if (!capabilities.supportedAdapterKinds.includes(input.adapterKind)) return null;

  const retentionClass = firstSupportedRetentionClass(capabilities, input.retentionClass);
  if (!retentionClass) return null;

  for (const profile of BROWSER_RECORDING_CAPTURE_PROFILES) {
    if (!profileSupportsAdapter(profile, input.adapterKind)) continue;
    if (!profileSupportsRenderEngine(profile, input.renderEngineKind)) continue;
    if (input.captureKind && profile.captureKind !== input.captureKind) continue;
    if (!capabilities.supportedCaptureKinds.includes(profile.captureKind)) continue;
    if (!profileHasRequiredCaptureSource(profile, input.captureSourceAvailable)) continue;

    const mimeType = firstSupportedMimeType(capabilities, profile, input.mimeType);
    if (!mimeType) continue;

    return {
      adapterKind: input.adapterKind,
      captureKind: profile.captureKind,
      fidelity: profile.fidelity,
      mimeType,
      retentionClass,
    };
  }

  return null;
}

export function resolveBrowserRecordingProfileUnavailableReason(input: Readonly<{
  recordingCapabilities: BrowserRecordingCapabilities;
  adapterKind: BrowserSemanticAdapterKindV1;
  renderEngineKind?: BrowserRenderEngineKindV1;
  captureKind: BrowserRecordingCaptureKindV1;
  mimeType: string;
  retentionClass: BrowserRecordingRetentionClassV1;
  captureSourceAvailable?: boolean;
}>): BrowserRecordingProfileUnavailableReason | null {
  const capabilities = input.recordingCapabilities;
  if (!capabilityEnabled(capabilities)) return 'capability';
  if (!capabilities.supportedAdapterKinds.includes(input.adapterKind)) return 'adapter';
  if (!capabilities.supportedRetentionClasses.includes(input.retentionClass)) return 'retention';

  const compatibleProfile = BROWSER_RECORDING_CAPTURE_PROFILES.find((profile) =>
    profile.captureKind === input.captureKind
    && profileSupportsAdapter(profile, input.adapterKind)
  );
  if (!compatibleProfile || !capabilities.supportedCaptureKinds.includes(input.captureKind)) {
    return 'capture';
  }
  if (!profileSupportsRenderEngine(compatibleProfile, input.renderEngineKind)) {
    return 'engine';
  }
  if (!profileHasRequiredCaptureSource(compatibleProfile, input.captureSourceAvailable)) {
    return 'source';
  }
  if (
    !profileSupportsMimeType(compatibleProfile, input.mimeType)
    || !capabilities.supportedMimeTypes.includes(input.mimeType)
  ) {
    return 'mime';
  }

  return null;
}

export type BrowserRecordingAvailabilityInput = Parameters<typeof resolveBrowserRecordingProfileUnavailableReason>[0] & Readonly<{
  browserRecordingEnabled: boolean;
  policyState?: BrowserRecordingPolicyStateV1;
}>;

export type BrowserRecordingAvailabilityReason = Readonly<{
  reasonCode:
    | 'browser_recording_disabled'
    | 'browser_recording_capability_unavailable'
    | 'browser_recording_policy_denied'
    | 'browser_recording_adapter_unavailable'
    | 'browser_recording_capture_unavailable'
    | 'browser_recording_mime_unavailable'
    | 'browser_recording_retention_unavailable';
  policyState: BrowserRecordingPolicyStateV1;
  message: string;
}>;

function createUnavailableReason(
  reasonCode: BrowserRecordingAvailabilityReason['reasonCode'],
  policyState: BrowserRecordingPolicyStateV1,
  message: string,
): BrowserRecordingAvailabilityReason {
  return { reasonCode, policyState, message };
}

export function resolveBrowserRecordingAvailability(
  input: BrowserRecordingAvailabilityInput,
): BrowserRecordingAvailabilityReason | null {
  if (!input.browserRecordingEnabled) {
    return createUnavailableReason(
      'browser_recording_disabled',
      'permissionDenied',
      'Browser recording is disabled.',
    );
  }

  const profileUnavailable = resolveBrowserRecordingProfileUnavailableReason(input);
  if (profileUnavailable === 'capability') {
    return createUnavailableReason(
      'browser_recording_capability_unavailable',
      'captureUnavailable',
      input.recordingCapabilities.disabledReasons[0] ?? 'Browser recording capability is unavailable.',
    );
  }
  if (input.policyState && input.policyState !== 'allowed') {
    return createUnavailableReason(
      'browser_recording_policy_denied',
      input.policyState,
      'Browser recording is denied by policy.',
    );
  }

  if (profileUnavailable) {
    switch (profileUnavailable) {
      case 'adapter':
        return createUnavailableReason(
          'browser_recording_adapter_unavailable',
          'captureUnavailable',
          'Browser recording is unavailable for this adapter.',
        );
      case 'capture':
      case 'engine':
      case 'source':
        return createUnavailableReason(
          'browser_recording_capture_unavailable',
          'captureUnavailable',
          'Browser recording capture is unavailable for this adapter.',
        );
      case 'mime':
        return createUnavailableReason(
          'browser_recording_mime_unavailable',
          'captureUnavailable',
          'Browser recording output type is unavailable.',
        );
      case 'retention':
        return createUnavailableReason(
          'browser_recording_retention_unavailable',
          'retentionLimited',
          'Browser recording retention class is unavailable.',
        );
    }
  }

  return null;
}
