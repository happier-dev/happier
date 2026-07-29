import {
  DEFAULT_BROWSER_RECORDING_CAPABILITIES,
  DaemonBrowserRecordingStartInputV1Schema,
  type BrowserRecordingCapabilities,
} from '@happier-dev/protocol';

import { createTransferPathAllowanceRegistry } from '@/transfers/targets/createTransferPathAllowanceRegistry';
import type { TransferPathAllowanceRegistry } from '@/transfers/targets/createTransferPathAllowanceRegistry';

import {
  BrowserRecordingRetentionCleanupScheduler,
} from './retentionScheduler';
import { createFfmpegBrowserRecordingStreamFrameEncoderFactory } from './adapters/ffmpegStreamEncoder';
import {
  createBrowserRecordingStreamFrameCaptureAdapter,
  type BrowserRecordingStreamFrameEncoderFactory,
} from './adapters/stream';
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
import {
  createBrowserRecordingDaemonService,
  type BrowserRecordingCaptureAdapter,
  type BrowserRecordingDaemonService,
  type BrowserRecordingMediaWriter,
} from './service';
import {
  createBrowserRecordingSessionMediaWriter,
  type BrowserRecordingSessionMediaTarget,
  type BrowserRecordingSessionMediaWriterOptions,
} from './sessionMediaWriter';
import type { MachineLiveStreamCaptureRegistry } from '../../peer/mediation/stream/captureRegistry';

const STARTUP_DISABLED_RECORDING_CAPABILITIES = {
  ...DEFAULT_BROWSER_RECORDING_CAPABILITIES,
  disabledReasons: [
    'Browser recording capture adapters are not configured for this daemon runtime.',
  ],
} satisfies BrowserRecordingCapabilities;

const PERSISTENCE_DISABLED_RECORDING_CAPABILITIES = {
  ...DEFAULT_BROWSER_RECORDING_CAPABILITIES,
  disabledReasons: [
    'Browser recording session-media target policy is not configured for this daemon runtime.',
  ],
} satisfies BrowserRecordingCapabilities;

export type BrowserRecordingDaemonRuntime = Readonly<{
  service: BrowserRecordingDaemonService;
  routes: BrowserRecordingRoutes;
  stop: () => void;
}>;

export type BrowserRecordingDaemonRuntimeOptions = Readonly<{
  workingDirectory: string;
  captureAdapters?: readonly BrowserRecordingCaptureAdapter[];
  liveStreamCaptureRegistry?: MachineLiveStreamCaptureRegistry;
  streamFrameEncoderFactory?: BrowserRecordingStreamFrameEncoderFactory;
  mediaWriter?: BrowserRecordingMediaWriter;
  pathAllowanceRegistry?: TransferPathAllowanceRegistry;
  resolveSessionMediaTarget?: BrowserRecordingSessionMediaWriterOptions['resolveSessionMediaTarget'];
  resolveStartContext?: (input: Parameters<BrowserRecordingRoutes['startRecording']>[0]) =>
    | BrowserRecordingStartContext
    | Promise<BrowserRecordingStartContext>;
  // Native still-capture (nativeViewCapture) producer. Registered only when BOTH the per-platform
  // capture-support flag and a real native capture command are supplied — capability-true, no
  // daemon-side over-claim. Absent today (no daemon->native IPC path); stays fail-closed.
  nativeViewCapture?: Readonly<{
    isPlatformCaptureSupported: () => boolean;
    captureCommand: BrowserRecordingNativeViewCaptureCommand;
  }>;
  // Managed-Chromium agent-sidecar `cdpScreencast` producer (BA-4). Registered only when a real
  // CDP screencast transport is bound (managed Chromium running); absent today on hosts without a
  // sidecar, so the cell stays fail-closed (`browser_recording_capture_adapter_missing`).
  cdpScreencast?: Readonly<{
    transport: BrowserRecordingCdpScreencastTransport;
  }>;
  now?: () => number;
  retentionCleanupIntervalMs?: number;
  onRetentionCleanupError?: (error: unknown) => void;
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
    captureAdapters.push(createBrowserRecordingStreamFrameCaptureAdapter({
      captureRegistry: options.liveStreamCaptureRegistry,
      encoderFactory: options.streamFrameEncoderFactory
        ?? createFfmpegBrowserRecordingStreamFrameEncoderFactory({
          workingDirectory: options.workingDirectory,
        }),
      nowMs: options.now,
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
    now: options.now,
  });
  const baseRoutes = createBrowserRecordingRoutes({
    service,
    resolveStartContext: async (startInput) => {
      if (!hasConfiguredDurableMediaTarget && !startInput.mediaTarget) {
        return {
          browserRecordingEnabled: false,
          recordingCapabilities: PERSISTENCE_DISABLED_RECORDING_CAPABILITIES,
        };
      }
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
    async startRecording(rawStartInput) {
      const startInput = DaemonBrowserRecordingStartInputV1Schema.parse(rawStartInput);
      const result = await baseRoutes.startRecording(startInput);
      if (result.status === 'started' && startInput.mediaTarget) {
        commandMediaTargetsByRecordingId?.set(result.recording.recordingId, startInput.mediaTarget);
      }
      return result;
    },

    async stopRecording(stopInput) {
      const result = await baseRoutes.stopRecording(stopInput);
      if (result.status !== 'unavailable') {
        commandMediaTargetsByRecordingId?.delete(stopInput.recordingId);
      } else if (
        result.reason.code === 'browser_recording_missing'
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

    async cleanupExpiredRecordings(cleanupInput) {
      const result = await baseRoutes.cleanupExpiredRecordings(cleanupInput);
      for (const recordingId of result.discardedRecordingIds) {
        commandMediaTargetsByRecordingId?.delete(recordingId);
      }
      return result;
    },
  };
  const retentionScheduler = new BrowserRecordingRetentionCleanupScheduler({
    cleanupExpiredRecordings: routes.cleanupExpiredRecordings,
    nowMs: options.now,
    intervalMs: options.retentionCleanupIntervalMs,
    onCleanupError: options.onRetentionCleanupError,
  });
  retentionScheduler.start();

  return {
    service,
    routes,
    stop: () => {
      retentionScheduler.stop();
    },
  };
}
