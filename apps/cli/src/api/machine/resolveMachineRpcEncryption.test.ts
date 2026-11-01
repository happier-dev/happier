import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveMachineRpcEncryption } from './resolveMachineRpcEncryption';

describe('published machine transport', () => {
  afterEach(() => vi.restoreAllMocks());

  it('uses genuine plain transport for a published plain machine without account material', async () => {
    vi.spyOn(axios, 'get').mockImplementation(async (url) => String(url).endsWith('/v1/account/encryption')
      ? { status: 200, data: { mode: 'plain', updatedAt: 1 } }
      : { status: 200, data: { machine: {
      id: 'plain-machine', dataEncryptionKey: Buffer.from(JSON.stringify({ t: 'plain', v: null })).toString('base64'),
    } } });
    await expect(resolveMachineRpcEncryption({ credentials: { token: 'token', encryption: null }, machineId: 'plain-machine' }))
      .resolves.toEqual({ encryptionKey: null, encryptionVariant: 'plain' });
  });

  it('refuses a plain marker when the authoritative account mode is encrypted', async () => {
    vi.spyOn(axios, 'get').mockImplementation(async (url) => String(url).endsWith('/v1/account/encryption')
      ? { status: 200, data: { mode: 'e2ee', updatedAt: 1 } }
      : { status: 200, data: { machine: { id: 'plain-machine', dataEncryptionKey: Buffer.from(JSON.stringify({ t: 'plain', v: null })).toString('base64') } } });
    await expect(resolveMachineRpcEncryption({ credentials: { token: 'token', encryption: null }, machineId: 'plain-machine' }))
      .rejects.toMatchObject({ rpcErrorCode: 'MACHINE_RPC_ENCRYPTION_ERROR', reason: 'target_key_unavailable' });
  });
});
