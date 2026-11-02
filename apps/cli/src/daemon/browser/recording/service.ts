import { randomUUID } from 'node:crypto';
import { BrowserRecordingSessionV1Schema } from '@happier-dev/protocol/browser/recording/v1';
import { browserViewKey } from '@happier-dev/protocol/browser/view/key';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import { resolveBrowserRecordingAvailability, type BrowserRecordingAvailabilityReason } from '@happier-dev/protocol/browser/recording/captureProfiles';
import type { BrowserRecordingCaptureSourceV1, BrowserDiagnosticFidelityV1, BrowserEvidenceSessionMediaReferenceV1, BrowserRecordingCapabilities, BrowserRecordingCaptureKindV1, BrowserRenderEngineKindV1, BrowserRecordingOutcomeReasonV1, BrowserRecordingPolicyStateV1, BrowserRecordingRetentionClassV1, BrowserRecordingSessionV1, BrowserSemanticAdapterKindV1, BrowserViewTargetKindV1 } from '@happier-dev/protocol';
import type { SessionMediaIngestionSource } from '@/session/media/_types';
import type { SurfaceInputControl } from '../../surfaces/inputControl';

const RECORDING_ID_PREFIX = 'browser_recording';

// Lifecycle updates clear optional members with undefined. Admit their native JSON
// projection once here so state, Action results and strict IPC readers share one record.
function parseRecordingSession(value: unknown): BrowserRecordingSessionV1 {
  return BrowserRecordingSessionV1Schema.parse(projectNativeJsonValueForTransport(value));
}

export type BrowserRecordingInputControlResolver = (view: Readonly<{
  browserSessionId: string;
  viewId: string;
}>) => SurfaceInputControl | undefined;

export type BrowserRecordingDaemonUnavailableCode =
  | BrowserRecordingAvailabilityReason['reasonCode']
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
  /** A usable bounded clip can be stored even when its owner stopped accepting frames. */
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
  getRecordingStorage?: (recordingId: string) => Readonly<{ path: string; attached: boolean }> | null;
  persistRecording(input: Readonly<{
    recording: BrowserRecordingSessionV1;
    artifact: BrowserRecordingCapturedArtifact;
  }>): Promise<BrowserEvidenceSessionMediaReferenceV1>;
  discardRecording(input: Readonly<{
    recording: BrowserRecordingSessionV1;
    beforeEffect?: () => Promise<void>;
    reason: Extract<
      BrowserRecordingOutcomeReasonV1,
      'retention_limit' | 'expired' | 'user_discarded' | 'session_closed' | 'logout'
    >;
  }>): Promise<void>;
}>;

export type BrowserRecordingStorageRecord = Readonly<{
  recordingId: string;
  path: string;
  title?: string;
  expiresAtMs?: number;
  active: boolean;
}>;

export type BrowserRecordingDaemonService = Readonly<{
  startRecording(input: BrowserRecordingRuntimeStartInput): Promise<BrowserRecordingRuntimeStartResult>;
  stopRecording(input: BrowserRecordingRuntimeStopInput): Promise<BrowserRecordingRuntimeStopResult>;
  cancelRecording(input: BrowserRecordingRuntimeCancelInput): Promise<BrowserRecordingRuntimeTerminalResult>;
  cleanupExpiredRecordings(input: Readonly<{ nowMs: number; beforeEffect?: () => Promise<void> }>): Promise<Readonly<{
    discardedRecordingIds: readonly string[];
    failedRecordingIds: readonly string[];
  }>>;
  getRecordingStatus(recordingId: string): BrowserRecordingSessionV1 | null;
  listRecordingsForView(input: Readonly<{ browserSessionId: string; viewId: string }>): readonly BrowserRecordingSessionV1[];
  listStorageRecordings(): readonly BrowserRecordingStorageRecord[];
  discardStorageRecording(input: Readonly<{ recordingId: string; beforeEffect?: () => Promise<void> }>): Promise<void>;
  subscribeStorageChanges(listener: () => void): () => void;
  nextExpiryAtMs(): number | null;
}>;
export class BrowserRecordingStorageError extends Error {
  constructor(readonly code: 'browser_recording_missing' | 'browser_recording_not_active' | 'browser_recording_media_discard_failed') {
    super(code);
    this.name = 'BrowserRecordingStorageError';
  }
}

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

