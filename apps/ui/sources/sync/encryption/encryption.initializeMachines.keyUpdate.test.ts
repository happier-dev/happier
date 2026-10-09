import { describe, it, expect, vi } from 'vitest';
import * as platformCrypto from 'rn-encryption';
import { createDeferred, createMachineFixture } from '@/dev/testkit';
import { encodeBase64 } from '@/encryption/base64';
import { Encryption } from './encryption';
import { callSocketRpc, socketRpcCodec, type SocketRpcSocket } from '@happier-dev/sync-client';

describe('Encryption.initializeMachines (key updates)', () => {
  it('settles an issued RPC using its captured codec across replacement without replay', async () => {
    const encryption = await Encryption.create(new Uint8Array(32).fill(1));
    await encryption.initializeMachines(new Map([['rpc-machine', new Uint8Array(32).fill(2)]]));
    const before = encryption.getMachineEncryption('rpc-machine')!;
    const issued = createDeferred<void>();
    const release = createDeferred<void>();
    const requests: unknown[] = [];
    const socket: SocketRpcSocket = {
      connected: true,
      emit: () => undefined,
      emitWithAck: async (_event, payload) => {
        const request = payload as { method: string; params: unknown };
        requests.push(request);
        const cipher = requests.length === 1 ? before : encryption.getMachineEncryption('rpc-machine')!;
        const content = { mode: 'e2ee' as const, cipher };
        const decoded = await socketRpcCodec.decodeRequestParams(content, request.params, request.method);
        if (requests.length === 1) {
          issued.resolve();
          await release.promise;
        }
        return { ok: true, result: await socketRpcCodec.encodeResponse(content, decoded.params, decoded.callId) };
      },
    };
    const pending = callSocketRpc({ socket, target: { kind: 'machine', id: 'rpc-machine' }, method: 'probe',
      params: { reply: 'old' }, content: { mode: 'e2ee', cipher: before }, randomBytes: (length) => new Uint8Array(length).fill(5) });
    await issued.promise;
    await encryption.initializeMachines(new Map([['rpc-machine', new Uint8Array(32).fill(3)]]));
    release.resolve();
    expect(await pending).toEqual({ reply: 'old' });
    expect(await callSocketRpc({ socket, target: { kind: 'machine', id: 'rpc-machine' }, method: 'probe',
      params: { reply: 'new' }, content: { mode: 'e2ee', cipher: encryption.getMachineEncryption('rpc-machine')! },
      randomBytes: (length) => new Uint8Array(length).fill(6) })).toEqual({ reply: 'new' });
    expect(requests).toHaveLength(2);
  });
  it('retires warm metadata and daemon state only for the changed Machine', async () => {
    const encryption = await Encryption.create(new Uint8Array(32).fill(1));
    await encryption.initializeMachines(new Map([
      ['changed', new Uint8Array(32).fill(2)],
      ['retained', new Uint8Array(32).fill(4)],
    ]));
    const before = encryption.getMachineEncryption('changed')!;
    const retained = encryption.getMachineEncryption('retained')!;
    const oldMetadata = createMachineFixture().metadata!;
    const newMetadata = { ...oldMetadata, displayName: 'After conversion' };
    const oldCiphertext = await before.encryptMetadata(oldMetadata);
    const oldState = await before.encryptDaemonState({ status: 'old' });
    expect(await before.decryptMetadata(1, oldCiphertext)).toEqual(oldMetadata);
    expect(await before.decryptDaemonState(1, oldState)).toEqual({ status: 'old' });

    await encryption.initializeMachines(new Map([['changed', new Uint8Array(32).fill(3)]]));
    const after = encryption.getMachineEncryption('changed')!;
    expect(await after.decryptMetadata(1, await after.encryptMetadata(newMetadata))).toEqual(newMetadata);
    expect(await after.decryptDaemonState(1, await after.encryptDaemonState({ status: 'new' }))).toEqual({ status: 'new' });
    expect(encryption.getMachineEncryption('retained')).toBe(retained);
  });

  it('cannot reinstall an opening cipher after its Machine becomes unavailable', async () => {
    const encryption = await Encryption.create(new Uint8Array(32).fill(1));
    const opening = encryption.initializeMachines(new Map([['retired', new Uint8Array(32).fill(2)]]));
    await encryption.initializeMachines(new Map(), new Set(['retired']));
    await opening;
    expect(encryption.getMachineEncryption('retired')).toBeNull();
  });

  it('retires delayed admission when access is withdrawn with the same published key', async () => {
    const encryption = await Encryption.create(new Uint8Array(32).fill(1));
    const basis = { dataEncryptionKey: 'same-recipient-envelope', expectedDataEncryptionKey: 'owner-envelope', resourceMode: 'e2ee' as const };
    const old = encryption.captureMachineEncryptionContext('shared', { ...basis, accessState: 'ready' });
    encryption.captureMachineEncryptionContext('shared', { ...basis, accessState: 'key_pending' });
    await encryption.initializeMachines(new Map([['shared', new Uint8Array(32).fill(2)]]), undefined, { isMachineCurrent: () => old.isCurrent() });
    expect(encryption.getMachineEncryption('shared')).toBeNull();
  });

  it('does not publish or cache a platform decrypt completed after retirement', async () => {
    const encryption = await Encryption.create(new Uint8Array(32).fill(1));
    encryption.configureNativeCryptoWorker({ routing: { mode: 'off' } });
    await encryption.initializeMachines(new Map([['retired', new Uint8Array(32).fill(2)]]));
    const before = encryption.getMachineEncryption('retired')!;
    const oldMetadata = createMachineFixture().metadata!;
    const oldCiphertext = await before.encryptMetadata(oldMetadata);
    const started = createDeferred<void>();
    const release = createDeferred<void>();
    const originalDecrypt = platformCrypto.decryptAsyncAES;
    // Hold the real AES platform result, preserving the Machine/cache implementation.
    const spy = vi.spyOn(platformCrypto, 'decryptAsyncAES').mockImplementationOnce(async (...args) => {
      const plaintext = await originalDecrypt(...args);
      started.resolve();
      await release.promise;
      return plaintext;
    });
    const pending = before.decryptMetadata(1, oldCiphertext);
    try {
      await started.promise;
      await encryption.initializeMachines(new Map(), new Set(['retired']));
      await encryption.initializeMachines(new Map([['retired', new Uint8Array(32).fill(2)]]));
      release.resolve();
      expect(await pending).toBeNull();
      const after = encryption.getMachineEncryption('retired')!;
      const newMetadata = { ...oldMetadata, displayName: 'Regranted' };
      expect(await after.decryptMetadata(1, await after.encryptMetadata(newMetadata))).toEqual(newMetadata);
      expect(await before.decryptMetadata(1, oldCiphertext)).toBeNull();
    } finally {
      release.resolve();
      spy.mockRestore();
      await pending;
    }
  });
  it('updates machine encryption when a data key becomes available later', async () => {
    const masterSecret = new Uint8Array(32).fill(1);
    const machineDataKey = new Uint8Array(32).fill(2);
    const machineId = 'machine_1';

    const encryption = await Encryption.create(masterSecret);

    // First initialize without a data key (fallback encryption).
    await encryption.initializeMachines(new Map([[machineId, null]]));
    const before = encryption.getMachineEncryption(machineId);
    expect(before).toBeTruthy();

    // Encrypt a payload using the machine data key (AES mode).
    const aes = await encryption.openEncryption(machineDataKey);
    const payload = { hello: 'world' };
    const encrypted = await aes.encrypt([payload]);
    const ciphertextB64 = encodeBase64(encrypted[0], 'base64');

    // With fallback encryption, decrypting AES ciphertext must fail.
    expect(await before!.decryptRaw(ciphertextB64)).toBeNull();

    // Later, the data key becomes available (e.g. after decryptEncryptionKey succeeds).
    await encryption.initializeMachines(new Map([[machineId, machineDataKey]]));
    const after = encryption.getMachineEncryption(machineId);
    expect(after).toBeTruthy();

    // After re-initialization, decryption should succeed.
    expect(await after!.decryptRaw(ciphertextB64)).toEqual(payload);
  });
});
