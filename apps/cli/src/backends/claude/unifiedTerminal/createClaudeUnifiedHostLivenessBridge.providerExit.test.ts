import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalHostHandle } from '@/integrations/terminalHost/_types';

// Keep identity parsing and liveness policy real; simulate only the Windows OS probe.
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawnSync: (command: string) => {
    if (command !== 'powershell.exe') throw new Error('Unexpected process-instance OS probe');
    return { status: 0, stdout: '2026-10-02T12:00:00.0000000Z', stderr: '' };
  },
}));
import { createClaudeUnifiedHostLivenessBridge } from './createClaudeUnifiedHostLivenessBridge';

const handle: TerminalHostHandle = {
  kind: 'herdr', sessionName: 'this-session', paneId: 'pane',
  attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared', locality: 'same_machine', liveProbe: 'required' },
};

describe('provider exit proof', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const invocation = { command: '/managed/claude', args: ['--session-id', 'this-session'] };
  const provider = { pid: 4242, argv: [invocation.command, ...invocation.args] };
  const shell = { pid: 4343, argv: ['/bin/bash'] };
  let alive = true;

  beforeEach(() => {
    vi.useFakeTimers();
    alive = true;
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    vi.spyOn(process, 'kill').mockImplementation(() => {
      if (!alive) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      return true;
    });
  });
  afterEach(() => {
    Object.defineProperty(process, 'platform', platform);
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function start(foreground: readonly typeof provider[]) {
    let processes = foreground;
    const onProviderGone = vi.fn(async () => undefined);
    const onHostDead = vi.fn(async () => undefined);
    const bridge = createClaudeUnifiedHostLivenessBridge({
      hostAdapter: { evaluateLiveness: async () => ({ paneAlive: true,
        paneForegroundProcesses: processes, observedAt: Date.now() }) },
      handle, onHostDead, onProviderGone,
      providerInvocation: invocation,
      pollIntervalMs: 10, pollJitterMs: 0, startupGraceActive: () => false,
    });
    const abort = new AbortController();
    const monitor = Promise.resolve(bridge.start({ abortSignal: abort.signal }));
    return { onProviderGone, onHostDead, monitor,
      foreground: (value: readonly typeof provider[]) => { processes = value; },
      stop: async () => { bridge.dispose(); abort.abort(); await monitor; } };
  }

  it('does not infer exit from a shell-only snapshot before identifying this provider', async () => {
    const run = start([shell]);
    await vi.advanceTimersByTimeAsync(50);
    expect(run.onProviderGone).not.toHaveBeenCalled();
    await run.stop();
  });

  it('keeps an identified live provider when another job takes the foreground', async () => {
    const run = start([provider]);
    await vi.advanceTimersByTimeAsync(10);
    run.foreground([shell]);
    await vi.advanceTimersByTimeAsync(50);
    expect(run.onProviderGone).not.toHaveBeenCalled();
    await run.stop();
  });

  it('reports a verified exit once while the pane remains alive', async () => {
    const run = start([provider]);
    await vi.advanceTimersByTimeAsync(10);
    alive = false;
    run.foreground([shell]);
    await vi.advanceTimersByTimeAsync(50);
    expect(run.onProviderGone).toHaveBeenCalledTimes(1);
    expect(run.onHostDead).not.toHaveBeenCalled();
    await run.stop();
  });

  it('does not adopt a launcher or another Claude session as this provider', async () => {
    const run = start([{ pid: 4242, argv: ['/managed/node', 'terminal_launch_spec_runner.cjs', 'spec'] },
      { pid: 4243, argv: ['/managed/claude', '--session-id', 'another-session'] }]);
    await vi.advanceTimersByTimeAsync(10);
    alive = false;
    run.foreground([shell]);
    await vi.advanceTimersByTimeAsync(50);
    expect(run.onProviderGone).not.toHaveBeenCalled();
    await run.stop();
  });

  it('propagates notification failure to the supervising controller', async () => {
    const run = start([provider]);
    const error = new Error('provider exit delivery failed');
    run.onProviderGone.mockRejectedValue(error);
    const rejected = expect(run.monitor).rejects.toBe(error);
    await vi.advanceTimersByTimeAsync(10);
    alive = false;
    run.foreground([shell]);
    await vi.advanceTimersByTimeAsync(50);
    await run.stop().catch(() => undefined);
    await rejected;
  });
});
