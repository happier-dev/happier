import axios from 'axios';
import tweetnacl from 'tweetnacl';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { deriveAccountMachineKeyFromRecoverySecret } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { MachineContentKeyTransitionInputV1Schema } from '@happier-dev/protocol/machines/machineContentKeyTransitionV1';
import { ApiClient } from './api';
import { decodeBase64, decrypt, encodeBase64, encrypt, getRandomBytes } from './encryption';
import predecessor from './machine/machineLegacyContent.predecessor.fixture.json';

// Home HTTP is mocked, but custody still reads the authenticated fixture Account subject.
const ownerToken = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;

describe('ApiClient Machine content-key preparation', () => {
  it.each(['legacy', 'resource'] as const)('refuses a withheld %s metadata projection before preparing a key', async keyKind => {
    const machineKey = new Uint8Array(32).fill(17);
    const publicKey = tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey;
    const row = { id: 'withheld', storageMode: 'e2ee', metadata: null, metadataVersion: 0,
      daemonState: null, daemonStateVersion: 0, dataEncryptionKey: keyKind === 'legacy' ? null
        : encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey: new Uint8Array(32).fill(31), recipientPublicKey: publicKey, randomBytes: getRandomBytes })) };
    const get = vi.spyOn(axios, 'get').mockImplementation(async (url: string) => url.endsWith('/v1/machines/withheld')
      ? { status: 200, data: { machine: row } } : { status: 200, data: { mode: 'e2ee', updatedAt: 1 } });
    const post = vi.spyOn(axios, 'post').mockRejectedValue(new Error('Unexpected transition'));
    onTestFinished(() => { get.mockRestore(); post.mockRestore(); });
    const api = await ApiClient.create({ token: ownerToken, encryption: { type: 'dataKey', machineKey, publicKey } });
    await expect(api.prepareMachineContentKey(row.id)).rejects.toMatchObject({ code: 'machine_content_key_unavailable' });
    expect(post).not.toHaveBeenCalled();
  });
  it.each(predecessor.rows)('converts actual predecessor $credentialKind ciphertext without dropping the complete opened blobs', async (fixture) => {
    let row = fixture.machine;
    const get = vi.spyOn(axios, 'get').mockImplementation(async (url: string) => url.endsWith(`/v1/machines/${row.id}`)
      ? { status: 200, data: { machine: row } } : { status: 200, data: { mode: 'e2ee', updatedAt: 1 } });
    const post = vi.spyOn(axios, 'post').mockImplementation(async (_url: string, input) => {
      const transition = MachineContentKeyTransitionInputV1Schema.parse(input);
      if (transition.next.daemonState === null) throw new Error('Transition dropped the existing daemon content');
      row = { ...row, ...transition.next, daemonState: transition.next.daemonState,
        metadataVersion: row.metadataVersion + 1, daemonStateVersion: row.daemonStateVersion + 1 };
      return { status: 200, data: { kind: 'committed', machine: row } };
    });
    onTestFinished(() => { get.mockRestore(); post.mockRestore(); });
    const secret = decodeBase64(fixture.accountSecret);
    const credential = { token: ownerToken, encryption: fixture.credentialKind === 'legacy'
      ? { type: 'legacy' as const, secret }
      : { type: 'dataKey' as const, machineKey: secret, publicKey: decodeBase64(fixture.accountPublicKey!) } };
    const api = await ApiClient.create(credential);
    const converted = await api.prepareMachineContentKey(row.id);
    if (converted.encryptionMode === 'plain') throw new Error('Expected encrypted Machine');
    expect(converted.encryptionKey).not.toEqual(secret);
    expect(decrypt(converted.encryptionKey, 'dataKey', decodeBase64(row.metadata))).toEqual(predecessor.openedMetadata);
    expect(decrypt(converted.encryptionKey, 'dataKey', decodeBase64(row.daemonState))).toEqual(predecessor.openedDaemonState);
    expect(converted).toMatchObject({ metadataVersion: 5, daemonStateVersion: 4 });
    expect(post).toHaveBeenCalledOnce();
  });
  it.each([
    ['legacy', 'committed'], ['legacy', 'lost-ack'], ['dataKey', 'committed'], ['dataKey', 'lost-ack'],
  ] as const)('preserves legacy %s content and adopts %s without replay', async (type, reply) => {
    const secret = new Uint8Array(32).fill(17);
    const machineKey = type === 'legacy' ? deriveAccountMachineKeyFromRecoverySecret(secret) : secret;
    const publicKey = tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey;
    const oldKey = type === 'legacy' ? secret : machineKey;
    const metadata = { host: 'old-host', homeDir: '/home/owner', platform: 'linux', happyCliVersion: 'test', happyHomeDir: '/home/owner/.happier',
      displayName: 'User edit', finitePolicyV1: { accepting: false, runAtMost: 2 } };
    const completeMetadata = { ...metadata, legacyExtension: { preserve: 'entire old blob' } };
    const daemonState = { status: 'running', pid: 42 };
    let row = { id: 'legacy-machine', storageMode: 'e2ee' as const,
      dataEncryptionKey: type === 'legacy' ? null : encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey: machineKey, recipientPublicKey: publicKey, randomBytes: getRandomBytes })),
      metadata: encodeBase64(encrypt(oldKey, type, completeMetadata)), metadataVersion: 4,
      daemonState: encodeBase64(encrypt(oldKey, type, daemonState)), daemonStateVersion: 3 };
    const get = vi.spyOn(axios, 'get').mockImplementation(async (url: string) => url.endsWith('/v1/machines/legacy-machine')
      ? { status: 200, data: { machine: row } }
      : { status: 200, data: { mode: 'e2ee', updatedAt: 1 } });
    const post = vi.spyOn(axios, 'post').mockImplementation(async (_url: string, input) => {
      const transition = MachineContentKeyTransitionInputV1Schema.parse(input);
      expect(transition.expected).toEqual({ dataEncryptionKey: row.dataEncryptionKey, metadataVersion: 4, daemonStateVersion: 3 });
      if (transition.next.daemonState === null) throw new Error('Transition dropped the existing daemon content');
      row = { ...row, ...transition.next, daemonState: transition.next.daemonState, metadataVersion: 5, daemonStateVersion: 4 };
      if (reply === 'committed') return { status: 200, data: { kind: 'committed', machine: row } };
      throw new Error('Acknowledgement dropped after commit');
    });
    onTestFinished(() => { get.mockRestore(); post.mockRestore(); });
    const api = await ApiClient.create({ token: ownerToken, encryption: type === 'legacy'
      ? { type, secret } : { type, machineKey, publicKey } });
    const adopted = await api.prepareMachineContentKey(row.id);
    expect(adopted).toMatchObject({ metadata, daemonState, metadataVersion: 5, daemonStateVersion: 4,
      encryptionVariant: 'dataKey', dataEncryptionKey: row.dataEncryptionKey });
    if (adopted.encryptionMode === 'plain') throw new Error('Expected E2EE context');
    expect(adopted.encryptionKey).not.toEqual(oldKey);
    expect(decrypt(adopted.encryptionKey, 'dataKey', decodeBase64(row.metadata))).toEqual(completeMetadata);
    expect(decrypt(adopted.encryptionKey, 'dataKey', decodeBase64(row.daemonState))).toEqual(daemonState);
    expect(post).toHaveBeenCalledOnce();
    expect(await api.prepareMachineContentKey(row.id)).toMatchObject({ metadata, daemonState,
      encryptionKey: adopted.encryptionKey, dataEncryptionKey: row.dataEncryptionKey });
    expect(post).toHaveBeenCalledOnce();
  });

  it.each(['unchanged', 'edited-after-commit'] as const)('reports an unknown outcome when observation is %s, not the exact transmitted proposal', async (observation) => {
    const machineKey = new Uint8Array(32).fill(13);
    const publicKey = tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey;
    let row: { id: string; storageMode: 'e2ee'; dataEncryptionKey: string | null; metadata: string; metadataVersion: number; daemonState: string | null; daemonStateVersion: number } = { id: 'unconfirmed', storageMode: 'e2ee', dataEncryptionKey: null,
      metadata: encodeBase64(encrypt(machineKey, 'dataKey', { host: 'old-host', homeDir: '/home/owner', platform: 'linux',
        happyCliVersion: 'test', happyHomeDir: '/home/owner/.happier' })), metadataVersion: 1,
      daemonState: null, daemonStateVersion: 0 };
    const get = vi.spyOn(axios, 'get').mockImplementation(async (url: string) => url.endsWith('/v1/machines/unconfirmed')
      ? { status: 200, data: { machine: row } } : { status: 200, data: { mode: 'e2ee', updatedAt: 1 } });
    const post = vi.spyOn(axios, 'post').mockImplementation(async (_url: string, input) => {
      const transition = MachineContentKeyTransitionInputV1Schema.parse(input);
      if (observation === 'edited-after-commit') {
        row = { ...row, ...transition.next, metadata: 'a-later-published-content',
          metadataVersion: transition.expected.metadataVersion + 2, daemonStateVersion: transition.expected.daemonStateVersion + 1 };
      }
      throw new Error('Response lost');
    });
    onTestFinished(() => { get.mockRestore(); post.mockRestore(); });
    const api = await ApiClient.create({ token: ownerToken, encryption: { type: 'dataKey', machineKey, publicKey } });
    await expect(api.prepareMachineContentKey(row.id)).rejects.toMatchObject({ code: 'machine_content_key_outcome_unknown' });
    expect(post).toHaveBeenCalledOnce();
  });
});
