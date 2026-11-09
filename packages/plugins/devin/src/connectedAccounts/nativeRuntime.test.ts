import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ConnectedAccountAuthenticationContext, ConnectedAccountRuntime } from '@happier-dev/plugin-sdk/connected-accounts';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { DEVIN_PLUGIN } from '../manifest.js';
import { DEVIN_NATIVE_FILE } from './nativeCredentials.js';
import { parse } from 'smol-toml';

const fixtures = [
  { mode: 'session', kind: 'oauth', raw: 'windsurf_api_key = "devin-session-token$eyJ.fake.B"\napi_server_url = "https://server.codeium.com"\ndevin_webapp_host = "app.devin.ai"\ndevin_api_url = "https://api.devin.ai"\n' },
  { mode: 'enterprise', kind: 'token', raw: 'windsurf_api_key = "fake-seat-B"\napi_server_url = "https://enterprise.example.test"\n' },
] as const;
describe('registered Devin explicit native import', () => {
  it.each(fixtures)('imports only the selected native $mode file and preserves complete metadata', async fixture => {
    const root = await mkdtemp(join(tmpdir(), 'devin-native-import-'));
    const kit = await createPluginTestkit({ manifest: DEVIN_PLUGIN.manifest, module: { activate: DEVIN_PLUGIN.activate } });
    const owner = kit.registration('connectedAccountDescriptors', 'devin-account');
    const mode = owner?.authentication.modes['native-import'];
    try {
      if (!owner || mode?.kind !== 'manual') throw new Error('Native import is not registered');
      await mkdir(join(root, 'devin'));
      const path = join(root, DEVIN_NATIVE_FILE);
      await writeFile(path, fixture.raw, { mode: 0o600 });
      vi.stubEnv(process.platform === 'win32' ? 'APPDATA' : 'XDG_DATA_HOME', root);
      const values = new Map<string, string>();
      const credentials = { get: async (key: string) => values.get(key) ?? null,
        set: async (key: string, value: string) => { values.set(key, value); }, delete: async (key: string) => { values.delete(key); } };
      const context = { signal: new AbortController().signal, attemptCredentials: credentials,
        services: { http: { async request() { throw new Error('Native import must not call HTTP'); } } },
      } as ConnectedAccountAuthenticationContext;
      expect(await mode.complete({ fields: { source: 'other' } }, context)).toMatchObject({ status: 'unavailable' });
      expect(values.size).toBe(0);
      expect(await mode.complete({ fields: { source: 'native' } }, context)).toMatchObject({ status: 'connected', credentialKind: fixture.kind });
      expect(values.get('credentialMode')).toBe(fixture.mode);
      const read = { ...context, credentials } as Parameters<ConnectedAccountRuntime['status']>[0];
      const result = await owner.materialize({ kind: 'files', fileIds: [DEVIN_NATIVE_FILE] }, read);
      if (result.kind !== 'files') throw new Error('Expected native material');
      expect(parse(new TextDecoder().decode(result.files[DEVIN_NATIVE_FILE]))).toEqual(parse(fixture.raw));
      expect(await readFile(path, 'utf8')).toBe(fixture.raw);
      values.clear();
      await writeFile(path, 'windsurf_api_key = "fake-secret"\nschema_version = 999\n');
      const rejected = await mode.complete({ fields: { source: 'native' } }, context);
      expect(rejected).toMatchObject({ status: 'unavailable' });
      expect(JSON.stringify(rejected)).not.toContain('fake-secret');
      expect(values.size).toBe(0);
      vi.stubEnv(process.platform === 'win32' ? 'APPDATA' : 'XDG_DATA_HOME', 'relative-root');
      expect(await mode.complete({ fields: { source: 'native' } }, context)).toMatchObject({ status: 'unavailable' });
    } finally { vi.unstubAllEnvs(); await kit.dispose(); await rm(root, { recursive: true, force: true }); }
  });
});
