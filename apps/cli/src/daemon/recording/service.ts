import { randomUUID } from 'node:crypto';
import type { DaemonBrowserRecordingUnavailableReasonV1 } from '@happier-dev/protocol/browser/recording/v1';
import type { BrowserRecordingCaptureSourceV1, BrowserDiagnosticFidelityV1, BrowserEvidenceSessionMediaReferenceV1, BrowserRecordingCapabilities, BrowserRecordingCaptureKindV1, BrowserRenderEngineKindV1, BrowserRecordingOutcomeReasonV1, BrowserRecordingPolicyStateV1, BrowserRecordingRetentionClassV1, BrowserRecordingSessionV1, BrowserSemanticAdapterKindV1, BrowserViewTargetKindV1 } from '@happier-dev/protocol';
import type { SessionMediaIngestionSource } from '@/session/media/_types';
import type { SurfaceInputControl } from '../surfaces/inputControl';
import type { RecordingOperationContext } from './sessionMediaHost';
import { readRequesterAccountActionContext } from '../sessionEncryption/requesterAccountActionContext';

const RECORDING_ID_PREFIX = 'browser_recording';

// Lifecycle facts shared by Browser views and Computer targets; identity stays with each source.
export type RecordingSession = Omit<BrowserRecordingSessionV1,
  'browserSessionId' | 'viewId' | 'profileId' | 'targetKind' | 'adapterKind' | 'renderEngineKind'
  | 'fidelity' | 'navigationGenerationStart' | 'navigationGenerationEnd'>;
export type RecordingStartInput = Pick<BrowserRecordingRuntimeStartInput,
  'captureKind' | 'captureSource' | 'mimeType' | 'retentionClass' | 'policyState' | 'startedAtMs' | 'recordingId'>
  & Readonly<{ recordingCapabilities: Pick<BrowserRecordingCapabilities, 'maxFps'> }>;
type BrowserRecordingTarget = Readonly<{ browserSessionId: string; viewId: string }>;

export type BrowserRecordingInputControlResolver = (view: Readonly<{
  browserSessionId: string;
  viewId: string;
}>) => SurfaceInputControl | undefined;

export type BrowserRecordingDaemonUnavailableReason = Readonly<DaemonBrowserRecordingUnavailableReasonV1>;
export type BrowserRecordingDaemonUnavailableCode = BrowserRecordingDaemonUnavailableReason['code'];

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

export type BrowserRecordingCaptureAdapter<R extends RecordingSession = BrowserRecordingSessionV1> = Readonly<{
  captureKind: BrowserRecordingCaptureKindV1;
  start(input: BrowserRecordingCaptureStartInput<R>): Promise<BrowserRecordingCaptureAdapterStartResult>;
  stop(input: BrowserRecordingCaptureStopInput<R>): Promise<BrowserRecordingCapturedArtifact>;
  discard(input: BrowserRecordingCaptureDiscardInput<R>): Promise<void>;
}>;

