import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SERVER_ENV_KEYS = [
  'HAPPIER_ACTIVE_SERVER_ID',
  'HAPPIER_SERVER_URL',
  'HAPPIER_LOCAL_SERVER_URL',
  'HAPPIER_PUBLIC_SERVER_URL',
  'HAPPIER_WEBAPP_URL',
  'HAPPIER_STACK_ENV_FILE',
] as const;

function stubServerEnv(values: Partial<Record<typeof SERVER_ENV_KEYS[number], string>>): void {
  for (const key of SERVER_ENV_KEYS) {
    vi.stubEnv(key, values[key] ?? '');
  }
}

describe('resolveServerHttpBaseUrl', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('uses the live runtime endpoint instead of stale loaded configuration', async () => {
    stubServerEnv({ HAPPIER_SERVER_URL: 'http://127.0.0.1:41001' });
    await import('@/configuration');

    stubServerEnv({ HAPPIER_LOCAL_SERVER_URL: 'http://127.0.0.1:52002/' });
    const { resolveServerHttpBaseUrl } = await import('./serverHttpBaseUrl');

    expect(resolveServerHttpBaseUrl()).toBe('http://127.0.0.1:52002');
  });

  it('prefers an explicit invocation endpoint over an inherited stack env file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-server-http-base-url-'));
    const stackEnvFile = join(directory, 'stack.env');
    await writeFile(stackEnvFile, 'HAPPIER_SERVER_URL=http://127.0.0.1:52753\n');
    try {
      stubServerEnv({
        HAPPIER_SERVER_URL: 'http://127.0.0.1:53288',
        HAPPIER_STACK_ENV_FILE: stackEnvFile,
      });
      const { resolveServerHttpBaseUrl } = await import('./serverHttpBaseUrl');

      expect(resolveServerHttpBaseUrl()).toBe('http://127.0.0.1:53288');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
