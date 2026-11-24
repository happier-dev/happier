import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { resolveConnectedAccountDirectExportContractV1 } from '@happier-dev/protocol/connect/pluginConnectedAccountAuthenticationV2';
import { museAccountDescriptor } from './declarations.js';
import { museConnectedAccountRuntime } from './museAccountNativeRuntime.js';

describe('Muse explicit native import', () => {
  it('offers brokered sharing only for every Muse authentication mode', () => {
    for (const mode of museAccountDescriptor.authentication.modes) {
      for (const kind of ['oauth', 'token'] as const) {
        expect(resolveConnectedAccountDirectExportContractV1(mode, kind), `${mode.id}/${kind}`).toBeNull();
      }
    }
  });
  it.each([
    { name: 'JWT expiry', token: 'synthetic.' + btoa(JSON.stringify({ exp: 4102444800 })).replaceAll('=', '') + '.synthetic', expected: '4102444800000' },
    { name: 'unknown expiry', token: 'synthetic-opaque-account-token', expected: undefined },
  ])('imports and enriches $name without changing the native file or acquiring credentials', async ({ token, expected }) => {
    const directory = await mkdtemp(join(tmpdir(), 'muse-native-fixture-'));
    const bytes = JSON.stringify({ schema_version: 1, providers: { meta: {
      access_token: token, api_key: 'synthetic-native-key', api_base_url: 'https://api.meta.ai/v1',
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
      const declaration = museAccountDescriptor.authentication.modes.find(candidate => candidate.id === 'native-import');
      if (!declaration) throw new Error('Expected native import declaration');
      expect(resolveConnectedAccountDirectExportContractV1(declaration, 'oauth')).toBeNull();
      expect(resolveConnectedAccountDirectExportContractV1(declaration, 'token')).toBeNull();
      expect(values.get('expiresAtMs')).toBe(expected);
      // Pre-declaration accounts retain the original native fields, without expiresAtMs.
      values.delete('expiresAtMs');
      const enrich = museConnectedAccountRuntime.enrichCredentialContext;
      const status = enrich
        ? await enrich({ ...context, stagedCredentials: credentials,
          operation: { operationId: 'synthetic-enrich', configurationRevision: 'synthetic-config' } })
        : await museConnectedAccountRuntime.status(context);
      expect(status).toMatchObject({ status: 'connected' });
      expect(status).not.toHaveProperty('diagnostic');
      expect(values.get('expiresAtMs')).toBeUndefined();
      expect(values.get('accountToken')).toBe(token);
      expect(values.get('inferenceKey')).toBe('synthetic-native-key');
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
