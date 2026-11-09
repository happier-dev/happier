import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { ConnectedAccountAuthenticationContext } from '@happier-dev/plugin-sdk/connected-accounts';
import { createKimiNativeConnectedAccountRuntime } from './nativeRuntime.js';

const directories: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
it('explicitly imports only the non-default Node reference without changing native A', async () => {
  const home = await mkdtemp(join(tmpdir(), 'kimi-fake-native-')); directories.push(home);
  vi.stubEnv('KIMI_CODE_HOME', home);
  await mkdir(join(home, 'credentials'));
  const config = 'default_model = "custom/b"\n[providers.personal]\ntype = "kimi"\nbase_url = "https://api.kimi.ai/coding/v1"\n[providers.personal.oauth]\nstorage = "file"\nkey = "selected-b"\n[models."custom/b"]\nprovider = "personal"\nmodel = "b"\nmax_context_size = 128000\n';
  await writeFile(join(home, 'config.toml'), config);
  const original = JSON.stringify({ access_token: 'fake-b', refresh_token: 'fake-root-b', expires_at: 4102444800 });
  await writeFile(join(home, 'credentials', 'selected-b.json'), original);
  await writeFile(join(home, 'credentials', 'unrelated-a.json'), 'malformed unrelated credentials');
  const values = new Map<string, string>();
  const mode = createKimiNativeConnectedAccountRuntime().authentication.modes['native-import'];
  expect(mode).toBeDefined();
  if (!mode || mode.kind !== 'manual') throw new Error('Native import mode missing');
  // OS files and persisted attempt credentials are boundaries; parser and runtime stay real.
  const daemon = new Map<string, string>([['kimi-device-id', 'fake-existing-install']]);
  const context = { invokedAtMs: 1800000000000, signal: new AbortController().signal, services: { storage: { daemon: { async transaction<T>(work: (store: { get(key: string): Promise<string | null>; set(key: string, value: string): Promise<void> }) => Promise<T>) {
    return work({ async get(key) { return daemon.get(key) ?? null; }, async set(key, value) { daemon.set(key, value); } });
  } } } }, attemptCredentials: {
    async get(key: string) { return values.get(key) ?? null; }, async set(key: string, value: string) { values.set(key, value); }, async delete(key: string) { values.delete(key); },
  } } as ConnectedAccountAuthenticationContext;
  expect(await mode.complete({ fields: { source: 'native' } }, context)).toMatchObject({ status: 'connected', credentialKind: 'oauth' });
  expect(values.get('accessToken')).toBe('fake-b');
  expect(values.get('refreshToken')).toBe('fake-root-b');
  expect(values.get('apiBase')).toBe('https://api.kimi.ai/coding/v1');
  expect(values.get('deviceId')).toBe('fake-existing-install');
  expect(await readFile(join(home, 'credentials', 'selected-b.json'), 'utf8')).toBe(original);
  expect(await readFile(join(home, 'config.toml'), 'utf8')).toBe(config);
});
