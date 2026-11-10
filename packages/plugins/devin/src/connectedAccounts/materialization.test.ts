import { expect, it } from 'vitest';
import type { ConnectedAccountRuntime } from '@happier-dev/plugin-sdk/connected-accounts';
import { createDevinConnectedAccountRuntime } from './runtime.js';
import { DEVIN_NATIVE_GENERATION, DEVIN_SESSION_METADATA } from './nativeCredentials.js';

function context(values: Readonly<Record<string, string>>) {
  // Sealed credential custody and HTTP are host boundaries; the service runtime remains real.
  return { credentials: { async get(key: string) { return values[key] ?? null; } }, account: { accountId: 'fake-account' },
    services: { http: { async request() { throw new Error('Native delivery must not exchange credentials'); } } },
  } as unknown as Parameters<ConnectedAccountRuntime['materialize']>[1];
}

it.each([
  { mode: 'session', apiServerUrl: 'https://server.codeium.com', token: 'devin-session-token$eyJ.fake.session' },
  { mode: 'enterprise', apiServerUrl: 'https://server.enterprise.windsurf.com', token: 'fake-seat-key' },
])('delivers $mode native material with its server and metadata', async row => {
  const owner = createDevinConnectedAccountRuntime();
  const read = context({ credentialMode: row.mode, apiServerUrl: row.apiServerUrl,
    [row.mode === 'session' ? 'sessionToken' : 'seatToken']: row.token,
    nativeGeneration: DEVIN_NATIVE_GENERATION, nativeMetadata: JSON.stringify(DEVIN_SESSION_METADATA) });
  expect(await owner.materialize({ kind: 'environment', keys: ['DEVIN_API_KEY'] }, read))
    .toEqual({ kind: 'environment', env: { DEVIN_API_KEY: row.token } });
  expect(await owner.materialize({ kind: 'httpHeaders', origin: row.apiServerUrl, headerNames: ['authorization'] }, read))
    .toMatchObject({ facts: { mode: row.mode, base_url: row.apiServerUrl } });
  const native = await owner.materialize({ kind: 'files', fileIds: ['devin/credentials.toml'] }, read);
  if (native.kind !== 'files') throw new Error('Expected native Devin credentials');
  const file = new TextDecoder().decode(native.files['devin/credentials.toml']);
  expect(file).toContain(`api_server_url = "${row.apiServerUrl}"`);
  expect(file).toContain('devin_api_url = "https://api.devin.ai"');
});

it('retains custom enterprise servers in native files and refuses the default-host environment driver', async () => {
  const owner = createDevinConnectedAccountRuntime();
  const read = context({ credentialMode: 'enterprise', seatToken: 'fake-seat-key', apiServerUrl: 'https://enterprise.example.test',
    nativeGeneration: DEVIN_NATIVE_GENERATION, nativeMetadata: '{}' });
  await expect(owner.materialize({ kind: 'environment', keys: ['DEVIN_API_KEY'] }, read)).rejects.toMatchObject({ code: 'unsupported' });
  const native = await owner.materialize({ kind: 'files', fileIds: ['devin/credentials.toml'] }, read);
  if (native.kind !== 'files') throw new Error('Expected native Devin credentials');
  expect(new TextDecoder().decode(native.files['devin/credentials.toml'])).toContain('api_server_url = "https://enterprise.example.test"');
});