export type BrowserRecordingRuntimeStartResult =
  | Readonly<{ status: 'started'; recording: BrowserRecordingSessionV1 }>
  | Readonly<{ status: 'unavailable'; reason: BrowserRecordingDaemonUnavailableReason }>;

export type BrowserRecordingRuntimeStopResult =
  | Readonly<{ status: 'finalized'; recording: BrowserRecordingSessionV1 }>
  | Readonly<{ status: 'failed'; recording: BrowserRecordingSessionV1; reason: BrowserRecordingOutcomeReasonV1 }>
  | Readonly<{ status: 'unavailable'; reason: BrowserRecordingDaemonUnavailableReason }>;

export type BrowserRecordingRuntimeTerminalResult =
  | Readonly<{ status: 'failed' | 'canceled' | 'discarded'; recording: BrowserRecordingSessionV1 }>
  | Readonly<{ status: 'unavailable'; reason: BrowserRecordingDaemonUnavailableReason }>;

type BrowserRecordingTerminalOutcomeStatus = Exclude<BrowserRecordingRuntimeTerminalResult['status'], 'unavailable'>;

function createUnavailable(
  code: BrowserRecordingDaemonUnavailableCode,
  message: string,
): BrowserRecordingDaemonUnavailableReason {
  return { code, message };
}

function buildRecordingId(input: BrowserRecordingRuntimeStartInput): string {
  return input.recordingId ?? `${RECORDING_ID_PREFIX}_${randomUUID()}`;
}

