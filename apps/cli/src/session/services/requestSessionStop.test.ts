import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';

const {
  fetchSessionByIdCompatMock,
  isPidSafeHappySessionProcessMock,
  listSessionMarkersMock,
  removeSessionMarkerMock,
  resolveSessionIdOrPrefixMock,
  stopDaemonSessionMock,
  waitForTrackedRunnerProcessesExitMock,
  disposeTerminalHostMock,
  updateSessionMetadataWithRetryMock,
  persistedMetadata,
} = vi.hoisted(() => ({
  fetchSessionByIdCompatMock: vi.fn(),
  isPidSafeHappySessionProcessMock: vi.fn(),
  listSessionMarkersMock: vi.fn(),
  removeSessionMarkerMock: vi.fn(),
  resolveSessionIdOrPrefixMock: vi.fn(),
  stopDaemonSessionMock: vi.fn(),
  waitForTrackedRunnerProcessesExitMock: vi.fn(),
  disposeTerminalHostMock: vi.fn(async () => undefined),
  updateSessionMetadataWithRetryMock: vi.fn(),
  persistedMetadata: { current: {} as Record<string, unknown> },
}));

vi.mock('@/daemon/controlClient', () => ({
  stopDaemonSession: stopDaemonSessionMock,
}));

vi.mock('@/daemon/pidSafety', () => ({
  isPidSafeHappySessionProcess: isPidSafeHappySessionProcessMock,
}));

vi.mock('@/daemon/sessionRegistry', () => ({
  listSessionMarkers: listSessionMarkersMock,
  removeSessionMarker: removeSessionMarkerMock,
}));

vi.mock('@/session/query/resolveSessionId', () => ({
  resolveSessionIdOrPrefix: resolveSessionIdOrPrefixMock,
}));

vi.mock('@/session/transport/http/sessionsHttp', () => ({
  fetchSessionByIdCompat: fetchSessionByIdCompatMock,
}));

vi.mock('@/daemon/sessions/waitForTrackedRunnerProcessesExit', () => ({
  waitForTrackedRunnerProcessesExit: waitForTrackedRunnerProcessesExitMock,
}));

vi.mock('@/integrations/terminal/host/defaultAdapters', () => ({
  createDefaultTerminalHostAdapterInventory: vi.fn(async () => ({
    adapters: {
      zellij: { kind: 'zellij', dispose: disposeTerminalHostMock },
      windows_console: { kind: 'windows_console', dispose: disposeTerminalHostMock },
    },
  })),
}));

vi.mock('@/session/metadata/updateSessionMetadataWithRetry', () => ({
  updateSessionMetadataWithRetry: updateSessionMetadataWithRetryMock,
}));

