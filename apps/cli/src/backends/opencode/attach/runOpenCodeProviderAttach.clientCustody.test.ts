import { ChildProcess, type spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { terminalLauncherBoundary } from '@/testkit/process/terminalLauncher';
import { waitForProcessExit } from '@/testkit/process/spawn';
import { createManagedOpenCodeClientFixture } from '../server/managedOpenCodeClient.testkit';
import { isOpenCodeServerPidAlive } from '../server/openCodeServerProcessState';
import { reapUnusedSharedManagedOpenCodeServersBestEffort } from '../server/sharedManagedServer';

import { runOpenCodeProviderAttach } from './runOpenCodeProviderAttach';

afterEach(() => vi.restoreAllMocks());

describe('standalone OpenCode native attach client custody', () => {
  it.each(['native exit', 'unverified wrapper exit'] as const)('protects its managed server independently of a Session runner through %s', async (completion) => {
    const fixture = await createManagedOpenCodeClientFixture();
    const native = new ChildProcess();
    Object.defineProperty(native, 'pid', { value: process.pid });
    let signalSpawned!: () => void;
    const spawned = new Promise<void>((resolve) => { signalSpawned = resolve; });
    const spawnBoundary = vi.fn(() => {
      signalSpawned();
      return terminalLauncherBoundary(native);
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).pathname;
      return path === '/global/health'
        ? Response.json({ healthy: true, version: 'fake-opencode' })
        : new Response(null, { status: 404 });
    });
    let attaching: Promise<number> | undefined;
    const finishNative = () => {
      if (completion === 'native exit') native.emit('message', { type: 'terminal-native-exited', code: 0, signal: null });
      native.emit('exit', 0, null);
    };
    try {
      attaching = runOpenCodeProviderAttach({
        sessionId: 'standalone-native-session',
        metadata: {
          path: fixture.homeDir,
          opencodeSessionId: 'native-session',
          opencodeBackendMode: 'server',
        },
        command: 'opencode', commandArgs: [],
        // The OS child/IPC boundary is simulated; attach, launch-spec and custody owners stay real.
        spawnProcess: spawnBoundary as unknown as typeof spawn,
      });
      await Promise.race([spawned, attaching.then(() => { throw new Error('Attach exited before native spawn'); })]);
      await new Promise<void>((resolve) => setImmediate(resolve));

      // No Session marker or HTTP runtime client exists: this independent attach is the live user.
      await reapUnusedSharedManagedOpenCodeServersBestEffort();
      expect(isOpenCodeServerPidAlive(fixture.pid)).toBe(true);
      expect(existsSync(fixture.statePath)).toBe(true);

      finishNative();
      expect(await attaching).toBe(0);
      await reapUnusedSharedManagedOpenCodeServersBestEffort();
      if (completion === 'native exit') {
        expect(await waitForProcessExit(fixture.pid, { timeoutMs: 1_000 })).toBe(true);
        expect(existsSync(fixture.statePath)).toBe(false);
      } else {
        expect(isOpenCodeServerPidAlive(fixture.pid)).toBe(true);
        expect(existsSync(fixture.statePath)).toBe(true);
      }
    } finally {
      finishNative();
      await attaching?.catch(() => undefined);
      await fixture.close();
    }
  });
});