function durationFrom(recording: BrowserRecordingSessionV1, atMs: number): number {
  return Math.max(0, atMs - recording.startedAtMs);
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

function resolveTerminalStatus(reason: BrowserRecordingOutcomeReasonV1): BrowserRecordingTerminalOutcomeStatus {
  if (reason === 'user_canceled') return 'canceled';
  if (reason === 'user_discarded' || reason === 'session_closed' || reason === 'logout') {
    return 'discarded';
  }
  return 'failed';
}

function isActiveStatus(status: BrowserRecordingSessionV1['status']): boolean {
  return status === 'starting' || status === 'recording' || status === 'stopping';
}

function isStoredMediaDiscardReason(
  reason: BrowserRecordingRuntimeCancelInput['reason'],
): reason is Extract<BrowserRecordingOutcomeReasonV1, 'user_discarded' | 'session_closed' | 'logout'> {
  return reason === 'user_discarded' || reason === 'session_closed' || reason === 'logout';
}

export function createBrowserRecordingDaemonService(input: Readonly<{
  captureAdapters: readonly BrowserRecordingCaptureAdapter[];
  mediaWriter: BrowserRecordingMediaWriter;
  resolveInputControl?: BrowserRecordingInputControlResolver;
  now?: () => number;
}>): BrowserRecordingDaemonService {
  const now = input.now ?? (() => Date.now());
  const adaptersByCaptureKind = new Map(
    input.captureAdapters.map((adapter) => [adapter.captureKind, adapter]),
  );
  const sessionsById = new Map<string, BrowserRecordingSessionV1>();
  const storageChangeListeners = new Set<() => void>();
  const sessionOrder: string[] = [];
  const activeRecordingIdByView = new Map<string, string>();
  const activeAdapterByRecordingId = new Map<string, {
    readonly adapter: BrowserRecordingCaptureAdapter;
    readonly control?: SurfaceInputControl;
    readonly unregisterConfidentialityDrain?: () => void;
    discard?: Promise<void>;
  }>();

  function confidentialityUnavailable(): Extract<BrowserRecordingRuntimeStartResult, { status: 'unavailable' }> {
    return { status: 'unavailable', reason: createUnavailable('browser_recording_policy_denied', 'Browser recording is held for confidential input.') };
  }

  function putRecording(recording: BrowserRecordingSessionV1, activeForView: boolean): void {
    if (!sessionsById.has(recording.recordingId)) {
      sessionOrder.push(recording.recordingId);
    }
    sessionsById.set(recording.recordingId, recording);
    const viewKey = browserViewKey(recording);
    if (activeForView) {
      activeRecordingIdByView.set(viewKey, recording.recordingId);
    } else {
      if (activeRecordingIdByView.get(viewKey) === recording.recordingId) {
        activeRecordingIdByView.delete(viewKey);
      }
      activeAdapterByRecordingId.get(recording.recordingId)?.unregisterConfidentialityDrain?.();
      activeAdapterByRecordingId.delete(recording.recordingId);
    }
    for (const listener of storageChangeListeners) listener();
  }

  function readRecording(recordingId: string): BrowserRecordingSessionV1 | null {
    return sessionsById.get(recordingId) ?? null;
  }

  async function discardCapture(
    recording: BrowserRecordingSessionV1,
    reason: BrowserRecordingOutcomeReasonV1,
  ): Promise<void> {
    const active = activeAdapterByRecordingId.get(recording.recordingId);
    if (!active) return;
    // Await the same actual teardown, including its rejection. A second adapter discard can
    // otherwise report success after the adapter retired its handle but shutdown failed.
    active.discard ??= active.adapter.discard({ recordingId: recording.recordingId, recording, reason });
    await active.discard;
  }

  async function terminalOutcome(
    recording: BrowserRecordingSessionV1,
    reason: BrowserRecordingOutcomeReasonV1,
    atMs: number,
  ): Promise<BrowserRecordingRuntimeTerminalResult> {
    const status = resolveTerminalStatus(reason);
    await discardCapture(recording, reason);
    const updated = parseRecordingSession({
      ...recording,
      status,
      outcomeReason: reason,
      stoppedAtMs: atMs,
      durationMs: durationFrom(recording, atMs),
      mediaRef: undefined,
    });
    putRecording(updated, false);
    return { status, recording: updated };
  }

  async function discardFinalizedStoredMedia(
    recording: BrowserRecordingSessionV1,
    reason: Extract<BrowserRecordingOutcomeReasonV1, 'user_discarded' | 'session_closed' | 'logout'>,
    atMs: number,
    beforeEffect?: () => Promise<void>,
  ): Promise<BrowserRecordingRuntimeTerminalResult> {
    let effectAdmitted = beforeEffect === undefined;
    try {
      await input.mediaWriter.discardRecording({ recording, reason, ...(beforeEffect ? { beforeEffect: async () => {
        await beforeEffect();
        effectAdmitted = true;
      } } : {}) });
    } catch (error) {
      if (!effectAdmitted) throw error;
      return {
        status: 'unavailable',
        reason: createUnavailable(
          'browser_recording_media_discard_failed',
          'Browser recording media could not be discarded.',
        ),
      };
    }
    const discarded = parseRecordingSession({
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
    nextExpiryAtMs() {
      let earliest: number | null = null;
      for (const recording of sessionsById.values()) {
        if ((recording.status === 'completed' || recording.status === 'finalized') && recording.expiresAtMs !== undefined) {
          earliest = Math.min(earliest ?? Infinity, recording.expiresAtMs);
        }
      }
      return earliest;
    },
    async discardStorageRecording({ recordingId, beforeEffect }) {
      const recording = readRecording(recordingId);
      const storage = input.mediaWriter.getRecordingStorage?.(recordingId);
      if (!recording || !storage || storage.attached) throw new BrowserRecordingStorageError('browser_recording_missing');
      if (recording.status !== 'completed' && recording.status !== 'finalized') throw new BrowserRecordingStorageError('browser_recording_not_active');
      const result = await discardFinalizedStoredMedia(recording, 'user_discarded', now(), beforeEffect);
      if (result.status === 'unavailable') throw new BrowserRecordingStorageError('browser_recording_media_discard_failed');
    },
    async startRecording(startInput) {
      const control = input.resolveInputControl?.(startInput);
      if (control?.isObservationHeld()) return confidentialityUnavailable();
      const activeRecordingId = activeRecordingIdByView.get(browserViewKey(startInput));
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
      const recordingId = buildRecordingId(startInput);
      if (sessionsById.has(recordingId)) {
        return {
          status: 'unavailable',
          reason: createUnavailable(
            'browser_recording_id_conflict',
            'A browser recording with this identity already exists.',
          ),
        };
      }
      const recording = parseRecordingSession({
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
        status: 'starting',
        navigationGenerationStart: startInput.navigationGeneration,
        durationMs: 0,
        byteSize: 0,
        frameCount: 0,
        fps: startInput.recordingCapabilities.maxFps,
        mimeType: startInput.mimeType,
        retentionClass: startInput.retentionClass,
        redactionLevel: 'metadataOnly',
        policyState: startInput.policyState ?? 'allowed',
      });

      // Register before capture startup can await; the input owner drains the actual operation
      // before discarding its capture, so no encoder can appear after confidential delivery.
      const unregisterConfidentialityDrain = control?.registerConfidentialityDrain(async () => {
        const current = readRecording(recordingId);
        if (current && activeAdapterByRecordingId.has(recordingId)) {
          await terminalOutcome(current, 'policy_revoked', now());
        }
      });
      activeAdapterByRecordingId.set(recordingId, { adapter, control, unregisterConfidentialityDrain });
      putRecording(recording, true);
      const start = async (): Promise<BrowserRecordingRuntimeStartResult> => {
        let adapterStart: BrowserRecordingCaptureAdapterStartResult;
        try {
          adapterStart = await adapter.start({ recording, captureSource: startInput.captureSource });
        } catch {
          await terminalOutcome(recording, 'capture_failed', now());
          return { status: 'unavailable', reason: createUnavailable('browser_recording_capture_failed', 'Browser recording capture failed to start.') };
        }
        if (!activeAdapterByRecordingId.has(recordingId)) {
          // Cancellation may have drained before the adapter finished allocating its source.
          // The completed startup still owns that late allocation and must retire it directly.
          const discard = adapter.discard({ recordingId, recording, reason: readRecording(recordingId)?.outcomeReason ?? 'user_canceled' });
          // The old registration was retired by cancellation. Keep this actual late teardown
          // registered until it succeeds so a rejected observation cannot authorize a fill.
          const unregisterLateDrain = control?.registerConfidentialityDrain(() => discard);
          await discard;
          unregisterLateDrain?.();
          return { status: 'unavailable', reason: createUnavailable('browser_recording_not_active', 'Browser recording is no longer active.') };
        }
        if (control?.isObservationHeld()) {
          await terminalOutcome(recording, 'policy_revoked', now());
          return confidentialityUnavailable();
        }
        if (adapterStart.status === 'unavailable') {
          await terminalOutcome(recording, 'capture_unavailable', now());
          return { status: 'unavailable', reason: adapterStart.reason };
        }
        const started = parseRecordingSession({ ...recording, status: 'recording' });
        putRecording(started, true);
        return { status: 'started', recording: started };
      };
      return (control ? await control.observeWhile(start) : await start()) ?? confidentialityUnavailable();
    },

    async stopRecording(stopInput) {
      const recording = readRecording(stopInput.recordingId);
      if (!recording) {
        return {
          status: 'unavailable',
          reason: createUnavailable('browser_recording_missing', 'Browser recording is no longer available.'),
        };
      }
      const control = activeAdapterByRecordingId.get(recording.recordingId)?.control ?? input.resolveInputControl?.(recording);
      if (control?.isObservationHeld()) return confidentialityUnavailable();
      if (recording.status === 'finalized' || recording.status === 'completed') {
        return { status: 'finalized', recording };
      }
      if (recording.status === 'failed' && recording.outcomeReason) {
        return { status: 'failed', recording, reason: recording.outcomeReason };
      }

      const adapter = activeAdapterByRecordingId.get(recording.recordingId)?.adapter;
      if (!adapter || !isActiveStatus(recording.status)) {
        return {
          status: 'unavailable',
          reason: createUnavailable(
            'browser_recording_capture_adapter_missing',
            'Browser recording capture adapter is unavailable.',
          ),
        };
      }

      const finalize = async (): Promise<BrowserRecordingRuntimeStopResult> => {
        let artifact: BrowserRecordingCapturedArtifact | null = null;
        try {
          artifact = await adapter.stop({ recordingId: recording.recordingId, recording });
          if (control?.isObservationHeld()) throw new Error('Browser recording is held for confidential input.');
          const mediaRef = await input.mediaWriter.persistRecording({ recording, artifact });
          if (control?.isObservationHeld()) {
            await input.mediaWriter.discardRecording({ recording: { ...recording, mediaRef }, reason: 'user_discarded' });
            throw new Error('Browser recording is held for confidential input.');
          }
          const stoppedAtMs = stopInput.stoppedAtMs ?? now();
          const finalized = parseRecordingSession({
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
          if (control?.isObservationHeld()) {
            const outcome = await terminalOutcome(recording, 'policy_revoked', now());
            if (outcome.status === 'unavailable') return outcome;
            return { status: 'failed', recording: outcome.recording, reason: 'policy_revoked' };
          }
          const failed = parseRecordingSession({
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
          if (artifact?.cleanup) await artifact.cleanup();
        }
      };
      return (control ? await control.observeWhile(finalize) : await finalize()) ?? confidentialityUnavailable();
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
      const control = activeAdapterByRecordingId.get(recording.recordingId)?.control;
      const cancel = () => terminalOutcome(recording, cancelInput.reason, cancelInput.atMs ?? now());
      // A closed input target still needs capture cleanup. For an open target, the same
      // observation tracker makes confidential delivery await an already-issued teardown.
      if (!control || control.isClosed()) return await cancel();
      return await control.observeWhile(cancel) ?? confidentialityUnavailable();
    },

    async cleanupExpiredRecordings(cleanupInput) {
      const discardedRecordingIds: string[] = [];
      const failedRecordingIds: string[] = [];
      for (const recordingId of [...sessionOrder]) {
        const recording = readRecording(recordingId);
        if (!recording || recording.expiresAtMs === undefined || recording.expiresAtMs > cleanupInput.nowMs) continue;
        if (recording.status !== 'completed' && recording.status !== 'finalized') continue;
        try {
          await input.mediaWriter.discardRecording({
            recording,
            reason: 'retention_limit',
            beforeEffect: cleanupInput.beforeEffect,
          });
        } catch {
          failedRecordingIds.push(recordingId);
          continue;
        }
        const discarded = parseRecordingSession({
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
      const viewKey = browserViewKey(viewInput);
      return sessionOrder
        .map((recordingId) => readRecording(recordingId))
        .filter((recording): recording is BrowserRecordingSessionV1 => recording != null && browserViewKey(recording) === viewKey);
    },

    listStorageRecordings() {
      return [...sessionsById.values()].flatMap((recording): BrowserRecordingStorageRecord[] => {
        const storage = input.mediaWriter.getRecordingStorage?.(recording.recordingId);
        // Transcript custody owns attached uploads; they are sized as session folders.
        if (!storage || storage.attached) return [];
        return [{
          recordingId: recording.recordingId,
          path: storage.path,
          expiresAtMs: recording.expiresAtMs,
          active: isActiveStatus(recording.status),
        }];
      });
    },

    subscribeStorageChanges(listener) {
      storageChangeListeners.add(listener);
      return () => { storageChangeListeners.delete(listener); };
    },
  };
}
