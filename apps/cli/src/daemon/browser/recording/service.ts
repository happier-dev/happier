import { BrowserRecordingSessionV1Schema } from '@happier-dev/protocol/browser/recording/v1';
import { browserViewKey } from '@happier-dev/protocol/browser/view/key';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import { resolveBrowserRecordingAvailability } from '@happier-dev/protocol/browser/recording/captureProfiles';
import type { BrowserRecordingSessionV1 } from '@happier-dev/protocol';
import { createRecordingDaemonService, type BrowserRecordingRuntimeStartInput, type BrowserRecordingDaemonService,
  type BrowserRecordingCaptureAdapter, type BrowserRecordingMediaWriter, type BrowserRecordingInputControlResolver,
  type BrowserRecordingDaemonUnavailableReason } from '../../recording/service';

// Lifecycle updates clear optional members with undefined. Admit their native JSON
// projection once here so state, Action results and strict IPC readers share one record.
function parseRecordingSession(value: unknown): BrowserRecordingSessionV1 {
  return BrowserRecordingSessionV1Schema.parse(projectNativeJsonValueForTransport(value));
}

function resolveStartUnavailable(
  input: BrowserRecordingRuntimeStartInput,
): BrowserRecordingDaemonUnavailableReason | null {
  const unavailable = resolveBrowserRecordingAvailability({
    ...input,
    captureSourceAvailable: resolveStartCaptureSourceAvailable(input),
  });
  return unavailable ? { code: unavailable.reasonCode, message: unavailable.message } : null;
}

function resolveStartCaptureSourceAvailable(input: BrowserRecordingRuntimeStartInput): boolean | undefined {
  if (input.captureKind === 'streamFrameCapture') {
    return input.captureSource !== undefined;
  }
  if (input.captureKind === 'nativeViewCapture') {
    return input.captureSourceAvailable === true;
  }
  return input.captureSourceAvailable;
}

export function createBrowserRecordingDaemonService(input: Readonly<{
  captureAdapters: readonly BrowserRecordingCaptureAdapter[];
  mediaWriter: BrowserRecordingMediaWriter;
  resolveInputControl?: BrowserRecordingInputControlResolver;
  now?: () => number;
}>): BrowserRecordingDaemonService {
  return createRecordingDaemonService<BrowserRecordingSessionV1, BrowserRecordingRuntimeStartInput, { browserSessionId: string; viewId: string }>({ ...input, model: {
    parseSession: parseRecordingSession,
    targetKey: browserViewKey,
    startUnavailable: resolveStartUnavailable,
    sessionFields: start => ({ browserSessionId: start.browserSessionId, viewId: start.viewId,
      profileId: start.profileId, targetKind: start.targetKind, adapterKind: start.adapterKind,
      renderEngineKind: start.renderEngineKind, fidelity: start.fidelity,
      navigationGenerationStart: start.navigationGeneration }),
  } });
}
