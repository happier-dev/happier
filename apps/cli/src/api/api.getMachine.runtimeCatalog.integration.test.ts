import axios from 'axios';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { ApiClient } from './api';
import tweetnacl from 'tweetnacl';
import { sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { encodeBase64, encrypt, getRandomBytes } from './encryption';
import { runWithServerHttpBaseUrl } from './client/serverHttpBaseUrl';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { classifyDaemonServerWorkError } from '@/daemon/serverWork/classifyDaemonServerWorkError';

describe('ApiClient.getMachine capability authority', () => {
  it('preserves outage classification and registers retained Machine content on recovery', async () => {
    const metadata = { host: 'outage-host', homeDir: '/home/owner', platform: 'linux',
      happyCliVersion: 'test', happyHomeDir: '/home/owner/.happier' };
    const daemonState = { status: 'running', managedActivity: { kind: 'idle', since: 10 } };
    const machine = { id: 'outage-machine', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
      metadata: encodePlainMachineStoredContent({ ...metadata, retiredMetadata: true }), metadataVersion: 4,
      daemonState: encodePlainMachineStoredContent({ ...daemonState, retiredDaemonField: true }), daemonStateVersion: 3 };
    let online = false;
    // Only the HTTP boundary changes; mode, content decoding and retry classification stay real.
    const get = vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      if (!online) throw new axios.AxiosError('Connection reset', 'ECONNRESET');
      return url.endsWith(`/v1/machines/${machine.id}`)
        ? { status: 200, data: { machine } } : { status: 200, data: { mode: 'plain', updatedAt: 1 } };
    });
    const post = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { machine } });
    onTestFinished(() => { get.mockRestore(); post.mockRestore(); });
    const api = await ApiClient.create({ token: 'test-token', encryption: null });
    const failure: unknown = await api.getOrCreateMachine({ machineId: machine.id, metadata })
      .catch((error: unknown) => error);
    expect(classifyDaemonServerWorkError(failure)).toMatchObject({ kind: 'network', retryable: true });
    expect(post).not.toHaveBeenCalled();

    online = true;
    const recovered = await api.getOrCreateMachine({ machineId: machine.id, metadata });
    expect(recovered).toMatchObject({
      id: machine.id, encryptionMode: 'plain', metadata, daemonState,
    });
    expect(recovered.metadata).toEqual(metadata);
    expect(recovered.daemonState).toEqual(daemonState);
    expect(post.mock.calls[0]?.[1]).toMatchObject({
      metadata: machine.metadata, daemonState: machine.daemonState, dataEncryptionKey: machine.dataEncryptionKey,
    });
  });

  it('reads Account mode and exact Machine from the caller-bound Home endpoint', async () => {
    const urls: string[] = [];
    const get = vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      urls.push(url);
      return url.endsWith('/v1/machines/target')
        ? { status: 200, data: { machine: { id: 'target', metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 } } }
        : { status: 200, data: { mode: 'e2ee', updatedAt: 1 } };
    });
    onTestFinished(() => get.mockRestore());
    const api = await ApiClient.create({ token: 'test-token', encryption: { type: 'legacy', secret: new Uint8Array(32) } });
    await runWithServerHttpBaseUrl('https://bound-home.test', () => api.getMachine('target'));
    expect(urls).toEqual(['https://bound-home.test/v1/account/encryption', 'https://bound-home.test/v1/machines/target']);
  });

  it('adopts a competing registration winner before opening its content and after reload', async () => {
    const machineKey = new Uint8Array(32).fill(11);
    const winnerKey = new Uint8Array(32).fill(29);
    const publicKey = tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey;
    const metadata = { host: 'winner', displayName: 'Owner edit', homeDir: '/home/winner', platform: 'linux',
      happyCliVersion: 'test', happyHomeDir: '/home/winner/.happier', happyLibDir: '/tmp/lib' };
    const daemonState = { status: 'running' };
    const machine = { id: 'winning-machine',
      dataEncryptionKey: encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey: winnerKey, recipientPublicKey: publicKey, randomBytes: getRandomBytes })),
      metadata: encodeBase64(encrypt(winnerKey, 'dataKey', metadata)), metadataVersion: 4,
      daemonState: encodeBase64(encrypt(winnerKey, 'dataKey', daemonState)), daemonStateVersion: 3 };
    let firstRead = true;
    const get = vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      if (!url.endsWith('/v1/machines/winning-machine')) return { status: 200, data: { mode: 'e2ee', updatedAt: 1 } };
      if (firstRead) {
        firstRead = false;
        throw new axios.AxiosError('Not found', 'ERR_BAD_REQUEST', undefined, undefined, {
          status: 404, statusText: 'Not Found', data: {}, headers: {}, config: { headers: new axios.AxiosHeaders() },
        });
      }
      return { status: 200, data: { machine } };
    });
    const post = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { machine } });
    onTestFinished(() => { get.mockRestore(); post.mockRestore(); });
    const api = await ApiClient.create({ token: 'test-token', encryption: { type: 'dataKey', machineKey, publicKey } });
    expect(await api.getOrCreateMachine({ machineId: machine.id, metadata })).toMatchObject({
      metadata, daemonState, encryptionKey: winnerKey, encryptionVariant: 'dataKey', dataEncryptionKey: machine.dataEncryptionKey,
    });
    expect(await api.getMachine(machine.id)).toMatchObject({ metadata, daemonState, encryptionKey: winnerKey,
      dataEncryptionKey: machine.dataEncryptionKey });
  });

  it('registers an incumbent with its exact published ciphertext and envelope rather than resealing', async () => {
    const secret = new Uint8Array(32).fill(17);
    const machine = { id: 'repeat-machine', dataEncryptionKey: null,
      metadata: encodeBase64(encrypt(secret, 'legacy', { host: 'incumbent', homeDir: '/home/owner', platform: 'linux',
        happyCliVersion: 'test', happyHomeDir: '/home/owner/.happier', displayName: 'User edit' })), metadataVersion: 4,
      daemonState: encodeBase64(encrypt(secret, 'legacy', { status: 'running' })), daemonStateVersion: 3 };
    const get = vi.spyOn(axios, 'get').mockImplementation(async (url: string) => url.endsWith(`/v1/machines/${machine.id}`)
      ? { status: 200, data: { machine } } : { status: 200, data: { mode: 'e2ee', updatedAt: 1 } });
    const post = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { machine } });
    onTestFinished(() => { get.mockRestore(); post.mockRestore(); });
    const api = await ApiClient.create({ token: 'test-token', encryption: { type: 'legacy', secret } });
    await api.getOrCreateMachine({ machineId: machine.id, metadata: { host: 'startup', homeDir: '/home/owner', platform: 'linux',
      happyCliVersion: 'test', happyHomeDir: '/home/owner/.happier' } });
    expect(post.mock.calls[0]?.[1]).toMatchObject({ metadata: machine.metadata, daemonState: machine.daemonState,
      dataEncryptionKey: machine.dataEncryptionKey });
  });

  it('refuses to enroll a shared foreign Machine before publishing owner registration content', async () => {
    const metadata = { host: 'shared', homeDir: '/home/owner', platform: 'linux', happyCliVersion: 'test', happyHomeDir: '/home/owner/.happier' };
    const machine = { id: 'shared-plain', metadata: encodePlainMachineStoredContent(metadata), metadataVersion: 1,
      daemonState: null, daemonStateVersion: 0, dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
      access: { custodian: { accountId: 'owner', displayName: 'Owner' }, role: 'use', resourceMode: 'plain', accessState: 'ready' } };
    const get = vi.spyOn(axios, 'get').mockImplementation(async (url: string) => url.endsWith(`/v1/machines/${machine.id}`)
      ? { status: 200, data: { machine } } : { status: 200, data: { mode: 'plain', updatedAt: 1 } });
    const post = vi.spyOn(axios, 'post').mockRejectedValue(new Error('Unexpected owner registration'));
    onTestFinished(() => { get.mockRestore(); post.mockRestore(); });
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'viewer' })).toString('base64url')}.signature`;
    const api = await ApiClient.create({ token, encryption: null });
    await expect(api.getOrCreateMachine({ machineId: machine.id, metadata })).rejects.toMatchObject({ code: 'machine_content_key_unavailable' });
    expect(post).not.toHaveBeenCalled();
  });

  it.each(['get', 'registration'] as const)('refuses a swapped Machine row at the exact-target %s reader', async entry => {
    const machineKey = new Uint8Array(32).fill(17);
    const publicKey = tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey;
    const resourceKey = new Uint8Array(32).fill(31);
    const metadata = { host: 'another', homeDir: '/home/owner', platform: 'linux', happyCliVersion: 'test', happyHomeDir: '/home/owner/.happier' };
    const machine = { id: 'another-machine', dataEncryptionKey: encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey: resourceKey,
      recipientPublicKey: publicKey, randomBytes: getRandomBytes })), metadata: encodeBase64(encrypt(resourceKey, 'dataKey', metadata)), metadataVersion: 1,
      daemonState: null, daemonStateVersion: 0 };
    const get = vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      if (!url.endsWith('/v1/machines/target')) return { status: 200, data: { mode: 'e2ee', updatedAt: 1 } };
      if (entry === 'registration') throw new axios.AxiosError('Not found', 'ERR_BAD_REQUEST', undefined, undefined, {
        status: 404, statusText: 'Not Found', data: {}, headers: {}, config: { headers: new axios.AxiosHeaders() },
      });
      return { status: 200, data: { machine } };
    });
    const post = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { machine } });
    onTestFinished(() => { get.mockRestore(); post.mockRestore(); });
    const api = await ApiClient.create({ token: 'test-token', encryption: { type: 'dataKey', machineKey, publicKey } });
    await expect(entry === 'get' ? api.getMachine('target') : api.getOrCreateMachine({ machineId: 'target', metadata }))
      .rejects.toMatchObject({ code: 'machine_content_key_unavailable' });
    expect(post).toHaveBeenCalledTimes(entry === 'registration' ? 1 : 0);
  });

  it('retains the exact-target snapshot and withdraws revoked, replaced or malformed authority', async () => {
    const capabilities = { irohMachineEndpoint: {
      protocolVersions: [1], endpointId: 'b'.repeat(64), directAddresses: ['10.0.0.2:7777'],
    } };
    let machine = {
      id: 'target', metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0,
      revokedAt: null as number | null, replacedByMachineId: null as string | null,
      operationProtocolCapabilities: capabilities, operationProtocolCapabilitiesRevision: 7,
    };
    // Only HTTP is replaced; the API reader, content codec and capability parser are real.
    const get = vi.spyOn(axios, 'get').mockImplementation(async (url: string) => url.endsWith('/v1/machines/target')
      ? { status: 200, data: { machine } }
      : { status: 200, data: { mode: 'e2ee', updatedAt: 1 } });
    onTestFinished(() => get.mockRestore());
    const api = await ApiClient.create({ token: 'test-token', encryption: { type: 'legacy', secret: new Uint8Array(32) } });
    const current = await api.getMachine('target');
    expect(current).toMatchObject({
      operationProtocolCapabilities: capabilities,
      operationProtocolCapabilitiesRevision: 7,
    });

    const original = machine;
    for (const change of [
      { revokedAt: Date.parse('2026-10-01T00:00:00.000Z') },
      { replacedByMachineId: 'replacement' },
      { operationProtocolCapabilitiesRevision: 0 },
      { operationProtocolCapabilities: { irohMachineEndpoint: { ...capabilities.irohMachineEndpoint, endpointId: 'invalid' } } },
    ]) {
      machine = { ...original, ...change };
      expect(await api.getMachine('target')).toMatchObject({
        operationProtocolCapabilities: null,
        operationProtocolCapabilitiesRevision: null,
      });
    }
  });
});
