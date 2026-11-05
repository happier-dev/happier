import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TerminalHostHandle } from '@/integrations/terminalHost/_types';

import { createClaudeUnifiedHostLivenessBridge } from './createClaudeUnifiedHostLivenessBridge';

const handle: TerminalHostHandle = {
  kind: 'zellij',
  sessionName: 'happier-claude-unified-test',
  paneId: 'terminal_1',
  attachMetadata: {
    attachStrategy: 'terminal_host',
    topology: 'shared',
    locality: 'same_machine',
    liveProbe: 'required',
  },
};

describe('createClaudeUnifiedHostLivenessBridge', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses a slow staggered default cadence for steady-state host liveness checks', async () => {
    vi.useFakeTimers();
    let nowMs = 0;
    const evaluateLiveness = vi.fn(async () => ({ paneAlive: true, observedAt: nowMs }));
    const bridge = createClaudeUnifiedHostLivenessBridge({
      hostAdapter: { evaluateLiveness },
      handle,
      onHostDead: vi.fn(async () => undefined),
      nowMs: () => nowMs,
    });
    const abortController = new AbortController();

    bridge.start({ abortSignal: abortController.signal });

    nowMs += 29_999;
    await vi.advanceTimersByTimeAsync(29_999);
    expect(evaluateLiveness).not.toHaveBeenCalled();

    nowMs += 1;
    await vi.advanceTimersByTimeAsync(1);
    expect(evaluateLiveness).not.toHaveBeenCalled();

    nowMs += 5_000;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(evaluateLiveness).toHaveBeenCalledTimes(1);

    bridge.dispose();
    abortController.abort();
  });

  it('settles the monitor promise on abort without waiting out the steady-state poll timer', async () => {
    vi.useFakeTimers();
    const evaluateLiveness = vi.fn(async () => ({ paneAlive: true, observedAt: 0 }));
    const bridge = createClaudeUnifiedHostLivenessBridge({
      hostAdapter: { evaluateLiveness },
      handle,
      onHostDead: vi.fn(async () => undefined),
      nowMs: () => 0,
    });
    const abortController = new AbortController();

    let settled = false;
    const started = Promise.resolve(bridge.start({ abortSignal: abortController.signal }))
      .then(() => { settled = true; });

    // Mid steady-state wait (30s + jitter): aborting must settle the monitor promptly instead of
    // leaving a pending multi-second timer holding the event loop after session shutdown.
    abortController.abort();
    await vi.advanceTimersByTimeAsync(0);

    expect(settled).toBe(true);
    expect(evaluateLiveness).not.toHaveBeenCalled();
    bridge.dispose();
    await started;
  });

  it('confirms a suspected dead host quickly instead of waiting for the steady-state cadence', async () => {
    vi.useFakeTimers();
    let nowMs = 100;
    const evaluateLiveness = vi
      .fn()
      .mockResolvedValueOnce({ paneAlive: false, paneDead: true, observedAt: 110 })
      .mockResolvedValueOnce({ paneAlive: false, paneDead: true, observedAt: 111 });
    const onHostDead = vi.fn(async () => undefined);
    const bridge = createClaudeUnifiedHostLivenessBridge({
      hostAdapter: { evaluateLiveness },
      handle,
      onHostDead,
      pollIntervalMs: 30_000,
      pollJitterMs: 0,
      startupGraceMs: 0,
      startupGraceActive: () => false,
      nowMs: () => nowMs,
    });
    const abortController = new AbortController();

    bridge.start({ abortSignal: abortController.signal });

    nowMs += 30_000;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(onHostDead).not.toHaveBeenCalled();

    nowMs += 999;
    await vi.advanceTimersByTimeAsync(999);
    expect(onHostDead).not.toHaveBeenCalled();

    nowMs += 1;
    await vi.advanceTimersByTimeAsync(1);
    expect(onHostDead).toHaveBeenCalledTimes(1);

    bridge.dispose();
    abortController.abort();
  });

  it('treats dead-pane observations during startup grace as transient', async () => {
    vi.useFakeTimers();
    let nowMs = 0;
    const evaluateLiveness = vi.fn(async () => ({ paneAlive: false, observedAt: nowMs }));
    const onHostDead = vi.fn(async () => undefined);
    const bridge = createClaudeUnifiedHostLivenessBridge({
      hostAdapter: { evaluateLiveness },
      handle,
      onHostDead,
      pollIntervalMs: 10,
      startupGraceMs: 50,
      nowMs: () => nowMs,
    });
    const abortController = new AbortController();

    bridge.start({ abortSignal: abortController.signal });

    nowMs += 10;
    await vi.advanceTimersByTimeAsync(10);
    expect(onHostDead).not.toHaveBeenCalled();

    evaluateLiveness.mockResolvedValueOnce({ paneAlive: true, observedAt: nowMs });
    nowMs += 10;
    await vi.advanceTimersByTimeAsync(10);
    expect(onHostDead).not.toHaveBeenCalled();

    bridge.dispose();
    abortController.abort();
  });

  it('does not report host death for a single transient dead observation after startup grace', async () => {
    vi.useFakeTimers();
    let nowMs = 100;
    const evaluateLiveness = vi
      .fn()
      .mockResolvedValueOnce({ paneAlive: false, paneDead: true, observedAt: 110 })
      .mockResolvedValueOnce({ paneAlive: true, paneDead: false, observedAt: 120 });
    const onHostDead = vi.fn(async () => undefined);
    const bridge = createClaudeUnifiedHostLivenessBridge({
      hostAdapter: { evaluateLiveness },
      handle,
      onHostDead,
      pollIntervalMs: 10,
      startupGraceMs: 0,
      startupGraceActive: () => false,
      nowMs: () => nowMs,
    });
    const abortController = new AbortController();

    bridge.start({ abortSignal: abortController.signal });

    nowMs += 10;
    await vi.advanceTimersByTimeAsync(10);
    expect(onHostDead).not.toHaveBeenCalled();

    nowMs += 10;
    await vi.advanceTimersByTimeAsync(10);
    expect(onHostDead).not.toHaveBeenCalled();

    bridge.dispose();
    abortController.abort();
  });

  it('does not report host death for a single transient liveness probe failure after startup grace', async () => {
    vi.useFakeTimers();
    let nowMs = 100;
    const evaluateLiveness = vi
      .fn()
      .mockRejectedValueOnce(new Error('control plane unavailable'))
      .mockResolvedValueOnce({ paneAlive: true, observedAt: 120 });
    const onHostDead = vi.fn(async () => undefined);
    const bridge = createClaudeUnifiedHostLivenessBridge({
      hostAdapter: { evaluateLiveness },
      handle,
      onHostDead,
      pollIntervalMs: 10,
      startupGraceMs: 0,
      startupGraceActive: () => false,
      nowMs: () => nowMs,
    });
    const abortController = new AbortController();

    bridge.start({ abortSignal: abortController.signal });

    nowMs += 10;
    await vi.advanceTimersByTimeAsync(10);
    expect(onHostDead).not.toHaveBeenCalled();

    nowMs += 10;
    await vi.advanceTimersByTimeAsync(10);
    expect(onHostDead).not.toHaveBeenCalled();

    bridge.dispose();
    abortController.abort();
  });

  it('does not report host death for a single explicit inconclusive liveness result after startup grace', async () => {
    vi.useFakeTimers();
    let nowMs = 100;
    const evaluateLiveness = vi
      .fn()
      .mockResolvedValueOnce({
        paneAlive: false,
        probeInconclusive: true,
        paneScreenDumpError: 'tmux display-message timed out',
        observedAt: 110,
      })
      .mockResolvedValueOnce({ paneAlive: true, observedAt: 120 });
    const onHostDead = vi.fn(async () => undefined);
    const bridge = createClaudeUnifiedHostLivenessBridge({
      hostAdapter: { evaluateLiveness },
      handle,
      onHostDead,
      pollIntervalMs: 10,
      startupGraceMs: 0,
      startupGraceActive: () => false,
      nowMs: () => nowMs,
    });
    const abortController = new AbortController();

    bridge.start({ abortSignal: abortController.signal });

    nowMs += 10;
    await vi.advanceTimersByTimeAsync(10);
    expect(onHostDead).not.toHaveBeenCalled();

    nowMs += 10;
    await vi.advanceTimersByTimeAsync(10);
    expect(onHostDead).not.toHaveBeenCalled();

    bridge.dispose();
    abortController.abort();
  });

  it('reports host death after startup grace expires', async () => {
    vi.useFakeTimers();
    let nowMs = 0;
    const deadLiveness = {
      paneAlive: false,
      paneDead: true,
      paneCurrentCommand: '/managed/node',
      paneExitStatus: 1,
      observedAt: 20,
    };
    const evaluateLiveness = vi.fn(async () => ({
      ...deadLiveness,
      observedAt: nowMs,
    }));
    const onHostDead = vi.fn(async () => undefined);
    const bridge = createClaudeUnifiedHostLivenessBridge({
      hostAdapter: { evaluateLiveness },
      handle,
      onHostDead,
      pollIntervalMs: 10,
      startupGraceMs: 15,
      nowMs: () => nowMs,
    });
    const abortController = new AbortController();

    bridge.start({ abortSignal: abortController.signal });

    nowMs += 10;
    await vi.advanceTimersByTimeAsync(10);
    expect(onHostDead).not.toHaveBeenCalled();

    nowMs += 10;
    await vi.advanceTimersByTimeAsync(10);
    expect(onHostDead).not.toHaveBeenCalled();

    nowMs += 10;
    await vi.advanceTimersByTimeAsync(10);
    expect(onHostDead).toHaveBeenCalledTimes(1);
    expect(onHostDead).toHaveBeenCalledWith(expect.objectContaining({
      code: 'claude_unified_terminal_host_dead',
      liveness: {
        ...deadLiveness,
        observedAt: nowMs,
      },
    }));

    bridge.dispose();
    abortController.abort();
  });

  // Incident cmq8y3nlx 2026-06-12 11:24: two consecutive `zellij list-panes timed out` probe
  // failures ~1s apart (one machine-load spike) were escalated to host_dead and the dispose path
  // killed a HEALTHY idle Claude session. Probe failures are inconclusive: they must never seed or
  // confirm host death on their own within the sustained-failure window.
  it('does not report host death for consecutive transient probe failures under production defaults', async () => {
    vi.useFakeTimers();
    let nowMs = 100;
    const evaluateLiveness = vi
      .fn()
      .mockRejectedValueOnce(new Error('zellij list-panes timed out'))
      .mockRejectedValueOnce(new Error('zellij list-panes timed out'))
      .mockResolvedValue({ paneAlive: true, observedAt: 0 });
    const onHostDead = vi.fn(async () => undefined);
    const bridge = createClaudeUnifiedHostLivenessBridge({
      hostAdapter: { evaluateLiveness },
      handle,
      onHostDead,
      pollJitterMs: 0,
      startupGraceMs: 0,
      startupGraceActive: () => false,
      nowMs: () => nowMs,
    });
    const abortController = new AbortController();

    bridge.start({ abortSignal: abortController.signal });

    // Steady-state poll fails (probe threw, e.g. zellij overloaded).
    nowMs += 30_000;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(evaluateLiveness).toHaveBeenCalledTimes(1);
    expect(onHostDead).not.toHaveBeenCalled();

    // Fast re-poll fails again ~1s later — the incident shape. Must NOT kill the host.
    nowMs += 1_000;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(evaluateLiveness).toHaveBeenCalledTimes(2);
    expect(onHostDead).not.toHaveBeenCalled();

    // Probe recovers: streak resets, no host death ever reported.
    nowMs += 1_000;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onHostDead).not.toHaveBeenCalled();

    nowMs += 30_000;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(onHostDead).not.toHaveBeenCalled();

    bridge.dispose();
    abortController.abort();
  });

  it('does not report host death for consecutive explicit inconclusive liveness results under production defaults', async () => {
    vi.useFakeTimers();
    let nowMs = 100;
    const evaluateLiveness = vi
      .fn()
      .mockResolvedValueOnce({
        paneAlive: false,
        probeInconclusive: true,
        paneScreenDumpError: 'tmux display-message timed out',
        observedAt: 110,
      })
      .mockResolvedValueOnce({
        paneAlive: false,
        probeInconclusive: true,
        paneScreenDumpError: 'tmux display-message timed out',
        observedAt: 111,
      })
      .mockResolvedValue({ paneAlive: true, observedAt: 0 });
    const onHostDead = vi.fn(async () => undefined);
    const bridge = createClaudeUnifiedHostLivenessBridge({
      hostAdapter: { evaluateLiveness },
      handle,
      onHostDead,
      pollJitterMs: 0,
      startupGraceMs: 0,
      startupGraceActive: () => false,
      nowMs: () => nowMs,
    });
    const abortController = new AbortController();

    bridge.start({ abortSignal: abortController.signal });

    nowMs += 30_000;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(onHostDead).not.toHaveBeenCalled();

    nowMs += 1_000;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onHostDead).not.toHaveBeenCalled();

    nowMs += 30_000;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(onHostDead).not.toHaveBeenCalled();

    bridge.dispose();
    abortController.abort();
  });

  it('never reports host death for sustained liveness probe failures', async () => {
    vi.useFakeTimers();
    let nowMs = 100;
    const evaluateLiveness = vi.fn().mockRejectedValue(new Error('control plane unavailable'));
    const onHostDead = vi.fn(async () => undefined);
    const bridge = createClaudeUnifiedHostLivenessBridge({
      hostAdapter: { evaluateLiveness },
      handle,
      onHostDead,
      pollIntervalMs: 10,
      probeFailureConfirmDeadMs: 35,
      startupGraceMs: 0,
      startupGraceActive: () => false,
      nowMs: () => nowMs,
    });
    const abortController = new AbortController();

    bridge.start({ abortSignal: abortController.signal });

    for (let i = 0; i < 5; i += 1) {
      nowMs += 10;
      await vi.advanceTimersByTimeAsync(10);
      expect(onHostDead).not.toHaveBeenCalled();
    }

    bridge.dispose();
    abortController.abort();
  });

  it('escalates a sustained inconclusive live-host episode once without declaring death, then rearms after a successful probe', async () => {
    vi.useFakeTimers();
    let nowMs = 0;
    const inconclusive = {
      paneAlive: false,
      probeInconclusive: true,
      paneScreenDumpError: 'spawn /deleted-snapshot/zellij ENOENT',
      observedAt: 0,
    };
    const evaluateLiveness = vi
      .fn()
      .mockResolvedValueOnce(inconclusive)
      .mockResolvedValueOnce(inconclusive)
      .mockResolvedValueOnce(inconclusive)
      .mockResolvedValueOnce(inconclusive)
      .mockResolvedValueOnce({ paneAlive: true, observedAt: 50 })
      .mockResolvedValueOnce(inconclusive)
      .mockResolvedValueOnce(inconclusive)
      .mockResolvedValueOnce(inconclusive);
    const onHostDead = vi.fn(async () => undefined);
    const onProbeFailureStarvation = vi.fn(async () => undefined);
    const bridge = createClaudeUnifiedHostLivenessBridge({
      hostAdapter: { evaluateLiveness },
      handle,
      onHostDead,
      onProbeFailureStarvation,
      pollIntervalMs: 10,
      confirmDeadPollIntervalMs: 10,
      probeFailureStarvationMs: 20,
      startupGraceMs: 0,
      startupGraceActive: () => false,
      nowMs: () => nowMs,
    });
    const abortController = new AbortController();

    bridge.start({ abortSignal: abortController.signal });

    for (let i = 0; i < 4; i += 1) {
      nowMs += 10;
      await vi.advanceTimersByTimeAsync(10);
    }
    expect(onProbeFailureStarvation).toHaveBeenCalledTimes(1);
    expect(onHostDead).not.toHaveBeenCalled();

    nowMs += 10;
    await vi.advanceTimersByTimeAsync(10);

    for (let i = 0; i < 3; i += 1) {
      nowMs += 10;
      await vi.advanceTimersByTimeAsync(10);
    }
    expect(onProbeFailureStarvation).toHaveBeenCalledTimes(2);
    expect(onHostDead).not.toHaveBeenCalled();

    bridge.dispose();
    abortController.abort();
  });

  it('never promotes an ENOENT probe-tool spawn failure to host death or relay disposal', async () => {
    vi.useFakeTimers();
    let nowMs = 100;
    const spawnError = Object.assign(new Error('spawn /deleted-snapshot/zellij ENOENT'), { code: 'ENOENT' });
    const onHostDead = vi.fn(async () => undefined);
    const bridge = createClaudeUnifiedHostLivenessBridge({
      hostAdapter: { evaluateLiveness: vi.fn().mockRejectedValue(spawnError) },
      handle,
      onHostDead,
      pollIntervalMs: 10,
      probeFailureConfirmDeadMs: 1,
      startupGraceMs: 0,
      startupGraceActive: () => false,
      nowMs: () => nowMs,
    });
    const abortController = new AbortController();

    bridge.start({ abortSignal: abortController.signal });
    for (let i = 0; i < 5; i += 1) {
      nowMs += 10;
      await vi.advanceTimersByTimeAsync(10);
    }

    expect(onHostDead).not.toHaveBeenCalled();
    bridge.dispose();
    abortController.abort();
  });

  it('does not let a probe failure confirm a pending conclusive dead observation', async () => {
    vi.useFakeTimers();
    let nowMs = 100;
    const evaluateLiveness = vi
      .fn()
      .mockResolvedValueOnce({ paneAlive: false, paneDead: true, observedAt: 110 })
      .mockRejectedValueOnce(new Error('zellij list-panes timed out'))
      .mockResolvedValue({ paneAlive: true, observedAt: 0 });
    const onHostDead = vi.fn(async () => undefined);
    const bridge = createClaudeUnifiedHostLivenessBridge({
      hostAdapter: { evaluateLiveness },
      handle,
      onHostDead,
      pollIntervalMs: 10,
      startupGraceMs: 0,
      startupGraceActive: () => false,
      nowMs: () => nowMs,
    });
    const abortController = new AbortController();

    bridge.start({ abortSignal: abortController.signal });

    // Conclusive dead observation arms the pending confirmation.
    nowMs += 10;
    await vi.advanceTimersByTimeAsync(10);
    expect(onHostDead).not.toHaveBeenCalled();

    // The confirming poll throws (inconclusive) — must NOT confirm death.
    nowMs += 10;
    await vi.advanceTimersByTimeAsync(10);
    expect(onHostDead).not.toHaveBeenCalled();

    // Host turns out alive: nothing is ever reported.
    nowMs += 10;
    await vi.advanceTimersByTimeAsync(10);
    expect(onHostDead).not.toHaveBeenCalled();

    nowMs += 10;
    await vi.advanceTimersByTimeAsync(10);
    expect(onHostDead).not.toHaveBeenCalled();

    bridge.dispose();
    abortController.abort();
  });

  it('still confirms a pending conclusive dead observation across an interleaved probe failure', async () => {
    vi.useFakeTimers();
    let nowMs = 100;
    const evaluateLiveness = vi
      .fn()
      .mockResolvedValueOnce({ paneAlive: false, paneDead: true, paneExitStatus: 1, observedAt: 110 })
      .mockRejectedValueOnce(new Error('zellij list-panes timed out'))
      .mockResolvedValue({ paneAlive: false, paneDead: true, observedAt: 130 });
    const onHostDead = vi.fn(async () => undefined);
    const bridge = createClaudeUnifiedHostLivenessBridge({
      hostAdapter: { evaluateLiveness },
      handle,
      onHostDead,
      pollIntervalMs: 10,
      startupGraceMs: 0,
      startupGraceActive: () => false,
      nowMs: () => nowMs,
    });
    const abortController = new AbortController();

    bridge.start({ abortSignal: abortController.signal });

    nowMs += 10;
    await vi.advanceTimersByTimeAsync(10);
    expect(onHostDead).not.toHaveBeenCalled();

    nowMs += 10;
    await vi.advanceTimersByTimeAsync(10);
    expect(onHostDead).not.toHaveBeenCalled();

    // Next conclusive dead observation confirms, preserving first-observation diagnostics.
    nowMs += 10;
    await vi.advanceTimersByTimeAsync(10);
    expect(onHostDead).toHaveBeenCalledTimes(1);
    expect(onHostDead).toHaveBeenCalledWith(expect.objectContaining({
      code: 'claude_unified_terminal_host_dead',
      liveness: expect.objectContaining({ paneDead: true, paneExitStatus: 1 }),
    }));

    bridge.dispose();
    abortController.abort();
  });

  it('preserves first dead-pane diagnostics when the confirming dead observation is sparse', async () => {
    vi.useFakeTimers();
    let nowMs = 100;
    const evaluateLiveness = vi
      .fn()
      .mockResolvedValueOnce({
        paneAlive: false,
        paneDead: true,
        paneCurrentCommand: '/managed/node',
        paneExitStatus: 127,
        paneScreenDumpCaptured: true,
        paneScreenDumpTruncated: false,
        observedAt: 110,
      })
      .mockResolvedValueOnce({
        paneAlive: false,
        paneDead: true,
        observedAt: 120,
      });
    const onHostDead = vi.fn(async () => undefined);
    const bridge = createClaudeUnifiedHostLivenessBridge({
      hostAdapter: { evaluateLiveness },
      handle,
      onHostDead,
      pollIntervalMs: 10,
      startupGraceMs: 0,
      startupGraceActive: () => false,
      nowMs: () => nowMs,
    });
    const abortController = new AbortController();

    bridge.start({ abortSignal: abortController.signal });

    nowMs += 10;
    await vi.advanceTimersByTimeAsync(10);
    expect(onHostDead).not.toHaveBeenCalled();

    nowMs += 10;
    await vi.advanceTimersByTimeAsync(10);
    expect(onHostDead).toHaveBeenCalledWith(expect.objectContaining({
      code: 'claude_unified_terminal_host_dead',
      liveness: expect.objectContaining({
        paneCurrentCommand: '/managed/node',
        paneExitStatus: 127,
        paneScreenDumpCaptured: true,
        paneScreenDumpTruncated: false,
        observedAt: 120,
      }),
    }));

    bridge.dispose();
    abortController.abort();
  });

  it('still reports host death when telemetry emit fails', async () => {
    vi.useFakeTimers();
    let nowMs = 0;
    const deadLiveness = {
      paneAlive: false,
      paneDead: true,
      paneCurrentCommand: '/managed/node',
      paneExitStatus: 1,
      observedAt: 10,
    };
    const evaluateLiveness = vi.fn(async () => deadLiveness);
    const onHostDead = vi.fn(async () => undefined);
    const bridge = createClaudeUnifiedHostLivenessBridge({
      hostAdapter: { evaluateLiveness },
      handle,
      telemetry: {
        emit: vi.fn(() => {
          throw new Error('telemetry sink failed');
        }),
      },
      onHostDead,
      pollIntervalMs: 10,
      nowMs: () => nowMs,
    });
    const abortController = new AbortController();

    bridge.start({ abortSignal: abortController.signal });
    nowMs += 10;
    await vi.advanceTimersByTimeAsync(10);
    expect(onHostDead).not.toHaveBeenCalled();

    nowMs += 10;
    await vi.advanceTimersByTimeAsync(10);

    expect(onHostDead).toHaveBeenCalledTimes(1);
    expect(onHostDead).toHaveBeenCalledWith(expect.objectContaining({
      code: 'claude_unified_terminal_host_dead',
      liveness: deadLiveness,
    }));

    bridge.dispose();
    abortController.abort();
  });
});
