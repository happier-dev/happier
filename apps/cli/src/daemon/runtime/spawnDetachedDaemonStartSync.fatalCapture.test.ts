import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { isPidPresent } from '@happier-dev/cli-common/process';

import { withTempDir } from '@/testkit/fs/tempDir';

// Use the CLI harness's 30-second test budget for both the containing test and
// the Windows child-exit observation, rather than expect.poll's shorter default.
const testTimeoutMs = 30_000;

describe('detached daemon fatal capture', () => {
  const originalArgv = process.argv;

  afterEach(() => {
    process.argv = originalArgv;
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it.each([
    { name: 'native abort', script: 'process.abort();\n', reason: /Abort|abort|Native stack trace/ },
    { name: 'V8 heap exhaustion', script: 'const retained = []; while (true) retained.push(new Array(1024).fill(1));\n', reason: /FATAL ERROR:.*heap|heap out of memory/i },
  ])('retains $name on disk without dumping the child environment', async ({ script, reason }) => {
    await withTempDir('daemon-fatal-capture-', async (root) => {
      const entrypoint = join(root, 'package-dist', 'index.mjs');
      await mkdir(join(root, 'package-dist'), { recursive: true });
      const stdoutMarker = 'daemon fixture stdout must be discarded';
      await writeFile(entrypoint, `process.stdout.write(${JSON.stringify(stdoutMarker)});\n${script}`);
      vi.stubEnv('HAPPIER_HOME_DIR', join(root, 'launcher'));
      vi.stubEnv('HAPPIER_CLI_SUBPROCESS_PREFER_TSX', '0');
      // Exercise the real packaged-entrypoint resolver with a disposable child,
      // rather than starting any daemon or replacing an internal launch owner.
      process.argv = [process.execPath, entrypoint, 'daemon', 'start'];
      vi.resetModules();
      const { spawnDetachedDaemonStartSync } = await import('./spawnDetachedDaemonStartSync');
      const privateValue = randomUUID();
      const child = await spawnDetachedDaemonStartSync({
        cwd: root,
        env: {
          ...process.env,
          HAPPIER_HOME_DIR: root,
          DBUS_SESSION_BUS_ADDRESS: '',
          NODE_OPTIONS: '--max-old-space-size=16',
          HAPPIER_FATAL_CAPTURE_PRIVATE_VALUE: privateValue,
        },
      });
      const detachedDaemonPid = child.detachedDaemonPid;
      if (detachedDaemonPid) {
        // Windows returns the short-lived PowerShell launcher. Observe the
        // actual disposable child's termination before reading/removing files.
        await expect.poll(() => isPidPresent(detachedDaemonPid), { timeout: testTimeoutMs }).toBe(false);
      } else {
        const [code, signal] = await once(child, 'close');
        expect(code !== 0 || signal !== null).toBe(true);
      }
      const logsDir = join(root, 'logs');
      const names = await readdir(logsDir).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
      const records = await Promise.all(names.map(name => readFile(join(logsDir, name), 'utf8')));
      expect(records.some(record => reason.test(record))).toBe(true);
      expect(records.some(record => record.includes(privateValue))).toBe(false);
      expect(records.some(record => record.includes(stdoutMarker))).toBe(false);
    });
  }, testTimeoutMs);
});
