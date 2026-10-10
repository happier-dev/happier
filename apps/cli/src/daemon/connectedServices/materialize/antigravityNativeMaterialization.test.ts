import { describe, expect, it } from 'vitest';
import type { ConnectedAccountRuntime } from '@happier-dev/plugin-sdk/connected-accounts';
import { antigravityConnectedAccountRuntime } from '../../../../../../packages/plugins/antigravity/src/connectedAccounts/antigravityConnectedAccountRuntime';

function context(): Parameters<ConnectedAccountRuntime['materialize']>[1] {
  const account = { service: { pluginId: 'happier.agent.antigravity', localId: 'antigravity-account' }, accountId: 'selected-account' };
  // Host credential/configuration services are genuine boundaries; materialization remains real.
  return { account, signal: new AbortController().signal, credentials: { async get() { return null; } },
    configuration: { target: { kind: 'account', account, modeId: 'oauth-personal' }, revision: 'configuration-1', values: {}, async getSecret() { return null; } },
  } as Parameters<ConnectedAccountRuntime['materialize']>[1];
}

describe('Antigravity native authentication materialization', () => {
  it('writes the pinned ACP auth.type settings contract', async () => {
    const result = await antigravityConnectedAccountRuntime.materialize({ kind: 'files', fileIds: ['antigravity-acp/settings.json'] }, context());
    if (result.kind !== 'files') throw new Error('Native settings were not materialized');
    expect(JSON.parse(new TextDecoder().decode(result.files['antigravity-acp/settings.json']))).toEqual({ auth: { type: 'oauth-personal' } });
  });

  it('forces file storage only for the explicit selected-purpose key', async () => {
    await expect(antigravityConnectedAccountRuntime.materialize({ kind: 'environment', keys: ['AGY_ACP_FORCE_FILE_STORAGE'] }, context())).resolves.toEqual({ kind: 'environment', env: { AGY_ACP_FORCE_FILE_STORAGE: '1' } });
    await expect(antigravityConnectedAccountRuntime.materialize({ kind: 'environment', keys: ['GOOGLE_API_KEY'] }, context())).rejects.toThrow();
    await expect(antigravityConnectedAccountRuntime.materialize({ kind: 'httpHeaders', origin: 'https://oauth2.googleapis.com', headerNames: ['Authorization'] }, context())).rejects.toThrow();
  });
});
