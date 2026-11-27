import { DEFAULT_BROWSER_RECORDING_CAPABILITIES } from '@happier-dev/protocol/features/payload/capabilities/browserCapabilities';
import { DaemonBrowserRecordingStartInputV1Schema } from '@happier-dev/protocol/browser/recording/v1';
import type { BrowserRecordingCapabilities } from '@happier-dev/protocol';

import { createTransferPathAllowanceRegistry } from '@/transfers/targets/createTransferPathAllowanceRegistry';
import type { TransferPathAllowanceRegistry } from '@/transfers/targets/createTransferPathAllowanceRegistry';

import { createFfmpegBrowserRecordingStreamFrameEncoderFactory } from '../../recording/ffmpegStreamEncoder';
import {
  createBrowserRecordingStreamFrameCaptureAdapter,
  type BrowserRecordingStreamFrameEncoderFactory,
} from '../../recording/stream';
import {
  createBrowserRecordingNativeViewCaptureAdapter,
  type BrowserRecordingNativeViewCaptureCommand,
} from './adapters/nativeView';
import {
  createBrowserRecordingCdpScreencastCaptureAdapter,
  type BrowserRecordingCdpScreencastTransport,
} from './adapters/cdpScreencast';
import {
  createBrowserRecordingRoutes,
  type BrowserRecordingRoutes,
  type BrowserRecordingStartContext,
} from './routes';
import { createBrowserRecordingDaemonService } from './service';
import type { BrowserRecordingSessionV1 } from '@happier-dev/protocol';
import { buildRecordingId, type BrowserRecordingCaptureAdapter, type BrowserRecordingDaemonService, type BrowserRecordingMediaWriter, type BrowserRecordingInputControlResolver } from '../../recording/service';
import {
  createBrowserRecordingSessionMediaWriter,
  type BrowserRecordingSessionMediaTarget,
  type BrowserRecordingSessionMediaWriterOptions,
} from '../../recording/sessionMediaWriter';
import type { MachineLiveStreamCaptureRegistry } from '../../peer/mediation/stream/captureRegistry';

const STARTUP_DISABLED_RECORDING_CAPABILITIES = {
  ...DEFAULT_BROWSER_RECORDING_CAPABILITIES,
  disabledReasons: [
    'Browser recording capture adapters are not configured for this daemon runtime.',
  ],
} satisfies BrowserRecordingCapabilities;

export type BrowserRecordingDaemonRuntime = Readonly<{
  service: BrowserRecordingDaemonService;
  routes: BrowserRecordingRoutes;
  attachToComposer: NonNullable<BrowserRecordingMediaWriter['attachToComposer']>;
  stop: () => Promise<void>;
}>;

export type BrowserRecordingDaemonRuntimeOptions = Readonly<{
  workingDirectory: string;
  captureAdapters?: readonly BrowserRecordingCaptureAdapter[];
  liveStreamCaptureRegistry?: MachineLiveStreamCaptureRegistry;
  streamFrameEncoderFactory?: BrowserRecordingStreamFrameEncoderFactory;
  mediaWriter?: BrowserRecordingMediaWriter;
  pathAllowanceRegistry?: TransferPathAllowanceRegistry;
  resolveSessionMediaTarget?: BrowserRecordingSessionMediaWriterOptions['resolveSessionMediaTarget'];
  admitSave?: BrowserRecordingSessionMediaWriterOptions['admitSave'];
  resolveWorkingDirectory?: BrowserRecordingSessionMediaWriterOptions['resolveWorkingDirectory'];
  commitAttachment?: BrowserRecordingSessionMediaWriterOptions['commitAttachment'];
  resolveInputControl?: BrowserRecordingInputControlResolver;
  resolveStartContext?: (input: Parameters<BrowserRecordingRoutes['startRecording']>[0]) =>
    | BrowserRecordingStartContext
    | Promise<BrowserRecordingStartContext>;
  // Native still-capture producer. A directly bound producer may supply a known
  // platform fact; reverse capture resolves support at the answering UI/native
  // command. Registering its transport alone cannot produce an artifact.
  nativeViewCapture?: Readonly<{
    isPlatformCaptureSupported?: () => boolean;
    captureCommand: BrowserRecordingNativeViewCaptureCommand;
  }>;
  // Managed-Chromium agent-sidecar `cdpScreencast` producer (BA-4). Registered only when a real
  // CDP screencast transport is bound (managed Chromium running); absent today on hosts without a
  // sidecar, so the cell stays fail-closed (`browser_recording_capture_adapter_missing`).
  cdpScreencast?: Readonly<{
    transport: BrowserRecordingCdpScreencastTransport;
  }>;
  now?: () => number;
}>;

