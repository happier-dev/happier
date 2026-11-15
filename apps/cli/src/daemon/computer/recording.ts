import { COMPUTER_RECORDING_ACTION_IDS_V1 as ids, type ComputerRecordingActionIdV1 } from '@happier-dev/protocol/actions/actionIds';
import { computerSourceIdentityKeyV1, type ComputerSourceIdentityV1 } from '@happier-dev/protocol/computer/v1';
import { ComputerRecordingSessionV1Schema, type ComputerRecordingSessionV1 } from '@happier-dev/protocol/computer/recording';
import { DEFAULT_BROWSER_RECORDING_CAPABILITIES } from '@happier-dev/protocol/features/payload/capabilities/browserCapabilities';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import type { z } from 'zod/mini';
import type { COMPUTER_RUNTIME_ACTION_INPUT_SCHEMAS } from '@happier-dev/protocol/actions/specs/computer';
import { createTransferPathAllowanceRegistry } from '@/transfers/targets/createTransferPathAllowanceRegistry';
import { configuration } from '@/configuration';
import { createRecordingDaemonService, type RecordingStartInput } from '../recording/service';
import { createBrowserRecordingStreamFrameCaptureAdapter, type BrowserRecordingStreamFrameEncoderFactory } from '../recording/stream';
import { createFfmpegBrowserRecordingStreamFrameEncoderFactory } from '../recording/ffmpegStreamEncoder';
import { createBrowserRecordingSessionMediaWriter, type BrowserRecordingSessionMediaWriterOptions } from '../recording/sessionMediaWriter';
import { createBrowserRecordingAttachToComposer } from '../recording/attachToComposer';
import type { MachineLiveStreamCaptureRegistry } from '../peer/mediation/stream/captureRegistry';
import type { ComputerCaptureSource } from './source';
import type { RecordingOperationContext } from '../recording/sessionMediaHost';

export type ComputerRecordingOptions = Readonly<{
  workingDirectory?: string;
  encoderFactory?: BrowserRecordingStreamFrameEncoderFactory;
  resolveWorkingDirectory?: BrowserRecordingSessionMediaWriterOptions<ComputerRecordingSessionV1>['resolveWorkingDirectory'];
  commitAttachment?: BrowserRecordingSessionMediaWriterOptions<ComputerRecordingSessionV1>['commitAttachment'];
}>;
export type ComputerRecordingActionInput = z.infer<(typeof COMPUTER_RUNTIME_ACTION_INPUT_SCHEMAS)[ComputerRecordingActionIdV1]>;
type StartInput = RecordingStartInput & Pick<ComputerRecordingSessionV1, 'machineId' | 'sourceId' | 'sourceIdentity' | 'desktopKey' | 'target' | 'mediaTarget'>;

