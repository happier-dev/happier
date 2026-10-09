import type {
  BrowserEvidenceSessionMediaReferenceV1,
  BrowserRecordingSessionV1,
} from '@happier-dev/protocol';

import type { BrowserRecordingRoutes } from './routes';
import type { BrowserRecordingInputControlResolver } from './service';

export type BrowserRecordingAttachToComposerInput = Readonly<{
  recordingId: string;
  sessionId?: string;
}>;

export type BrowserRecordingComposerAttachInput = Readonly<{
  recordingId: string;
  sessionId?: string;
  mediaRef: BrowserEvidenceSessionMediaReferenceV1;
  recording: BrowserRecordingSessionV1;
}>;

export type BrowserRecordingComposerAttachResult =
  | Readonly<{ ok: true; attachmentId: string }>
  | Readonly<{ ok: false; reason: string }>;

export type BrowserRecordingAttachToComposerResult =
  | Readonly<{ ok: true; attachmentId: string }>
  | Readonly<{ ok: false; errorCode: 'runtime_action_disabled'; error: string }>;

export type BrowserRecordingAttachToComposerOptions = Readonly<{
  routes: Pick<BrowserRecordingRoutes, 'getRecordingStatus'>;
  attachToComposer(input: BrowserRecordingComposerAttachInput): Promise<BrowserRecordingComposerAttachResult>;
  resolveInputControl?: BrowserRecordingInputControlResolver;
}>;

type BrowserRecordingAttachDisabledReason =
  | 'browser_recording_missing'
  | 'browser_recording_not_finalized'
  | 'browser_recording_media_missing'
  | 'browser_recording_policy_denied'
  | 'browser_recording_attach_failed';

function disabled(reason: BrowserRecordingAttachDisabledReason): BrowserRecordingAttachToComposerResult {
  return {
    ok: false,
    errorCode: 'runtime_action_disabled',
    error: `runtime_action_disabled:browser:${reason}`,
  };
}

function isTerminalRecording(status: BrowserRecordingSessionV1['status']): boolean {
  return status === 'completed' || status === 'finalized';
}

/**
 * Daemon attach-to-composer leaf for `browser.recording.attachToComposer`. Resolves the
 * recording's stored `mediaRef` from the recording routes and routes it (reference-only —
 * never raw bytes) to the canonical session-media/composer attach owner. Fail-closed on a
 * missing / non-terminal / media-less recording.
 */
export function createBrowserRecordingAttachToComposer(
  options: BrowserRecordingAttachToComposerOptions,
): (input: BrowserRecordingAttachToComposerInput) => Promise<BrowserRecordingAttachToComposerResult> {
  return async (input) => {
    const recording = await options.routes.getRecordingStatus({ recordingId: input.recordingId });
    if (!recording) {
      return disabled('browser_recording_missing');
    }
    const control = options.resolveInputControl?.(recording);
    if (control?.isObservationHeld()) return disabled('browser_recording_policy_denied');
    if (!isTerminalRecording(recording.status)) {
      return disabled('browser_recording_not_finalized');
    }
    const mediaRef = recording.mediaRef;
    if (!mediaRef) {
      return disabled('browser_recording_media_missing');
    }
    const attach = () => options.attachToComposer({
      recordingId: recording.recordingId,
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      mediaRef,
      recording,
    });
    const attached = control ? await control.observeWhile(attach) : await attach();
    if (!attached) return disabled('browser_recording_policy_denied');
    if (!attached.ok) {
      return disabled('browser_recording_attach_failed');
    }
    return { ok: true, attachmentId: attached.attachmentId };
  };
}
