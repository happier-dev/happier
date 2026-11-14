import { rm } from 'node:fs/promises';
import { afterAll, describe, expect, it, vi } from 'vitest';

const testHome = vi.hoisted(() => {
  const home = `${process.env.TMPDIR ?? '/tmp'}/happier-host-command-${process.pid}-${Date.now()}`;
  process.env.HAPPIER_HOME_DIR = home;
  return home;
});

import { captureProcessBirthWitness } from '@/daemon/processIdentity';
import { writeDaemonState } from '@/persistence';
import { addLocalSessionHostSession, SESSION_HOST_READY_LINE } from '@/session/transport/rpc/localSessionRpcChannel';
import { captureStdout } from '@/testkit/logger/captureOutput';
import { findCommandDispatchDescriptor } from './commandRegistry';
import { dispatchCli } from './dispatch';

describe('session-host CLI dispatch', () => {
  afterAll(async () => { await rm(testHome, { recursive: true, force: true }); });

  it('publishes a ready host and executes an added command instead of launching the default Agent', async () => {
    expect(findCommandDispatchDescriptor('session-host')).not.toBeNull();
    const processBirth = await captureProcessBirthWitness(process.pid);
    if (!processBirth) throw new Error('The host fixture needs its real OS process birth');
    writeDaemonState({ pid: process.pid, httpPort: 1, startedAt: Date.now(), startedWithCliVersion: 'test', processBirth });
    const output = captureStdout();
    // Process exit is the only replaced boundary; dispatch, host lifecycle and owner-only IPC are real.
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const running = dispatchCli({ args: ['session-host'], rawArgv: ['happier', 'session-host'], terminalRuntime: null });
    // Attach immediately so a startup refusal is observed rather than becoming an unhandled rejection.
    const settled = running.then(() => ({ ok: true }), error => ({ ok: false, error }));
    try {
      await vi.waitFor(() => expect(output.text()).toContain(`${SESSION_HOST_READY_LINE} ${process.pid}`), { timeout: 120_000 });
      const session = addLocalSessionHostSession({ hostPid: process.pid, request: {
        trackingKey: 'host-command-version', argv: ['--version'], env: {}, cwd: testHome,
      } });
      await expect(session.admitted).resolves.toBe(true);
      await expect(session.ended).resolves.toMatchObject({ exitCode: 0 });
      await expect(settled).resolves.toEqual({ ok: true });
      expect(exit).toHaveBeenCalledWith(0);
    } finally {
      process.emit('SIGTERM', 'SIGTERM');
      output.restore();
      exit.mockRestore();
    }
  }, 120_000);
});
