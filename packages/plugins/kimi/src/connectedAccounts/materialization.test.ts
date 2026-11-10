import { expect, it } from 'vitest';
import type { ConnectedAccountRuntime } from '@happier-dev/plugin-sdk/connected-accounts';
import { createKimiConnectedAccountRuntime } from './runtime.js';

it.each([
  { credentialKind: 'token', apiKind: 'code', apiBase: 'https://api.kimi.com/coding/v1', keys: ['KIMI_API_KEY', 'HAPPIER_CONNECTED_KIMI_API_KEY'], env: { KIMI_API_KEY: 'fake-selected', HAPPIER_CONNECTED_KIMI_API_KEY: 'fake-selected' } },
  { credentialKind: 'token', apiKind: 'platform', apiBase: 'https://api.moonshot.ai/v1', keys: ['MOONSHOT_API_KEY'], env: { MOONSHOT_API_KEY: 'fake-selected' } },
  { credentialKind: 'oauth', apiKind: 'code', apiBase: 'https://api.kimi.ai/coding/v1', keys: ['MOONSHOT_API_KEY'], env: {} },
])('keeps $credentialKind/$apiKind native inputs distinct without acquiring credentials', async row => {
  const owner = createKimiConnectedAccountRuntime();
  const values: Record<string, string> = { accessToken: 'fake-selected', refreshToken: 'fake-root',
    credentialKind: row.credentialKind, apiKind: row.apiKind, apiBase: row.apiBase };
  // Sealed credential custody and HTTP are host boundaries; the service runtime remains real.
  const context = { credentials: { async get(key: string) { return values[key] ?? null; } },
    services: { http: { async request() { throw new Error('Native delivery must not acquire credentials'); } } },
  } as unknown as Parameters<ConnectedAccountRuntime['materialize']>[1];
  expect(await owner.materialize({ kind: 'environment', keys: row.keys }, context))
    .toEqual({ kind: 'environment', env: row.env });
  expect(await owner.materialize({ kind: 'environment', keys: ['HAPPIER_KIMI_ACCESS_TOKEN'] }, context))
    .toEqual({ kind: 'environment', env: { HAPPIER_KIMI_ACCESS_TOKEN: 'fake-selected' } });
  expect(await owner.materialize({ kind: 'httpHeaders', origin: new URL(row.apiBase).origin, headerNames: ['Authorization'] }, context))
    .toMatchObject({ facts: { credentialKind: row.credentialKind, apiKind: row.apiKind, apiBase: row.apiBase } });
  if (row.credentialKind === 'oauth' || row.apiKind === 'platform') {
    await expect(owner.materialize({ kind: 'environment', keys: ['HAPPIER_CONNECTED_KIMI_API_KEY'] }, context))
      .rejects.toMatchObject({ code: 'kimi_code_api_key_unavailable' });
  }
});

it('delivers the selected regional Code base alongside OAuth without exporting a Code API key', async () => {
  const owner = createKimiConnectedAccountRuntime();
  const values: Record<string, string> = { accessToken: 'fake-selected', credentialKind: 'oauth', apiKind: 'code', apiBase: 'https://api.kimi.ai/coding/v1' };
  const context = { credentials: { async get(key: string) { return values[key] ?? null; } },
    services: { http: { async request() { throw new Error('Native delivery must not acquire credentials'); } } },
  } as unknown as Parameters<ConnectedAccountRuntime['materialize']>[1];
  expect(await owner.materialize({ kind: 'environment', keys: ['HAPPIER_KIMI_ACCESS_TOKEN', 'KIMI_CODE_BASE_URL'] }, context))
    .toEqual({ kind: 'environment', env: { HAPPIER_KIMI_ACCESS_TOKEN: 'fake-selected', KIMI_CODE_BASE_URL: 'https://api.kimi.ai/coding/v1' } });
  await expect(owner.materialize({ kind: 'environment', keys: ['KIMI_API_KEY'] }, context))
    .rejects.toMatchObject({ code: 'kimi_code_api_key_unavailable' });
});

it.each(['https://api.kimi.com/coding/v1', 'https://api.kimi.ai/coding/v1'])('materializes selected regional facts from the gateway declaration at %s', async apiBase => {
  const owner = createKimiConnectedAccountRuntime();
  const values: Record<string, string> = { accessToken: 'fake-selected', credentialKind: 'oauth', apiKind: 'code', apiBase, deviceId: 'selected-device' };
  const context = { credentials: { async get(key: string) { return values[key] ?? null; } },
    services: { http: { async request() { throw new Error('Header delivery must not acquire credentials'); } } },
  } as unknown as Parameters<ConnectedAccountRuntime['materialize']>[1];
  expect(await owner.materialize({ kind: 'httpHeaders', origin: 'https://api.kimi.com', headerNames: ['Authorization'] }, context))
    .toMatchObject({ headers: { Authorization: 'Bearer fake-selected' }, facts: { apiBase, deviceId: 'selected-device' } });
  await expect(owner.materialize({ kind: 'httpHeaders', origin: 'https://foreign.example', headerNames: ['Authorization'] }, context)).rejects.toThrow();
});
