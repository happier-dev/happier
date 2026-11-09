import axios from 'axios';
import tweetnacl from 'tweetnacl';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { signMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { decodePlainMachineStoredContent } from '@happier-dev/protocol/machines/machineStoredContent';
import { ApiClient } from './api';
import { encodeBase64, encrypt } from './encryption';

describe('ordinary managed child Machine registration', () => {
  it('rehydrates a child fact from the retained row after a predecessor whole-metadata write erases its copy', async () => {
    const machineId = 'enrolled-child';
    const secret = new Uint8Array(32).fill(82);
    const projection = { relation: { managedMachineId: 'managed-child', managedMachineKind: 'devcontainer' as const,
      parentMachineId: 'physical-controller' }, observation: { nativeResourceId: 'native-child', user: 'custom-user',
      workspaceFolder: '/work/custom', storage: { kind: 'child' as const, childPath: '/work/custom' } } };
    // Prospective 0.2 HEAD 37a6541578749067b49d4579be8c752c9591b8c8:
    // storageTypes.ts#585 strips the unknown child field; machine/[id]/index.tsx#663
    // and ops/machines.ts#1158 rename by encrypting this entire stripped document.
    const renamedMetadata = { host: 'container', platform: 'linux', happyCliVersion: '0.2',
      homeDir: '/home/custom-user', happyHomeDir: '/home/custom-user/.happier', displayName: 'Renamed by predecessor' };
    let rowProjection: typeof projection | null | undefined = projection;
    let claimedMetadata: typeof renamedMetadata & { devcontainerChild?: typeof projection } = renamedMetadata;
    const get = vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'e2ee', updatedAt: 1 } };
      return { status: 200, data: { machine: { id: machineId, metadata: encodeBase64(encrypt(secret, 'legacy', claimedMetadata)),
        metadataVersion: 2, daemonState: null, daemonStateVersion: 0, storageMode: 'e2ee', dataEncryptionKey: null,
        installationId: 'child-installation', ...(rowProjection !== undefined ? { devcontainerChild: rowProjection } : {}) } } };
    });
    onTestFinished(() => get.mockRestore());
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
    const api = await ApiClient.create({ token, encryption: { type: 'legacy', secret } });
    expect(await api.getMachine(machineId)).toMatchObject({ id: machineId, encryptionMode: 'e2ee',
      metadata: { displayName: renamedMetadata.displayName, devcontainerChild: projection } });
    claimedMetadata = { ...renamedMetadata, devcontainerChild: projection };
    rowProjection = null;
    expect((await api.getMachine(machineId))?.metadata?.devcontainerChild).toBeUndefined();
    rowProjection = undefined;
    await expect(api.getMachine(machineId)).rejects.toMatchObject({ code: 'machine_unavailable' });
  });
  it.each([true, false])('registers an admitted managed Machine with controller present=%s without inventing a child relation', async (controllerPresent) => {
    const keys = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(91));
    const machineId = 'enrolled-child';
    const installationId = 'child-installation';
    const devcontainerObservation = { nativeResourceId: 'native-child', user: 'custom-user', workspaceFolder: '/work/custom',
      storage: { kind: 'bind' as const, hostPath: '/host/project', childPath: '/work/custom' } };
    const controller = { machineId: 'physical-controller', installationId: 'host-installation' };
    const managedEnrollment = { homeId: 'srv_child_home', managedId: 'managed-child', expectedIntentRevision: 2,
      requestId: 'approved-create', ...(controllerPresent ? { controller } : {}),
      resource: controllerPresent
        ? { contributionRef: { pluginId: 'happier.devcontainer', localId: 'devcontainer' }, schemaVersion: 1,
          value: { containerId: 'native-child' }, devcontainerObservation }
        : { contributionRef: { pluginId: 'fixture.cloud', localId: 'vm' }, schemaVersion: 1,
          value: { nativeId: 'cloud-guest' } } };
    const metadata = { host: 'container', platform: 'linux', happyCliVersion: 'test',
      homeDir: '/home/custom-user', happyHomeDir: '/home/custom-user/.happier' };
    const get = vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      throw new axios.AxiosError('not found', undefined, undefined, undefined,
        { status: 404, statusText: 'Not Found', data: {}, headers: {}, config: { headers: new axios.AxiosHeaders() } });
    });
    const post = vi.spyOn(axios, 'post').mockImplementation(async (_url: string, body) => {
      if (!body || typeof body !== 'object' || !('id' in body) || typeof body.id !== 'string'
        || !('metadata' in body) || typeof body.metadata !== 'string') throw new Error('Invalid Machine registration carrier');
      return { status: 200, data: { machine: {
      id: body.id, metadata: body.metadata, metadataVersion: 1, daemonState: null,
      daemonStateVersion: 0, storageMode: 'plain', dataEncryptionKey: null,
      devcontainerChild: controllerPresent ? { relation: { managedMachineId: managedEnrollment.managedId, managedMachineKind: 'devcontainer',
        parentMachineId: controller.machineId }, observation: devcontainerObservation } : null,
    } } };
    });
    onTestFinished(() => { get.mockRestore(); post.mockRestore(); });
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
    const api = await ApiClient.create({ token, encryption: null });
    const registered = await api.getOrCreateMachine({ machineId, metadata, managedEnrollment,
      registrationIdentity: { installationId, installationPublicKey: Buffer.from(keys.publicKey).toString('base64url'),
        installationProof: signMachineInstallationProof({ payload: { version: 1, machineId, installationId, accountId: 'owner' },
          privateKey: keys.secretKey }) } });
    const expected = controllerPresent ? { relation: { managedMachineId: managedEnrollment.managedId, managedMachineKind: 'devcontainer',
      parentMachineId: controller.machineId }, observation: devcontainerObservation } : undefined;
    expect(registered).toMatchObject({ id: machineId, encryptionMode: 'plain' });
    if (expected) expect(registered.metadata?.devcontainerChild).toEqual(expected);
    else expect(registered.metadata).not.toHaveProperty('devcontainerChild');
    const body = post.mock.calls[0]?.[1];
    if (!body || typeof body !== 'object' || !('metadata' in body) || typeof body.metadata !== 'string'
      || !('installationId' in body)) throw new Error('Missing registered Machine carrier');
    if (expected) expect(decodePlainMachineStoredContent(body.metadata)).toMatchObject({ devcontainerChild: expected });
    else expect(decodePlainMachineStoredContent(body.metadata)).not.toHaveProperty('devcontainerChild');
    expect(body).toMatchObject({ id: machineId, installationId, managedEnrollment });
    expect(body.installationId).not.toBe(controller.installationId);
  });
});
