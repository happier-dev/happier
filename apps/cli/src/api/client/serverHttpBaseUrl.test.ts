import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SERVER_ENV_KEYS = [
  'HAPPIER_ACTIVE_SERVER_ID',
  'HAPPIER_SERVER_URL',
  'HAPPIER_LOCAL_SERVER_URL',
  'HAPPIER_PUBLIC_SERVER_URL',
  'HAPPIER_WEBAPP_URL',
] as const;

function stubServerEnv(values: Partial<Record<typeof SERVER_ENV_KEYS[number], string>>): void {
  for (const key of SERVER_ENV_KEYS) {
    vi.stubEnv(key, values[key] ?? '');
  }
}

describe('resolveServerHttpBaseUrl', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    for (const directory of tempDirs.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('changes endpoints only after the canonical configuration selection is reloaded', async () => {
    vi.resetModules();
    stubServerEnv({
      HAPPIER_ACTIVE_SERVER_ID: 'stale-stack',
      HAPPIER_SERVER_URL: 'http://127.0.0.1:41001',
    });

    const configurationModule = await import('@/configuration');
    const { resolveServerHttpBaseUrl } = await import('./serverHttpBaseUrl');

    stubServerEnv({
      HAPPIER_ACTIVE_SERVER_ID: 'live-stack',
      HAPPIER_SERVER_URL: 'http://127.0.0.1:52002',
    });

    expect(resolveServerHttpBaseUrl()).toBe('http://127.0.0.1:41001');

    configurationModule.reloadConfiguration();
    expect(resolveServerHttpBaseUrl()).toBe('http://127.0.0.1:52002');
  });

  it('keeps HTTP and socket traffic on the persisted active profile when inherited URLs contradict it', async () => {
    const homeDir = join(tmpdir(), `happier-server-http-selection-${process.pid}-${Date.now()}`);
    tempDirs.push(homeDir);
    mkdirSync(homeDir, { recursive: true });
    writeFileSync(join(homeDir, 'settings.json'), JSON.stringify({
      schemaVersion: 6,
      activeServerId: 'selected-profile',
      servers: {
        'selected-profile': {
          id: 'selected-profile',
          serverUrl: 'http://127.0.0.1:52755',
          localServerUrl: 'http://127.0.0.1:52755',
          webappUrl: 'http://localhost:18829',
        },
        'other-profile': {
          id: 'other-profile',
          serverUrl: 'http://127.0.0.1:52753',
          localServerUrl: 'http://127.0.0.1:52753',
          webappUrl: 'http://localhost:18829',
        },
      },
    }));
    vi.stubEnv('HAPPIER_HOME_DIR', homeDir);
    stubServerEnv({
      HAPPIER_ACTIVE_SERVER_ID: 'selected-profile',
      HAPPIER_SERVER_URL: 'http://127.0.0.1:52753',
      HAPPIER_WEBAPP_URL: 'http://localhost:18829',
    });

    const { configuration } = await import('@/configuration');
    const { resolveServerHttpBaseUrl } = await import('./serverHttpBaseUrl');

    expect(configuration.activeServerId).toBe('selected-profile');
    expect(configuration.apiServerUrl).toBe('http://127.0.0.1:52755');
    expect(resolveServerHttpBaseUrl()).toBe('http://127.0.0.1:52755');
  });
});
