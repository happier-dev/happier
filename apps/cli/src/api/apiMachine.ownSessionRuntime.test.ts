import axios, { AxiosHeaders } from 'axios';
import tweetnacl from 'tweetnacl';
import { describe, expect, it, vi } from 'vitest';

import { configuration } from '@/configuration';
import type { StoredCredentials } from '@/persistence';
import type { RpcHandlerContext } from '@/api/rpc/types';
import type { Machine } from '@/api/types';
import { ApiMachineClient } from './apiMachine';
import { createMachineEnvironmentAction } from '@/workspaces/environment/machineEnvironmentAction';
import { ExternalActionExecutionAuthorizationV1Schema, EXTERNAL_ACTION_EFFECT_ACTION_HEADER, EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER } from '@happier-dev/protocol/actions/externalActionApi';
import { MachineEnvironmentReportInputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import type { ActionExecutorContext } from '@happier-dev/protocol';
import { projectRequesterAccountActionAuthorization } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { projectExternalActionRequesterHttpAuthorization } from '@/api/externalActionExecutionAuthorization';

const osStore = vi.hoisted(() => ({
  identity: null as import('@happier-dev/protocol').MachineInstallationIdentityV1 | null,
  credentials: null as StoredCredentials | null,
  reads: [] as string[],
}));
const nativeTerminal = vi.hoisted(() => ({
  launches: [] as Array<{ file: string; args: string[]; options: import('@/terminal/pty/provider').PtyForkOptions }>,
  exit: undefined as ((code: number) => void) | undefined,
}));
// Only native module loading is substituted. The real registration, terminal
// manager, finite process owner and installed Account custody remain in use.
vi.mock('node:module', async importOriginal => {
  const actual = await importOriginal<typeof import('node:module')>();
  return { ...actual, createRequire: (...args: Parameters<typeof actual.createRequire>) => {
    const original = actual.createRequire(...args);
    return Object.assign((id: string) => id === 'node-pty' ? { spawn(file: string, argv: string[], options: import('@/terminal/pty/provider').PtyForkOptions) {
      nativeTerminal.launches.push({ file, args: argv, options });
      const listeners = new Set<(event: { exitCode: number }) => void>();
      nativeTerminal.exit = code => { for (const listener of listeners) listener({ exitCode: code }); };
      return { pid: 2147483600, write() {}, resize() {}, kill() {},
        onData() { return { dispose() {} }; }, onExit(listener: (event: { exitCode: number }) => void) {
          listeners.add(listener); return { dispose() { listeners.delete(listener); } };
        } };
    } } : original(id), original);
  } };
});
// Credential files and installation key storage are the actual OS boundaries.
vi.mock('@/persistence', async importOriginal => ({
  ...await importOriginal<typeof import('@/persistence')>(),
  readStoredCredentialsForServerId: async (serverId: string) => {
    osStore.reads.push(serverId);
    return osStore.credentials;
  },
}));
vi.mock('@/daemon/identity/store', async importOriginal => ({
  ...await importOriginal<typeof import('@/daemon/identity/store')>(),
  readInstallationIdentityIfExistsSync: () => osStore.identity,
}));

describe('ApiMachine own Session Account read custody', () => {
  it('consumes Bob admitted original Account ports for his Session on Alice installation without reading Alice credentials', async () => {
    const pair = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(17));
    osStore.identity = { version: 1, installationId: '11111111-1111-4111-8111-111111111111', createdAt: 1,
      publicKey: Buffer.from(pair.publicKey).toString('base64url'), privateKey: Buffer.from(pair.secretKey).toString('base64url') };
    osStore.credentials = { token: 'alice-token', encryption: null };
    osStore.reads.length = 0;
    const machine: Machine = { id: 'alice-machine', encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy',
      metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 };
    const client = new ApiMachineClient('alice-token', machine);
    let live = true;
    const get = vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { mode: 'plain', version: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } });
    const post = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { ok: true } });
    const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'bob-root', binding: {
      accountId: 'bob', custodianAccountId: 'alice', authentication: { kind: 'account', tokenEpoch: 1 }, accountEncryptionMode: 'plain',
      serverIdentityId: 'stable-home', machineId: machine.id, installationId: osStore.identity.installationId,
      actionId: 'machines.terminal.open', requestId: 'bob-open', requestEnvelopeDigest: 'a'.repeat(43), target: { kind: 'machine', machineId: machine.id },
    } });
    try {
      const http = await projectExternalActionRequesterHttpAuthorization({ authorization: root, serverId: configuration.activeServerId,
        serverIdentityId: 'stable-home', serverHttpBaseUrl: 'https://bob-home.test', target: root.binding.target,
        installationId: osStore.identity.installationId, privateKey: pair.secretKey, isCurrent: async () => live });
      if (!http) throw new Error('Original HTTP custody missing');
      const authorization = await projectRequesterAccountActionAuthorization({ authorization: http, serverIdentityId: 'stable-home',
        bootstrap: { credentials: { token: 'bob-token', encryption: null }, serverHttpBaseUrl: 'https://bob-home.test',
          attribution: { serverId: configuration.activeServerId, accountId: 'bob', machineId: machine.id, installationId: osStore.identity.installationId },
          isCurrent: async () => live } });
      if (!authorization) throw new Error('Private custody missing');
      const ingress: RpcHandlerContext = { signal: new AbortController().signal, callerInputAuthorization: authorization,
        machineAdmission: { actorAccountId: 'bob', custodianAccountId: 'alice', machineId: machine.id,
          installationId: osStore.identity.installationId, role: 'use', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: async () => live };
      const runtime = await client.resolveOwnSessionRuntime(ingress);
      expect(runtime).toMatchObject({ accountId: 'bob', machineId: machine.id, serverId: configuration.activeServerId });
      expect(runtime).not.toHaveProperty('credentials');
      expect(osStore.reads).toEqual([]);
      await expect(client.resolveOwnSessionRuntime({ ...ingress, machineAdmission: { ...ingress.machineAdmission!, actorAccountId: 'cara' } })).resolves.toBeNull();
      live = false;
      await expect(runtime?.isCurrent?.()).resolves.toBe(false);
      await expect(client.resolveOwnSessionRuntime(ingress)).resolves.toBeNull();
      expect(osStore.credentials.token).toBe('alice-token');
    } finally { get.mockRestore(); post.mockRestore(); osStore.identity = null; osStore.credentials = null; }
  });
  it('supplies installed Account provenance for local observation without granting missing-admission effects or foreign Session reads', async () => {
    const pair = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(17));
    osStore.identity = { version: 1, installationId: '11111111-1111-4111-8111-111111111111', createdAt: 1,
      publicKey: Buffer.from(pair.publicKey).toString('base64url'), privateKey: Buffer.from(pair.secretKey).toString('base64url') };
    osStore.credentials = { token: 'alice-token', encryption: null, credentialProvenance: 'stored_session' };
    const profile = vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { id: 'alice' } });
    const machine: Machine = { id: 'alice-machine', encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy',
      metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 };
    const client = new ApiMachineClient('alice-token', machine);
    const lifetime = new AbortController();
    const ingress: RpcHandlerContext = { signal: lifetime.signal };
    try {
      expect(await client.resolveMachineEnvironmentRuntime(ingress)).toBeNull();
      expect(await client.resolveOwnSessionRuntime({ ...ingress,
        machineAdmission: { actorAccountId: 'bob', custodianAccountId: 'alice', machineId: machine.id,
          installationId: osStore.identity.installationId, role: 'manage', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: async () => true })).toBeNull();
      const runtime = await client.resolveInstalledAccountObservationRuntime(lifetime.signal);
      expect(runtime).toMatchObject({ accountId: 'alice', machineId: machine.id, serverId: configuration.activeServerId,
        credentials: osStore.credentials });
      expect(await runtime?.isCurrent?.()).toBe(true);
      osStore.credentials = { token: 'replacement-token', encryption: null, credentialProvenance: 'stored_session' };
      expect(await runtime?.isCurrent?.()).toBe(false);
      expect(await client.resolveInstalledAccountObservationRuntime(lifetime.signal)).toBeNull();
    } finally { profile.mockRestore(); osStore.identity = null; osStore.credentials = null; }
  });
  it('composes the receiving machine setup factory with real installed custody and the registered finite terminal owner', async () => {
    const pair = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(17));
    osStore.identity = { version: 1, installationId: '11111111-1111-4111-8111-111111111111', createdAt: 1,
      publicKey: Buffer.from(pair.publicKey).toString('base64url'), privateKey: Buffer.from(pair.secretKey).toString('base64url') };
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'alice' })).toString('base64url')}.signature`;
    osStore.credentials = { token, encryption: null, credentialProvenance: 'stored_session' };
    nativeTerminal.launches.length = 0;
    const profile = vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { id: 'alice' } });
    const reports: string[] = [];
    const transport = vi.spyOn(axios, 'post').mockImplementation(async (url, body, options) => {
      expect(options?.headers).not.toHaveProperty('Authorization');
      expect(options?.headers).toMatchObject({ [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: 'machines.environment.apply',
        [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: 'home-issued-setup' });
      if (String(url).endsWith('/resolve')) return { status: 200, data: { environment: { setupScript: 'echo actual-setup' }, managedId: 'managed' } };
      expect(String(url)).toMatch(/\/v1\/machines\/environment\/report$/u);
      reports.push(MachineEnvironmentReportInputV1Schema.parse(body).state);
      return { status: 200, data: { ok: true } };
    });
    const machine: Machine = { id: 'alice-machine', encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy',
      metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 };
    const client = new ApiMachineClient(token, machine);
    const registration = client.setRPCHandlers({ spawnSession: async () => { throw new Error('Not a Session'); },
      stopSession: async () => ({ status: 'not_found' }), requestShutdown() {} });
    const input = { homeId: 'srv_home', machineId: machine.id, presetId: 'preset', presetRevision: 4 };
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-issued-setup', binding: {
      accountId: 'bob', custodianAccountId: 'alice', authentication: { kind: 'account', tokenEpoch: 7 }, accountEncryptionMode: 'plain',
      machineId: machine.id, installationId: osStore.identity.installationId, serverIdentityId: input.homeId,
      actionId: 'machines.environment.apply', requestId: 'setup-request', requestEnvelopeDigest: 'a'.repeat(43), target: { kind: 'machine', machineId: machine.id },
    } });
    const context: ActionExecutorContext = { surface: 'rpc', actionRequestId: 'setup-request', signal: new AbortController().signal,
      externalActionExecutionAuthorization: authorization, externalActionTarget: authorization.binding.target,
      machineAdmission: { actorAccountId: 'bob', custodianAccountId: 'alice', machineId: machine.id,
        installationId: osStore.identity.installationId, role: 'manage', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: async () => true };
    try {
      const apply = createMachineEnvironmentAction({ apiMachine: client, machineId: machine.id, homeId: input.homeId,
        installation: { installationId: osStore.identity.installationId, privateKey: pair.secretKey } });
      const execution = apply({ input, context });
      await expect.poll(() => nativeTerminal.launches.length).toBe(1);
      expect(reports).toEqual(['running']);
      expect(nativeTerminal.launches[0]?.args).toContain('echo actual-setup');
      nativeTerminal.exit!(0);
      expect(await execution).toMatchObject({ operationId: expect.any(String), terminalId: expect.any(String) });
      expect(reports).toEqual(['running', 'succeeded']);
    } finally { await registration.dispose(); profile.mockRestore(); transport.mockRestore(); osStore.identity = null; osStore.credentials = null; }
  });
  it('uses installed custodian material for a foreign admitted machine setup actor without exposing Session reads', async () => {
    const pair = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(17));
    osStore.identity = { version: 1, installationId: '11111111-1111-4111-8111-111111111111', createdAt: 1,
      publicKey: Buffer.from(pair.publicKey).toString('base64url'), privateKey: Buffer.from(pair.secretKey).toString('base64url') };
    osStore.credentials = { token: 'alice-token', encryption: null, credentialProvenance: 'stored_session' };
    const profile = vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { id: 'alice' } });
    const machine: Machine = { id: 'alice-machine', encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy',
      metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 };
    const client = new ApiMachineClient('alice-token', machine);
    const lifetime = new AbortController();
    const ingress: RpcHandlerContext = { signal: lifetime.signal,
      machineAdmission: { actorAccountId: 'bob', custodianAccountId: 'alice', machineId: machine.id,
        installationId: osStore.identity.installationId, role: 'manage', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: async () => true };
    try {
      await expect(client.resolveOwnSessionRuntime(ingress)).resolves.toBeNull();
      const runtime = await client.resolveMachineEnvironmentRuntime(ingress);
      expect(runtime).toMatchObject({ accountId: 'alice', machineId: machine.id, credentials: osStore.credentials });
      expect(await client.resolveMachineEnvironmentRuntime({ ...ingress, machineAdmission: { ...ingress.machineAdmission!, custodianAccountId: 'bob' } })).toBeNull();
      lifetime.abort();
      await expect(runtime?.isCurrent?.()).resolves.toBe(false);
      await expect(runtime?.isCustodyCurrent()).resolves.toBe(true);
      osStore.credentials = { token: 'replacement-token', encryption: null, credentialProvenance: 'stored_session' };
      await expect(runtime?.isCurrent?.()).resolves.toBe(false);
      await expect(runtime?.isCustodyCurrent()).resolves.toBe(false);
    } finally { profile.mockRestore(); osStore.identity = null; osStore.credentials = null; }
  });
  it('provides only its verified owner material and retires it after credential or installation replacement', async () => {
    const pair = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(17));
    osStore.identity = { version: 1, installationId: '11111111-1111-4111-8111-111111111111', createdAt: 1,
      publicKey: Buffer.from(pair.publicKey).toString('base64url'), privateKey: Buffer.from(pair.secretKey).toString('base64url') };
    osStore.credentials = { token: 'alice-token', encryption: null, credentialProvenance: 'stored_session' };
    osStore.reads.length = 0;
    // Authenticated Home profile is the network boundary; Account resolution stays real.
    const profile = vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, statusText: 'OK',
      headers: {}, config: { headers: new AxiosHeaders() }, data: { id: 'alice' } });
    const machine: Machine = { id: 'alice-machine', encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy',
      metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 };
    const client = new ApiMachineClient('alice-token', machine);
    let replaceCredentialDuringAdmission = false;
    const ingress: RpcHandlerContext = { signal: new AbortController().signal,
      machineAdmission: { actorAccountId: 'alice', custodianAccountId: 'alice', machineId: machine.id,
        installationId: osStore.identity.installationId, role: 'manage', encryptionMode: 'plain' },
      verifyMachineAdmissionCurrent: async () => {
        if (replaceCredentialDuringAdmission) osStore.credentials = {
          token: 'replacement-token', encryption: null, credentialProvenance: 'stored_session',
        };
        return true;
      } };
    try {
      await expect(client.resolveOwnSessionRuntime({ ...ingress,
        machineAdmission: { ...ingress.machineAdmission!, actorAccountId: 'bob' } })).resolves.toBeNull();
      expect(osStore.reads).toEqual([]);
      expect(profile).not.toHaveBeenCalled();
      const runtime = await client.resolveOwnSessionRuntime(ingress);
      expect(runtime).toMatchObject({ accountId: 'alice', serverId: configuration.activeServerId,
        machineId: machine.id, credentials: osStore.credentials });
      expect(profile).toHaveBeenCalledWith(expect.stringContaining('/v1/account/profile'),
        expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer alice-token' }) }));
      osStore.reads.length = 0;
      await expect(client.resolveOwnSessionRuntime({ ...ingress, machineAdmission: {
        ...ingress.machineAdmission!, actorAccountId: 'bob', custodianAccountId: 'bob',
      } })).resolves.toBeNull();
      expect(osStore.reads).toEqual([]);
      await expect(runtime?.isCurrent?.()).resolves.toBe(true);
      replaceCredentialDuringAdmission = true;
      await expect(runtime?.isCurrent?.()).resolves.toBe(false);
      replaceCredentialDuringAdmission = false;
      await expect(client.resolveOwnSessionRuntime(ingress)).resolves.toBeNull();
      osStore.credentials = { token: 'alice-token', encryption: null, credentialProvenance: 'stored_session' };
      osStore.identity = { ...osStore.identity!, installationId: '22222222-2222-4222-8222-222222222222' };
      await expect(runtime?.isCurrent?.()).resolves.toBe(false);
      await expect(client.resolveOwnSessionRuntime({ ...ingress, machineAdmission: {
        ...ingress.machineAdmission!, installationId: osStore.identity.installationId,
      } })).resolves.toBeNull();
    } finally {
      profile.mockRestore();
      osStore.identity = null;
      osStore.credentials = null;
    }
  });
});
