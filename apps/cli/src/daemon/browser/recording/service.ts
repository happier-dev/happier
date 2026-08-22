import {
  BrowserRecordingSessionV1Schema,
  resolveBrowserRecordingProfileUnavailableReason,
  type BrowserRecordingCaptureSourceV1,
  type BrowserDiagnosticFidelityV1,
  type BrowserEvidenceSessionMediaReferenceV1,
  type BrowserRecordingCapabilities,
  type BrowserRecordingCaptureKindV1,
  type BrowserRenderEngineKindV1,
  type BrowserRecordingOutcomeReasonV1,
  type BrowserRecordingPolicyStateV1,
  type BrowserRecordingRetentionClassV1,
  type BrowserRecordingSessionV1,
  type BrowserSemanticAdapterKindV1,
  type BrowserViewTargetKindV1,
} from '@happier-dev/protocol';
import type { SessionMediaIngestionSource } from '@/session/media/_types';

const RECORDING_ID_PREFIX = 'browser_recording';

export type BrowserRecordingDaemonUnavailableCode =
  | 'browser_recording_disabled'
  | 'browser_recording_capability_unavailable'
  | 'browser_recording_policy_denied'
  | 'browser_recording_adapter_unavailable'
  | 'browser_recording_capture_unavailable'
  | 'browser_recording_mime_unavailable'
  | 'browser_recording_retention_unavailable'
  | 'browser_recording_capture_adapter_missing'
  | 'browser_recording_already_active'
  | 'browser_recording_id_conflict'
  | 'browser_recording_missing'
  | 'browser_recording_not_active'
  | 'browser_recording_media_discard_failed'
  | 'browser_recording_capture_failed';

export type BrowserRecordingDaemonUnavailableReason = Readonly<{
  code: BrowserRecordingDaemonUnavailableCode;
  message: string;
}>;

export type BrowserRecordingCapturedArtifact = Readonly<{
  durationMs: number;
  byteSize: number;
  frameCount: number;
  fps: number;
  mimeType: string;
  source: Extract<SessionMediaIngestionSource, { kind: 'local-file' | 'local-uri' }>;
  cleanup?: () => Promise<void>;
}>;

export type BrowserRecordingCaptureAdapterStartResult =
  | Readonly<{ status: 'started' }>
  | Readonly<{ status: 'unavailable'; reason: BrowserRecordingDaemonUnavailableReason }>;

export type BrowserRecordingCaptureAdapter = Readonly<{
  captureKind: BrowserRecordingCaptureKindV1;
  start(input: BrowserRecordingCaptureStartInput): Promise<BrowserRecordingCaptureAdapterStartResult>;
  stop(input: BrowserRecordingCaptureStopInput): Promise<BrowserRecordingCapturedArtifact>;
  discard(input: BrowserRecordingCaptureDiscardInput): Promise<void>;
}>;

export type BrowserRecordingMediaWriter = Readonly<{
  persistRecording(input: Readonly<{
    recording: BrowserRecordingSessionV1;
    artifact: BrowserRecordingCapturedArtifact;
  }>): Promise<BrowserEvidenceSessionMediaReferenceV1>;
  discardRecording(input: Readonly<{
    recording: BrowserRecordingSessionV1;
    reason: Extract<
      BrowserRecordingOutcomeReasonV1,
      'retention_limit' | 'expired' | 'user_discarded' | 'session_closed' | 'logout'
    >;
  }>): Promise<void>;
}>;

export type BrowserRecordingDaemonService = Readonly<{
  startRecording(input: BrowserRecordingRuntimeStartInput): Promise<BrowserRecordingRuntimeStartResult>;
  stopRecording(input: BrowserRecordingRuntimeStopInput): Promise<BrowserRecordingRuntimeStopResult>;
  cancelRecording(input: BrowserRecordingRuntimeCancelInput): Promise<BrowserRecordingRuntimeTerminalResult>;
  applyLifecycleOutcome(input: BrowserRecordingRuntimeLifecycleInput): Promise<BrowserRecordingRuntimeTerminalResult>;
  cleanupExpiredRecordings(input: Readonly<{ nowMs: number }>): Promise<Readonly<{
    discardedRecordingIds: readonly string[];
    failedRecordingIds: readonly string[];
  }>>;
  getRecordingStatus(recordingId: string): BrowserRecordingSessionV1 | null;
  listRecordingsForView(input: Readonly<{ viewId: string }>): readonly BrowserRecordingSessionV1[];
}>;

