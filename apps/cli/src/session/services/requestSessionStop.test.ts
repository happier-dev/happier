import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { reloadConfiguration } from '@/configuration';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';

const mocks = vi.hoisted(() => ({
  resolveSessionIdOrPrefix: vi.fn(),
  callMachineRpc: vi.fn(),
  stopDaemonSession: vi.fn(),
  listSessionMarkers: vi.fn(),
  removeSessionMarker: vi.fn(),
  fetchSessionByIdCompat: vi.fn(),
  waitForTrackedRunnerProcessesExit: vi.fn(),
  isPidSafeHappySessionProcess: vi.fn(),
  disposeTerminalHost: vi.fn(async () => undefined),
  updateSessionMetadataWithRetry: vi.fn(),
  persistedMetadata: {} as Record<string, unknown>,
}));

vi.mock('@/session/query/resolveSessionId', () => ({
  resolveSessionIdOrPrefix: mocks.resolveSessionIdOrPrefix,
}));

vi.mock('@/session/transport/rpc/machineRpc', () => ({
  callMachineRpc: mocks.callMachineRpc,
}));

vi.mock('@/daemon/controlClient', () => ({
  stopDaemonSession: mocks.stopDaemonSession,
}));

vi.mock('@/daemon/sessionRegistry', () => ({
  listSessionMarkers: mocks.listSessionMarkers,
  removeSessionMarker: mocks.removeSessionMarker,
}));

vi.mock('@/session/transport/http/sessionsHttp', () => ({
  fetchSessionByIdCompat: mocks.fetchSessionByIdCompat,
}));

vi.mock('@/daemon/sessions/waitForTrackedRunnerProcessesExit', () => ({
  waitForTrackedRunnerProcessesExit: mocks.waitForTrackedRunnerProcessesExit,
}));

vi.mock('@/session/metadata/updateSessionMetadataWithRetry', () => ({
  updateSessionMetadataWithRetry: mocks.updateSessionMetadataWithRetry,
}));

vi.mock('@/daemon/pidSafety', () => ({
  isPidSafeHappySessionProcess: mocks.isPidSafeHappySessionProcess,
}));

vi.mock('@/integrations/terminalHost/defaultRegistry', () => ({
  createDefaultTerminalHostRegistry: vi.fn(async () => ({
    zellij: {
      kind: 'zellij',
      createOrAttachHost: vi.fn(),
      injectUserPrompt: vi.fn(),
      interruptTurn: vi.fn(),
      evaluateLiveness: vi.fn(),
      dispose: mocks.disposeTerminalHost,
    },
  })),
}));

