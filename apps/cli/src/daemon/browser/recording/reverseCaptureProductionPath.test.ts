import {
  UiBrowserRecordingCaptureFrameRequestV1Schema,
  UiBrowserRecordingCaptureFrameResponseV1Schema,
  type UiBrowserRecordingCaptureFrameRequestV1,
  type UiBrowserRecordingCaptureFrameResponseV1,
} from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';
import { ApiMachineClient } from '@/api/apiMachine';
import type { RpcHandler, RpcHandlerContext } from '@/api/rpc/types';
import { registerDaemonBrowserRecordingHandlers } from '@/rpc/handlers/daemonBrowserRecording';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { createDesktopReverseBrowserRecordingCaptureUiCall } from './reverseChannel/desktopReverseCaptureUiCall';

import { createBrowserRecordingNativeViewCaptureCommand } from './adapters/nativeViewCommand';
import { createDesktopBrowserRecordingNativeViewCaptureTransport } from './adapters/nativeViewTransport';
import {
  createReverseDesktopBrowserRecordingNativeViewCaptureInvoke,
  type ReverseDesktopBrowserRecordingCaptureUiCall,
} from './adapters/reverseCaptureInvoke';
import { createBrowserRecordingDaemonRuntime } from './runtime';

/**
 * PRODUCTION-PATH CROSS-BOUNDARY ACCEPTANCE (W2C-BA-1) — the desktop reverse capture channel.
 *
 * Proves the FULL desktop recording chain crosses the cross-process daemon->UI reverse RPC boundary:
 *   daemon recording producer -> nativeViewTransport (daemon-owned outputPath) ->
 *   reverse invoke -> callUi (the daemon<->UI session RPC seam) -> UI handler ->
 *   `desktop_browser_capture_recording_frame` -> reference-only frame.
 *
 * The boundary is exercised through the SHARED protocol contract: the daemon serializes a
 * `UiBrowserRecordingCaptureFrameRequestV1` and the UI half (here, a native-faked stand-in for
 * `captureDesktopBrowserRecordingFrame`) answers a `UiBrowserRecordingCaptureFrameResponseV1`. With
 * the reverse channel bound, a desktop-view recording reaches a LIVE producer (never
 * `browser_recording_capture_adapter_missing`); with no UI reachable it stays honestly fail-closed.
 */

const WORKING_DIRECTORY = '/tmp/happier-native-view-reverse-production-path';

/**
 * Stand-in for the UI process running `captureDesktopBrowserRecordingFrame` against the A2-registered
 * Tauri command. It validates the request the daemon sent against the SHARED contract, then answers a
 * contract-valid reference-only response (no inline pixel bytes), exactly as the real UI handler does.
 */
function uiCallThatRunsCaptureDesktopBrowserRecordingFrame(
  nativeCapture: (request: {
    outputPath: string;
  }) => Promise<UiBrowserRecordingCaptureFrameResponseV1['result']>,
) {
  return async (request: UiBrowserRecordingCaptureFrameRequestV1) => {
    // The daemon serialized a contract-valid request across the boundary.
    UiBrowserRecordingCaptureFrameRequestV1Schema.parse(request);
    const result = await nativeCapture({ outputPath: request.outputPath });
    return UiBrowserRecordingCaptureFrameResponseV1Schema.parse({ protocolVersion: 1, result });
  };
}

function buildRuntime(
  callUi: ReverseDesktopBrowserRecordingCaptureUiCall,
  options: Readonly<{ captureSourceAvailable?: boolean }> = {},
) {
  const transport = createDesktopBrowserRecordingNativeViewCaptureTransport({
    randomId: () => 'capture_1',
    deleteFile: async () => undefined,
    invokeRecordingFrameCapture: createReverseDesktopBrowserRecordingNativeViewCaptureInvoke({ callUi }),
  });
  return createBrowserRecordingDaemonRuntime({
    workingDirectory: WORKING_DIRECTORY,
    resolveSessionMediaTarget: () => ({ sessionId: 'session_native', messageLocalId: 'message_native' }),
    resolveStartContext: async () => ({
      browserRecordingEnabled: true,
      recordingCapabilities: {
        enabled: true,
        attachmentsEnabled: true,
        available: true,
        supportedCaptureKinds: ['nativeViewCapture'],
        supportedMimeTypes: ['image/png'],
        supportedAdapterKinds: ['externalUrl'],
        maxFps: 12,
        audioSupported: false,
        cursorOverlaySupported: false,
        actionTimelineChaptersSupported: false,
        supportedRetentionClasses: ['preSend'],
        disabledReasons: [],
        policyDeniedReasons: [],
      },
      ...(options.captureSourceAvailable ? { captureSourceAvailable: true } : {}),
    }),
    nativeViewCapture: {
      isPlatformCaptureSupported: () => true,
      captureCommand: createBrowserRecordingNativeViewCaptureCommand({ transport }),
    },
  });
}

function startInput() {
  return {
    browserSessionId: 'browser_session_1',
    viewId: 'view_1',
    profileId: 'profile_1',
    targetKind: 'externalUrl' as const,
    adapterKind: 'externalUrl' as const,
    renderEngineKind: 'desktopWebView' as const,
    captureKind: 'nativeViewCapture' as const,
    fidelity: 'nativeCallback' as const,
    navigationGeneration: 1,
    mimeType: 'image/png',
    retentionClass: 'preSend' as const,
    mediaTarget: { sessionId: 'session_native', messageLocalId: 'message_native' },
  };
}

