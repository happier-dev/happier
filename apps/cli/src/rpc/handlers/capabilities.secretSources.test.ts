import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { authorizeMachineRpcRequest } from '@/api/machine/machineRpcAuthorization';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc/errors';
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

// Exercise the native handler through the real daemon admission owner. Only the
// Home's grant verification is a boundary fixture; internal policy stays real.
it('admits the vault custodian and refuses an ungranted Account or Session Agent before native I/O', async () => {
  const stored: string[] = [];
  const source = await createSecretSourceHostFixture({ runtime: {
    async acquire() { return { ok: true, value: '' }; },
    async store(input) { stored.push(input.value); return { ok: true, account: input.account, reference: 'op://vault/item/secret' }; },
  } });
  try {
    const manager = new RpcHandlerManager({ scopePrefix: 'machine-vault', encryptionMode: 'plain', logger: () => {},
      authorizeRequest: request => authorizeMachineRpcRequest(request, { machineId: 'machine-vault',
        resolveCustodianAccountId: async () => 'owner', resolveInstallationId: () => 'installation',
        verifyMachineAdmission: async ({ context }) => context.actorAccountId === 'owner',
      }),
    });
    registerCapabilitiesHandlers(manager, { secretSources: source.host });
    const request = { method: 'machine-vault:' + RPC_METHODS.DAEMON_SECRET_SOURCE_INVOKE,
      params: { operation: 'store', target: { contribution: source.contribution, account: 'account', vaultId: 'vault' },
        title: 'Token', value: 'private-fixture', accountEncryptionMode: 'plain' },
      machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: 'machine-vault',
        installationId: 'installation', role: 'manage' as const, encryptionMode: 'plain' as const },
      callerAuthority: 'present_user' as const };
    expect(await manager.handleRequest({ ...request,
      machineAdmission: { ...request.machineAdmission, actorAccountId: 'ungranted' } })).toMatchObject({
      errorCode: 'confidential_continuation_failed', effectAttempted: false,
    });
    expect(await manager.handleRequest({ ...request, callerAuthority: 'account_automation', sessionActionOrigin: {
      v: 1, caller: { kind: 'session', sessionId: 'agent', starterDepth: 0, turnDepth: 0 },
      callerPermissionMode: 'default', sourceTurnId: 'turn', requestId: 'agent-request',
    } })).toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
    expect(stored).toEqual([]);
    expect(await manager.handleRequest(request)).toEqual({ ok: true, account: 'account', reference: 'op://vault/item/secret' });
    expect(stored).toEqual(['private-fixture']);
  } finally { await source.dispose(); }
});