describe('requestSessionStop marker fallback', () => {
  let happyHomeDir = '';
  const previousHappyHomeDir = process.env.HAPPIER_HOME_DIR;
  const credentials = {
    token: 'token-1',
    encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    happyHomeDir = await createTempDir('happier-marker-stop-');
    process.env.HAPPIER_HOME_DIR = happyHomeDir;
    reloadConfiguration();
    mocks.resolveSessionIdOrPrefix.mockResolvedValue({
      ok: true,
      sessionId: 'sess-marker-stop',
      rawSession: { id: 'sess-marker-stop', active: false },
    });
    mocks.callMachineRpc.mockReset();
    mocks.stopDaemonSession.mockResolvedValue({ status: 'not_found' });
    mocks.listSessionMarkers.mockResolvedValue([{
      pid: 4242,
      happySessionId: 'sess-marker-stop',
      startedBy: 'daemon',
      processCommandHash: 'a'.repeat(64),
      respawn: {
        version: 1,
        directory: '/tmp/project',
        terminal: { mode: 'plain' },
      },
    }]);
    mocks.isPidSafeHappySessionProcess.mockResolvedValue(true);
    mocks.waitForTrackedRunnerProcessesExit.mockResolvedValue(true);
    mocks.fetchSessionByIdCompat.mockResolvedValue({ id: 'sess-marker-stop', active: false });
    mocks.removeSessionMarker.mockResolvedValue(undefined);
    mocks.persistedMetadata = {};
    mocks.updateSessionMetadataWithRetry.mockImplementation(async ({ updater }: {
      updater: (metadata: Record<string, unknown>) => Record<string, unknown>;
    }) => {
      mocks.persistedMetadata = updater(mocks.persistedMetadata);
      return { version: 2, metadata: mocks.persistedMetadata };
    });
    vi.spyOn(process, 'kill').mockImplementation(() => true as never);
  });

  it('returns an identity-resolution failure before attempting any physical stop', async () => {
    mocks.resolveSessionIdOrPrefix.mockResolvedValue({
      ok: false,
      code: 'session_id_ambiguous',
      candidates: ['sess-a', 'sess-b'],
    });

    const { requestSessionStop } = await import('./requestSessionStop');
    await expect(requestSessionStop({ credentials, idOrPrefix: 'sess' })).resolves.toEqual({
      ok: false,
      code: 'session_id_ambiguous',
      candidates: ['sess-a', 'sess-b'],
    });

    expect(mocks.callMachineRpc).not.toHaveBeenCalled();
    expect(mocks.stopDaemonSession).not.toHaveBeenCalled();
    expect(mocks.listSessionMarkers).not.toHaveBeenCalled();
  });

  it('routes a stop only to the exact machine recorded by the session', async () => {
    mocks.resolveSessionIdOrPrefix.mockResolvedValue({
      ok: true,
      sessionId: 'sess-marker-stop',
      rawSession: {
        id: 'sess-marker-stop',
        active: true,
        machineId: 'machine-owning-session',
      },
    });
    mocks.fetchSessionByIdCompat.mockResolvedValue({
      id: 'sess-marker-stop',
      active: false,
      machineId: 'machine-owning-session',
    });
    mocks.callMachineRpc.mockResolvedValue({ status: 'stopped' });

    const { requestSessionStop } = await import('./requestSessionStop');

    await expect(requestSessionStop({ credentials, idOrPrefix: 'sess-marker-stop' })).resolves.toEqual({
      ok: true,
      sessionId: 'sess-marker-stop',
      stopped: true,
    });
    expect(mocks.callMachineRpc).toHaveBeenCalledOnce();
    expect(mocks.callMachineRpc).toHaveBeenCalledWith({
      credentials,
      machineId: 'machine-owning-session',
      method: 'stop-session',
      request: { sessionId: 'sess-marker-stop' },
      authorization: { kind: 'session.write', sessionId: 'sess-marker-stop' },
    });
    expect(mocks.stopDaemonSession).not.toHaveBeenCalled();
    expect(mocks.listSessionMarkers).not.toHaveBeenCalled();
  });

  it('reports the exact target daemon as unavailable without trying caller-local control', async () => {
    mocks.resolveSessionIdOrPrefix.mockResolvedValue({
      ok: true,
      sessionId: 'sess-marker-stop',
      rawSession: {
        id: 'sess-marker-stop',
        active: true,
        machineId: 'machine-owning-session',
      },
    });
    mocks.fetchSessionByIdCompat.mockResolvedValue({
      id: 'sess-marker-stop',
      active: true,
      machineId: 'machine-owning-session',
    });
    mocks.callMachineRpc.mockRejectedValue(new Error('Machine RPC target unavailable'));

    const { requestSessionStop } = await import('./requestSessionStop');

    await expect(requestSessionStop({ credentials, idOrPrefix: 'sess-marker-stop' })).resolves.toEqual({
      ok: true,
      sessionId: 'sess-marker-stop',
      stopped: false,
      stopOutcome: {
        status: 'physical_stop_unconfirmed',
        reason: 'target_daemon_unavailable',
      },
    });
    expect(mocks.stopDaemonSession).not.toHaveBeenCalled();
    expect(mocks.listSessionMarkers).not.toHaveBeenCalled();
  });

  it('reports an exact machine authorization refusal instead of calling the daemon unavailable', async () => {
    mocks.resolveSessionIdOrPrefix.mockResolvedValue({
      ok: true,
      sessionId: 'sess-marker-stop',
      rawSession: {
        id: 'sess-marker-stop',
        active: true,
        machineId: 'machine-owning-session',
      },
    });
    mocks.fetchSessionByIdCompat.mockResolvedValue({
      id: 'sess-marker-stop',
      active: true,
      machineId: 'machine-owning-session',
    });
    mocks.callMachineRpc.mockResolvedValue({ error: 'Forbidden', errorCode: 'RPC_FORBIDDEN' });

    const { requestSessionStop } = await import('./requestSessionStop');

    await expect(requestSessionStop({ credentials, idOrPrefix: 'sess-marker-stop' })).resolves.toEqual({
      ok: true,
      sessionId: 'sess-marker-stop',
      stopped: false,
      stopOutcome: {
        status: 'physical_stop_unconfirmed',
        reason: 'target_daemon_forbidden',
      },
    });
  });

  it('reports an unsupported machine response separately from transport unavailability', async () => {
    mocks.resolveSessionIdOrPrefix.mockResolvedValue({
      ok: true,
      sessionId: 'sess-marker-stop',
      rawSession: {
        id: 'sess-marker-stop',
        active: true,
        machineId: 'machine-owning-session',
      },
    });
    mocks.fetchSessionByIdCompat.mockResolvedValue({
      id: 'sess-marker-stop',
      active: true,
      machineId: 'machine-owning-session',
    });
    mocks.callMachineRpc.mockResolvedValue({ status: 'newer_unknown_status' });

    const { requestSessionStop } = await import('./requestSessionStop');

    await expect(requestSessionStop({ credentials, idOrPrefix: 'sess-marker-stop' })).resolves.toEqual({
      ok: true,
      sessionId: 'sess-marker-stop',
      stopped: false,
      stopOutcome: {
        status: 'physical_stop_unconfirmed',
        reason: 'target_daemon_response_unsupported',
      },
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (previousHappyHomeDir === undefined) delete process.env.HAPPIER_HOME_DIR;
    else process.env.HAPPIER_HOME_DIR = previousHappyHomeDir;
    reloadConfiguration();
    if (happyHomeDir) await removeTempDir(happyHomeDir);
    happyHomeDir = '';
  });

  it('observes exact marker PID exit before treating the aggregate stop as complete', async () => {
    const { requestSessionStop } = await import('./requestSessionStop');

    await expect(requestSessionStop({ credentials, idOrPrefix: 'sess-marker-stop' })).resolves.toEqual({
      ok: true,
      sessionId: 'sess-marker-stop',
      stopped: true,
    });

    expect(mocks.waitForTrackedRunnerProcessesExit).toHaveBeenCalledWith({
      runners: [{ pid: 4242 }],
      timeoutMs: expect.any(Number),
      pollIntervalMs: expect.any(Number),
    });
  });

  it('distinguishes a proven physical stop when relay inactivity is not yet observed', async () => {
    const previousStopTimeoutMs = process.env.HAPPIER_SESSION_STOP_TIMEOUT_MS;
    const previousStopPollIntervalMs = process.env.HAPPIER_SESSION_STOP_POLL_INTERVAL_MS;
    process.env.HAPPIER_SESSION_STOP_TIMEOUT_MS = '1';
    process.env.HAPPIER_SESSION_STOP_POLL_INTERVAL_MS = '1';
    reloadConfiguration();
    mocks.stopDaemonSession.mockResolvedValue({ status: 'stopped' });
    mocks.fetchSessionByIdCompat.mockResolvedValue({ id: 'sess-marker-stop', active: true });

    try {
      const { requestSessionStop } = await import('./requestSessionStop');
      await expect(requestSessionStop({ credentials, idOrPrefix: 'sess-marker-stop' })).resolves.toEqual({
        ok: true,
        sessionId: 'sess-marker-stop',
        stopped: false,
        stopOutcome: {
          status: 'stopped_projection_unconfirmed',
          reason: 'relay_inactive_not_observed',
        },
      });
    } finally {
      if (previousStopTimeoutMs === undefined) delete process.env.HAPPIER_SESSION_STOP_TIMEOUT_MS;
      else process.env.HAPPIER_SESSION_STOP_TIMEOUT_MS = previousStopTimeoutMs;
      if (previousStopPollIntervalMs === undefined) delete process.env.HAPPIER_SESSION_STOP_POLL_INTERVAL_MS;
      else process.env.HAPPIER_SESSION_STOP_POLL_INTERVAL_MS = previousStopPollIntervalMs;
      reloadConfiguration();
    }
  });

  it('does not start marker fallback for a transport-ambiguous plain runner without exact attachment identity', async () => {
    mocks.stopDaemonSession.mockRejectedValue(new Error('local control timeout'));

    const { requestSessionStop } = await import('./requestSessionStop');
    await expect(requestSessionStop({ credentials, idOrPrefix: 'sess-marker-stop' })).resolves.toEqual({
      ok: true,
      sessionId: 'sess-marker-stop',
      stopped: false,
      stopOutcome: { status: 'physical_stop_unconfirmed', reason: 'transport_ambiguous' },
    });

    expect(mocks.waitForTrackedRunnerProcessesExit).not.toHaveBeenCalled();
  });

  it('does not report a post-ambiguity marker refusal with a pre-signal reason', async () => {
    // The tenth instance of the arm-guarantee class, at its producer.
    //
    // The marker fallback runs here only BECAUSE the daemon transport was
    // ambiguous — the daemon may have accepted and executed Stop and lost only
    // its answer, which is precisely why its markers are then gone or its
    // runner absent. Reporting the fallback's own refusal reason hands the
    // caller a `physical_stop_unconfirmed` reason from the set that proves
    // "nothing was signalled", and the Agent transition turns that into
    // `rejected('source_stop_failed')` with `sourceEffect: 'none'` — the UI
    // offers Keep editing in front of a runtime that is already dead.
    const attachmentId = 'attachment-ambiguous-then-gone';
    mocks.stopDaemonSession.mockRejectedValue(new Error('local control timeout'));
    // Markers are gone: the daemon that (may have) stopped the session removed
    // them. The fallback therefore answers `not_found`.
    mocks.listSessionMarkers.mockResolvedValue([]);
    const sessionsDir = join(happyHomeDir, 'terminal', 'sessions');
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(join(sessionsDir, 'sess-marker-stop.json'), JSON.stringify({
      version: 2,
      attachmentId,
      sessionId: 'sess-marker-stop',
      handle: {
        attachmentId,
        kind: 'zellij',
        sessionName: 'ambiguous-host',
        paneId: 'terminal_1',
        socketDir: '/tmp/ambiguous-zellij',
        attachMetadata: {
          attachStrategy: 'terminal_host',
          topology: 'shared',
          locality: 'same_machine',
          liveProbe: 'required',
        },
      },
      terminal: {
        mode: 'zellij',
        zellij: {
          sessionName: 'ambiguous-host',
          paneId: 'terminal_1',
          socketDirV1: '/tmp/ambiguous-zellij',
        },
      },
      updatedAt: 1,
    }), 'utf8');

    const { requestSessionStop } = await import('./requestSessionStop');
    const result = await requestSessionStop({ credentials, idOrPrefix: 'sess-marker-stop' });

    expect(result).toMatchObject({ ok: true, stopped: false });
    // The fallback really ran — otherwise this asserts nothing.
    expect(mocks.listSessionMarkers).toHaveBeenCalled();
    // The reason must not be one that a consumer may read as "nothing was
    // signalled".
    expect(result).not.toMatchObject({
      stopOutcome: { status: 'physical_stop_unconfirmed', reason: 'local_session_not_found' },
    });
    // The canonical Session row reports it inactive, so the honest answer is
    // better than the ambiguity: nothing is running and that is established.
    // This is the same carve-out the masking rule already makes for
    // `stopped_cleanup_incomplete` — an outcome that PROVES the host is gone
    // names a strictly more informative residue and is left as reported. The
    // masking rule itself is unchanged: it is expressed over the classified
    // status, not over the fallback's raw reason.
    expect(result).toMatchObject({
      stopOutcome: { status: 'already_stopped', reason: 'no_runtime_session_inactive' },
    });
  });

  it('reports post-ambiguity marker refusal as the ambiguity when liveness is not established', async () => {
    // Same path, one fact removed: the Session row still reports it running, so
    // the fallback's `not_found` proves nothing and the ambiguity that caused
    // the fallback is again the honest answer. This is the original input of the
    // case above and pins the masking rule that the confirmed arm must not
    // swallow.
    const attachmentId = 'attachment-ambiguous-still-live';
    mocks.stopDaemonSession.mockRejectedValue(new Error('local control timeout'));
    mocks.listSessionMarkers.mockResolvedValue([]);
    mocks.fetchSessionByIdCompat.mockResolvedValue({ id: 'sess-marker-stop', active: true });
    const sessionsDir = join(happyHomeDir, 'terminal', 'sessions');
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(join(sessionsDir, 'sess-marker-stop.json'), JSON.stringify({
      version: 2,
      attachmentId,
      sessionId: 'sess-marker-stop',
      handle: {
        attachmentId,
        kind: 'zellij',
        sessionName: 'ambiguous-host',
        paneId: 'terminal_1',
        socketDir: '/tmp/ambiguous-zellij',
        attachMetadata: {
          attachStrategy: 'terminal_host',
          topology: 'shared',
          locality: 'same_machine',
          liveProbe: 'required',
        },
      },
      terminal: {
        mode: 'zellij',
        zellij: {
          sessionName: 'ambiguous-host',
          paneId: 'terminal_1',
          socketDirV1: '/tmp/ambiguous-zellij',
        },
      },
      updatedAt: 1,
    }), 'utf8');

    const { requestSessionStop } = await import('./requestSessionStop');
    const result = await requestSessionStop({ credentials, idOrPrefix: 'sess-marker-stop' });

    expect(mocks.listSessionMarkers).toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: true,
      stopped: false,
      stopOutcome: { status: 'physical_stop_unconfirmed', reason: 'transport_ambiguous' },
    });
  });

  it('does not let pre-existing inactive metadata turn a daemon-incomplete stop into success', async () => {
    mocks.stopDaemonSession.mockResolvedValue({
      status: 'incomplete',
      reason: 'runner_exit_timeout',
    });

    const { requestSessionStop } = await import('./requestSessionStop');
    await expect(requestSessionStop({ credentials, idOrPrefix: 'sess-marker-stop' })).resolves.toEqual({
      ok: true,
      sessionId: 'sess-marker-stop',
      stopped: false,
      stopOutcome: {
        status: 'physical_stop_unconfirmed',
        reason: 'runner_exit_timeout',
      },
    });

    expect(mocks.waitForTrackedRunnerProcessesExit).not.toHaveBeenCalled();
    expect(mocks.fetchSessionByIdCompat).not.toHaveBeenCalled();
  });

  it('does not let pre-existing inactive metadata turn an incomplete marker stop into success', async () => {
    mocks.waitForTrackedRunnerProcessesExit.mockResolvedValue(false);

    const { requestSessionStop } = await import('./requestSessionStop');
    await expect(requestSessionStop({ credentials, idOrPrefix: 'sess-marker-stop' })).resolves.toEqual({
      ok: true,
      sessionId: 'sess-marker-stop',
      stopped: false,
      stopOutcome: { status: 'physical_stop_unconfirmed', reason: 'runner_exit_timeout' },
    });

    expect(mocks.fetchSessionByIdCompat).not.toHaveBeenCalled();
  });

  it('fails closed when a terminal-bearing marker has a corrupt attachment descriptor', async () => {
    mocks.listSessionMarkers.mockResolvedValue([{
      pid: 4242,
      happySessionId: 'sess-marker-stop',
      startedBy: 'daemon',
      processCommandHash: 'a'.repeat(64),
      respawn: {
        version: 1,
        directory: '/tmp/project',
        terminal: { mode: 'tmux', tmux: { sessionName: 'owned-host' } },
      },
    }]);
    const sessionsDir = join(happyHomeDir, 'terminal', 'sessions');
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(join(sessionsDir, 'sess-marker-stop.json'), 'not-json', 'utf8');

    const { requestSessionStop } = await import('./requestSessionStop');
    await expect(requestSessionStop({ credentials, idOrPrefix: 'sess-marker-stop' })).resolves.toEqual({
      ok: true,
      sessionId: 'sess-marker-stop',
      stopped: false,
      stopOutcome: { status: 'physical_stop_unconfirmed', reason: 'missing_topology_proof' },
    });

    expect(mocks.removeSessionMarker).not.toHaveBeenCalled();
    expect(mocks.fetchSessionByIdCompat).not.toHaveBeenCalled();
  });

  it('fails closed when terminal-bearing marker topology survives but its descriptor is absent', async () => {
    mocks.listSessionMarkers.mockResolvedValue([{
      pid: 4242,
      happySessionId: 'sess-marker-stop',
      startedBy: 'daemon',
      processCommandHash: 'a'.repeat(64),
      respawn: {
        version: 1,
        directory: '/tmp/project',
        terminal: { mode: 'tmux', tmux: { sessionName: 'owned-host' } },
      },
    }]);

    const { requestSessionStop } = await import('./requestSessionStop');
    await expect(requestSessionStop({ credentials, idOrPrefix: 'sess-marker-stop' })).resolves.toEqual({
      ok: true,
      sessionId: 'sess-marker-stop',
      stopped: false,
      stopOutcome: { status: 'physical_stop_unconfirmed', reason: 'missing_attachment_identity' },
    });

    expect(mocks.removeSessionMarker).not.toHaveBeenCalled();
    expect(mocks.fetchSessionByIdCompat).not.toHaveBeenCalled();
  });

  it('retires matching serviceability when transport ambiguity falls back to an exact preserved host', async () => {
    const attachmentId = 'attachment-preserved-stop';
    mocks.listSessionMarkers.mockResolvedValue([{
      pid: 4242,
      happySessionId: 'sess-marker-stop',
      startedBy: 'daemon',
      processCommandHash: 'a'.repeat(64),
      respawn: {
        version: 1,
        directory: '/tmp/project',
        terminal: {
          mode: 'zellij',
          zellij: {
            sessionName: 'preserved-host',
            paneId: 'terminal_1',
            socketDirV1: '/tmp/preserved-zellij',
          },
        },
      },
    }]);
    const sessionsDir = join(happyHomeDir, 'terminal', 'sessions');
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(join(sessionsDir, 'sess-marker-stop.json'), JSON.stringify({
      version: 2,
      attachmentId,
      sessionId: 'sess-marker-stop',
      handle: {
        attachmentId,
        kind: 'zellij',
        sessionName: 'preserved-host',
        paneId: 'terminal_1',
        socketDir: '/tmp/preserved-zellij',
        attachMetadata: {
          attachStrategy: 'terminal_host',
          topology: 'shared',
          locality: 'same_machine',
          liveProbe: 'required',
        },
      },
      terminal: {
        mode: 'zellij',
        zellij: {
          sessionName: 'preserved-host',
          paneId: 'terminal_1',
          socketDirV1: '/tmp/preserved-zellij',
        },
      },
      updatedAt: 1,
    }), 'utf8');
    mocks.waitForTrackedRunnerProcessesExit.mockResolvedValue(true);
    mocks.stopDaemonSession.mockRejectedValue(new Error('local control timeout'));
    mocks.persistedMetadata = {
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

    const { requestSessionStop } = await import('./requestSessionStop');
    await expect(requestSessionStop({ credentials, idOrPrefix: 'sess-marker-stop' })).resolves.toEqual({
      ok: true,
      sessionId: 'sess-marker-stop',
      stopped: true,
    });

    expect(mocks.isPidSafeHappySessionProcess).not.toHaveBeenCalled();
    expect(mocks.disposeTerminalHost).toHaveBeenCalledTimes(1);
    expect(mocks.persistedMetadata).toMatchObject({
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

  it('preserves replacement serviceability during transport-ambiguous exact marker fallback', async () => {
    const attachmentId = 'attachment-retired';
    const replacementAttachmentId = 'attachment-replacement';
    mocks.stopDaemonSession.mockRejectedValue(new Error('local control timeout'));
    mocks.listSessionMarkers.mockResolvedValue([{
      pid: 4242,
      happySessionId: 'sess-marker-stop',
      startedBy: 'daemon',
      processCommandHash: 'a'.repeat(64),
      respawn: {
        version: 1,
        directory: '/tmp/project',
        terminal: { mode: 'zellij', zellij: { sessionName: 'preserved-host', paneId: 'terminal_1', socketDirV1: '/tmp/preserved-zellij' } },
      },
    }]);
    const sessionsDir = join(happyHomeDir, 'terminal', 'sessions');
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(join(sessionsDir, 'sess-marker-stop.json'), JSON.stringify({
      version: 2,
      attachmentId,
      sessionId: 'sess-marker-stop',
      handle: {
        attachmentId,
        kind: 'zellij',
        sessionName: 'preserved-host',
        paneId: 'terminal_1',
        socketDir: '/tmp/preserved-zellij',
        attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared', locality: 'same_machine', liveProbe: 'required' },
      },
      terminal: { mode: 'zellij', zellij: { sessionName: 'preserved-host', paneId: 'terminal_1', socketDirV1: '/tmp/preserved-zellij' } },
      updatedAt: 1,
    }), 'utf8');
    mocks.persistedMetadata = {
      terminal: {
        mode: 'zellij',
        controlServiceabilityV1: { v: 1, attachmentId: replacementAttachmentId, state: 'servable', observedAt: 200 },
      },
    };

    const { requestSessionStop } = await import('./requestSessionStop');
    await expect(requestSessionStop({ credentials, idOrPrefix: 'sess-marker-stop' })).resolves.toEqual({
      ok: true,
      sessionId: 'sess-marker-stop',
      stopped: true,
    });
    expect(mocks.persistedMetadata).toMatchObject({
      terminal: { controlServiceabilityV1: { attachmentId: replacementAttachmentId, state: 'servable' } },
    });
  });

  it('does not let an ambiguous retry destroy an attachment installed after the daemon request began', async () => {
    const originalAttachmentId = 'attachment-before-daemon-stop';
    const replacementAttachmentId = 'attachment-after-daemon-stop';
    mocks.listSessionMarkers.mockResolvedValue([{
      pid: 4242,
      happySessionId: 'sess-marker-stop',
      startedBy: 'daemon',
      processCommandHash: 'a'.repeat(64),
      respawn: {
        version: 1,
        directory: '/tmp/project',
        terminal: { mode: 'zellij', zellij: { sessionName: 'preserved-host', paneId: 'terminal_1', socketDirV1: '/tmp/preserved-zellij' } },
      },
    }]);
    const sessionsDir = join(happyHomeDir, 'terminal', 'sessions');
    const descriptorPath = join(sessionsDir, 'sess-marker-stop.json');
    await mkdir(sessionsDir, { recursive: true });
    const descriptor = (attachmentId: string) => ({
      version: 2,
      attachmentId,
      sessionId: 'sess-marker-stop',
      handle: {
        attachmentId,
        kind: 'zellij',
        sessionName: 'preserved-host',
        paneId: 'terminal_1',
        socketDir: '/tmp/preserved-zellij',
        attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared', locality: 'same_machine', liveProbe: 'required' },
      },
      terminal: { mode: 'zellij', zellij: { sessionName: 'preserved-host', paneId: 'terminal_1', socketDirV1: '/tmp/preserved-zellij' } },
      updatedAt: attachmentId === originalAttachmentId ? 1 : 2,
    });
    await writeFile(descriptorPath, JSON.stringify(descriptor(originalAttachmentId)), 'utf8');
    mocks.stopDaemonSession.mockImplementation(async () => {
      await writeFile(descriptorPath, JSON.stringify(descriptor(replacementAttachmentId)), 'utf8');
      throw new Error('local control timeout');
    });

    const { requestSessionStop } = await import('./requestSessionStop');
    await expect(requestSessionStop({ credentials, idOrPrefix: 'sess-marker-stop' })).resolves.toEqual({
      ok: true,
      sessionId: 'sess-marker-stop',
      stopped: false,
      // The refusal itself is unchanged and still fails closed — nothing is
      // destroyed. Only the REPORTED reason moved: `attachment_mismatch` is one
      // of the reasons a consumer reads as proof that nothing was signalled,
      // and after an ambiguous daemon stop that proof does not exist. The
      // ambiguity that caused the fallback is the honest answer.
      stopOutcome: { status: 'physical_stop_unconfirmed', reason: 'transport_ambiguous' },
    });
    expect(mocks.disposeTerminalHost).not.toHaveBeenCalled();
  });

  it('does not report full success when exact marker fallback cannot retire serviceability', async () => {
    const attachmentId = 'attachment-retirement-failure';
    mocks.stopDaemonSession.mockRejectedValue(new Error('local control timeout'));
    mocks.listSessionMarkers.mockResolvedValue([{
      pid: 4242,
      happySessionId: 'sess-marker-stop',
      startedBy: 'daemon',
      processCommandHash: 'a'.repeat(64),
      respawn: {
        version: 1,
        directory: '/tmp/project',
        terminal: { mode: 'zellij', zellij: { sessionName: 'preserved-host', paneId: 'terminal_1', socketDirV1: '/tmp/preserved-zellij' } },
      },
    }]);
    const sessionsDir = join(happyHomeDir, 'terminal', 'sessions');
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(join(sessionsDir, 'sess-marker-stop.json'), JSON.stringify({
      version: 2,
      attachmentId,
      sessionId: 'sess-marker-stop',
      handle: {
        attachmentId,
        kind: 'zellij',
        sessionName: 'preserved-host',
        paneId: 'terminal_1',
        socketDir: '/tmp/preserved-zellij',
        attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared', locality: 'same_machine', liveProbe: 'required' },
      },
      terminal: { mode: 'zellij', zellij: { sessionName: 'preserved-host', paneId: 'terminal_1', socketDirV1: '/tmp/preserved-zellij' } },
      updatedAt: 1,
    }), 'utf8');
    mocks.updateSessionMetadataWithRetry.mockRejectedValueOnce(new Error('metadata persistence unavailable'));

    const { requestSessionStop } = await import('./requestSessionStop');
    await expect(requestSessionStop({ credentials, idOrPrefix: 'sess-marker-stop' })).resolves.toEqual({
      ok: true,
      sessionId: 'sess-marker-stop',
      stopped: false,
      stopOutcome: {
        status: 'stopped_cleanup_incomplete',
        reason: 'terminal_control_serviceability_retirement_failed',
      },
    });
    expect(mocks.disposeTerminalHost).toHaveBeenCalledTimes(1);
  });

  it('reports descriptor retirement failure as cleanup-incomplete after proven host destruction', async () => {
    mocks.stopDaemonSession.mockResolvedValue({
      status: 'incomplete',
      reason: 'terminal_attachment_descriptor_retirement_failed',
    });

    const { requestSessionStop } = await import('./requestSessionStop');
    await expect(requestSessionStop({ credentials, idOrPrefix: 'sess-marker-stop' })).resolves.toEqual({
      ok: true,
      sessionId: 'sess-marker-stop',
      stopped: false,
      stopOutcome: {
        status: 'stopped_cleanup_incomplete',
        reason: 'terminal_attachment_descriptor_retirement_failed',
      },
    });
  });
  /**
   * The user-blocking case: a Session created days ago whose runtime is long
   * gone. The stop target answers `not_found`, which is PROOF that no runtime
   * exists rather than a failure to determine it — provided the canonical
   * Session row agrees, which is the same fact this owner already accepts as a
   * confirmed stop after signalling a live runtime. Without the distinction a
   * cold Session can never satisfy a consumer that requires a confirmed stop,
   * because there is nothing left to signal.
   */
  it('confirms a cold Session as already stopped when the owning machine has no runtime', async () => {
    mocks.resolveSessionIdOrPrefix.mockResolvedValue({
      ok: true,
      sessionId: 'sess-marker-stop',
      rawSession: { id: 'sess-marker-stop', active: false, machineId: 'machine-owning-session' },
    });
    mocks.callMachineRpc.mockResolvedValue({ status: 'not_found' });
    mocks.fetchSessionByIdCompat.mockResolvedValue({ id: 'sess-marker-stop', active: false });

    const { requestSessionStop } = await import('./requestSessionStop');

    await expect(requestSessionStop({ credentials, idOrPrefix: 'sess-marker-stop' })).resolves.toEqual({
      ok: true,
      sessionId: 'sess-marker-stop',
      stopped: false,
      stopOutcome: { status: 'already_stopped', reason: 'no_runtime_session_inactive' },
    });
  });

  it('confirms a cold Session as already stopped when caller-local control tracks nothing', async () => {
    mocks.stopDaemonSession.mockResolvedValue({ status: 'not_found' });
    mocks.listSessionMarkers.mockResolvedValue([]);
    mocks.fetchSessionByIdCompat.mockResolvedValue({ id: 'sess-marker-stop', active: false });

    const { requestSessionStop } = await import('./requestSessionStop');

    await expect(requestSessionStop({ credentials, idOrPrefix: 'sess-marker-stop' })).resolves.toEqual({
      ok: true,
      sessionId: 'sess-marker-stop',
      stopped: false,
      stopOutcome: { status: 'already_stopped', reason: 'no_runtime_session_inactive' },
    });
  });

  /**
   * The mirror that keeps the distinction real. `not_found` alone is not the
   * proof — the liveness observation is. A row that still reports the Session
   * running, and a row that cannot be read at all, are both "could not
   * determine" and must keep the unconfirmed status every consumer treats as
   * indeterminate.
   */
  it.each([
    ['the Session row still reports it running', () => {
      mocks.fetchSessionByIdCompat.mockResolvedValue({ id: 'sess-marker-stop', active: true });
    }],
    ['the Session row cannot be read at all', () => {
      mocks.fetchSessionByIdCompat.mockRejectedValue(new Error('relay unreachable'));
    }],
  ] as const)(
    'keeps a not-found stop unconfirmed when %s',
    async (_label, primeLiveness) => {
      mocks.resolveSessionIdOrPrefix.mockResolvedValue({
        ok: true,
        sessionId: 'sess-marker-stop',
        rawSession: { id: 'sess-marker-stop', active: true, machineId: 'machine-owning-session' },
      });
      mocks.callMachineRpc.mockResolvedValue({ status: 'not_found' });
      primeLiveness();

      const { requestSessionStop } = await import('./requestSessionStop');

      await expect(requestSessionStop({ credentials, idOrPrefix: 'sess-marker-stop' })).resolves.toEqual({
        ok: true,
        sessionId: 'sess-marker-stop',
        stopped: false,
        stopOutcome: { status: 'physical_stop_unconfirmed', reason: 'target_session_not_found' },
      });
    },
  );
});