describe('nativeViewCapture reverse channel production path (W2C-BA-1)', () => {
  it('records a desktop view through the daemon->UI reverse RPC to a reference-only artifact (not adapter_missing)', async () => {
    const nativeCapture = vi.fn(async ({ outputPath }: { outputPath: string }) => ({
      ok: true as const,
      frame: { mimeType: 'image/png', width: 800, height: 600, sizeBytes: 4_096, path: outputPath },
    }));
    const callUi = vi.fn(uiCallThatRunsCaptureDesktopBrowserRecordingFrame(nativeCapture));
    const runtime = buildRuntime(callUi, { captureSourceAvailable: true });
    try {
      const started = await runtime.routes.startRecording(startInput());
      expect(started.status).toBe('started');
      // The reverse channel crosses to the UI half once with no cap operand.
      expect(callUi).toHaveBeenCalledTimes(1);
      expect(nativeCapture).toHaveBeenCalledTimes(1);
      expect(callUi.mock.calls[0]?.[0]).not.toHaveProperty('maxBytes');
      const outputPath = callUi.mock.calls[0]?.[0].outputPath;
      expect(outputPath).toMatch(/^browser_recording_.+\.capture_1\.native-view\.png$/);
      expect(outputPath).not.toMatch(/^[/\\]|^[A-Za-z]:[\\/]/);
    } finally {
      await runtime.stop();
    }
  });

  it('allows the owning Account and refuses an unrelated or unattributed Account before sending a frame RPC', async () => {
    const machineId = 'test-machine';
    const token = `h.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.s`;
    const client = new ApiMachineClient(token, {
      id: machineId, encryptionMode: 'plain', metadata: null, metadataVersion: 0,
      daemonState: null, daemonStateVersion: 0,
    });
    const capture = vi.fn(uiCallThatRunsCaptureDesktopBrowserRecordingFrame(async ({ outputPath }) => ({
      ok: true, frame: { mimeType: 'image/png', width: 8, height: 6, sizeBytes: 32, path: outputPath },
    })));
    Reflect.set(client, 'socket', createApiSessionSocketStub({
      connected: true,
      emitWithAck: async (_event, payload) => ({
        ok: true,
        result: await capture(UiBrowserRecordingCaptureFrameRequestV1Schema.parse(
          (payload as { params: unknown }).params,
        )),
      }),
    }));
    const runtime = buildRuntime(createDesktopReverseBrowserRecordingCaptureUiCall({
      getMachineClient: () => client,
    }), { captureSourceAvailable: true });
    const handlers = new Map<string, RpcHandler>();
    registerDaemonBrowserRecordingHandlers({
      registerHandler: (method, handler) => { handlers.set(method, handler); },
    }, { browserRecording: runtime.routes });
    const signal = new AbortController().signal;
    const admission = (actorAccountId: string): RpcHandlerContext => ({
      signal,
      machineAdmission: { actorAccountId, custodianAccountId: 'owner', machineId,
        installationId: 'test-installation', role: 'manage', encryptionMode: 'plain' },
    });
    const start = (viewId: string, context: RpcHandlerContext) =>
      handlers.get(RPC_METHODS.DAEMON_BROWSER_RECORDING_START)!({
        protocolVersion: 1, machineId, input: { ...startInput(), viewId },
      }, context);
    try {
      await expect(start('owner_view', admission('owner'))).resolves.toMatchObject({ result: { status: 'started' } });
      expect(capture).toHaveBeenCalledTimes(1);

      const unavailable = { result: { status: 'unavailable', reason: { code: 'RPC_CLIENT_NOT_AVAILABLE' } } };
      await expect.soft(start('member_view', admission('member'))).resolves.toMatchObject(unavailable);
      await expect.soft(start('unattributed_view', { signal })).resolves.toMatchObject(unavailable);
      expect(capture).toHaveBeenCalledTimes(1);
    } finally {
      await runtime.stop();
    }
  });

  it('fails closed before reverse invocation when no desktop UI handler source truth is registered', async () => {
    const callUi = vi.fn(async () => {
      throw new Error('no desktop UI connected');
    });
    const runtime = buildRuntime(callUi);
    try {
      await expect(runtime.routes.startRecording(startInput())).resolves.toMatchObject({
        status: 'unavailable',
        reason: { code: 'browser_recording_capture_unavailable' },
      });
      expect(callUi).not.toHaveBeenCalled();
    } finally {
      await runtime.stop();
    }
  });

  it('starts a valid reverse capture beyond the former byte default', async () => {
    const callUi = uiCallThatRunsCaptureDesktopBrowserRecordingFrame(async ({ outputPath }) => ({
      ok: true as const,
      frame: { mimeType: 'image/png', width: 4_000, height: 4_000, sizeBytes: 32_000_000, path: outputPath },
    }));
    const runtime = buildRuntime(callUi, { captureSourceAvailable: true });
    try {
      await expect(runtime.routes.startRecording(startInput())).resolves.toMatchObject({
        status: 'started',
      });
    } finally {
      await runtime.stop();
    }
  });
});