export type BrowserRecordingRuntimeStartInput = Readonly<{
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
  navigationGeneration: number;
  mimeType: string;
  retentionClass: BrowserRecordingRetentionClassV1;
  policyState?: BrowserRecordingPolicyStateV1;
  captureSource?: BrowserRecordingCaptureSourceV1;
  captureSourceAvailable?: boolean;
  startedAtMs?: number;
  recordingId?: string;
}>;

export type BrowserRecordingCaptureStartInput = Readonly<{
  recording: BrowserRecordingSessionV1;
  captureSource?: BrowserRecordingCaptureSourceV1;
}>;

export type BrowserRecordingCaptureStopInput = Readonly<{
  recordingId: string;
  recording: BrowserRecordingSessionV1;
}>;

export type BrowserRecordingCaptureDiscardInput = Readonly<{
  recordingId: string;
  recording: BrowserRecordingSessionV1;
  reason: BrowserRecordingOutcomeReasonV1;
}>;

export type BrowserRecordingRuntimeStopInput = Readonly<{
  recordingId: string;
  stoppedAtMs?: number;
  navigationGenerationEnd: number;
  expiresAtMs?: number;
}>;

export type BrowserRecordingRuntimeCancelInput = Readonly<{
  recordingId: string;
  atMs?: number;
  reason: Extract<BrowserRecordingOutcomeReasonV1, 'user_canceled' | 'user_discarded' | 'session_closed' | 'logout'>;
}>;

export type BrowserRecordingRuntimeLifecycleInput = Readonly<{
  browserSessionId: string;
  viewId: string;
  atMs?: number;
  reason: Extract<
    BrowserRecordingOutcomeReasonV1,
    | 'view_hidden'
    | 'view_parked'
    | 'view_suspended'
    | 'host_lost'
    | 'view_closed'
    | 'policy_revoked'
    | 'adapter_lost'
    | 'session_closed'
    | 'logout'
    | 'capture_failed'
  >;
}>;

export type BrowserRecordingRuntimeStartResult =
  | Readonly<{ status: 'started'; recording: BrowserRecordingSessionV1 }>
  | Readonly<{ status: 'unavailable'; reason: BrowserRecordingDaemonUnavailableReason }>;

export type BrowserRecordingRuntimeStopResult =
  | Readonly<{ status: 'finalized'; recording: BrowserRecordingSessionV1 }>
  | Readonly<{ status: 'failed'; recording: BrowserRecordingSessionV1; reason: BrowserRecordingOutcomeReasonV1 }>
  | Readonly<{ status: 'unavailable'; reason: BrowserRecordingDaemonUnavailableReason }>;

export type BrowserRecordingRuntimeTerminalResult =
  | Readonly<{ status: 'paused' | 'failed' | 'canceled' | 'discarded'; recording: BrowserRecordingSessionV1 }>
  | Readonly<{ status: 'unavailable'; reason: BrowserRecordingDaemonUnavailableReason }>;

type BrowserRecordingTerminalOutcomeStatus = Exclude<BrowserRecordingRuntimeTerminalResult['status'], 'unavailable'>;

function createUnavailable(
  code: BrowserRecordingDaemonUnavailableCode,
  message: string,
): BrowserRecordingDaemonUnavailableReason {
  return { code, message };
}

function sanitizeRecordingIdSegment(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  return sanitized.length > 0 ? sanitized.slice(0, 72) : 'view';
}

