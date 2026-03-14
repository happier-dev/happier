import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function restoreEnv(envBackup: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in envBackup)) delete process.env[key];
  }
  Object.assign(process.env, envBackup);
}

describe('resolveDaemonServiceCliRuntimeFromEnv entrypoint resolution', () => {
  const envBackup = { ...process.env };
  const tempHomes: string[] = [];

  afterEach(() => {
    for (const homeDir of tempHomes.splice(0)) {
      rmSync(homeDir, { recursive: true, force: true });
    }
    restoreEnv(envBackup);
    vi.resetModules();
  });

  it('derives the bundled entrypoint for an explicit managed js runtime wrapper path', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'happier-cli-daemon-service-entry-'));
    tempHomes.push(homeDir);
    process.env.HAPPIER_HOME_DIR = homeDir;
    process.env.HAPPIER_DAEMON_SERVICE_NODE_PATH = '/Users/test/.happier/tools/js-runtime/current/bin/happier-js-runtime';

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { resolveDaemonServiceCliRuntimeFromEnv } = await import('./cli.js');
      const runtime = resolveDaemonServiceCliRuntimeFromEnv();
      expect(runtime.nodePath).toBe('/Users/test/.happier/tools/js-runtime/current/bin/happier-js-runtime');
      expect(runtime.entryPath).toContain('/apps/cli/bin/happier.mjs');
    } finally {
      warn.mockRestore();
    }
  });
});
