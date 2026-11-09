import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { museConnectedAccountRuntime } from './museAccountNativeRuntime.js';

describe('Muse explicit native import', () => {
  it('reads only the selected native file without changing it or acquiring credentials', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'muse-native-fixture-'));
    const bytes = JSON.stringify({ schema_version: 1, providers: { meta: {
      access_token: 'synthetic-account-token', api_key: 'synthetic-native-key', api_base_url: 'https://api.meta.ai/v1',
      mechanism: 'oauth', obtained_via: 'device_code', subs_active: false,
    } } });
    await mkdir(join(directory, 'muse'));
    await writeFile(join(directory, 'muse', 'auth.json'), bytes, { mode: 0o600 });
    vi.stubEnv('XDG_CONFIG_HOME', directory);
    const mode = museConnectedAccountRuntime.authentication.modes['native-import'];
    if (!mode || mode.kind !== 'manual') throw new Error('Expected native import');
    const values = new Map<string, string>();
    const credentials = {
      async get(key: string) { return values.get(key) ?? null; },
      async set(key: string, value: string) { values.set(key, value); },
      async delete(key: string) { values.delete(key); },
    };
    const context = {
      signal: new AbortController().signal, attemptCredentials: credentials, credentials,
      services: { http: { async request() { throw new Error('Import must not use HTTP'); } } },
    } as Parameters<typeof mode.complete>[1];
    try {
      await expect(mode.complete({ fields: { source: 'native' } }, context)).resolves.toMatchObject({ status: 'connected', credentialKind: 'oauth' });
      const result = await museConnectedAccountRuntime.materialize({ kind: 'files', fileIds: ['muse/auth.json'] }, context);
      if (result.kind !== 'files') throw new Error('Expected file materialization');
      expect(JSON.parse(new TextDecoder().decode(result.files['muse/auth.json']))).toEqual(JSON.parse(bytes));
      expect(await readFile(join(directory, 'muse', 'auth.json'), 'utf8')).toBe(bytes);
      await writeFile(join(directory, 'muse', 'auth.json'), JSON.stringify({ schema_version: 999, providers: {} }));
      await expect(mode.complete({ fields: { source: 'native' } }, context)).resolves.toMatchObject({ status: 'unavailable' });
      vi.stubEnv('XDG_CONFIG_HOME', 'relative-config');
      await expect(mode.complete({ fields: { source: 'native' } }, context)).resolves.toMatchObject({ status: 'unavailable', diagnostic: { details: { reason: 'native_root_invalid' } } });
    } finally { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); }
  });
});
