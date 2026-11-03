import { describe, expect, it } from 'vitest';
import { createSecretSourceHostFixture } from '@/plugins/testkit/secretSources';
import { registerCapabilitiesHandlers } from './capabilities';
import { createEncryptedRpcTestClient } from './encryptedRpc.testkit';

describe('private native vault transport', () => {
  it('writes through the live source and returns only its reference, with Account mode admitted before native I/O', async () => {
    let written: string | null = null;
    const source = await createSecretSourceHostFixture({ runtime: {
      async acquire() { return { ok: true, value: written ?? '' }; },
      async store(input) { written = input.value; return { ok: true, account: input.account, reference: 'op://vault/item/secret' }; },
    } });
    try {
      const { call } = createEncryptedRpcTestClient({ scopePrefix: 'machine-vault',
        registerHandlers: manager => registerCapabilitiesHandlers(manager, { secretSources: source.host }) });
      const target = { contribution: source.contribution, account: 'account', vaultId: 'vault' };
      const mismatch = await call('daemon.secrets.source.invoke.v1', { operation: 'store', target, title: 'Token',
        value: 'private-fixture', accountEncryptionMode: 'plain' });
      expect(mismatch).toMatchObject({ ok: false, code: 'access_denied' });
      expect(written).toBeNull();
      const result = await call('daemon.secrets.source.invoke.v1', { operation: 'store', target, title: 'Token',
        value: 'private-fixture', accountEncryptionMode: 'e2ee' });
      expect(result).toEqual({ ok: true, account: 'account', reference: 'op://vault/item/secret' });
      expect(written).toBe('private-fixture');
      expect(JSON.stringify(result)).not.toContain('private-fixture');
    } finally { await source.dispose(); }
  });
});
