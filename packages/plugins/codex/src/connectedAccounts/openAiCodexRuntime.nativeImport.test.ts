import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConnectedAccountAuthenticationContext } from '@happier-dev/plugin-sdk/connected-accounts';
import { openAiCodexConnectedAccountRuntime as runtime } from './openAiCodexNativeRuntime.js';

function jwt(payload: Record<string, unknown>) {
  return `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
}
function context(values: Map<string, string>): ConnectedAccountAuthenticationContext {
  // The persisted attempt store is an external credential boundary; acquisition/parser remain real.
  return {
    signal: new AbortController().signal,
    attemptCredentials: {
      async get(key: string) { return values.get(key) ?? null; },
      async set(key: string, value: string) { values.set(key, value); },
      async delete(key: string) { values.delete(key); },
    },
    services: {},
  } as ConnectedAccountAuthenticationContext;
}
function mode() {
  const selected = runtime.authentication.modes['native-import'];
  if (!selected || selected.kind !== 'manual') throw new Error('Native import mode unavailable');
  return selected;
}

describe('Codex Connected Account native import', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });
  it('stores the selected native OAuth account through the existing attempt store without refresh or native writes', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codex-native-import-'));
    dirs.push(home);
    vi.stubEnv('CODEX_HOME', home);
    const accessToken = jwt({ exp: 4_102_444_800 });
    const idToken = jwt({ email: 'native@example.test', 'https://api.openai.com/auth': { chatgpt_account_id: 'account-native' }, exp: 1 });
    const original = JSON.stringify({ auth_mode: 'chatgpt', tokens: {
      id_token: idToken, access_token: accessToken, refresh_token: 'native-refresh',
    } });
    await writeFile(join(home, 'auth.json'), original);
    const values = new Map<string, string>();
    const connected = await mode().complete({ fields: { source: 'native' } }, context(values));
    expect(connected).toMatchObject({
      status: 'connected', expiresAt: 4_102_444_800_000, providerIdentity: { accountId: 'account-native', email: 'native@example.test' },
    });
    expect(connected).not.toHaveProperty('accountId');
    expect(values.get('accessToken')).toBe(accessToken);
    expect(values.get('refreshToken')).toBe('native-refresh');
    expect(values.get('idToken')).toBe(idToken);
    expect(values.get('providerAccountId')).toBe('account-native');
    expect(values.get('expiresAtMs')).toBe('4102444800000');
    await expect(runtime.status({ credentials: context(values).attemptCredentials } as Parameters<typeof runtime.status>[0]))
      .resolves.toMatchObject({ status: 'connected', expiresAt: 4_102_444_800_000 });
    expect(await readFile(join(home, 'auth.json'), 'utf8')).toBe(original);
  });
  it('rejects expired access and non-OAuth native records without storing credentials', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codex-native-invalid-'));
    dirs.push(home);
    vi.stubEnv('CODEX_HOME', home);
    for (const record of [
      { tokens: { id_token: jwt({ exp: 4_102_444_800, chatgpt_account_id: 'native' }), access_token: jwt({ exp: 1 }), refresh_token: 'refresh' } },
      { auth_mode: 'apikey', OPENAI_API_KEY: 'private-api-key', tokens: { id_token: 'hidden-id', access_token: 'hidden-access', refresh_token: 'hidden-refresh', account_id: 'hidden-account' } },
    ]) {
      await writeFile(join(home, 'auth.json'), JSON.stringify(record));
      const values = new Map<string, string>();
      await expect(mode().complete({ fields: { source: 'native' } }, context(values))).resolves.toMatchObject({
        status: 'rejected', diagnostic: { code: 'openai_codex_import_reauthorization_required' },
      });
      expect(values.size).toBe(0);
    }
  });
  it('rejects arbitrary source ids before reading native credentials', async () => {
    const values = new Map<string, string>();
    await expect(mode().complete({ fields: { source: '/private/credentials' } }, context(values))).resolves.toMatchObject({
      status: 'rejected', diagnostic: { code: 'openai_codex_import_source_unsupported' },
    });
    expect(values.size).toBe(0);
  });
});