/** Computer supplies only identity, admission and an existing frame source to the shared recorder. */
export function createComputerRecording(input: Readonly<{
  machineId: string; registry: MachineLiveStreamCaptureRegistry; options?: ComputerRecordingOptions;
}>) {
  const workingDirectory = input.options?.workingDirectory ?? configuration.happyHomeDir;
  const controlFor = (recording: { sourceId: string }) => {
    const resolved = input.registry.resolve({ sourceId: recording.sourceId });
    return resolved.ok ? resolved.source.computer?.inputControl : undefined;
  };
  const writer = createBrowserRecordingSessionMediaWriter<ComputerRecordingSessionV1>({
    workingDirectory, pathAllowanceRegistry: createTransferPathAllowanceRegistry(),
    resolveSessionMediaTarget: recording => recording.mediaTarget,
    resolveWorkingDirectory: input.options?.resolveWorkingDirectory,
    commitAttachment: input.options?.commitAttachment,
    resolveInputControl: controlFor,
  });
  const service = createRecordingDaemonService<ComputerRecordingSessionV1, StartInput, { sourceId: string }>({
    mediaWriter: writer, resolveInputControl: controlFor,
    captureAdapters: [createBrowserRecordingStreamFrameCaptureAdapter<ComputerRecordingSessionV1>({
      captureRegistry: input.registry, sourceMachineId: input.machineId, resolveInputControl: controlFor,
      encoderFactory: input.options?.encoderFactory ?? createFfmpegBrowserRecordingStreamFrameEncoderFactory({ workingDirectory }),
    })],
    model: {
      parseSession: value => ComputerRecordingSessionV1Schema.parse(projectNativeJsonValueForTransport(value)),
      targetKey: target => target.sourceId,
      startUnavailable: () => null,
      sessionFields: start => ({ machineId: start.machineId, sourceId: start.sourceId,
        sourceIdentity: start.sourceIdentity, desktopKey: start.desktopKey, target: start.target, mediaTarget: start.mediaTarget }),
    },
  });
  const attach = createBrowserRecordingAttachToComposer<ComputerRecordingSessionV1>({
    routes: { getRecordingStatus: async ({ recordingId }) => service.getRecordingStatus(recordingId) },
    resolveInputControl: controlFor,
    attachToComposer: request => writer.attachToComposer!(request),
  });
  const belongsTo = (recording: ComputerRecordingSessionV1, sourceIdentity: ComputerSourceIdentityV1, sourceId: string, desktopKey?: string) =>
    recording.sourceId === sourceId
    && recording.desktopKey === desktopKey
    && computerSourceIdentityKeyV1(recording.sourceIdentity) === computerSourceIdentityKeyV1(sourceIdentity);
  return {
    service,
    async start(request: ComputerRecordingActionInput, source: ComputerCaptureSource, context?: RecordingOperationContext) {
      if (!('mediaTarget' in request)) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' } as const;
      // Session media custody belongs to the invoking Session. A machine-only
      // desktop admission does not grant transcript mutation in an arbitrary Session.
      if (source.sourceIdentity.kind !== 'session') {
        return { ok: false, errorCode: 'computer_session_required', error: 'computer_session_required' } as const;
      }
      if (request.mediaTarget.sessionId !== source.sourceIdentity.sessionId) {
        return { ok: false, errorCode: 'computer_session_mismatch', error: 'computer_session_mismatch' } as const;
      }
      const resolved = input.registry.resolve({ sourceId: source.sourceId });
      // Use the producer's advertised cadence, or the shared output target when unspecified.
      const maxFps = (resolved.ok ? resolved.source.capabilities.maxFramesPerSecond : undefined)
        ?? DEFAULT_BROWSER_RECORDING_CAPABILITIES.maxFps;
      return service.startRecording({ machineId: input.machineId, sourceId: source.sourceId,
        sourceIdentity: source.sourceIdentity, desktopKey: source.desktopKey, target: source.target, mediaTarget: request.mediaTarget,
        captureKind: 'streamFrameCapture', captureSource: { kind: 'machineLiveStream', streamFamily: 'screen', sourceId: source.sourceId },
        recordingCapabilities: { maxFps }, mimeType: 'video/webm', retentionClass: request.retentionClass }, context);
    },
    async dispatch(actionId: ComputerRecordingActionIdV1, request: ComputerRecordingActionInput, sourceIdentity: ComputerSourceIdentityV1, desktopKey?: string) {
      const sourceId = request.sourceId;
      if (!sourceId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' } as const;
      if (actionId === ids.list || actionId === ids.cleanupExpired) {
        const records = service.listRecordingsForView({ sourceId }).filter(recording => belongsTo(recording, sourceIdentity, sourceId, desktopKey));
        if (actionId === ids.list) return records;
        if (!records.length) return { discardedRecordingIds: [], failedRecordingIds: [] };
        return service.cleanupExpiredRecordings({ nowMs: Date.now(), target: { sourceId } });
      }
      const recording = 'recordingId' in request ? service.getRecordingStatus(request.recordingId) : null;
      if (!recording || !belongsTo(recording, sourceIdentity, sourceId, desktopKey)) {
        if (actionId === ids.status) return null;
        return { ok: false, errorCode: 'computer_recording_missing', error: 'computer_recording_missing' } as const;
      }
      if (actionId === ids.status) return recording;
      if (actionId === ids.stop) return service.stopRecording({ recordingId: recording.recordingId,
        ...('expiresAtMs' in request && request.expiresAtMs !== undefined ? { expiresAtMs: request.expiresAtMs } : {}) });
      if (actionId === ids.attachToComposer) return attach({ recordingId: recording.recordingId,
        ...('sessionId' in request && request.sessionId ? { sessionId: request.sessionId } : {}) });
      return service.cancelRecording({ recordingId: recording.recordingId,
        reason: actionId === ids.discard ? 'user_discarded' : 'user_canceled' });
    },
    async closeSource(sourceId: string) {
      for (const recording of service.listRecordingsForView({ sourceId })) {
        if (recording.status === 'starting' || recording.status === 'recording' || recording.status === 'stopping') {
          await service.cancelRecording({ recordingId: recording.recordingId, reason: 'session_closed' });
        }
      }
    },
  };
}
