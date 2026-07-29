import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { BrowserRecordingCapabilities, RuntimeActionExecuteArgs } from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import { createBrowserRecordingDaemonRuntime } from '../recording/runtime';
import { createBrowserRecordingActionRoutes } from '../recording/actionRoutes';
import { createBrowserRecordingNativeViewCaptureCommand } from '../recording/adapters/nativeViewCommand';
import { createBrowserRecordingAttachToComposer } from '../recording/attachToComposer';
import { createBrowserAutomationDaemonService } from '../automation/service';
import { createBrowserAutomationRoutes } from '../automation/routes';
import type { BrowserAutomationAdapter } from '../automation/adapters/types';
import type { BrowserDaemonFeatureGate } from '../featureGate';
import { createBrowserDaemonRuntimeActionExecutor } from './runtimeActionExecutor';

/**
 * BA-8 — agent browser loop end-to-end ACROSS THE ASSEMBLED EXECUTOR (not a mock). The agent path
 * drives `createBrowserDaemonRuntimeActionExecutor` over REAL daemon route owners — the real
 * automation service + adapter, the real recording runtime with the BA-4 `nativeViewCapture`
 * producer, and a real session-media writer. Only the CDP/native capture transports are faked at the
 * Chromium/Wry boundary. The loop: snapshot (semantic state) → recording start → stop produces
 * DURABLE session-media → artifact is attachable to the composer (reference-only). This is the
 * cross-boundary contract the §0 completion rule requires — a mocked-boundary unit test would NOT
 * catch a seam-without-wiring regression here.
 */

const recordingCapabilities = {
  enabled: true,
  attachmentsEnabled: true,
  available: true,
  supportedCaptureKinds: ['nativeViewCapture'],
  supportedMimeTypes: ['image/png'],
  supportedAdapterKinds: ['externalUrl'],
  maxDurationMs: 30_000,
  maxBytes: 16_000_000,
  maxFps: 12,
  audioSupported: false,
  cursorOverlaySupported: false,
  actionTimelineChaptersSupported: false,
  supportedRetentionClasses: ['preSend'],
  disabledReasons: [],
  policyDeniedReasons: [],
} satisfies BrowserRecordingCapabilities;

const allowAllBrowserGate = {
  isEnabled: () => true,
  refresh: async () => {},
} satisfies BrowserDaemonFeatureGate;

function runtimeArgs(args: Omit<RuntimeActionExecuteArgs, 'context'>): RuntimeActionExecuteArgs {
  return { context: { surface: 'agent' }, ...args } as RuntimeActionExecuteArgs;
}

function semanticSnapshotAdapter(): BrowserAutomationAdapter {
  return {
    adapterKind: 'chromiumSidecar',
    supportedOperations: new Set(['snapshot', 'semanticSnapshot', 'navigate']),
    execute: vi.fn(async () => ({
      status: 'succeeded' as const,
      fidelity: 'cdp' as const,
      trustedInput: true,
      resultSummary: {
        interactiveElements: [{ role: 'button', name: 'Submit', selector: 'role=button[name="Submit"]' }],
      },
    })),
  };
}

