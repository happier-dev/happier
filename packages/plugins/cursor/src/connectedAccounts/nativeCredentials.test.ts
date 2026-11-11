import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPluginHttpFixture } from '@happier-dev/plugin-sdk/testing';
import type { ConnectedAccountAuthenticationContext, ConnectedAccountPortableAuthenticationContext } from '@happier-dev/plugin-sdk/connected-accounts';

import { createCursorNativeImportMode, readCursorNativeCredential } from './nativeCredentials.js';

function nativeFixturePath(selected: string) {
  return process.platform === 'win32' ? join(selected, '.config', 'Cursor', 'auth.json')
    : process.platform === 'darwin' ? join(selected, '.cursor', 'auth.json') : join(selected, '.config', 'cursor', 'auth.json');
}
const credentials = { accessToken: 'fake-native-access', refreshToken: 'fake-native-refresh' };
const homes: string[] = [];
async function home() {
  const path = await mkdtemp(join(tmpdir(), 'happier-cursor-native-'));
  homes.push(path);
  return path;
}
async function put(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value));
}
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(homes.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe('Cursor CLI native subscription import', () => {
  it('reads Linux native auth.json from the selected home without changing the native login', async () => {
    const selected = await home();
    const path = join(selected, '.config', 'cursor', 'auth.json');
    await put(path, credentials);
    const original = await readFile(path, 'utf8');
    await expect(readCursorNativeCredential({ environment: { HOME: selected }, platform: 'linux' })).resolves.toEqual(credentials);
    expect(await readFile(path, 'utf8')).toBe(original);
  });
  it('honors XDG_CONFIG_HOME and does not mistake cli-config settings for credentials', async () => {
    const selected = await home();
    await put(join(selected, 'config', 'cursor', 'auth.json'), credentials);
    await put(join(selected, '.cursor', 'cli-config.json'), { accessToken: 'wrong-account' });
    await expect(readCursorNativeCredential({ environment: { HOME: selected, XDG_CONFIG_HOME: join(selected, 'config') }, platform: 'linux' })).resolves.toEqual(credentials);
  });
  it.each([true, false])('reads Windows native storage with APPDATA configured=%s', async configured => {
    const selected = await home();
    const appdata = configured ? join(selected, 'roaming') : join(selected, 'AppData', 'Roaming');
    await put(join(appdata, 'Cursor', 'auth.json'), credentials);
    await expect(readCursorNativeCredential({ environment: { HOME: selected, USERPROFILE: selected, ...(configured ? { APPDATA: appdata } : {}) }, platform: 'win32' })).resolves.toEqual(credentials);
  });
  it('uses the explicit macOS file store instead of Keychain', async () => {
    const selected = await home();
    await put(join(selected, '.cursor', 'auth.json'), credentials);
    await expect(readCursorNativeCredential({ environment: { HOME: selected, AGENT_CLI_CREDENTIAL_STORE: 'file' }, platform: 'darwin',
      readKeyring: async () => { throw new Error('Keychain must not be read'); },
    })).resolves.toEqual(credentials);
  });
  it('uses the macOS selected Keychain identities and does not borrow a stale native file', async () => {
    const selected = await home();
    await put(join(selected, '.cursor', 'auth.json'), { accessToken: 'wrong', refreshToken: 'wrong' });
    // macOS Keychain is an OS credential boundary; all selection and parsing remain real.
    await expect(readCursorNativeCredential({ environment: { HOME: selected }, platform: 'darwin',
      readKeyring: async ({ service, account }: { service: string; account: string }) => account === 'cursor-user'
        ? service === 'cursor-access-token' ? credentials.accessToken : service === 'cursor-refresh-token' ? credentials.refreshToken : null : null,
    })).resolves.toEqual(credentials);
    await expect(readCursorNativeCredential({ environment: { HOME: selected }, platform: 'darwin', readKeyring: async () => null }))
      .rejects.toMatchObject({ code: 'credentials_unavailable' });
  });
  it('refuses missing, malformed, API-key and incomplete native stores without leaking parser input', async () => {
    const selected = await home();
    const options = { environment: { HOME: selected }, platform: 'linux' as const };
    await expect(readCursorNativeCredential(options)).rejects.toMatchObject({ code: 'credentials_unavailable' });
    for (const value of ['fake-secret malformed-json', [], {}, { ...credentials, apiKey: 'fake-api-key' }, { accessToken: 'fake-secret' }]) {
      await put(join(selected, '.config', 'cursor', 'auth.json'), value);
      const error = await readCursorNativeCredential(options).catch(error => error);
      expect(error).toMatchObject({ code: 'schema_unsupported' });
      expect(String(error)).not.toContain('fake-secret');
    }
  });
  it('rejects the ephemeral store and propagates cancellation instead of reading another source', async () => {
    const selected = await home();
    await put(join(selected, '.config', 'cursor', 'auth.json'), credentials);
    await expect(readCursorNativeCredential({ environment: { HOME: selected, AGENT_CLI_CREDENTIAL_STORE: 'memory' }, platform: 'linux' }))
      .rejects.toMatchObject({ code: 'credentials_unavailable' });
    const abort = new AbortController(); abort.abort();
    await expect(readCursorNativeCredential({ environment: { HOME: selected }, platform: 'linux', signal: abort.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
  });
});

function importContext() {
  const values = new Map<string, string>();
  const service = { pluginId: 'happier.agent.cursor', localId: 'cursor-account' };
  const context = {
    plugin: { id: service.pluginId, version: '0.0.0' }, contribution: { id: service.localId, qualifiedId: `${service.pluginId}/${service.localId}` },
    surface: 'ui', invokedAtMs: 1000, service, attempt: { kind: 'connect', attemptId: 'native-fixture' },
    configuration: { target: { kind: 'attempt', service, attemptId: 'native-fixture', modeId: 'native-import' }, revision: '1', values: {}, async getSecret() { return null; } },
    signal: new AbortController().signal,
    attemptCredentials: { async get(key: string) { return values.get(key) ?? null; },
      async set(key: string, value: string) { values.set(key, value); }, async delete(key: string) { values.delete(key); } },
    services: { http: createPluginHttpFixture({ async request() { throw new Error('Native import must not call HTTP'); } }) },
  } satisfies ConnectedAccountPortableAuthenticationContext;
  // Only credential storage, environment and OS keychain are boundaries; the native mode and shared token writer remain real.
  return { context: context as ConnectedAccountAuthenticationContext, values };
}

describe('Cursor native import manual mode', () => {
  it('stores the selected native subscription and expiry through the shared token owner without modifying native storage', async () => {
    const selected = await home();
    const path = nativeFixturePath(selected);
    const accessToken = `e30.${Buffer.from(JSON.stringify({ exp: 4102444800 })).toString('base64url')}.fixture`;
    await put(path, { ...credentials, accessToken });
    vi.stubEnv('HOME', selected); vi.stubEnv('USERPROFILE', selected);
    vi.stubEnv('XDG_CONFIG_HOME', join(selected, '.config')); vi.stubEnv('APPDATA', join(selected, '.config')); vi.stubEnv('AGENT_CLI_CREDENTIAL_STORE', 'file');
    const fixture = importContext();
    const result = await createCursorNativeImportMode().complete({ fields: { source: 'native' } }, fixture.context);
    expect(result).toMatchObject({ status: 'connected', credentialKind: 'oauth' });
    expect(fixture.values).toEqual(new Map([['accessToken', accessToken], ['refreshToken', credentials.refreshToken], ['credentialKind', 'oauth'], ['expiresAtMs', '4102444800000']]));
    expect(JSON.stringify(result)).not.toContain(accessToken);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ ...credentials, accessToken });
  });
  it('rejects arbitrary native sources before acquisition and returns sanitized missing/malformed outcomes', async () => {
    const selected = await home();
    vi.stubEnv('HOME', selected); vi.stubEnv('USERPROFILE', selected);
    vi.stubEnv('XDG_CONFIG_HOME', join(selected, '.config')); vi.stubEnv('APPDATA', join(selected, '.config')); vi.stubEnv('AGENT_CLI_CREDENTIAL_STORE', 'file');
    const fixture = importContext();
    const mode = createCursorNativeImportMode();
    await expect(mode.complete({ fields: { source: '/another/account' } }, fixture.context))
      .resolves.toMatchObject({ status: 'rejected', diagnostic: { code: 'cursor_native_source_unsupported' } });
    await expect(mode.complete({ fields: { source: 'native' } }, fixture.context))
      .resolves.toMatchObject({ status: 'unavailable', diagnostic: { code: 'cursor_native_credentials_unavailable' } });
    await put(nativeFixturePath(selected), 'fake-secret malformed-json');
    const result = await mode.complete({ fields: { source: 'native' } }, fixture.context);
    expect(result).toMatchObject({ status: 'rejected', diagnostic: { code: 'cursor_native_schema_unsupported' } });
    expect(JSON.stringify(result)).not.toContain('fake-secret');
    expect(fixture.values.size).toBe(0);
  });
});
