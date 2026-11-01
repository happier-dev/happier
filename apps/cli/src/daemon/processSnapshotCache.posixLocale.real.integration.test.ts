import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { readProcessInfoByPid } from './doctor';
import { listProcessSnapshot } from './processSnapshotCache';
import { resolveSessionRunnerRuntimeState } from './sessionRunnerRuntime/resolveRuntimeState';

describe.skipIf(process.platform !== 'darwin')('Darwin process discovery with a service locale', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('preserves Unicode commands and current snapshot identity across runner replacement without leaking locale', async () => {
    vi.stubEnv('LANG', 'C');
    vi.stubEnv('LC_ALL', 'C');
    const root = await mkdtemp(join(tmpdir(), 'happier-ps-locale-'));
    const fingerprint = 'bee5314ededb46bd';
    const directory = join(root, '项目 with spaces', '.runner-snapshots', fingerprint);
    const script = join(directory, 'index.mjs');
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(script, 'setInterval(() => {}, 1000);');
      for (const phase of ['initial', 'replacement']) {
        const child = spawn(process.execPath, [script, 'opencode', '--started-by', 'daemon'], { stdio: 'ignore' });
        const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
        try {
          await once(child, 'spawn');
          if (child.pid === undefined) throw new Error('Missing probe process PID');
          const pending = listProcessSnapshot({ ttlMs: 0 });
          await Promise.resolve();
          const inheritedLocale = execFileSync(process.execPath, ['-e', 'process.stdout.write(process.env.LC_ALL ?? "")'], { encoding: 'utf8' });
          expect(inheritedLocale, phase).toBe('C');
          const observedProcess = (await pending).find(row => row.pid === child.pid);
          expect(observedProcess?.cmd).toContain(script);
          const info = await readProcessInfoByPid(child.pid);
          expect(info?.cmd).toContain(script);
          const runtime = resolveSessionRunnerRuntimeState({
            sessionId: 'unicode-probe',
            tracked: { pid: child.pid, startedBy: 'daemon', processCommand: info?.cmd },
            currentIdentity: {
              status: 'known', source: 'launch_spec', comparableId: `snapshot:${fingerprint}`, entrypointVersion: null,
            },
          });
          expect(runtime.versionState).toBe('current');
        } finally {
          child.kill('SIGTERM');
          await closed;
        }
      }
      expect(process.env.LANG).toBe('C');
      expect(process.env.LC_ALL).toBe('C');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
