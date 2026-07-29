import {
  DaemonBrowserRecordingCancelInputV1Schema,
  DaemonBrowserRecordingCleanupInputV1Schema,
  DaemonBrowserRecordingCleanupResultV1Schema,
  DaemonBrowserRecordingListInputV1Schema,
  DaemonBrowserRecordingListResponseV1Schema,
  DaemonBrowserRecordingStartInputV1Schema,
  DaemonBrowserRecordingStartResultV1Schema,
  DaemonBrowserRecordingStatusInputV1Schema,
  DaemonBrowserRecordingStatusResponseV1Schema,
  DaemonBrowserRecordingStopInputV1Schema,
  DaemonBrowserRecordingStopResultV1Schema,
  DaemonBrowserRecordingTerminalResultV1Schema,
  type BrowserRecordingCapabilities,
  type BrowserRecordingSessionV1,
  type DaemonBrowserRecordingCancelInputV1,
  type DaemonBrowserRecordingCleanupInputV1,
  type DaemonBrowserRecordingCleanupResultV1,
  type DaemonBrowserRecordingListInputV1,
  type DaemonBrowserRecordingStartInputV1,
  type DaemonBrowserRecordingStartResultV1,
  type DaemonBrowserRecordingStatusInputV1,
  type DaemonBrowserRecordingStopInputV1,
  type DaemonBrowserRecordingStopResultV1,
  type DaemonBrowserRecordingTerminalResultV1,
} from '@happier-dev/protocol';

import type { BrowserRecordingDaemonService } from './service';

export type BrowserRecordingStartContext = Readonly<{
  browserRecordingEnabled: boolean;
  recordingCapabilities: BrowserRecordingCapabilities;
  captureSourceAvailable?: boolean;
}>;

export type BrowserRecordingRoutes = Readonly<{
  startRecording(input: DaemonBrowserRecordingStartInputV1): Promise<DaemonBrowserRecordingStartResultV1>;
  stopRecording(input: DaemonBrowserRecordingStopInputV1): Promise<DaemonBrowserRecordingStopResultV1>;
  cancelRecording(input: DaemonBrowserRecordingCancelInputV1): Promise<DaemonBrowserRecordingTerminalResultV1>;
  getRecordingStatus(input: DaemonBrowserRecordingStatusInputV1): Promise<BrowserRecordingSessionV1 | null>;
  listRecordingsForView(input: DaemonBrowserRecordingListInputV1): Promise<readonly BrowserRecordingSessionV1[]>;
  cleanupExpiredRecordings(
    input: DaemonBrowserRecordingCleanupInputV1,
  ): Promise<DaemonBrowserRecordingCleanupResultV1>;
}>;

export function createBrowserRecordingRoutes(input: Readonly<{
  service: BrowserRecordingDaemonService;
  resolveStartContext(
    startInput: DaemonBrowserRecordingStartInputV1,
  ): Promise<BrowserRecordingStartContext> | BrowserRecordingStartContext;
  now?: () => number;
}>): BrowserRecordingRoutes {
  const now = input.now ?? (() => Date.now());

  return {
    async startRecording(rawStartInput) {
      const startInput = DaemonBrowserRecordingStartInputV1Schema.parse(rawStartInput);
      const startContext = await input.resolveStartContext(startInput);
      const result = await input.service.startRecording({
        ...startInput,
        browserRecordingEnabled: startContext.browserRecordingEnabled,
        recordingCapabilities: startContext.recordingCapabilities,
        ...(startContext.captureSourceAvailable === true ? { captureSourceAvailable: true } : {}),
      });
      return DaemonBrowserRecordingStartResultV1Schema.parse(result);
    },

    async stopRecording(rawStopInput) {
      const stopInput = DaemonBrowserRecordingStopInputV1Schema.parse(rawStopInput);
      const result = await input.service.stopRecording(stopInput);
      return DaemonBrowserRecordingStopResultV1Schema.parse(result);
    },

    async cancelRecording(rawCancelInput) {
      const cancelInput = DaemonBrowserRecordingCancelInputV1Schema.parse(rawCancelInput);
      const result = await input.service.cancelRecording(cancelInput);
      return DaemonBrowserRecordingTerminalResultV1Schema.parse(result);
    },

    async getRecordingStatus(rawStatusInput) {
      const statusInput = DaemonBrowserRecordingStatusInputV1Schema.parse(rawStatusInput);
      const recording = input.service.getRecordingStatus(statusInput.recordingId);
      return DaemonBrowserRecordingStatusResponseV1Schema.parse({
        protocolVersion: 1,
        recording,
      }).recording;
    },

    async listRecordingsForView(rawListInput) {
      const listInput = DaemonBrowserRecordingListInputV1Schema.parse(rawListInput);
      const recordings = input.service.listRecordingsForView(listInput);
      return DaemonBrowserRecordingListResponseV1Schema.parse({
        protocolVersion: 1,
        recordings,
      }).recordings;
    },

    async cleanupExpiredRecordings(rawCleanupInput) {
      const cleanupInput = DaemonBrowserRecordingCleanupInputV1Schema.parse(rawCleanupInput);
      const result = await input.service.cleanupExpiredRecordings({
        nowMs: cleanupInput.nowMs ?? now(),
      });
      return DaemonBrowserRecordingCleanupResultV1Schema.parse(result);
    },
  };
}
