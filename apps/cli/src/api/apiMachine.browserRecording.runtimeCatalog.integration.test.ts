import { describe, expect, it, vi } from 'vitest';

import type { Machine } from '@/api/types';
import type { BrowserRecordingSessionV1 } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { isApprovalRequiredByActionsSettings } from '@happier-dev/protocol/actions/actionApprovalPolicy';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { createLocalServicesDaemonRuntime } from '@/daemon/local/services/runtime';
import { createLocalServicesDaemonFeatureGate } from '@/daemon/local/services/featureGate';
import { createLocalServicesDaemonRuntimeActionExecutor } from '@/daemon/local/services/actions/runtimeActionExecutor';

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
  it('attaches real local service reads and policy-admitted controls to the machine RPC handler manager', async () => {
    const client = new ApiMachineClient('token', createMachine());
    const rpc = (client as unknown as {
      rpcHandlerManager: Pick<RpcHandlerManager, 'invokeLocal'>;
    }).rpcHandlerManager;
    const machineId = createMachine().id;
    const resolveServerFeaturesSnapshot = () => ({ status: 'ready' as const,
      features: FeaturesResponseSchema.parse({ features: {
        localServices: { enabled: true, inventory: { enabled: true }, launcher: { enabled: true }, actions: { enabled: true } },
        browser: { enabled: true, viewTargets: { enabled: true } },
      }, capabilities: {} }),
    });
    const runtime = createLocalServicesDaemonRuntime({ machineId, startLoop: false, processEnv: {}, now: () => 1_000,
      resolveServerFeaturesSnapshot,
      // OS inventory and accepted Account rows are external boundaries; domain routes stay real.
      scan: async () => ({ listeners: [], processes: new Map(), workspaces: [], diagnostics: [] }),
      workspaceFacts: () => ({ facts: [], acceptedWorkspaceRefs: [], diagnostics: [] }),
    });
    const gate = createLocalServicesDaemonFeatureGate({ env: {}, resolveServerFeaturesSnapshot });
    await gate.refresh();
    try {
      client.registerLocalServicesRoutes({ machineId, localServicesInventory: runtime.inventoryRoutes,
        localServicesLauncher: runtime.launcherRoutes, localServicesActions: runtime.actionRoutes,
        resolveLauncherActionExecutor: ({ ingress }) => {
          const executor = createActionExecutor({
            isActionApprovalRequired: (actionId, context) => isApprovalRequiredByActionsSettings(actionId,
              normalizeActionsSettingsV1(null), { surface: context.surface ?? null, authority: context.authority }),
            // Account Artifact persistence/decision is the boundary, not policy or launcher dispatch.
            approvalsCreate: async () => ({ artifactId: 'service-start-approval' }),
            approvalsUpdate: async () => {},
            approvalsWaitForDecision: async ({ request }) => ({ decision: 'reject' as const, request,
              decisionAuthority: 'present_user' as const }),
            runtimeActionExecute: createLocalServicesDaemonRuntimeActionExecutor({ featureGate: gate, ingress,
              routes: { launcherRoutes: runtime.launcherRoutes, actionRoutes: runtime.actionRoutes } }),
          });
          return { execute: (actionId, input, context) => executor.execute(actionId, input, { serverId: 'home-a', ...context }) };
        },
      });
      await expect(rpc.invokeLocal(RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_SNAPSHOT, { machineId }))
        .resolves.toMatchObject({ protocolVersion: 1, snapshot: { machineId, entries: [] } });
      await expect(rpc.invokeLocal(RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_SNAPSHOT, { machineId }))
        .resolves.toMatchObject({ protocolVersion: 1, snapshot: { machineId, targets: [] } });
      const invocation = { localActionContext: { surface: 'agent' as const, authority: 'account_automation' as const,
        actionRequestId: 'service-policy-request' } };
      await expect(rpc.invokeLocal(RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_START,
        { machineId, targetId: 'unavailable-declaration' }, invocation))
        .resolves.toMatchObject({ ok: false, errorCode: 'approval_rejected' });
      await expect(rpc.invokeLocal(RPC_METHODS.DAEMON_LOCAL_SERVICES_ACTIONS_EXECUTE, {
        requestId: 'request_1', target: { kind: 'inventory_entry', inventoryEntryId: 'entry_1', machineId },
        action: 'copy_url', force: false,
      }, invocation)).resolves.toMatchObject({ protocolVersion: 1,
        result: { requestId: 'request_1', status: 'denied', reasonCode: 'unknown_inventory_entry' } });
      expect((await runtime.launcherRoutes.getSnapshot()).targets).toEqual([]);
    } finally { await runtime.stop(); }
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