describe('requestSessionStop', () => {
  let happyHomeDir = '';
  const previousHappyHomeDir = process.env.HAPPIER_HOME_DIR;

  beforeEach(async () => {
    vi.resetModules();
    happyHomeDir = await createTempDir('happier-request-session-stop-');
    process.env.HAPPIER_HOME_DIR = happyHomeDir;

    fetchSessionByIdCompatMock.mockReset();
    isPidSafeHappySessionProcessMock.mockReset();
    listSessionMarkersMock.mockReset();
    removeSessionMarkerMock.mockReset();
    resolveSessionIdOrPrefixMock.mockReset();
    stopDaemonSessionMock.mockReset();
    waitForTrackedRunnerProcessesExitMock.mockReset();
    waitForTrackedRunnerProcessesExitMock.mockResolvedValue(false);
    disposeTerminalHostMock.mockClear();
    persistedMetadata.current = {};
    updateSessionMetadataWithRetryMock.mockReset();
    updateSessionMetadataWithRetryMock.mockImplementation(async ({ updater }: {
      updater: (metadata: Record<string, unknown>) => Record<string, unknown>;
    }) => {
      persistedMetadata.current = updater(persistedMetadata.current);
      return { version: 2, metadata: persistedMetadata.current };
    });
  });

  afterEach(async () => {
    if (previousHappyHomeDir === undefined) delete process.env.HAPPIER_HOME_DIR;
    else process.env.HAPPIER_HOME_DIR = previousHappyHomeDir;

    if (happyHomeDir) {
      await removeTempDir(happyHomeDir);
      happyHomeDir = '';
    }
    vi.restoreAllMocks();
  });

  it('keeps marker PID reuse diagnostics out of stdout when stopping from a JSON command path', async () => {
    const sessionId = 'sess_marker_pid_reuse';
    const markerPid = 12345;
    resolveSessionIdOrPrefixMock.mockResolvedValue({ ok: true, sessionId });
    stopDaemonSessionMock.mockResolvedValue({ status: 'not_found' });
    listSessionMarkersMock.mockResolvedValue([
      {
        pid: markerPid,
        happySessionId: sessionId,
        happyHomeDir,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        startedBy: 'terminal',
        processCommandHash: 'a'.repeat(64),
        respawn: {
          version: 1,
          directory: '/tmp/project',
          terminal: { mode: 'plain' },
        },
      },
    ]);
    isPidSafeHappySessionProcessMock.mockResolvedValue(false);
    fetchSessionByIdCompatMock.mockResolvedValue({ id: sessionId, active: false });

    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();
    const { requestSessionStop } = await import('./requestSessionStop');

    const result = await requestSessionStop({
      credentials: { token: 'token_test', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) } },
      idOrPrefix: sessionId,
    });

    expect(result).toEqual({ ok: true, sessionId, stopped: false });
    expect(isPidSafeHappySessionProcessMock).toHaveBeenCalledWith({
      pid: markerPid,
      expectedProcessCommandHash: 'a'.repeat(64),
    });
    expect(consoleLogSpy).not.toHaveBeenCalled();
  }, 120_000);

  it('does not start marker fallback when daemon stop completion is transport-ambiguous', async () => {
    const sessionId = 'sess_ambiguous_daemon_stop';
    resolveSessionIdOrPrefixMock.mockResolvedValue({ ok: true, sessionId });
    stopDaemonSessionMock.mockRejectedValue(new Error('local control timeout'));
    listSessionMarkersMock.mockResolvedValue([{ pid: 12346, happySessionId: sessionId, startedBy: 'terminal' }]);
    fetchSessionByIdCompatMock.mockResolvedValue({ id: sessionId, active: false });

    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();
    const { requestSessionStop } = await import('./requestSessionStop');

    await expect(requestSessionStop({
      credentials: { token: 'token_test', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) } },
      idOrPrefix: sessionId,
    })).resolves.toEqual({ ok: true, sessionId, stopped: false });

    expect(isPidSafeHappySessionProcessMock).not.toHaveBeenCalled();
  });

  async function configureExactTransportAmbiguousHost(input: Readonly<{
    sessionId: string;
    attachmentId: string;
  }>): Promise<void> {
    resolveSessionIdOrPrefixMock.mockResolvedValue({ ok: true, sessionId: input.sessionId });
    stopDaemonSessionMock.mockRejectedValue(new Error('local control timeout'));
    waitForTrackedRunnerProcessesExitMock.mockResolvedValue(true);
    isPidSafeHappySessionProcessMock.mockResolvedValue(true);
    vi.spyOn(process, 'kill').mockImplementation(() => true as never);
    listSessionMarkersMock.mockResolvedValue([{
      pid: 12350,
      happySessionId: input.sessionId,
      startedBy: 'daemon',
      processCommandHash: 'a'.repeat(64),
      respawn: {
        version: 1,
        directory: '/tmp/project',
        terminal: { mode: 'zellij' },
      },
    }]);
    fetchSessionByIdCompatMock.mockResolvedValue({
      id: input.sessionId,
      active: false,
      metadata: '{}',
      metadataVersion: 1,
      encryptionMode: 'plain',
      dataEncryptionKey: null,
    });
    const sessionsDir = join(happyHomeDir, 'terminal', 'sessions');
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(join(sessionsDir, `${input.sessionId}.host.json`), JSON.stringify({
      version: 2,
      attachmentId: input.attachmentId,
      sessionId: input.sessionId,
      handle: {
        attachmentId: input.attachmentId,
        kind: 'zellij',
        sessionName: 'preserved-host',
        paneId: 'terminal_1',
        socketDir: '/tmp/preserved-zellij',
        attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared', locality: 'same_machine', liveProbe: 'required' },
      },
      updatedAt: 1,
    }), 'utf8');
  }

  async function configureExactWindowsMarkerHost(input: Readonly<{
    sessionId: string;
    attachmentId: string;
    daemonResult: 'not_found' | 'transport_ambiguous';
  }>): Promise<void> {
    resolveSessionIdOrPrefixMock.mockResolvedValue({ ok: true, sessionId: input.sessionId });
    if (input.daemonResult === 'not_found') {
      stopDaemonSessionMock.mockResolvedValue({ status: 'not_found' });
    } else {
      stopDaemonSessionMock.mockRejectedValue(new Error('local control timeout'));
    }
    waitForTrackedRunnerProcessesExitMock.mockResolvedValue(true);
    listSessionMarkersMock.mockResolvedValue([{
      pid: 12351,
      happySessionId: input.sessionId,
      startedBy: 'daemon',
      processCommandHash: 'b'.repeat(64),
      metadata: {
        terminal: {
          mode: 'windows_console',
          requested: 'windows_terminal',
          fallbackReason: 'wt.exe unavailable',
          controlServiceabilityV1: {
            v: 1,
            attachmentId: input.attachmentId,
            state: 'recoverable_unservable',
            observedAt: 100,
          },
        },
      },
      respawn: {
        version: 1,
        directory: 'C:\\project',
        terminal: { mode: 'windows_terminal' },
        windowsRemoteSessionLaunchMode: 'windows_terminal',
      },
    }]);
    fetchSessionByIdCompatMock.mockResolvedValue({
      id: input.sessionId,
      active: false,
      metadata: '{}',
      metadataVersion: 1,
      encryptionMode: 'plain',
      dataEncryptionKey: null,
    });
    const sessionsDir = join(happyHomeDir, 'terminal', 'sessions');
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(join(sessionsDir, `${input.sessionId}.host.json`), JSON.stringify({
      version: 2,
      attachmentId: input.attachmentId,
      sessionId: input.sessionId,
      handle: {
        attachmentId: input.attachmentId,
        kind: 'windows_console',
        sessionName: 'preserved-windows-host',
        attachMetadata: { attachStrategy: 'terminal_host', topology: 'exclusive', locality: 'same_machine', liveProbe: 'required' },
      },
      updatedAt: 1,
    }), 'utf8');
  }

  it('retires matching serviceability when transport ambiguity falls back to an exact preserved host', async () => {
    const sessionId = 'sess_transport_exact';
    const attachmentId = 'attachment-transport-exact';
    await configureExactTransportAmbiguousHost({ sessionId, attachmentId });
    persistedMetadata.current = {
      terminal: {
        mode: 'zellij',
        controlServiceabilityV1: {
          v: 1,
          attachmentId,
          state: 'recoverable_unservable',
          observedAt: 100,
          reason: 'control_descriptor_missing',
        },
      },
    };
    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();
    const { requestSessionStop } = await import('./requestSessionStop');

    await expect(requestSessionStop({
      credentials: { token: 'token_test', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) } },
      idOrPrefix: sessionId,
    })).resolves.toEqual({ ok: true, sessionId, stopped: true });
    expect(disposeTerminalHostMock).toHaveBeenCalledTimes(1);
    expect(persistedMetadata.current).toMatchObject({
      terminal: {
        mode: 'zellij',
        controlServiceabilityV1: {
          attachmentId,
          state: 'unknown',
          reason: 'attachment_retired',
          retired: true,
        },
      },
    });
  });

  it.each(['not_found', 'transport_ambiguous'] as const)(
    'retires the marker-authored actual Windows mode through the %s fallback',
    async (daemonResult) => {
      const sessionId = `sess_windows_marker_${daemonResult}`;
      const attachmentId = `attachment-windows-marker-${daemonResult}`;
      await configureExactWindowsMarkerHost({ sessionId, attachmentId, daemonResult });
      const { reloadConfiguration } = await import('@/configuration');
      reloadConfiguration();
      const { requestSessionStop } = await import('./requestSessionStop');

      await expect(requestSessionStop({
        credentials: { token: 'token_test', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) } },
        idOrPrefix: sessionId,
      })).resolves.toEqual({ ok: true, sessionId, stopped: true });

      expect(disposeTerminalHostMock).toHaveBeenCalledTimes(1);
      expect(persistedMetadata.current).toMatchObject({
        terminal: {
          mode: 'windows_console',
          controlServiceabilityV1: {
            attachmentId,
            state: 'unknown',
            reason: 'attachment_retired',
            retired: true,
          },
        },
      });
    },
  );

  it('preserves replacement serviceability during transport-ambiguous exact marker fallback', async () => {
    const sessionId = 'sess_transport_replacement';
    await configureExactTransportAmbiguousHost({ sessionId, attachmentId: 'attachment-retired' });
    persistedMetadata.current = {
      terminal: {
        mode: 'zellij',
        controlServiceabilityV1: { v: 1, attachmentId: 'attachment-replacement', state: 'servable', observedAt: 200 },
      },
    };
    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();
    const { requestSessionStop } = await import('./requestSessionStop');

    await expect(requestSessionStop({
      credentials: { token: 'token_test', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) } },
      idOrPrefix: sessionId,
    })).resolves.toEqual({ ok: true, sessionId, stopped: true });
    expect(persistedMetadata.current).toMatchObject({
      terminal: { controlServiceabilityV1: { attachmentId: 'attachment-replacement', state: 'servable' } },
    });
  });

  it('does not let an ambiguous retry destroy an attachment installed after the daemon request began', async () => {
    const sessionId = 'sess_transport_replaced_during_request';
    const originalAttachmentId = 'attachment-before-daemon-stop';
    const replacementAttachmentId = 'attachment-after-daemon-stop';
    await configureExactTransportAmbiguousHost({ sessionId, attachmentId: originalAttachmentId });
    const descriptorPath = join(happyHomeDir, 'terminal', 'sessions', `${sessionId}.host.json`);
    stopDaemonSessionMock.mockImplementation(async () => {
      await writeFile(descriptorPath, JSON.stringify({
        version: 2,
        attachmentId: replacementAttachmentId,
        sessionId,
        handle: {
          attachmentId: replacementAttachmentId,
          kind: 'zellij',
          sessionName: 'replacement-host',
          paneId: 'terminal_2',
          socketDir: '/tmp/replacement-zellij',
          attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared', locality: 'same_machine', liveProbe: 'required' },
        },
        updatedAt: 2,
      }), 'utf8');
      throw new Error('local control timeout');
    });
    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();
    const { requestSessionStop } = await import('./requestSessionStop');

    await expect(requestSessionStop({
      credentials: { token: 'token_test', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) } },
      idOrPrefix: sessionId,
    })).resolves.toEqual({ ok: true, sessionId, stopped: false });
    expect(disposeTerminalHostMock).not.toHaveBeenCalled();
  });

  it('does not report full success when exact marker fallback cannot retire serviceability', async () => {
    const sessionId = 'sess_transport_retirement_failure';
    await configureExactTransportAmbiguousHost({ sessionId, attachmentId: 'attachment-retirement-failure' });
    updateSessionMetadataWithRetryMock.mockRejectedValueOnce(new Error('metadata persistence unavailable'));
    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();
    const { requestSessionStop } = await import('./requestSessionStop');

    await expect(requestSessionStop({
      credentials: { token: 'token_test', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) } },
      idOrPrefix: sessionId,
    })).resolves.toEqual({ ok: true, sessionId, stopped: false });
    expect(disposeTerminalHostMock).toHaveBeenCalledTimes(1);
  });

  it('does not let inactive metadata manufacture success from an incomplete daemon result', async () => {
    const sessionId = 'sess_incomplete_daemon_stop';
    resolveSessionIdOrPrefixMock.mockResolvedValue({ ok: true, sessionId });
    stopDaemonSessionMock.mockResolvedValue({ status: 'incomplete', reason: 'runner_exit_timeout' });
    listSessionMarkersMock.mockResolvedValue([{ pid: 12347, happySessionId: sessionId, startedBy: 'terminal' }]);
    fetchSessionByIdCompatMock.mockResolvedValue({ id: sessionId, active: false });

    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();
    const { requestSessionStop } = await import('./requestSessionStop');

    await expect(requestSessionStop({
      credentials: { token: 'token_test', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) } },
      idOrPrefix: sessionId,
    })).resolves.toEqual({ ok: true, sessionId, stopped: false });

    expect(isPidSafeHappySessionProcessMock).not.toHaveBeenCalled();
    expect(fetchSessionByIdCompatMock).not.toHaveBeenCalled();
  });

  it('fails closed when a terminal-bearing marker has a corrupt host attachment descriptor', async () => {
    const sessionId = 'sess_corrupt_marker_host';
    resolveSessionIdOrPrefixMock.mockResolvedValue({ ok: true, sessionId });
    stopDaemonSessionMock.mockResolvedValue({ status: 'not_found' });
    listSessionMarkersMock.mockResolvedValue([{
      pid: 12348,
      happySessionId: sessionId,
      startedBy: 'terminal',
      processCommandHash: 'a'.repeat(64),
      respawn: {
        version: 1,
        directory: '/tmp/project',
        terminal: { mode: 'tmux', tmux: { sessionName: 'owned-host' } },
      },
    }]);
    const sessionsDir = join(happyHomeDir, 'terminal', 'sessions');
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(join(sessionsDir, `${sessionId}.host.json`), 'not-json', 'utf8');

    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();
    const { requestSessionStop } = await import('./requestSessionStop');
    await expect(requestSessionStop({
      credentials: { token: 'token_test', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) } },
      idOrPrefix: sessionId,
    })).resolves.toEqual({ ok: true, sessionId, stopped: false });

    expect(removeSessionMarkerMock).not.toHaveBeenCalled();
    expect(fetchSessionByIdCompatMock).not.toHaveBeenCalled();
  });

  it('fails closed when a terminal-bearing marker survives but its host descriptor is absent', async () => {
    const sessionId = 'sess_missing_marker_host';
    resolveSessionIdOrPrefixMock.mockResolvedValue({ ok: true, sessionId });
    stopDaemonSessionMock.mockResolvedValue({ status: 'not_found' });
    listSessionMarkersMock.mockResolvedValue([{
      pid: 12349,
      happySessionId: sessionId,
      startedBy: 'terminal',
      processCommandHash: 'a'.repeat(64),
      respawn: {
        version: 1,
        directory: '/tmp/project',
        terminal: { mode: 'zellij' },
      },
    }]);

    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();
    const { requestSessionStop } = await import('./requestSessionStop');
    await expect(requestSessionStop({
      credentials: { token: 'token_test', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) } },
      idOrPrefix: sessionId,
    })).resolves.toEqual({ ok: true, sessionId, stopped: false });

    expect(removeSessionMarkerMock).not.toHaveBeenCalled();
    expect(fetchSessionByIdCompatMock).not.toHaveBeenCalled();
  });
});
