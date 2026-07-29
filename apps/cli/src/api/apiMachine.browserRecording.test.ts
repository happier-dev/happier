import { describe, expect, it, vi } from 'vitest';

import type { Machine } from '@/api/types';
import type { BrowserRecordingSessionV1 } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { ApiMachineClient } from './apiMachine';

function createMachine(): Machine {
  return {
    id: 'machine-test',
    encryptionKey: new Uint8Array(32).fill(7),
    encryptionVariant: 'legacy',
    metadata: null,
    metadataVersion: 0,
    daemonState: null,
    daemonStateVersion: 0,
  };
}

const recording = {
  v: 1,
  recordingId: 'recording_1',
  browserSessionId: 'browser_session_1',
  viewId: 'view_1',
  profileId: 'profile_1',
  targetKind: 'localServicePreview',
  adapterKind: 'localPreview',
  renderEngineKind: 'webIframe',
  captureKind: 'streamFrameCapture',
  fidelity: 'streamFrame',
  startedAtMs: 10_000,
  status: 'recording',
  navigationGenerationStart: 7,
  durationMs: 0,
  byteSize: 0,
  frameCount: 0,
  fps: 12,
  mimeType: 'video/webm',
  retentionClass: 'preSend',
  redactionLevel: 'metadataOnly',
  policyState: 'allowed',
  maxDurationMs: 30_000,
  maxBytes: 16_000_000,
  actionChapters: [],
  relatedReferences: [],
} satisfies BrowserRecordingSessionV1;

describe('ApiMachineClient browser recording routes', () => {
  it('attaches daemon local service routes to the machine RPC handler manager', async () => {
    const client = new ApiMachineClient('token', createMachine());
    const rpc = (client as unknown as {
      rpcHandlerManager: {
        invokeLocal(method: string, params: unknown): Promise<unknown>;
      };
    }).rpcHandlerManager;
    const typedClient = client as unknown as {
      registerLocalServicesRoutes?: (routes: unknown) => void;
    };

    expect(typedClient.registerLocalServicesRoutes).toBeTypeOf('function');
    typedClient.registerLocalServicesRoutes?.({
      localServicesInventory: {
        getSnapshot: vi.fn(async () => ({
          v: 1,
          machineId: 'machine_1',
          generatedAt: 1_000,
          refreshState: 'idle',
          entries: [],
          diagnostics: [],
        })),
        refreshSnapshot: vi.fn(),
      },
      localServicesLauncher: {
        getSnapshot: vi.fn(async () => ({
          v: 1,
          machineId: 'machine_1',
          updatedAt: 2_000,
          targets: [],
        })),
        startTarget: vi.fn(async (request: { machineId: string; targetId: string }) => ({
          protocolVersion: 1,
          machineId: request.machineId,
          targetId: request.targetId,
          status: 'denied',
          reasonCode: 'launcher_start_unsupported',
          snapshot: {
            v: 1,
            machineId: request.machineId,
            updatedAt: 2_500,
            targets: [],
          },
        })),
      },
      localServicesActions: {
        execute: vi.fn(async () => ({
          v: 1,
          requestId: 'request_1',
          action: 'copy_url',
          status: 'succeeded',
          auditEvents: [{
            v: 1,
            eventId: 'request_1:0:succeeded',
            requestId: 'request_1',
            machineId: 'machine_1',
            action: 'copy_url',
            result: 'succeeded',
            recordedAt: 3_000,
          }],
        })),
      },
    });

    await expect(rpc.invokeLocal(RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_SNAPSHOT, {
      machineId: 'machine_1',
    })).resolves.toMatchObject({
      protocolVersion: 1,
      snapshot: { machineId: 'machine_1', generatedAt: 1_000 },
    });
    await expect(rpc.invokeLocal(RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_SNAPSHOT, {
      machineId: 'machine_1',
    })).resolves.toMatchObject({
      protocolVersion: 1,
      snapshot: { machineId: 'machine_1', updatedAt: 2_000 },
    });
    await expect(rpc.invokeLocal(RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_START, {
      machineId: 'machine_1',
      targetId: 'managed:web',
    })).resolves.toMatchObject({
      protocolVersion: 1,
      machineId: 'machine_1',
      targetId: 'managed:web',
      status: 'denied',
      reasonCode: 'launcher_start_unsupported',
      snapshot: { machineId: 'machine_1', updatedAt: 2_500 },
    });
    await expect(rpc.invokeLocal(RPC_METHODS.DAEMON_LOCAL_SERVICES_ACTIONS_EXECUTE, {
      requestId: 'request_1',
      target: { kind: 'inventory_entry', inventoryEntryId: 'entry_1', machineId: 'machine_1' },
      action: 'copy_url',
      force: false,
    })).resolves.toMatchObject({
      protocolVersion: 1,
      result: { requestId: 'request_1', status: 'succeeded' },
    });
  });

  it('attaches daemon browser recording routes to the machine RPC handler manager', async () => {
    const client = new ApiMachineClient('token', createMachine());
    const rpc = (client as unknown as {
      registerBrowserRecordingRoutes?: (routes: unknown) => void;
      rpcHandlerManager: {
        invokeLocal(method: string, params: unknown): Promise<unknown>;
      };
    }).rpcHandlerManager;
    const typedClient = client as unknown as {
      registerBrowserRecordingRoutes?: (routes: unknown) => void;
    };

    expect(typedClient.registerBrowserRecordingRoutes).toBeTypeOf('function');
    typedClient.registerBrowserRecordingRoutes?.({
      startRecording: vi.fn(async () => ({ status: 'started' as const, recording })),
      stopRecording: vi.fn(async () => ({
        status: 'unavailable' as const,
        reason: { code: 'browser_recording_missing', message: 'Browser recording is no longer available.' },
      })),
      cancelRecording: vi.fn(async () => ({
        status: 'unavailable' as const,
        reason: { code: 'browser_recording_missing', message: 'Browser recording is no longer available.' },
      })),
      getRecordingStatus: vi.fn(async () => null),
      listRecordingsForView: vi.fn(async () => []),
      cleanupExpiredRecordings: vi.fn(async () => ({ discardedRecordingIds: [], failedRecordingIds: [] })),
    });

    await expect(rpc.invokeLocal(RPC_METHODS.DAEMON_BROWSER_RECORDING_START, {
      protocolVersion: 1,
      machineId: 'machine_1',
      input: {
        browserSessionId: 'browser_session_1',
        viewId: 'view_1',
        profileId: 'profile_1',
        targetKind: 'localServicePreview',
        adapterKind: 'localPreview',
        renderEngineKind: 'webIframe',
        captureKind: 'streamFrameCapture',
        fidelity: 'streamFrame',
        navigationGeneration: 7,
        mimeType: 'video/webm',
        retentionClass: 'preSend',
      },
    })).resolves.toMatchObject({
      protocolVersion: 1,
      result: { status: 'started', recording: { recordingId: 'recording_1' } },
    });
  });
});
