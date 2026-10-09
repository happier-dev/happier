import { describe, expect, it, vi } from 'vitest';
import type { ConnectedAccountRuntime } from '@happier-dev/plugin-sdk/connected-accounts';
import { MODAL_CONNECTED_ACCOUNT_RUNTIME, MODAL_ENV_KEYS } from './connectedAccount.js';

function selectedProfile(serverUrl = 'http://127.0.0.1:1') {
  const credentialBoundary = new Map([['tokenId', 'dummy-id'], ['tokenSecret', 'dummy-secret']]);
  // Persistent credential/configuration reads are the host boundary. The leaf's
  // profile admission and environment materialization execute without mocks.
  return { configuration: { target: { kind: 'account', modeId: 'token', account: {
    service: { pluginId: 'happier.machine.modal', localId: 'modal-account' }, accountId: 'selected-account',
  } }, revision: 'fixture', values: { serverUrl, environment: 'selected' }, getSecret: async () => null },
    credentials: { get: vi.fn(async (key: string) => credentialBoundary.get(key) ?? null) } } as unknown as Parameters<ConnectedAccountRuntime['status']>[0];
}

describe('Modal selected Connected Account profile', () => {
  it('materializes only the exact selected token, endpoint and environment', async () => {
    expect(await MODAL_CONNECTED_ACCOUNT_RUNTIME.materialize({ kind: 'environment', keys: MODAL_ENV_KEYS }, selectedProfile())).toEqual({
      kind: 'environment', env: { MODAL_TOKEN_ID: 'dummy-id', MODAL_TOKEN_SECRET: 'dummy-secret',
        MODAL_SERVER_URL: 'http://127.0.0.1:1', MODAL_ENVIRONMENT: 'selected' },
    });
    await expect(MODAL_CONNECTED_ACCOUNT_RUNTIME.materialize({ kind: 'environment', keys: ['MODAL_CONFIG_PATH'] }, selectedProfile()))
      .rejects.toMatchObject({ code: 'credential_unavailable' });
  });

  it('refuses malformed native profile endpoints rather than borrowing ambient config', async () => {
    expect(await MODAL_CONNECTED_ACCOUNT_RUNTIME.status(selectedProfile('https://user:secret@api.modal.com')))
      .toMatchObject({ status: 'unavailable' });
    await expect(MODAL_CONNECTED_ACCOUNT_RUNTIME.materialize({ kind: 'environment', keys: MODAL_ENV_KEYS }, selectedProfile('https://api.modal.com/path')))
      .rejects.toMatchObject({ code: 'credential_unavailable' });
  });
});
