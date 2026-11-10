import { expect, it } from 'vitest';
import type { ConnectedAccountRuntime } from '@happier-dev/plugin-sdk/connected-accounts';
import { createXaiConnectedAccountRuntime } from './runtime.js';

it.each(['subscription', 'api-key'] as const)('materializes only the native xAI %s input without refresh custody', async mode => {
  const owner = createXaiConnectedAccountRuntime();
  // Sealed credential custody and HTTP are host boundaries; the service runtime remains real.
  const context = { credentials: { async get(key: string) {
    return key === 'xaiCredential' ? JSON.stringify({ mode, accessToken: 'fake-selected', refreshToken: 'fake-root' }) : null;
  } }, services: { http: { async request() { throw new Error('Native delivery must not refresh credentials'); } } },
  } as unknown as Parameters<ConnectedAccountRuntime['materialize']>[1];
  expect(await owner.materialize({ kind: 'environment', keys: ['XAI_API_KEY', 'XAI_OAUTH_TOKEN', 'HAPPIER_CONNECTED_XAI_API_KEY'] }, context))
    .toEqual({ kind: 'environment', env: mode === 'subscription' ? { XAI_OAUTH_TOKEN: 'fake-selected' }
      : { XAI_API_KEY: 'fake-selected', HAPPIER_CONNECTED_XAI_API_KEY: 'fake-selected' } });
});