export type BrowserRecordingMediaWriter<R extends RecordingSession = BrowserRecordingSessionV1> = Readonly<{
  attachToComposer?: (input: Readonly<{ recording: R; sessionId?: string }>) => Promise<
    Readonly<{ ok: true; attachmentId: string }> | Readonly<{ ok: false; reason: string }>>;
  getRecordingStorage?: (recordingId: string) => Readonly<{ path: string; attached: boolean }> | null;
  persistRecording(input: Readonly<{
    recording: R;
    artifact: BrowserRecordingCapturedArtifact;
    /** The lifecycle owner stopped capture before confidential input could be delivered. */
    captureStopped?: true;
    context?: RecordingOperationContext;
  }>): Promise<BrowserEvidenceSessionMediaReferenceV1>;
  discardRecording(input: Readonly<{
    recording: R;
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

export type BrowserRecordingDaemonService<R extends RecordingSession = BrowserRecordingSessionV1, S extends RecordingStartInput = BrowserRecordingRuntimeStartInput, Q = BrowserRecordingTarget> = Readonly<{
  dispose(): Promise<void>;
  startRecording(input: S, context?: RecordingOperationContext): Promise<BrowserRecordingRuntimeStartResult<R>>;
  stopRecording(input: BrowserRecordingRuntimeStopInput): Promise<BrowserRecordingRuntimeStopResult<R>>;
  cancelRecording(input: BrowserRecordingRuntimeCancelInput): Promise<BrowserRecordingRuntimeTerminalResult<R>>;
  cleanupExpiredRecordings(input: Readonly<{ nowMs: number; target?: Q; includeRecording?: (recording: R) => boolean; beforeEffect?: () => Promise<void> }>): Promise<Readonly<{
    discardedRecordingIds: readonly string[];
    failedRecordingIds: readonly string[];
  }>>;
  getRecordingStatus(recordingId: string): R | null;
  listRecordingsForView(input: Q): readonly R[];
  getStorageRecording(recordingId: string): BrowserRecordingStorageRecord | null;
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

export type RecordingStorageOwner = Pick<BrowserRecordingDaemonService,
  'nextExpiryAtMs' | 'getStorageRecording' | 'listStorageRecordings' | 'discardStorageRecording' | 'subscribeStorageChanges'> & Readonly<{
    cleanupExpiredRecordings(input: Readonly<{ nowMs: number; beforeEffect?: () => Promise<void> }>):
      ReturnType<BrowserRecordingDaemonService['cleanupExpiredRecordings']>;
  }>;

/** Fan out storage operations to the same lifecycle owner for each capture source. */
export function combineRecordingStorageOwners(readOwners: () => readonly RecordingStorageOwner[]): RecordingStorageOwner {
  function findStorageRecording(recordingId: string) {
    for (const owner of readOwners()) {
      const recording = owner.getStorageRecording(recordingId);
      if (recording) return { owner, recording };
    }
    return null;
  }
  return {
    nextExpiryAtMs() {
      const dates = readOwners().flatMap(owner => { const date = owner.nextExpiryAtMs(); return date === null ? [] : [date]; });
      return dates.length ? Math.min(...dates) : null;
    },
    getStorageRecording: recordingId => findStorageRecording(recordingId)?.recording ?? null,
    listStorageRecordings: () => readOwners().flatMap(owner => owner.listStorageRecordings()),
    async cleanupExpiredRecordings(request) {
      const results = await Promise.all(readOwners().map(owner => owner.cleanupExpiredRecordings(request)));
      return { discardedRecordingIds: results.flatMap(result => result.discardedRecordingIds),
        failedRecordingIds: results.flatMap(result => result.failedRecordingIds) };
    },
    async discardStorageRecording(request) {
      const found = findStorageRecording(request.recordingId);
      if (!found) throw new BrowserRecordingStorageError('browser_recording_missing');
      await found.owner.discardStorageRecording(request);
    },
    subscribeStorageChanges(listener) {
      const releases = readOwners().map(owner => owner.subscribeStorageChanges(listener));
      return () => { for (const release of releases) release(); };
    },
  };
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

export type BrowserRecordingCaptureStartInput<R extends RecordingSession = BrowserRecordingSessionV1> = Readonly<{
  recording: R;
  captureSource?: BrowserRecordingCaptureSourceV1;
}>;

export type BrowserRecordingCaptureStopInput<R extends RecordingSession = BrowserRecordingSessionV1> = Readonly<{
  recordingId: string;
  recording: R;
}>;

export type BrowserRecordingCaptureDiscardInput<R extends RecordingSession = BrowserRecordingSessionV1> = Readonly<{
  recordingId: string;
  recording: R;
  reason: BrowserRecordingOutcomeReasonV1;
}>;

export type BrowserRecordingRuntimeStopInput = Readonly<{
  recordingId: string;
  stoppedAtMs?: number;
  navigationGenerationEnd?: number;
  expiresAtMs?: number;
}>;

export type BrowserRecordingRuntimeCancelInput = Readonly<{
  recordingId: string;
  atMs?: number;
  reason: Extract<BrowserRecordingOutcomeReasonV1, 'user_canceled' | 'user_discarded' | 'session_closed' | 'logout'>;
}>;

export type BrowserRecordingRuntimeStartResult<R extends RecordingSession = BrowserRecordingSessionV1> =
  | Readonly<{ status: 'started'; recording: R }>
  | Readonly<{ status: 'unavailable'; reason: BrowserRecordingDaemonUnavailableReason }>;

export type BrowserRecordingRuntimeStopResult<R extends RecordingSession = BrowserRecordingSessionV1> =
  | Readonly<{ status: 'finalized'; recording: R }>
  | Readonly<{ status: 'failed'; recording: R; reason: BrowserRecordingOutcomeReasonV1 }>
  | Readonly<{ status: 'unavailable'; reason: BrowserRecordingDaemonUnavailableReason }>;

export type BrowserRecordingRuntimeTerminalResult<R extends RecordingSession = BrowserRecordingSessionV1> =
  | Readonly<{ status: 'failed' | 'canceled' | 'discarded'; recording: R }>
  | Readonly<{ status: 'unavailable'; reason: BrowserRecordingDaemonUnavailableReason }>;

type BrowserRecordingTerminalOutcomeStatus = Exclude<BrowserRecordingRuntimeTerminalResult['status'], 'unavailable'>;

function createUnavailable(
  code: BrowserRecordingDaemonUnavailableCode,
  message: string,
): BrowserRecordingDaemonUnavailableReason {
  return { code, message };
}

function buildRecordingId(input: Pick<RecordingStartInput, 'recordingId'>): string {
  return input.recordingId ?? `${RECORDING_ID_PREFIX}_${randomUUID()}`;
}

function durationFrom(recording: RecordingSession, atMs: number): number {
  return Math.max(0, atMs - recording.startedAtMs);
}

function resolveTerminalStatus(reason: BrowserRecordingOutcomeReasonV1): BrowserRecordingTerminalOutcomeStatus {
  if (reason === 'user_canceled') return 'canceled';
  if (reason === 'user_discarded' || reason === 'session_closed' || reason === 'logout') {
    return 'discarded';
  }
  return 'failed';
}

function isActiveStatus(status: RecordingSession['status']): boolean {
  return status === 'starting' || status === 'recording' || status === 'stopping';
}

function isStoredMediaDiscardReason(
  reason: BrowserRecordingRuntimeCancelInput['reason'],
): reason is Extract<BrowserRecordingOutcomeReasonV1, 'user_discarded' | 'session_closed' | 'logout'> {
  return reason === 'user_discarded' || reason === 'session_closed' || reason === 'logout';
}

export function createRecordingDaemonService<R extends RecordingSession, S extends RecordingStartInput, Q>(input: Readonly<{
  captureAdapters: readonly BrowserRecordingCaptureAdapter<R>[];
  mediaWriter: BrowserRecordingMediaWriter<R>;
  resolveInputControl?: (recording: R | S) => SurfaceInputControl | undefined;
  now?: () => number;
  model: Readonly<{
    parseSession(value: unknown): R;
    sessionFields(start: S): object;
    targetKey(target: R | S | Q): string;
    startUnavailable(start: S): BrowserRecordingDaemonUnavailableReason | null;
  }>;
}>): BrowserRecordingDaemonService<R, S, Q> {
  const parseRecordingSession = input.model.parseSession;
  const now = input.now ?? (() => Date.now());
  const adaptersByCaptureKind = new Map(
    input.captureAdapters.map((adapter) => [adapter.captureKind, adapter]),
  );
  const sessionsById = new Map<string, R>();
  const storageChangeListeners = new Set<() => void>();
  const sessionOrder: string[] = [];
  const activeRecordingIdByView = new Map<string, string>();
  const activeAdapterByRecordingId = new Map<string, {
    readonly adapter: BrowserRecordingCaptureAdapter<R>;
    readonly control?: SurfaceInputControl;
    readonly unregisterConfidentialityDrain?: () => void;
    readonly context?: RecordingOperationContext;
    readonly releaseCustody?: () => Promise<void>;
    discard?: Promise<void>;
  }>();

  function confidentialityUnavailable(): Extract<BrowserRecordingRuntimeStartResult<R>, { status: 'unavailable' }> {
    return { status: 'unavailable', reason: createUnavailable('browser_recording_policy_denied', 'Browser recording is held for confidential input.') };
  }

  async function putRecording(recording: R, activeForView: boolean): Promise<void> {
    if (!sessionsById.has(recording.recordingId)) {
      sessionOrder.push(recording.recordingId);
    }
    sessionsById.set(recording.recordingId, recording);
    const viewKey = input.model.targetKey(recording);
    if (activeForView) {
      activeRecordingIdByView.set(viewKey, recording.recordingId);
    } else {
      if (activeRecordingIdByView.get(viewKey) === recording.recordingId) {
        activeRecordingIdByView.delete(viewKey);
      }
      const active = activeAdapterByRecordingId.get(recording.recordingId);
      active?.unregisterConfidentialityDrain?.();
      activeAdapterByRecordingId.delete(recording.recordingId);
      await active?.releaseCustody?.();
    }
    for (const listener of storageChangeListeners) listener();
  }

  function readRecording(recordingId: string): R | null {
    return sessionsById.get(recordingId) ?? null;
  }

  function projectStorageRecording(recording: R | null): BrowserRecordingStorageRecord | null {
    if (!recording) return null;
    const storage = input.mediaWriter.getRecordingStorage?.(recording.recordingId);
    // Transcript custody owns attached uploads; they are sized as session folders.
    if (!storage || storage.attached) return null;
    return {
      recordingId: recording.recordingId,
      path: storage.path,
      expiresAtMs: recording.expiresAtMs,
      active: isActiveStatus(recording.status),
    };
  }

  async function discardCapture(
    recording: R,
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
    recording: R,
    reason: BrowserRecordingOutcomeReasonV1,
    atMs: number,
  ): Promise<BrowserRecordingRuntimeTerminalResult<R>> {
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
    await putRecording(updated, false);
    return { status, recording: updated };
  }

  async function discardFinalizedStoredMedia(
    recording: R,
    reason: Extract<BrowserRecordingOutcomeReasonV1, 'user_discarded' | 'session_closed' | 'logout'>,
    atMs: number,
    beforeEffect?: () => Promise<void>,
  ): Promise<BrowserRecordingRuntimeTerminalResult<R>> {
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
    await putRecording(discarded, false);
    return { status: 'discarded', recording: discarded };
  }

  async function finalizeRecording(
    recording: R,
    adapter: BrowserRecordingCaptureAdapter<R>,
    stopInput: Pick<BrowserRecordingRuntimeStopInput, 'stoppedAtMs' | 'expiresAtMs'> &
      Readonly<{ navigationGenerationEnd?: number }>,
    control?: SurfaceInputControl,
  ): Promise<BrowserRecordingRuntimeStopResult<R>> {
    let artifact: BrowserRecordingCapturedArtifact | null = null;
    try {
      artifact = await adapter.stop({ recordingId: recording.recordingId, recording });
      // Capture has ended. Decide its cause once, before persistence can outlive a later hold.
      const stopped = { ...recording, outcomeReason: control?.hasConfidentialityHold() ? 'policy_revoked' as const : 'user_stopped' as const };
      const mediaRef = await input.mediaWriter.persistRecording({ recording: stopped, artifact, captureStopped: true,
        context: activeAdapterByRecordingId.get(recording.recordingId)?.context });
      const stoppedAtMs = stopInput.stoppedAtMs ?? now();
      const finalized = parseRecordingSession({
        ...stopped,
        status: 'finalized',
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
      await putRecording(finalized, false);
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
      await putRecording(failed, false);
      return { status: 'failed', recording: failed, reason: 'capture_failed' };
    } finally {
      if (artifact?.cleanup) await artifact.cleanup();
    }
  }

  return {
    async dispose() {
      for (const recordingId of activeAdapterByRecordingId.keys()) {
        const recording = readRecording(recordingId);
        if (recording) await terminalOutcome(recording, 'session_closed', now());
      }
    },
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
      if (!recording || !projectStorageRecording(recording)) throw new BrowserRecordingStorageError('browser_recording_missing');
      if (recording.status !== 'completed' && recording.status !== 'finalized') throw new BrowserRecordingStorageError('browser_recording_not_active');
      const result = await discardFinalizedStoredMedia(recording, 'user_discarded', now(), beforeEffect);
      if (result.status === 'unavailable') throw new BrowserRecordingStorageError('browser_recording_media_discard_failed');
    },
    async startRecording(startInput, context) {
      const control = input.resolveInputControl?.(startInput);
      if (control?.isObservationHeld()) return confidentialityUnavailable();
      const activeRecordingId = activeRecordingIdByView.get(input.model.targetKey(startInput));
      if (activeRecordingId) {
        return {
          status: 'unavailable',
          reason: createUnavailable(
            'browser_recording_already_active',
            'Only one browser recording can be active for a view.',
          ),
        };
      }

      const unavailable = input.model.startUnavailable(startInput);
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
        ...input.model.sessionFields(startInput),
        captureKind: startInput.captureKind,
        startedAtMs,
        status: 'starting',
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
      // before stopping its capture, so no encoder can appear after confidential delivery.
      const unregisterConfidentialityDrain = control?.registerConfidentialityDrain(async () => {
        const current = readRecording(recordingId);
        if (current && activeAdapterByRecordingId.has(recordingId)) {
          if (current.status === 'recording') {
            await finalizeRecording(current, adapter, {
              stoppedAtMs: now(),
            }, control);
          } else {
            await terminalOutcome(current, 'policy_revoked', now());
          }
        }
      });
      const releaseCustody = readRequesterAccountActionContext(context?.externalActionExecutionAuthorization)?.retain();
      activeAdapterByRecordingId.set(recordingId, { adapter, control, unregisterConfidentialityDrain, context, releaseCustody });
      await putRecording(recording, true);
      const start = async (): Promise<BrowserRecordingRuntimeStartResult<R>> => {
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
        await putRecording(started, true);
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
      if (recording.status === 'finalized' || recording.status === 'completed') {
        return { status: 'finalized', recording };
      }
      if (control?.isObservationHeld()) return confidentialityUnavailable();
      if (recording.status === 'failed' && recording.outcomeReason) {
        return { status: 'failed', recording, reason: recording.outcomeReason };
      }

      if (!isActiveStatus(recording.status)) {
        return {
          status: 'unavailable',
          reason: createUnavailable(
            'browser_recording_not_active',
            `Recording is ${recording.status} (${recording.outcomeReason}). Start a new recording to capture again.`,
          ),
        };
      }
      const adapter = activeAdapterByRecordingId.get(recording.recordingId)?.adapter;
      if (!adapter) {
        return {
          status: 'unavailable',
          reason: createUnavailable(
            'browser_recording_capture_adapter_missing',
            'Browser recording capture adapter is unavailable.',
          ),
        };
      }

      const finalize = () => finalizeRecording(recording, adapter, stopInput, control);
      // Finalization owns an admitted capture, not a new page observation. Confidential
      // delivery waits for this operation; its stopped prefix remains safe to persist.
      return control ? await control.drainWhile(finalize) : await finalize();
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
        if (recording && cleanupInput.target && input.model.targetKey(recording) !== input.model.targetKey(cleanupInput.target)) continue;
        if (!recording || recording.expiresAtMs === undefined || recording.expiresAtMs > cleanupInput.nowMs) continue;
        if (recording.status !== 'completed' && recording.status !== 'finalized') continue;
        if (cleanupInput.includeRecording && !cleanupInput.includeRecording(recording)) continue;
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
        await putRecording(discarded, false);
        discardedRecordingIds.push(recordingId);
      }
      return { discardedRecordingIds, failedRecordingIds };
    },

    getRecordingStatus(recordingId) {
      return readRecording(recordingId);
    },

    listRecordingsForView(viewInput) {
      const viewKey = input.model.targetKey(viewInput);
      return sessionOrder
        .map((recordingId) => readRecording(recordingId))
        .filter((recording): recording is R => recording != null && input.model.targetKey(recording) === viewKey);
    },

    getStorageRecording(recordingId) {
      return projectStorageRecording(readRecording(recordingId));
    },

    listStorageRecordings() {
      return [...sessionsById.values()].flatMap((recording): BrowserRecordingStorageRecord[] => {
        const storage = projectStorageRecording(recording);
        return storage ? [storage] : [];
      });
    },

    subscribeStorageChanges(listener) {
      storageChangeListeners.add(listener);
      return () => { storageChangeListeners.delete(listener); };
    },
  };
}