function buildRecordingId(input: BrowserRecordingRuntimeStartInput, startedAtMs: number): string {
  if (input.recordingId) return input.recordingId;
  return [
    RECORDING_ID_PREFIX,
    sanitizeRecordingIdSegment(input.viewId),
    input.navigationGeneration,
    startedAtMs,
  ].join('_');
}

function durationFrom(recording: BrowserRecordingSessionV1, atMs: number): number {
  return Math.max(0, atMs - recording.startedAtMs);
}

function resolveStartUnavailable(
  input: BrowserRecordingRuntimeStartInput,
): BrowserRecordingDaemonUnavailableReason | null {
  if (!input.browserRecordingEnabled) {
    return createUnavailable('browser_recording_disabled', 'Browser recording is disabled.');
  }
  const capabilities = input.recordingCapabilities;
  if (!capabilities.enabled || !capabilities.available) {
    return createUnavailable(
      'browser_recording_capability_unavailable',
      capabilities.disabledReasons[0] ?? 'Browser recording capability is unavailable.',
    );
  }
  if (input.policyState && input.policyState !== 'allowed') {
    return createUnavailable('browser_recording_policy_denied', 'Browser recording is denied by policy.');
  }
  const profileUnavailable = resolveBrowserRecordingProfileUnavailableReason({
    recordingCapabilities: capabilities,
    adapterKind: input.adapterKind,
    renderEngineKind: input.renderEngineKind,
    captureKind: input.captureKind,
    mimeType: input.mimeType,
    retentionClass: input.retentionClass,
    captureSourceAvailable: resolveStartCaptureSourceAvailable(input),
  });
  if (profileUnavailable) {
    switch (profileUnavailable) {
      case 'adapter':
        return createUnavailable(
          'browser_recording_adapter_unavailable',
          'Browser recording is unavailable for this adapter.',
        );
      case 'capture':
      case 'engine':
      case 'source':
        return createUnavailable(
          'browser_recording_capture_unavailable',
          'Browser recording capture is unavailable for this adapter.',
        );
      case 'mime':
        return createUnavailable(
          'browser_recording_mime_unavailable',
          'Browser recording output type is unavailable.',
        );
      case 'retention':
        return createUnavailable(
          'browser_recording_retention_unavailable',
          'Browser recording retention class is unavailable.',
        );
      case 'capability':
        return createUnavailable(
          'browser_recording_capability_unavailable',
          capabilities.disabledReasons[0] ?? 'Browser recording capability is unavailable.',
        );
    }
  }
  return null;
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

function resolveTerminalStatus(reason: BrowserRecordingOutcomeReasonV1): BrowserRecordingTerminalOutcomeStatus {
  if (reason === 'view_hidden' || reason === 'view_parked' || reason === 'view_suspended') return 'paused';
  if (reason === 'user_canceled') return 'canceled';
  if (reason === 'user_discarded' || reason === 'view_closed' || reason === 'session_closed' || reason === 'logout') {
    return 'discarded';
  }
  return 'failed';
}

function isActiveStatus(status: BrowserRecordingSessionV1['status']): boolean {
  return status === 'starting' || status === 'recording' || status === 'paused' || status === 'stopping';
}

function isStoredMediaDiscardReason(
  reason: BrowserRecordingRuntimeCancelInput['reason'],
): reason is Extract<BrowserRecordingOutcomeReasonV1, 'user_discarded' | 'session_closed' | 'logout'> {
  return reason === 'user_discarded' || reason === 'session_closed' || reason === 'logout';
}

function resolveArtifactCapFailure(
  recording: BrowserRecordingSessionV1,
  artifact: BrowserRecordingCapturedArtifact,
): BrowserRecordingOutcomeReasonV1 | null {
  if (artifact.durationMs > recording.maxDurationMs) return 'duration_cap';
  if (artifact.byteSize > recording.maxBytes) return 'size_cap';
  if (artifact.fps > recording.fps) return 'capture_failed';
  return null;
}

export function createBrowserRecordingDaemonService(input: Readonly<{
  captureAdapters: readonly BrowserRecordingCaptureAdapter[];
  mediaWriter: BrowserRecordingMediaWriter;
  now?: () => number;
}>): BrowserRecordingDaemonService {
  const now = input.now ?? (() => Date.now());
  const adaptersByCaptureKind = new Map(
    input.captureAdapters.map((adapter) => [adapter.captureKind, adapter]),
  );
  const sessionsById = new Map<string, BrowserRecordingSessionV1>();
  const sessionOrder: string[] = [];
  const activeRecordingIdByViewId = new Map<string, string>();
  const activeAdapterByRecordingId = new Map<string, BrowserRecordingCaptureAdapter>();

  function putRecording(recording: BrowserRecordingSessionV1, activeForView: boolean): void {
    if (!sessionsById.has(recording.recordingId)) {
      sessionOrder.push(recording.recordingId);
    }
    sessionsById.set(recording.recordingId, recording);
    if (activeForView) {
      activeRecordingIdByViewId.set(recording.viewId, recording.recordingId);
      return;
    }
    if (activeRecordingIdByViewId.get(recording.viewId) === recording.recordingId) {
      activeRecordingIdByViewId.delete(recording.viewId);
    }
    activeAdapterByRecordingId.delete(recording.recordingId);
  }

  function readRecording(recordingId: string): BrowserRecordingSessionV1 | null {
    return sessionsById.get(recordingId) ?? null;
  }

  async function discardCapture(
    recording: BrowserRecordingSessionV1,
    reason: BrowserRecordingOutcomeReasonV1,
  ): Promise<void> {
    const adapter = activeAdapterByRecordingId.get(recording.recordingId);
    if (!adapter) return;
    await adapter.discard({ recordingId: recording.recordingId, recording, reason });
  }

  async function terminalOutcome(
    recording: BrowserRecordingSessionV1,
    reason: BrowserRecordingOutcomeReasonV1,
    atMs: number,
  ): Promise<BrowserRecordingRuntimeTerminalResult> {
    const status = resolveTerminalStatus(reason);
    if (status !== 'paused') {
      await discardCapture(recording, reason);
    }
    const updated = BrowserRecordingSessionV1Schema.parse({
      ...recording,
      status,
      outcomeReason: reason,
      stoppedAtMs: atMs,
      durationMs: durationFrom(recording, atMs),
      mediaRef: undefined,
    });
    putRecording(updated, status === 'paused');
    return { status, recording: updated };
  }

  async function discardFinalizedStoredMedia(
    recording: BrowserRecordingSessionV1,
    reason: Extract<BrowserRecordingOutcomeReasonV1, 'user_discarded' | 'session_closed' | 'logout'>,
    atMs: number,
  ): Promise<BrowserRecordingRuntimeTerminalResult> {
    try {
      await input.mediaWriter.discardRecording({ recording, reason });
    } catch {
      return {
        status: 'unavailable',
        reason: createUnavailable(
          'browser_recording_media_discard_failed',
          'Browser recording media could not be discarded.',
        ),
      };
    }
    const discarded = BrowserRecordingSessionV1Schema.parse({
      ...recording,
      status: 'discarded',
      outcomeReason: reason,
      stoppedAtMs: recording.stoppedAtMs ?? atMs,
      durationMs: recording.durationMs || durationFrom(recording, atMs),
      mediaRef: undefined,
    });
    putRecording(discarded, false);
    return { status: 'discarded', recording: discarded };
  }

  return {
    async startRecording(startInput) {
      const activeRecordingId = activeRecordingIdByViewId.get(startInput.viewId);
      if (activeRecordingId) {
        return {
          status: 'unavailable',
          reason: createUnavailable(
            'browser_recording_already_active',
            'Only one browser recording can be active for a view.',
          ),
        };
      }

      const unavailable = resolveStartUnavailable(startInput);
      if (unavailable) {
        return { status: 'unavailable', reason: unavailable };
      }

      const adapter = adaptersByCaptureKind.get(startInput.captureKind);
      if (!adapter) {
        return {
          status: 'unavailable',
          reason: createUnavailable(
            'browser_recording_capture_adapter_missing',
            'Browser recording capture adapter is unavailable.',
          ),
        };
      }

      const startedAtMs = startInput.startedAtMs ?? now();
      const recordingId = buildRecordingId(startInput, startedAtMs);
      if (sessionsById.has(recordingId)) {
        return {
          status: 'unavailable',
          reason: createUnavailable(
            'browser_recording_id_conflict',
            'A browser recording with this identity already exists.',
          ),
        };
      }
      const recording = BrowserRecordingSessionV1Schema.parse({
        v: 1,
        recordingId,
        browserSessionId: startInput.browserSessionId,
        viewId: startInput.viewId,
        profileId: startInput.profileId,
        targetKind: startInput.targetKind,
        adapterKind: startInput.adapterKind,
        renderEngineKind: startInput.renderEngineKind,
        captureKind: startInput.captureKind,
        fidelity: startInput.fidelity,
        startedAtMs,
        status: 'recording',
        navigationGenerationStart: startInput.navigationGeneration,
        durationMs: 0,
        byteSize: 0,
        frameCount: 0,
        fps: startInput.recordingCapabilities.maxFps,
        mimeType: startInput.mimeType,
        retentionClass: startInput.retentionClass,
        redactionLevel: 'metadataOnly',
        policyState: startInput.policyState ?? 'allowed',
        maxDurationMs: startInput.recordingCapabilities.maxDurationMs,
        maxBytes: startInput.recordingCapabilities.maxBytes,
      });

      let adapterStart: BrowserRecordingCaptureAdapterStartResult;
      try {
        adapterStart = await adapter.start({
          recording,
          captureSource: startInput.captureSource,
        });
      } catch {
        return {
          status: 'unavailable',
          reason: createUnavailable(
            'browser_recording_capture_failed',
            'Browser recording capture failed to start.',
          ),
        };
      }
      if (adapterStart.status === 'unavailable') {
        return { status: 'unavailable', reason: adapterStart.reason };
      }

      activeAdapterByRecordingId.set(recording.recordingId, adapter);
      putRecording(recording, true);
      return { status: 'started', recording };
    },

    async stopRecording(stopInput) {
      const recording = readRecording(stopInput.recordingId);
      if (!recording) {
        return {
          status: 'unavailable',
          reason: createUnavailable('browser_recording_missing', 'Browser recording is no longer available.'),
        };
      }
      if (recording.status === 'finalized' || recording.status === 'completed') {
        return { status: 'finalized', recording };
      }

      const adapter = activeAdapterByRecordingId.get(recording.recordingId);
      if (!adapter || !isActiveStatus(recording.status)) {
        return {
          status: 'unavailable',
          reason: createUnavailable(
            'browser_recording_capture_adapter_missing',
            'Browser recording capture adapter is unavailable.',
          ),
        };
      }

      let artifact: BrowserRecordingCapturedArtifact | null = null;
      try {
        artifact = await adapter.stop({ recordingId: recording.recordingId, recording });
        const capFailure = resolveArtifactCapFailure(recording, artifact);
        if (capFailure) {
          const failed = BrowserRecordingSessionV1Schema.parse({
            ...recording,
            status: 'failed',
            outcomeReason: capFailure,
            stoppedAtMs: stopInput.stoppedAtMs ?? now(),
            navigationGenerationEnd: stopInput.navigationGenerationEnd,
            durationMs: artifact.durationMs,
            byteSize: artifact.byteSize,
            frameCount: artifact.frameCount,
            fps: artifact.fps,
            mimeType: artifact.mimeType,
            mediaRef: undefined,
          });
          putRecording(failed, false);
          return { status: 'failed', recording: failed, reason: capFailure };
        }
        const mediaRef = await input.mediaWriter.persistRecording({ recording, artifact });
        const stoppedAtMs = stopInput.stoppedAtMs ?? now();
        const finalized = BrowserRecordingSessionV1Schema.parse({
          ...recording,
          status: 'finalized',
          outcomeReason: 'user_stopped',
          stoppedAtMs,
          navigationGenerationEnd: stopInput.navigationGenerationEnd,
          durationMs: artifact.durationMs,
          byteSize: artifact.byteSize,
          frameCount: artifact.frameCount,
          fps: artifact.fps,
          mimeType: artifact.mimeType,
          mediaRef,
          expiresAtMs: stopInput.expiresAtMs,
        });
        putRecording(finalized, false);
        return { status: 'finalized', recording: finalized };
      } catch {
        const failed = BrowserRecordingSessionV1Schema.parse({
          ...recording,
          status: 'failed',
          outcomeReason: 'capture_failed',
          stoppedAtMs: stopInput.stoppedAtMs ?? now(),
          durationMs: durationFrom(recording, stopInput.stoppedAtMs ?? now()),
          mediaRef: undefined,
        });
        putRecording(failed, false);
        return { status: 'failed', recording: failed, reason: 'capture_failed' };
      } finally {
        if (artifact?.cleanup) {
          await artifact.cleanup();
        }
      }
    },

    async cancelRecording(cancelInput) {
      const recording = readRecording(cancelInput.recordingId);
      if (!recording) {
        return {
          status: 'unavailable',
          reason: createUnavailable('browser_recording_missing', 'Browser recording is no longer available.'),
        };
      }
      if ((recording.status === 'finalized' || recording.status === 'completed') && recording.mediaRef) {
        if (!isStoredMediaDiscardReason(cancelInput.reason)) {
          return {
            status: 'unavailable',
            reason: createUnavailable('browser_recording_not_active', 'Browser recording is no longer active.'),
          };
        }
        return await discardFinalizedStoredMedia(recording, cancelInput.reason, cancelInput.atMs ?? now());
      }
      if (!isActiveStatus(recording.status)) {
        return {
          status: 'unavailable',
          reason: createUnavailable('browser_recording_not_active', 'Browser recording is no longer active.'),
        };
      }
      return await terminalOutcome(recording, cancelInput.reason, cancelInput.atMs ?? now());
    },

    async applyLifecycleOutcome(lifecycleInput) {
      const recordingId = activeRecordingIdByViewId.get(lifecycleInput.viewId);
      const recording = recordingId ? readRecording(recordingId) : null;
      if (!recording || recording.browserSessionId !== lifecycleInput.browserSessionId) {
        return {
          status: 'unavailable',
          reason: createUnavailable('browser_recording_missing', 'Browser recording is no longer available.'),
        };
      }
      return await terminalOutcome(recording, lifecycleInput.reason, lifecycleInput.atMs ?? now());
    },

    async cleanupExpiredRecordings(cleanupInput) {
      const discardedRecordingIds: string[] = [];
      const failedRecordingIds: string[] = [];
      for (const recordingId of [...sessionOrder]) {
        const recording = readRecording(recordingId);
        if (!recording?.expiresAtMs || recording.expiresAtMs > cleanupInput.nowMs) continue;
        if (recording.status !== 'completed' && recording.status !== 'finalized') continue;
        try {
          await input.mediaWriter.discardRecording({
            recording,
            reason: 'retention_limit',
          });
        } catch {
          failedRecordingIds.push(recordingId);
          continue;
        }
        const discarded = BrowserRecordingSessionV1Schema.parse({
          ...recording,
          status: 'discarded',
          outcomeReason: 'retention_limit',
          stoppedAtMs: recording.stoppedAtMs ?? cleanupInput.nowMs,
          mediaRef: undefined,
        });
        putRecording(discarded, false);
        discardedRecordingIds.push(recordingId);
      }
      return { discardedRecordingIds, failedRecordingIds };
    },

    getRecordingStatus(recordingId) {
      return readRecording(recordingId);
    },

    listRecordingsForView(viewInput) {
      return sessionOrder
        .map((recordingId) => readRecording(recordingId))
        .filter((recording): recording is BrowserRecordingSessionV1 => recording?.viewId === viewInput.viewId);
    },
  };
}