function createUnavailableMediaWriter(): BrowserRecordingMediaWriter {
  return {
    async persistRecording() {
      throw new Error('Browser recording session-media target resolution is unavailable.');
    },
    async discardRecording() {
      throw new Error('Browser recording session-media target resolution is unavailable.');
    },
  };
}

function createRuntimeMediaWriter(
  options: BrowserRecordingDaemonRuntimeOptions,
  commandMediaTargetsByRecordingId?: Map<string, BrowserRecordingSessionMediaTarget>,
): BrowserRecordingMediaWriter {
  if (options.mediaWriter) return options.mediaWriter;
  const resolveSessionMediaTarget = options.resolveSessionMediaTarget
    ?? (commandMediaTargetsByRecordingId
      ? ((recording) => {
        const commandTarget = commandMediaTargetsByRecordingId.get(recording.recordingId);
        if (!commandTarget) {
          throw new Error('Browser recording command media target is unavailable.');
        }
        return commandTarget;
      })
      : undefined);
  if (!resolveSessionMediaTarget) return createUnavailableMediaWriter();

  return createBrowserRecordingSessionMediaWriter({
    workingDirectory: options.workingDirectory,
    pathAllowanceRegistry: options.pathAllowanceRegistry ?? createTransferPathAllowanceRegistry(),
    resolveSessionMediaTarget,
    admitSave: options.admitSave,
    resolveWorkingDirectory: options.resolveWorkingDirectory,
    commitAttachment: options.commitAttachment,
    resolveInputControl: options.resolveInputControl,
  });
}

function createRuntimeCaptureAdapters(
  options: BrowserRecordingDaemonRuntimeOptions,
): readonly BrowserRecordingCaptureAdapter[] {
  const captureAdapters = [...(options.captureAdapters ?? [])];
  if (
    options.liveStreamCaptureRegistry
    && !captureAdapters.some((adapter) => adapter.captureKind === 'streamFrameCapture')
  ) {
    captureAdapters.push(createBrowserRecordingStreamFrameCaptureAdapter<BrowserRecordingSessionV1>({
      captureRegistry: options.liveStreamCaptureRegistry,
      encoderFactory: options.streamFrameEncoderFactory
        ?? createFfmpegBrowserRecordingStreamFrameEncoderFactory({
          workingDirectory: options.workingDirectory,
        }),
      nowMs: options.now,
      resolveInputControl: options.resolveInputControl,
    }));
  }
  if (
    options.nativeViewCapture
    && !captureAdapters.some((adapter) => adapter.captureKind === 'nativeViewCapture')
  ) {
    captureAdapters.push(createBrowserRecordingNativeViewCaptureAdapter({
      isPlatformCaptureSupported: options.nativeViewCapture.isPlatformCaptureSupported,
      captureCommand: options.nativeViewCapture.captureCommand,
      nowMs: options.now,
    }));
  }
  if (
    options.cdpScreencast
    && !captureAdapters.some((adapter) => adapter.captureKind === 'cdpScreencast')
  ) {
    captureAdapters.push(createBrowserRecordingCdpScreencastCaptureAdapter({
      transport: options.cdpScreencast.transport,
      encoderFactory: options.streamFrameEncoderFactory
        ?? createFfmpegBrowserRecordingStreamFrameEncoderFactory({
          workingDirectory: options.workingDirectory,
        }),
      nowMs: options.now,
    }));
  }
  return captureAdapters;
}

