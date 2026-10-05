import { afterEach, expect, it, vi } from 'vitest';
import axios from 'axios';

import { reloadConfiguration } from '@/configuration';
import { readStoredCredentials } from '@/persistence';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { captureConsoleLogAndMuteStdout } from '@/testkit/logger/captureOutput';
import { setStdioTtyForTest } from '@/testkit/process/stdio';
import { doAuth } from './auth';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      // Publication metadata is an ignored build artifact unavailable to source-only
      // workers. Model its filesystem boundary as the canonical empty failure list.
      if (String(args[0]).replaceAll('\\', '/').endsWith('/bundled-plugin-publication/failures.json')) {
        return '[]';
      }
      return actual.readFileSync(...args);
    },
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it.each(['unreadable', 'network', 'timeout', 'http'] as const)('reports %s Home features before creating terminal credentials', async (reason) => {
  const home = await createTempDir('happier-auth-feature-admission-');
  const env = createEnvKeyScope([
    'HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL',
    'HAPPIER_PUBLIC_SERVER_URL', 'HAPPIER_ACTIVE_SERVER_ID',
    'HAPPIER_AUTH_METHOD', 'HAPPIER_TAILSCALE_AUTO_PUBLIC_URL',
  ]);
  const restoreTty = setStdioTtyForTest({ stdin: false, stdout: false });
  const output = captureConsoleLogAndMuteStdout();
  // Only filesystem, HTTP and terminal I/O boundaries are replaced; feature parsing,
  // enrollment verification, and credential persistence remain real.
  const originalFetch = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input, init) => {
    if (String(input) === `https://${reason}.feature-admission.example.test/v1/features`) {
      if (reason === 'network') throw new TypeError('Fetch failed');
      if (reason === 'timeout') throw new DOMException('Request timed out', 'AbortError');
      if (reason === 'http') return new Response('', { status: 503 });
      return new Response(JSON.stringify({ features: 'unreadable' }));
    }
    return originalFetch(input, init);
  }));
  try {
    env.patch({
      HAPPIER_HOME_DIR: home,
      HAPPIER_SERVER_URL: `https://${reason}.feature-admission.example.test`,
      HAPPIER_WEBAPP_URL: `https://${reason}.feature-admission.example.test`,
      HAPPIER_PUBLIC_SERVER_URL: undefined,
      HAPPIER_ACTIVE_SERVER_ID: undefined,
      HAPPIER_AUTH_METHOD: 'web',
      HAPPIER_TAILSCALE_AUTO_PUBLIC_URL: '0',
    });
    // Load the source graph during collection, then use the configuration owner
    // to select this test's Home. Compilation is outside the behavior wait budget.
    reloadConfiguration();
    const post = vi.spyOn(axios, 'post').mockRejectedValue(new Error('Unexpected authentication request'));
    await expect(doAuth()).resolves.toBeNull();
    expect(post).not.toHaveBeenCalled();
    expect(await readStoredCredentials()).toBeNull();
    const text = output.logs.join('\n');
    expect(text).toContain({
      unreadable: 'HOME_FEATURES_UNREADABLE',
      network: 'HOME_FEATURES_NETWORK',
      timeout: 'HOME_FEATURES_TIMEOUT',
      http: 'HOME_FEATURES_HTTP_ERROR',
    }[reason]);
    expect(text).not.toContain('Unable to verify the selected Home identity');
  } finally {
    output.restore();
    restoreTty();
    env.restore();
    reloadConfiguration();
    await removeTempDir(home);
  }
});
