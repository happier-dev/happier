import { afterEach, expect, it, vi } from 'vitest';
import axios from 'axios';
import { inspect } from 'node:util';

import { reloadConfiguration } from '@/configuration';
import { readStoredCredentials, updateSettings } from '@/persistence';
import { adoptServerProfileHomeConnectionDescriptor } from '@/server/serverProfiles';
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

it.each([true, false])('uses the selected descriptor before pairing when public discovery omits it (matching identity=%s)', async (identityMatches) => {
  const home = await createTempDir('happier-auth-public-omission-');
  const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL',
    'HAPPIER_PUBLIC_SERVER_URL', 'HAPPIER_ACTIVE_SERVER_ID', 'HAPPIER_AUTH_METHOD', 'HAPPIER_TAILSCALE_AUTO_PUBLIC_URL']);
  const restoreTty = setStdioTtyForTest({ stdin: false, stdout: false });
  const output = captureConsoleLogAndMuteStdout();
  const origin = `https://${identityMatches ? 'matching' : 'wrong'}.selected-home.example.test`;
  const descriptor = { v: 1 as const, homeServerIdentityId: 'srv_selected_home', canonicalServerUrl: origin,
    revision: 1, endpoints: [{ kind: 'https' as const, url: origin }] };
  const post = vi.spyOn(axios, 'post').mockRejectedValue(new Error('Pairing request reached'));
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json({ features: {}, capabilities: {
    serverIdentity: { serverIdentityId: identityMatches ? descriptor.homeServerIdentityId : 'srv_other_home' },
  } })));
  try {
    env.patch({ HAPPIER_HOME_DIR: home, HAPPIER_SERVER_URL: undefined, HAPPIER_WEBAPP_URL: undefined,
      HAPPIER_PUBLIC_SERVER_URL: undefined, HAPPIER_ACTIVE_SERVER_ID: undefined,
      HAPPIER_AUTH_METHOD: 'web', HAPPIER_TAILSCALE_AUTO_PUBLIC_URL: '0' });
    reloadConfiguration();
    await adoptServerProfileHomeConnectionDescriptor({ descriptor, observation: 'exact', use: true });
    reloadConfiguration();
    await expect(doAuth()).resolves.toBeNull();
    expect(post).toHaveBeenCalledTimes(identityMatches ? 1 : 0);
    if (identityMatches) expect(post.mock.calls[0]?.[0]).toBe(`${origin}/v1/auth/request`);
    else expect(output.logs.join('\n')).toContain('HOME_AUTHORITY_MISMATCH');
    expect(await readStoredCredentials()).toBeNull();
  } finally {
    output.restore(); restoreTty(); env.restore(); reloadConfiguration(); await removeTempDir(home);
  }
});

it('reports an invalid saved Home web app URL before attempting terminal authentication', async () => {
  const home = await createTempDir('happier-auth-invalid-webapp-');
  const env = createEnvKeyScope([
    'HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL',
    'HAPPIER_PUBLIC_SERVER_URL', 'HAPPIER_ACTIVE_SERVER_ID', 'HAPPIER_AUTH_METHOD',
  ]);
  const restoreTty = setStdioTtyForTest({ stdin: false, stdout: false });
  const output = captureConsoleLogAndMuteStdout();
  try {
    env.patch({ HAPPIER_HOME_DIR: home, HAPPIER_SERVER_URL: undefined,
      HAPPIER_WEBAPP_URL: undefined, HAPPIER_PUBLIC_SERVER_URL: undefined,
      HAPPIER_ACTIVE_SERVER_ID: undefined, HAPPIER_AUTH_METHOD: 'web' });
    reloadConfiguration();
    await updateSettings(current => ({ ...current, activeServerId: 'borrowed-home', servers: {
      ...current.servers,
      'borrowed-home': { id: 'borrowed-home', name: 'Borrowed Home',
        serverUrl: 'http://127.0.0.1:43005',
        webappUrl: 'http://happier-qa.localhost:19364/?server=http%3A%2F%2Fhappier-qa.localhost%3A43005&happier_hmr=0',
        createdAt: 1, updatedAt: 1 },
    } }));
    reloadConfiguration();
    const post = vi.spyOn(axios, 'post').mockRejectedValue(new Error('Unexpected authentication request'));
    const fetchBoundary = vi.fn<typeof fetch>(async () => { throw new Error('Unexpected network request'); });
    vi.stubGlobal('fetch', fetchBoundary);
    await expect(doAuth()).resolves.toBeNull();
    const text = output.logs.join('\n');
    expect(text).toContain('invalid_target: Home web app URL is invalid');
    expect(text).not.toContain('Use HTTPS or loopback HTTP');
    expect(post).not.toHaveBeenCalled();
    expect(fetchBoundary).not.toHaveBeenCalled();
    expect(await readStoredCredentials()).toBeNull();
  } finally {
    output.restore(); restoreTty(); env.restore(); reloadConfiguration(); await removeTempDir(home);
  }
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

it('keeps HTTP credentials out of interactive authentication DEBUG errors', async () => {
  const home = await createTempDir('happier-auth-debug-error-');
  const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL',
    'HAPPIER_PUBLIC_SERVER_URL', 'HAPPIER_ACTIVE_SERVER_ID', 'HAPPIER_AUTH_METHOD', 'HAPPIER_TAILSCALE_AUTO_PUBLIC_URL', 'DEBUG']);
  const restoreTty = setStdioTtyForTest({ stdin: false, stdout: false });
  const output = captureConsoleLogAndMuteStdout();
  const origin = 'https://debug-auth.example.test';
  const token = 'debug-private-bearer';
  const password = 'debug-private-password';
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json({
    features: {}, capabilities: { serverIdentity: { serverIdentityId: 'srv_debug_auth' } },
  })));
  const post = vi.spyOn(axios, 'post').mockRejectedValue(Object.assign(new Error(`Authorization: Bearer ${token}`), {
    code: 'ERR_BAD_RESPONSE', response: { status: 500, data: { token } },
    config: { headers: { Authorization: `Bearer ${token}` }, data: { password } },
  }));
  try {
    env.patch({ HAPPIER_HOME_DIR: home, HAPPIER_SERVER_URL: origin, HAPPIER_WEBAPP_URL: origin,
      HAPPIER_PUBLIC_SERVER_URL: undefined, HAPPIER_ACTIVE_SERVER_ID: undefined,
      HAPPIER_AUTH_METHOD: 'web', HAPPIER_TAILSCALE_AUTO_PUBLIC_URL: '0', DEBUG: '1' });
    reloadConfiguration();
    await expect(doAuth()).resolves.toBeNull();
    expect(post).toHaveBeenCalled();
    const printed = inspect(vi.mocked(console.log).mock.calls, { depth: null, maxStringLength: null });
    expect(printed).not.toContain(token);
    expect(printed).not.toContain(password);
    expect(printed).toContain('ERR_BAD_RESPONSE');
    expect(printed).toContain('500');
    expect(await readStoredCredentials()).toBeNull();
  } finally {
    output.restore(); restoreTty(); env.restore(); reloadConfiguration(); await removeTempDir(home);
  }
});