export function createBrowserRecordingDaemonRuntime(
  options: BrowserRecordingDaemonRuntimeOptions,
): BrowserRecordingDaemonRuntime {
  const hasConfiguredDurableMediaTarget = Boolean(options.mediaWriter || options.resolveSessionMediaTarget);
  const commandMediaTargetsByRecordingId = hasConfiguredDurableMediaTarget
    ? undefined
    : new Map<string, BrowserRecordingSessionMediaTarget>();
  const mediaWriter = createRuntimeMediaWriter(options, commandMediaTargetsByRecordingId);
  const service = createBrowserRecordingDaemonService({
    captureAdapters: createRuntimeCaptureAdapters(options),
    mediaWriter,
    resolveInputControl: options.resolveInputControl,
    now: options.now,
  });
  const baseRoutes = createBrowserRecordingRoutes({
    service,
    resolveStartContext: async (startInput) => {
      return await (
        options.resolveStartContext?.(startInput)
        ?? {
          browserRecordingEnabled: false,
          recordingCapabilities: STARTUP_DISABLED_RECORDING_CAPABILITIES,
        }
      );
    },
    now: options.now,
  });
  const routes: BrowserRecordingRoutes = {
    async startRecording(rawStartInput, context) {
      const parsed = DaemonBrowserRecordingStartInputV1Schema.parse(rawStartInput);
      if (!commandMediaTargetsByRecordingId) return await baseRoutes.startRecording(parsed, context);
      // START admits the save, so the command's media target is known before the service starts.
      const startInput = { ...parsed, recordingId: parsed.recordingId ?? buildRecordingId({}) };
      const owned = !commandMediaTargetsByRecordingId.has(startInput.recordingId);
      if (owned) commandMediaTargetsByRecordingId.set(startInput.recordingId, startInput.mediaTarget ?? {
        sessionId: context?.defaultSessionId ?? startInput.browserSessionId,
        messageLocalId: startInput.recordingId,
      });
      const result = await baseRoutes.startRecording(startInput, context);
      if (owned && result.status !== 'started') commandMediaTargetsByRecordingId.delete(startInput.recordingId);
      return result;
    },

    async stopRecording(stopInput, context) {
      const result = await baseRoutes.stopRecording(stopInput, context);
      if (result.status !== 'unavailable' && result.status !== 'finalized') {
        commandMediaTargetsByRecordingId?.delete(stopInput.recordingId);
      } else if (
        result.status === 'unavailable' && result.reason.code === 'browser_recording_missing'
      ) {
        commandMediaTargetsByRecordingId?.delete(stopInput.recordingId);
      }
      return result;
    },

    async cancelRecording(cancelInput) {
      const result = await baseRoutes.cancelRecording(cancelInput);
      if (result.status !== 'unavailable') {
        commandMediaTargetsByRecordingId?.delete(cancelInput.recordingId);
      } else if (result.reason.code === 'browser_recording_missing') {
        commandMediaTargetsByRecordingId?.delete(cancelInput.recordingId);
      }
      return result;
    },

    getRecordingStatus: baseRoutes.getRecordingStatus,
    listRecordingsForView: baseRoutes.listRecordingsForView,

    async cleanupExpiredRecordings(cleanupInput, cleanupOptions) {
      const result = await baseRoutes.cleanupExpiredRecordings(cleanupInput, cleanupOptions);
      for (const recordingId of result.discardedRecordingIds) {
        commandMediaTargetsByRecordingId?.delete(recordingId);
      }
      return result;
    },
  };
  return {
    service,
    routes,
    attachToComposer: input => mediaWriter.attachToComposer?.(input)
      ?? Promise.resolve({ ok: false, reason: 'recording_attachment_unavailable' }),
    async stop() {
      await service.dispose();
      commandMediaTargetsByRecordingId?.clear();
    },
  };
}
