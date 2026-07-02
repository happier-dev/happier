import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDirSync, removeTempDirSync } from '@/testkit/fs/tempDir';

const ENV_KEYS = [
  'HAPPIER_HOME_DIR',
  'HAPPIER_ACTIVE_SERVER_ID',
  'HAPPIER_SERVER_URL',
  'HAPPIER_LOCAL_SERVER_URL',
  'HAPPIER_PUBLIC_SERVER_URL',
  'HAPPIER_WEBAPP_URL',
  'HAPPIER_ACCESS_TOKEN',
] as const;

let envScope = createEnvKeyScope(ENV_KEYS);
const tempDirs = new Set<string>();

afterEach(() => {
  envScope.restore();
  envScope = createEnvKeyScope(ENV_KEYS);
  for (const dir of tempDirs) removeTempDirSync(dir);
  tempDirs.clear();
  vi.resetModules();
});

describe('resolveHappierRuntimeContextEnvFromConfiguration', () => {
  it('forwards the resolved configuration home/server context as authoritative, non-secret env', async () => {
    const home = createTempDirSync('happier-runtime-ctx-home-');
    tempDirs.add(home);
    envScope.patch({
      HAPPIER_HOME_DIR: home,
      HAPPIER_ACTIVE_SERVER_ID: 'preview',
      // public != server -> split local/public stack
      HAPPIER_PUBLIC_SERVER_URL: 'https://public.happier.example',
      HAPPIER_SERVER_URL: 'http://127.0.0.1:48999',
      HAPPIER_WEBAPP_URL: 'https://app.happier.example',
      HAPPIER_ACCESS_TOKEN: 'secret-token-that-must-not-leak',
    });
    vi.resetModules();

    const { resolveHappierRuntimeContextEnvFromConfiguration } = await import(
      './resolveHappierRuntimeContextEnvFromConfiguration'
    );
    const { HAPPIER_RUNTIME_CONTEXT_ENV_KEYS } = await import('./resolveHappierRuntimeContextEnv');

    const env = resolveHappierRuntimeContextEnvFromConfiguration();

    // Home dir flows through from configuration (the credential anchor).
    expect(env.HAPPIER_HOME_DIR).toBe(home);
    // A resolved server URL is always present.
    expect(env.HAPPIER_SERVER_URL).toBeTruthy();

    // Only allowed, non-secret context keys are emitted.
    for (const key of Object.keys(env)) {
      expect(HAPPIER_RUNTIME_CONTEXT_ENV_KEYS).toContain(key);
    }
    expect(env).not.toHaveProperty('HAPPIER_ACCESS_TOKEN');
    expect(JSON.stringify(env)).not.toContain('secret-token-that-must-not-leak');
  });
});