describe('BA-8 agent browser loop across the assembled executor', () => {
  it('snapshot → record (nativeViewCapture) → durable media → attach, all through the real executor', async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-ba8-agent-loop-'));
    const captureDirectory = await mkdtemp(join(tmpdir(), 'happier-ba8-agent-loop-capture-'));

    try {
      await mkdir(join(workingDirectory, '.git', 'info'), { recursive: true });
      const pngBytes = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.from('ba8-agent-loop-frame', 'utf8'),
      ]);
      const capturePath = join(captureDirectory, 'agent-loop-frame.png');

      // Real native-view capture command driven by a fake desktop-host transport (the daemon->native
      // IPC boundary), exactly the contract the `desktop_browser_capture_recording_frame` Tauri
      // command satisfies.
      const captureCommand = createBrowserRecordingNativeViewCaptureCommand({
        transport: {
          captureFrame: vi.fn(async () => {
            await writeFile(capturePath, pngBytes);
            return {
              ok: true as const,
              path: capturePath,
              mimeType: 'image/png',
              byteSize: pngBytes.byteLength,
              width: 1280,
              height: 720,
              cleanup: async () => {
                await rm(capturePath, { force: true });
              },
            };
          }),
        },
      });

      const recordingRuntime = createBrowserRecordingDaemonRuntime({
        workingDirectory,
        nativeViewCapture: { isPlatformCaptureSupported: () => true, captureCommand },
        resolveSessionMediaTarget: () => ({ sessionId: 'session_ba8', messageLocalId: 'message_ba8' }),
        resolveStartContext: () => ({
          browserRecordingEnabled: true,
          recordingCapabilities,
          captureSourceAvailable: true,
        }),
        now: () => 30_000,
      });

      const automationService = createBrowserAutomationDaemonService({ adapter: semanticSnapshotAdapter() });

      // The attach half: the REAL attach owner crosses the recording runtime to resolve the
      // finalized recording's stored mediaRef and routes it (reference-only — never raw bytes) to
      // the composer attach boundary. The boundary publish is the only fake.
      let attachedMediaId: string | null = null;
      const attachToComposerBoundary = vi.fn(async (boundaryInput: { mediaRef: { mediaId: string }; recording: { mediaRef?: unknown } }) => {
        attachedMediaId = boundaryInput.mediaRef.mediaId;
        return { ok: true as const, attachmentId: `attachment_${boundaryInput.mediaRef.mediaId}` };
      });
      const recordingAttach = createBrowserRecordingAttachToComposer({
        routes: recordingRuntime.routes,
        attachToComposer: attachToComposerBoundary,
      });

      const execute = createBrowserDaemonRuntimeActionExecutor({
        automation: createBrowserAutomationRoutes({ service: automationService }),
        recording: createBrowserRecordingActionRoutes({ routes: recordingRuntime.routes }),
        recordingAttach,
        featureGate: allowAllBrowserGate,
      });

      try {
        // 1) Agent snapshot returns semantic state through the real automation service + adapter.
        const snapshot = await execute(runtimeArgs({
          actionId: 'browser.automation.semanticSnapshot',
          input: {
            v: 1,
            automationRequestId: 'req_snapshot_1',
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            navigationGeneration: 1,
            requestedBy: 'agent',
            requesterRef: { kind: 'agent', id: 'agent_1' },
            actionKind: 'semanticSnapshot',
            payload: {},
            timeoutMs: 5_000,
          },
        })) as { status?: string; resultSummary?: { interactiveElements?: unknown[] } };
        expect(snapshot.status).toBe('succeeded');
        expect(snapshot.resultSummary?.interactiveElements).toHaveLength(1);

        // 2) Recording start through the real recording route owner (nativeViewCapture producer).
        const started = await execute(runtimeArgs({
          actionId: 'browser.recording.start',
          input: {
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            profileId: 'profile_1',
            targetKind: 'streamedBrowser',
            adapterKind: 'externalUrl',
            renderEngineKind: 'desktopWebView',
            captureKind: 'nativeViewCapture',
            fidelity: 'nativeCallback',
            navigationGeneration: 1,
            mimeType: 'image/png',
            retentionClass: 'preSend',
            mediaTarget: { sessionId: 'session_ba8', messageLocalId: 'message_ba8' },
          },
        })) as { status?: string; recording?: { recordingId?: string } };
        expect(started.status).toBe('started');
        const recordingId = started.recording?.recordingId;
        expect(recordingId).toBeTruthy();
        if (!recordingId) return;

        // 3) Recording stop produces durable session-media (NOT adapter_missing).
        const stopped = await execute(runtimeArgs({
          actionId: 'browser.recording.stop',
          input: { recordingId, navigationGenerationEnd: 2 },
        })) as { status?: string; recording?: { mediaRef?: { mediaId: string; mimeType: string; sizeBytes: number } } };
        expect(stopped.status).toBe('finalized');
        const mediaRef = stopped.recording?.mediaRef;
        expect(mediaRef).toMatchObject({ mimeType: 'image/png', sizeBytes: pngBytes.byteLength });
        if (!mediaRef) return;

        const persistedFile = resolve(
          workingDirectory,
          '.happier',
          'uploads',
          'artifacts',
          'session_ba8',
          'message_ba8',
          `${mediaRef.mediaId.slice(0, 12)}-native-view-recording.png`,
        );
        await expect(readFile(persistedFile)).resolves.toEqual(pngBytes);

        // 4) The durable artifact attaches to the composer through the assembled executor.
        const attached = await execute(runtimeArgs({
          actionId: 'browser.recording.attachToComposer',
          input: { recordingId, sessionId: 'session_ba8' },
        })) as { ok?: boolean; attachmentId?: string };
        expect(attached.ok).toBe(true);
        expect(attached.attachmentId).toBe(`attachment_${mediaRef.mediaId}`);
        // Reference-only: the composer boundary received the media REFERENCE (mediaId), not bytes.
        expect(attachToComposerBoundary).toHaveBeenCalledOnce();
        expect(attachedMediaId).toBe(mediaRef.mediaId);
      } finally {
        recordingRuntime.stop();
      }
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
      await rm(captureDirectory, { recursive: true, force: true });
    }
  });
});
