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

describe('resolveDaemonServiceCliRuntimeFromEnv', () => {
  const envBackup = { ...process.env };
  const tempHomes: string[] = [];

  afterEach(() => {
    for (const homeDir of tempHomes.splice(0)) {
      rmSync(homeDir, { recursive: true, force: true });
    }
    restoreEnv(envBackup);
    vi.resetModules();
  });

  it('allows an explicit UID 0 from HAPPIER_DAEMON_SERVICE_UID', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'happier-cli-daemon-service-uid-'));
    tempHomes.push(homeDir);
    process.env.HAPPIER_HOME_DIR = homeDir;
    process.env.HAPPIER_DAEMON_SERVICE_UID = '0';

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { resolveDaemonServiceCliRuntimeFromEnv } = await import('./cli');
      const runtime = resolveDaemonServiceCliRuntimeFromEnv();
      expect(runtime.uid).toBe(0);
    } finally {
      warn.mockRestore();
    }
  });
});
