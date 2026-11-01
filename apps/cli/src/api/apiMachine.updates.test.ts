import { afterEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { z } from 'zod/mini';
import tweetnacl from 'tweetnacl';
import { openEncryptedDataKeyEnvelopeV1, sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { signAccountContentKeyBindingV1 } from '@happier-dev/protocol/crypto/accountContentKeyBindingV1';
import { computeContentPublicKeyFingerprint } from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';
import { computeMachineOwnerEnvelopeFingerprintV1 } from '@happier-dev/protocol/machines/machineOwnerEnvelopeFingerprintV1';
import { MachineRecipientKeyEnvelopeCommitInputV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
import { createSessionOwnerMetadataV1, projectSessionSharedMetadataV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { sealSessionOwnerMetadataEnvelopeV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1';
import { socketRpcCodec, type SocketRpcContent } from '@happier-dev/sync-client';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { readMachineFinitePolicyV1 } from '@happier-dev/protocol/machines/machineFinitePolicyV1';
import { decodeBase64, decrypt, encodeBase64, encrypt, getRandomBytes } from './encryption';

import { bindApiSessionSocketMock, bindApiSessionSocketSequenceMock, createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1 } from '@happier-dev/protocol/machines/operationProtocolCapabilitiesV1';
import { MachineUpdateMetadataRequestSchema, MachineUpdateStateRequestSchema } from '@happier-dev/protocol/machines/metadataUpdate';
import type { MachineAgentInventoryObservation } from '@/capabilities/snapshots/machineAgentInventory';

const ioMock = vi.hoisted(() => vi.fn());

vi.mock('socket.io-client', () => ({
  io: ioMock,
}));

// Cold source transformation belongs to collection, not a held-operation deadline.
await import('./api');

/** The Account feed consumes the active settings snapshot; this suite resets modules per case. */
async function seedActiveAccountSnapshot(token: string): Promise<void> {
  const [{ setActiveAccountSettingsSnapshot }, { accountSettingsParse }, { resolveAccountSettingsScopeKeyForToken }] = await Promise.all([
    import('@/settings/accountSettings/activeAccountSettingsSnapshot'),
    import('@happier-dev/protocol/account/settings/accountSettings'),
    import('@/settings/accountSettings/accountSettingsScopeKey'),
  ]);
  setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {}, settingsVersion: 1,
    loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKeyForToken(token) });
}

type ServedSessionRow = Readonly<{ transferredKey: Uint8Array; metadata: string; metadataLayoutVersion: number }>;

describe('ApiMachineClient updates', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    ioMock.mockReset();
    vi.resetModules();
  });

  it('publishes only changed Agent install facts while preserving newer equal-probe ordering', async () => {
    const key = new Uint8Array(32).fill(19);
    const machine = { id: 'machine-agent-publication', encryptionKey: key, encryptionVariant: 'legacy' as const,
      metadata: { host: 'worker', platform: 'linux', homeDir: '/home/worker', happyHomeDir: '/home/worker/.happier',
        happyCliVersion: 'test', agentInventory: { checkedAt: 10, installedAgentIds: ['codex'] } },
      metadataVersion: 1, daemonState: null, daemonStateVersion: 0 };
    const published: unknown[] = [];
    let failNextMetadataWrite = false;
    const socket = createApiSessionSocketStub({ connected: true, emitWithAck: (event, payload) => {
      if (event !== 'machine-update-metadata') throw new Error(`Unexpected event: ${event}`);
      if (failNextMetadataWrite) {
        failNextMetadataWrite = false;
        throw Object.assign(new Error('Metadata transport unavailable'), { retryable: false });
      }
      const write = MachineUpdateMetadataRequestSchema.parse(payload);
      published.push(decrypt(key, 'legacy', decodeBase64(write.metadata)));
      return { result: 'success', version: write.expectedVersion + 1, metadata: write.metadata };
    } });
    const { ApiMachineClient } = await import('./apiMachine');
    const client = new ApiMachineClient('token', machine);
    // The Socket is the real metadata publication boundary; reducers, codecs and CAS stay real.
    Reflect.set(client, 'socket', socket);
    const observation = (checkedAt: number, installed: boolean): MachineAgentInventoryObservation => ({ checkedAt,
      snapshot: { path: null, clis: { codex: { available: installed, installed } },
        tmux: { available: false }, windowsTerminal: { available: false } },
    });
    const observe = (checkedAt: number, installed: boolean) => client.updateMachineMetadata(
      current => { if (!current) throw new Error('Expected Machine metadata'); return current; },
      { agentInventoryObservation: observation(checkedAt, installed) },
    );
    try {
      await expect(observe(20, true)).resolves.toBe('unchanged');
      await expect(observe(15, false)).resolves.toBe('unchanged');
      expect(published).toEqual([]);
      expect(machine.metadataVersion).toBe(1);
      await expect(observe(30, false)).resolves.toBe('published');
      expect(machine.metadata.agentInventory).toEqual({ checkedAt: 30, installedAgentIds: [] });
      await expect(observe(40, false)).resolves.toBe('unchanged');
      await expect(observe(35, true)).resolves.toBe('unchanged');
      expect(published).toHaveLength(1);
      await expect(observe(50, true)).resolves.toBe('published');
      expect(machine.metadata.agentInventory).toEqual({ checkedAt: 50, installedAgentIds: ['codex'] });
      expect(published).toHaveLength(2);
      failNextMetadataWrite = true;
      await expect(observe(60, false)).rejects.toThrow('Metadata transport unavailable');
      expect(machine.metadata.agentInventory).toEqual({ checkedAt: 50, installedAgentIds: ['codex'] });
      await expect(observe(70, false)).resolves.toBe('published');
      expect(machine.metadata.agentInventory).toEqual({ checkedAt: 70, installedAgentIds: [] });
      await expect(observe(65, true)).resolves.toBe('unchanged');
      expect(published).toHaveLength(3);
    } finally { await client.shutdown(); }
  });

  it('adopts the authoritative child fact from an equal-version socket echo after a metadata acknowledgement', async () => {
    vi.stubEnv('HAPPY_ENABLE_V2_CHANGES', 'false');
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json({ features: {},
      capabilities: { serverIdentity: { serverIdentityId: 'fixture-home' } } })));
    const key = new Uint8Array(32).fill(83);
    const child = { relation: { managedMachineId: 'managed-child', managedMachineKind: 'devcontainer' as const,
      parentMachineId: 'physical-parent' }, observation: { nativeResourceId: 'old-native', user: 'custom-user',
      workspaceFolder: '/work/custom', storage: { kind: 'child' as const, childPath: '/work/custom' } } };
    const metadata = { host: 'child', platform: 'linux', homeDir: '/home/custom-user',
      happyHomeDir: '/home/custom-user/.happier', happyCliVersion: 'test' };
    vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'e2ee', updatedAt: 1 } };
      if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'owner' } };
      if (url.endsWith('/v1/machines/child-machine')) return { status: 200, data: { machine: {
        id: 'child-machine', metadata: encodeBase64(encrypt(key, 'legacy', metadata)), metadataVersion: 1,
        daemonState: null, daemonStateVersion: 0, storageMode: 'e2ee', dataEncryptionKey: null, devcontainerChild: child,
      } } };
      return { status: 404, data: {} };
    });
    let acknowledgedMetadata = '';
    const socket = createApiSessionSocketStub({ emitWithAck: (event, payload) => {
      if (event === MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1) return { result: 'success', revision: 1 };
      if (event !== 'machine-update-metadata') return { result: 'success', version: 1 };
      const write = MachineUpdateMetadataRequestSchema.parse(payload);
      acknowledgedMetadata = write.metadata;
      return { result: 'success', version: write.expectedVersion + 1, metadata: write.metadata };
    } });
    bindApiSessionSocketSequenceMock(ioMock, [socket, createApiSessionSocketStub()]);
    const { ApiClient } = await import('./api');
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
    const api = await ApiClient.create({ token, encryption: { type: 'legacy', secret: key } });
    const machine = await api.getMachine('child-machine');
    if (!machine) throw new Error('Expected admitted child Machine');
    const client = api.machineSyncClient(machine);
    try {
      client.connect();
      await vi.waitFor(() => expect(socket.connected).toBe(true));
      const callerClaim = { ...child, observation: { ...child.observation, nativeResourceId: 'caller-written-not-authority' } };
      await expect(client.updateMachineMetadata(value => ({ ...value!, displayName: 'Renamed', devcontainerChild: callerClaim })))
        .resolves.toBe('published');
      expect(machine.metadata?.devcontainerChild).toEqual(child);
      const replacement = { ...child, observation: { ...child.observation, nativeResourceId: 'replacement-native' } };
      socket.trigger('update', { id: 'child-current', seq: 2, createdAt: 2, body: { t: 'update-machine', machineId: machine.id,
        metadata: { value: acknowledgedMetadata, version: machine.metadataVersion }, devcontainerChild: replacement } });
      expect(machine.metadata).toMatchObject({ displayName: 'Renamed', devcontainerChild: replacement });
      socket.trigger('update', { id: 'child-retired', seq: 3, createdAt: 3, body: { t: 'update-machine', machineId: machine.id,
        devcontainerChild: null } });
      expect(machine.metadata?.devcontainerChild).toBeUndefined();
    } finally { await client.shutdown(); }
  });

  it('repairs a later Team member from the actual Machine change page using another online Manage holder', async () => {
    // afterEach resets the module graph; bind the filesystem boundary used by
    // this case's actual ApiMachine, not a retired top-level module instance.
    const persistence = await import('@/persistence');
    // The request-local Home context must belong to this same reset module
    // graph; a retired AsyncLocalStorage instance cannot scope ApiMachine.
    const { runWithServerHttpBaseUrl } = await import('./client/serverHttpBaseUrl');
    // Exercise the real first-feed preparation modules, but finish their cold
    // source transformation before starting the observable live-feed wait.
    await Promise.all([
      import('./machineAccessGrantEnvelopeHost'),
      import('@happier-dev/protocol/sessions/encryption/sessionDataKeyPreparationPass'),
    ]);
    const holder = tweetnacl.box.keyPair();
    const recipient = tweetnacl.box.keyPair();
    const signing = tweetnacl.sign.keyPair();
    const key = new Uint8Array(32).fill(41);
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'bob' })).toString('base64url')}.signature`;
    const credential = { token, encryption: { type: 'dataKey' as const, publicKey: holder.publicKey, machineKey: holder.secretKey } };
    const caller = encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey: key, recipientPublicKey: holder.publicKey, randomBytes: getRandomBytes }));
    const fingerprint = computeContentPublicKeyFingerprint(recipient.publicKey);
    let delivered: Uint8Array | null = null;
    let teamJoined = false;
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json({
      features: {}, capabilities: { serverIdentity: { serverIdentityId: 'fixture-home' } },
    })));
    vi.spyOn(persistence, 'readStoredCredentialsForServerId').mockResolvedValue(credential);
    vi.spyOn(persistence, 'readAccountChangesCursor').mockResolvedValue(0);
    let acknowledgeFeed!: () => void;
    const feedCommitted = new Promise<void>(resolve => { acknowledgeFeed = resolve; });
    vi.spyOn(persistence, 'writeAccountChangesCursor').mockImplementation(async (accountId, cursor) => {
      if (accountId === 'bob' && cursor === 1) acknowledgeFeed();
    });
    const publishedContent = {
      metadata: encodeBase64(encrypt(key, 'dataKey', { host: 'alice', platform: 'linux', happyCliVersion: '0.3', homeDir: '/home/alice', happyHomeDir: '/home/alice/.happier' })),
      metadataVersion: 3, daemonState: null, daemonStateVersion: 4,
    };
    vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'bob' } };
      if (url.endsWith('/v2/changes')) return { status: 200, data: { changes: teamJoined
        ? [{ cursor: 1, kind: 'machine', entityId: 'alice-machine', changedAt: 1 }] : [], nextCursor: teamJoined ? 1 : 0 } };
      if (url.endsWith('/v1/machines/alice-machine')) return { status: 200, data: { machine: {
        id: 'alice-machine', ...publishedContent, dataEncryptionKey: caller,
        access: { custodian: { accountId: 'offline-alice', displayName: 'Alice' }, role: 'manage', resourceMode: 'e2ee', accessState: 'ready' },
      } } };
      if (url.includes('/v1/machines/alice-machine/data-key-envelopes')) return { status: 200, data: {
        machineId: 'alice-machine', custodianAccountId: 'offline-alice', encryptionMode: 'e2ee',
        machineOwnerEnvelopeFingerprint: computeMachineOwnerEnvelopeFingerprintV1(decodeBase64(caller)), callerDataEncryptionKey: caller, nextCursor: null,
        content: publishedContent,
        recipients: delivered ? [] : [{ recipientAccountId: 'later-team-member', contentKey: { status: 'available',
          accountSigningPublicKey: Buffer.from(signing.publicKey).toString('hex'), contentPublicKey: encodeBase64(recipient.publicKey),
          contentPublicKeySignature: encodeBase64(signAccountContentKeyBindingV1({ accountSigningSecretKey: signing.secretKey, contentPublicKey: recipient.publicKey })) },
          contentPublicKeyFingerprint: fingerprint, encryptedDataKey: null, recipientContentPublicKeyFingerprint: null }],
      } };
      return { status: 404, data: {} };
    });
    vi.spyOn(axios, 'patch').mockImplementation(async (url: string, body: unknown) => {
      expect(url).toBe('https://holder-home.test/v1/machines/alice-machine/data-key-envelopes');
      const input = MachineRecipientKeyEnvelopeCommitInputV1Schema.parse({ machineId: 'alice-machine', ...z.omit(MachineRecipientKeyEnvelopeCommitInputV1Schema, { machineId: true }).parse(body) });
      delivered = openEncryptedDataKeyEnvelopeV1({ envelope: decodeBase64(input.recipientKeyEnvelopes[0]!.encryptedDataKey), recipientSecretKeyOrSeed: recipient.secretKey });
      return { status: 200, data: { appliedRecipientAccountIds: ['later-team-member'], skippedRecipientAccountIds: [] } };
    });
    const socket = createApiSessionSocketStub();
    bindApiSessionSocketSequenceMock(ioMock, [socket, createApiSessionSocketStub()]);
    const { ApiMachineClient } = await import('./apiMachine');
    const client = runWithServerHttpBaseUrl('https://holder-home.test', () => new ApiMachineClient(token, {
      id: 'bob-executor', encryptionMode: 'e2ee', encryptionKey: key, encryptionVariant: 'dataKey', dataEncryptionKey: caller,
      metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0,
    }));
    try {
      // This fixture owns the live socket/feed boundary, not daemon startup's connected-service
      // reconciler. Deliver the Home wake from the public connected callback; the incumbent
      // scheduler coalesces it into live catch-up without a fake startup-domain consumer.
      runWithServerHttpBaseUrl('https://holder-home.test', () => client.connect({ onConnect: () => {
        expect(delivered).toBeNull();
        teamJoined = true;
        socket.trigger('update', { id: 'team-member-joined', seq: 1, createdAt: 1, body: { t: 'account-change' } });
      } }));
      // Observe the owning feed commit after preparation, rather than imposing
      // vi.waitFor's unrelated one-second polling budget on cold crypto work.
      await feedCommitted;
      expect(axios.get).toHaveBeenCalledWith(
        'https://holder-home.test/v1/machines/alice-machine/data-key-envelopes?state=action_required',
        expect.anything(),
      );
      expect(delivered).toEqual(key);
      expect(persistence.writeAccountChangesCursor).toHaveBeenCalledWith('bob', 1);
    } finally { await client.shutdown(); }
  });

  /** One pushed `share` pass over real preparation modules; the Home serves the row the case names. */
  const runShareWakePass = async (serveSessionRow: (sessionKey: Uint8Array) => ServedSessionRow) => {
    const persistence = await import('@/persistence');
    const { runWithServerHttpBaseUrl } = await import('./client/serverHttpBaseUrl');
    await Promise.all([
      import('./sessionAccessGrantEnvelopeHost'),
      import('@happier-dev/protocol/sessions/encryption/sessionDataKeyPreparationPass'),
    ]);
    const owner = tweetnacl.box.keyPair();
    const recipient = tweetnacl.box.keyPair();
    const signing = tweetnacl.sign.keyPair();
    const key = new Uint8Array(32).fill(53);
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'alice' })).toString('base64url')}.signature`;
    const credential = { token, encryption: { type: 'dataKey' as const, publicKey: owner.publicKey, machineKey: owner.secretKey } };
    const sealToOwner = (dataKey: Uint8Array) => encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey, recipientPublicKey: owner.publicKey, randomBytes: getRandomBytes }));
    const ownerEnvelope = sealToOwner(key);
    const servedRow = serveSessionRow(key);
    const openedOwnerMetadata = createSessionOwnerMetadataV1({ metadata: { path: '/work', host: 'alice' } });
    if (!openedOwnerMetadata.ok) throw new Error('Expected owner metadata fixture');
    const ownerMetadata = sealSessionOwnerMetadataEnvelopeV1({ material: { type: 'dataKey', machineKey: owner.secretKey },
      ownerMetadata: openedOwnerMetadata.ownerMetadata, randomBytes: getRandomBytes });
    const owedItem = { recipientAccountId: 'later-team-member', envelopeState: 'missing', contentKey: { status: 'available',
      accountSigningPublicKey: Buffer.from(signing.publicKey).toString('hex'), contentPublicKey: encodeBase64(recipient.publicKey),
      contentPublicKeySignature: encodeBase64(signAccountContentKeyBindingV1({ accountSigningSecretKey: signing.secretKey, contentPublicKey: recipient.publicKey })) } };
    const summary = { prepared: 1, pending: 0, invalid: 0, recipientKeyUnavailable: 0 };
    let delivered: Uint8Array | null = null;
    let memberJoined = false;
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json({
      features: {}, capabilities: { serverIdentity: { serverIdentityId: 'fixture-home' } },
    })));
    vi.spyOn(persistence, 'readStoredCredentialsForServerId').mockResolvedValue(credential);
    vi.spyOn(persistence, 'readAccountChangesCursor').mockResolvedValue(0);
    let acknowledgeFeed!: () => void;
    const feedCommitted = new Promise<void>(resolve => { acknowledgeFeed = resolve; });
    vi.spyOn(persistence, 'writeAccountChangesCursor').mockImplementation(async (accountId, cursor) => {
      if (accountId === 'alice' && cursor === 4) acknowledgeFeed();
    });
    const sessionIds = ['foreign-session', 'settled-session', 'plain-session', 'owed-session'];
    const envelopePage = (sessionId: string) => {
      if (sessionId === 'foreign-session') return { status: 403, data: { error: 'forbidden' } };
      if (sessionId === 'plain-session') return { status: 200, data: { status: 'not_required' } };
      const items = sessionId === 'owed-session' && !delivered ? [owedItem] : [];
      return { status: 200, data: { status: 'required', summary, items, nextCursor: null } };
    };
    vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      const { pathname, searchParams } = new URL(url);
      if (pathname === '/v1/account/profile') return { status: 200, data: { id: 'alice' } };
      if (pathname === '/v1/account/encryption/currentness') return { status: 200, data: {
        mode: 'e2ee', version: 1, settingsVersion: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (pathname === '/v2/changes') {
        const subscribed = searchParams.get('kinds')?.split(',').includes('share');
        return { status: 200, data: { changes: memberJoined && subscribed
          ? sessionIds.map((entityId, index) => ({ cursor: index + 1, kind: 'share', entityId, changedAt: 1 })) : [], nextCursor: memberJoined ? 4 : 0 } };
      }
      const envelopes = pathname.match(/^\/v2\/sessions\/([^/]+)\/data-key\/envelopes$/);
      if (envelopes) return envelopePage(envelopes[1]!);
      if (pathname === '/v2/sessions/owed-session') return { status: 200, data: { session: {
        id: 'owed-session', seq: 1, createdAt: 1, updatedAt: 1, active: true, activeAt: 1, encryptionMode: 'e2ee',
        metadata: servedRow.metadata, metadataLayoutVersion: servedRow.metadataLayoutVersion, metadataVersion: 1,
        ...(servedRow.metadataLayoutVersion === 1 ? { share: null, ownerMetadata } : {}),
        agentState: null, agentStateVersion: 0, dataEncryptionKey: sealToOwner(servedRow.transferredKey) } } };
      return { status: 404, data: {} };
    });
    // The key holder's statement is the whole proof; the pass reads no Home audience.
    vi.spyOn(axios, 'post').mockResolvedValue({ status: 500, data: {} });
    const patch = vi.spyOn(axios, 'patch').mockImplementation(async (url: string, body: unknown) => {
      expect(url).toBe('https://owner-home.test/v2/sessions/owed-session/data-key/envelopes');
      // The Home only ever sees sealed bytes for the census's own recipient.
      expect(JSON.stringify(body)).not.toContain(encodeBase64(key));
      const { entries } = body as { entries: Array<{ recipientAccountId: string; encryptedDataKey: string }> };
      expect(entries.map(entry => entry.recipientAccountId)).toEqual(['later-team-member']);
      delivered = openEncryptedDataKeyEnvelopeV1({ envelope: decodeBase64(entries[0]!.encryptedDataKey), recipientSecretKeyOrSeed: recipient.secretKey });
      return { status: 200, data: { appliedCount: 1 } };
    });
    const socket = createApiSessionSocketStub();
    bindApiSessionSocketSequenceMock(ioMock, [socket, createApiSessionSocketStub()]);
    const { ApiMachineClient } = await import('./apiMachine');
    const client = runWithServerHttpBaseUrl('https://owner-home.test', () => new ApiMachineClient(token, {
      id: 'alice-executor', encryptionMode: 'e2ee', encryptionKey: key, encryptionVariant: 'dataKey', dataEncryptionKey: ownerEnvelope,
      metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0,
    }));
    client.onConnectedServicesProjection(async () => {});
    await seedActiveAccountSnapshot(token);
    try {
      runWithServerHttpBaseUrl('https://owner-home.test', () => client.connect({ onConnect: () => {
        memberJoined = true;
        socket.trigger('update', { id: 'team-member-joined', seq: 4, createdAt: 1, body: { t: 'account-change' } });
      } }));
      await feedCommitted;
      return { key, delivered, patch };
    } finally { await client.shutdown(); }
  };

  it('delivers Session keys from the owner daemon on the pushed share change, without a foreign or settled Session blocking it', async () => {
    const { key, delivered, patch } = await runShareWakePass(sessionKey => ({
      transferredKey: sessionKey, metadataLayoutVersion: 1,
      metadata: encodeBase64(encrypt(sessionKey, 'dataKey', projectSessionSharedMetadataV1({ metadata: {
        summary: { text: 'Shared work', updatedAt: 1 }, teamShareStatementV1: { v: 1, teamIds: ['session-team'] },
      } }))),
    }));
    expect(delivered).toEqual(key);
    expect(patch).toHaveBeenCalledTimes(1);
    expect(axios.post).not.toHaveBeenCalled();
    // Nothing owed, nothing opened: the key is read only for real work.
    expect(axios.get).not.toHaveBeenCalledWith('https://owner-home.test/v2/sessions/settled-session', expect.anything());
  });

  const otherResourceKey = new Uint8Array(32).fill(67);
  const machineContent = { host: 'alice', platform: 'linux', happyCliVersion: '0.3', homeDir: '/home/alice', happyHomeDir: '/home/alice/.happier' };
  const sealedTo = (key: Uint8Array, value: unknown) => encodeBase64(encrypt(key, 'dataKey', value));
  it.each<[string, (sessionKey: Uint8Array) => ServedSessionRow]>([
    ['a Machine key with its own content under the tolerant legacy layout', () => ({
      transferredKey: otherResourceKey, metadataLayoutVersion: 0, metadata: sealedTo(otherResourceKey, machineContent) })],
    ['a Machine key with its own content under the shared layout', () => ({
      transferredKey: otherResourceKey, metadataLayoutVersion: 1, metadata: sealedTo(otherResourceKey, machineContent) })],
    ['a key that cannot open the Session metadata', sessionKey => ({
      transferredKey: otherResourceKey, metadataLayoutVersion: 1, metadata: sealedTo(sessionKey, { v: 1 }) })],
    ['a Session no key holder shared with a Team', sessionKey => ({
      transferredKey: sessionKey, metadataLayoutVersion: 1, metadata: sealedTo(sessionKey, { v: 1 }) })],
  ])('leaves recipients pending and seals nothing when the Home serves %s as the Session key', async (_case, serveSessionRow) => {
    const { delivered, patch } = await runShareWakePass(serveSessionRow);
    expect(patch).not.toHaveBeenCalled();
    expect(delivered).toBeNull();
  });

  it.each(['http503', 'network', 'unopenable-key'] as const)('keeps RPC authority across snapshot refresh failure only without contrary key evidence (%s)', async (failure) => {
    vi.stubEnv('HAPPY_ENABLE_V2_CHANGES', 'false');
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json({ features: {},
      capabilities: { serverIdentity: { serverIdentityId: 'fixture-home' } } })));
    const accountKey = new Uint8Array(32).fill(11);
    const key = new Uint8Array(32).fill(19);
    const publicKey = tweetnacl.box.keyPair.fromSecretKey(accountKey).publicKey;
    const row = { id: 'machine-1', storageMode: 'e2ee',
      dataEncryptionKey: encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey: key,
        recipientPublicKey: publicKey, randomBytes: getRandomBytes })),
      metadata: null, metadataVersion: 1, daemonState: null, daemonStateVersion: 0 };
    let readFailure: typeof failure | null = null;
    vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'e2ee', updatedAt: 1 } };
      if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'fixture-owner' } };
      if (url.endsWith('/v1/machines/machine-1')) {
        if (readFailure === 'http503') throw new axios.AxiosError('Snapshot busy', 'ERR_BAD_RESPONSE', undefined, undefined,
          { status: 503, statusText: 'Service Unavailable', data: {}, headers: {}, config: { headers: new axios.AxiosHeaders() } });
        if (readFailure === 'network') throw new axios.AxiosError('Connection reset', 'ECONNRESET');
        return { status: 200, data: { machine: readFailure === 'unopenable-key' ? { ...row,
          dataEncryptionKey: encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey: new Uint8Array(32).fill(29),
            recipientPublicKey: tweetnacl.box.keyPair().publicKey, randomBytes: getRandomBytes })),
          metadataVersion: 2 } : row } };
      }
      return { status: 404, data: {} };
    });
    const { ApiClient } = await import('./api');
    const { RpcHandlerManager } = await import('./rpc/RpcHandlerManager');
    const api = await ApiClient.create({ token: 'token', encryption: { type: 'dataKey', machineKey: accountKey, publicKey } });
    const initial = await api.getMachine(row.id);
    if (!initial) throw new Error('Expected admitted Machine');
    const client = api.machineSyncClient(initial);
    const manager: unknown = Reflect.get(client, 'rpcHandlerManager');
    const refresh: unknown = Reflect.get(client, 'refreshMachineFromServer');
    if (!(manager instanceof RpcHandlerManager) || typeof refresh !== 'function') throw new Error('Missing Machine RPC owner');
    manager.registerHandler('context.read', () => ({ current: true }));
    const content: SocketRpcContent = { mode: 'e2ee', cipher: {
      encryptRaw: async value => encodeBase64(encrypt(key, 'dataKey', value)),
      decryptRaw: async value => decrypt(key, 'dataKey', decodeBase64(value)),
    } };
    const callId = '0123456789abcdef0123456789abcdef';
    const request = async () => manager.handleRequest({ method: 'machine-1:context.read',
      params: await socketRpcCodec.encodeParams(content, {}, { method: 'machine-1:context.read', callId }) });
    const decode = async (result: unknown) => socketRpcCodec.decodeResult(content, { ok: true, result }, callId);
    try {
      expect(await decode(await request())).toEqual({ current: true });
      readFailure = failure;
      await Reflect.apply(refresh, client, []);
      const afterFailure = await request();
      if (failure === 'unopenable-key') {
        expect(afterFailure).toMatchObject({ errorCode: RPC_ERROR_CODES.UPDATE_REQUIRED });
        // A failed read cannot restore authority that a proven key change retired.
        readFailure = 'http503';
        await Reflect.apply(refresh, client, []);
        expect(await request()).toMatchObject({ errorCode: RPC_ERROR_CODES.UPDATE_REQUIRED });
      } else expect(await decode(afterFailure)).toEqual({ current: true });
      readFailure = null;
      await Reflect.apply(refresh, client, []);
      expect(await decode(await request())).toEqual({ current: true });
    } finally { await client.shutdown(); }
  });

  it.each(['hint', 'held-ack', 'key-mismatch', 'stale-refresh'] as const)('adopts a committed Machine context for subsequent RPC and versioned writes (%s)', async (admission) => {
    // The real connection supervisor probes Home with fetch, independently of Axios.
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      features: {}, capabilities: { serverIdentity: { serverIdentityId: 'fixture-home' } },
    }), { status: 200, headers: { 'content-type': 'application/json' } })));
    const accountKey = new Uint8Array(32).fill(11);
    const oldKey = new Uint8Array(32).fill(19);
    const currentKey = new Uint8Array(32).fill(29);
    const publicKey = tweetnacl.box.keyPair.fromSecretKey(accountKey).publicKey;
    const envelope = (key: Uint8Array) => encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey: key,
      recipientPublicKey: publicKey, randomBytes: getRandomBytes }));
    const metadata = { host: 'old', homeDir: '/home/owner', platform: 'linux', happyCliVersion: 'test', happyHomeDir: '/home/owner/.happier' };
    let row = { id: 'machine-1', storageMode: 'e2ee', dataEncryptionKey: envelope(oldKey),
      metadata: encodeBase64(encrypt(oldKey, 'dataKey', metadata)), metadataVersion: 1,
      daemonState: null, daemonStateVersion: 0 };
    const respondToHomeRead = (url: string) => {
      if (url.endsWith('/v1/machines/machine-1')) return { status: 200, data: { machine: row } };
      if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'fixture-owner' } };
      if (url.endsWith('/v2/changes')) return { status: 200, data: { changes: [], nextCursor: 0 } };
      if (url.endsWith('/v1/auth/ping')) return { status: 200, data: {} };
      if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'e2ee', updatedAt: 1 } };
      return { status: 404, data: {} };
    };
    const get = vi.spyOn(axios, 'get').mockImplementation(async (url: string) => respondToHomeRead(url));
    const machineSocket = createApiSessionSocketStub();
    bindApiSessionSocketMock(ioMock, machineSocket);
    const { ApiClient } = await import('./api');
    const { RpcHandlerManager } = await import('./rpc/RpcHandlerManager');
    const api = await ApiClient.create({ token: 'token', encryption: { type: 'dataKey', machineKey: accountKey, publicKey } });
    const initial = await api.getMachine(row.id);
    if (!initial) throw new Error('Expected Machine');
    const client = api.machineSyncClient(initial);
    client.connect();
    let releaseOldReply: (() => void) | undefined;
    let releaseOldRead: (() => void) | undefined;
    let releaseCurrentRead: (() => void) | undefined;
    try {
      await vi.waitFor(() => expect(machineSocket.connected).toBe(true));
      let pendingPublication: Promise<unknown> | undefined;
      let pendingOldRefresh: Promise<unknown> | undefined;
      let observedReads = 0;
      if (admission === 'stale-refresh') {
        const oldRow = row;
        get.mockImplementation(async (url: string) => {
          if (!url.endsWith('/v1/machines/machine-1')) return respondToHomeRead(url);
          observedReads += 1;
          if (observedReads === 1) {
            await new Promise<void>(resolve => { releaseOldRead = resolve; });
            return { status: 200, data: { machine: oldRow } };
          }
          await new Promise<void>(resolve => { releaseCurrentRead = resolve; });
          return { status: 200, data: { machine: row } };
        });
        const refresh: unknown = Reflect.get(client, 'refreshMachineFromServer');
        if (typeof refresh !== 'function') throw new Error('Missing current-context owner');
        pendingOldRefresh = Reflect.apply(refresh, client, []);
        await vi.waitFor(() => expect(releaseOldRead).toBeDefined());
      }
      if (admission === 'held-ack') {
        machineSocket.emitWithAck.mockImplementation(async (event: string, payload: unknown) => {
          if (event !== 'machine-update-metadata') return { result: 'success', version: 1 };
          const write = payload as { metadata: string; expectedDataEncryptionKey: string | null };
          expect(write.expectedDataEncryptionKey).toBe(row.dataEncryptionKey);
          await new Promise<void>(resolve => { releaseOldReply = resolve; });
          return { result: 'success', version: 2, metadata: write.metadata };
        });
        pendingPublication = client.updateMachineMetadata(value => ({ ...value!, displayName: 'Owner edit' }));
        await vi.waitFor(() => expect(releaseOldReply).toBeDefined());
      }
      row = { ...row, dataEncryptionKey: envelope(currentKey), metadata: encodeBase64(encrypt(currentKey, 'dataKey', { ...metadata, host: 'current',
        ...(admission === 'held-ack' ? { displayName: 'Later user edit' } : {}) })),
        metadataVersion: 2, daemonStateVersion: 1 };
      if (admission === 'key-mismatch') {
        machineSocket.emitWithAck.mockImplementation(async (event: string, payload: unknown) => {
          if (event !== 'machine-update-metadata') return { result: 'success', version: 1 };
          const write = payload as { metadata: string; expectedDataEncryptionKey: string | null };
          expect(write.expectedDataEncryptionKey).toBe(initial.dataEncryptionKey);
          expect(decrypt(oldKey, 'dataKey', decodeBase64(write.metadata))).toEqual({ ...metadata, displayName: 'Owner edit' });
          return { result: 'key-mismatch' };
        });
        pendingPublication = client.updateMachineMetadata(value => ({ ...value!, displayName: 'Owner edit' }));
      } else machineSocket.trigger('update', { id: 'changed', seq: 1, createdAt: 1, body: {
        t: 'update-machine', machineId: row.id, dataEncryptionKey: row.dataEncryptionKey,
        metadata: { value: row.metadata, version: row.metadataVersion },
      } });
      if (admission === 'stale-refresh') {
        await vi.waitFor(() => expect(releaseCurrentRead).toBeDefined());
        releaseOldRead?.();
        await pendingOldRefresh;
        releaseCurrentRead?.();
      }
      const manager: unknown = Reflect.get(client, 'rpcHandlerManager');
      if (!(manager instanceof RpcHandlerManager)) throw new Error('Missing RPC owner');
      manager.registerHandler('context.read', () => ({ current: true }));
      const content: SocketRpcContent = { mode: 'e2ee', cipher: {
        encryptRaw: async value => encodeBase64(encrypt(currentKey, 'dataKey', value)),
        decryptRaw: async value => decrypt(currentKey, 'dataKey', decodeBase64(value)),
      } };
      const callId = '0123456789abcdef0123456789abcdef';
      await vi.waitFor(async () => {
        const params = await socketRpcCodec.encodeParams(content, {}, { method: 'machine-1:context.read', callId });
        const response = await manager.handleRequest({ method: 'machine-1:context.read', params });
        expect(await socketRpcCodec.decodeResult(content, { ok: true, result: response }, callId)).toEqual({ current: true });
      });
      if (admission === 'held-ack') {
        machineSocket.emitWithAck.mockImplementation(async (event: string, payload: unknown) => {
          if (event !== 'machine-update-metadata') return { result: 'success', version: 1 };
          const write = payload as { metadata: string };
          // A replay would overwrite the newer committed owner edit.
          row = { ...row, metadata: write.metadata, metadataVersion: row.metadataVersion + 1 };
          return { result: 'success', version: row.metadataVersion, metadata: row.metadata };
        });
        const settlement = expect(pendingPublication).rejects.toMatchObject({ retryable: false });
        releaseOldReply?.();
        await settlement;
        expect(decrypt(currentKey, 'dataKey', decodeBase64(row.metadata))).toEqual({ ...metadata, host: 'current', displayName: 'Later user edit' });
      }
      machineSocket.emitWithAck.mockImplementation(async (event: string, payload: unknown) => {
        if (event !== 'machine-update-metadata') return { result: 'success', version: 1 };
        const write = payload as { metadata: string; expectedVersion: number; expectedDataEncryptionKey: string | null };
        expect(write.expectedDataEncryptionKey).toBe(row.dataEncryptionKey);
        expect(write.expectedVersion).toBe(2);
        expect(decrypt(currentKey, 'dataKey', decodeBase64(write.metadata))).toEqual(admission === 'held-ack'
          ? { ...metadata, host: 'next host', displayName: 'Later user edit' }
          : { ...metadata, host: 'current', displayName: 'Owner edit' });
        return { result: 'success', version: 3, metadata: write.metadata };
      });
      releaseOldReply?.();
      await expect(admission === 'held-ack' ? client.updateMachineMetadata(value => ({ ...value!, host: 'next host' }))
        : pendingPublication ?? client.updateMachineMetadata(value => ({ ...value!, displayName: 'Owner edit' }))).resolves.toBe('published');
    } finally { releaseOldReply?.(); releaseOldRead?.(); releaseCurrentRead?.(); await client.shutdown(); }
  });

  it('settles concurrent startup publications across a same-key snapshot refresh without replaying committed writes', async () => {
    vi.stubEnv('HAPPY_ENABLE_V2_CHANGES', 'false');
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json({
      features: {}, capabilities: { serverIdentity: { serverIdentityId: 'fixture-home' } },
    })));
    const accountKey = new Uint8Array(32).fill(51);
    const key = new Uint8Array(32).fill(61);
    const publicKey = tweetnacl.box.keyPair.fromSecretKey(accountKey).publicKey;
    const envelope = encodeBase64(sealEncryptedDataKeyEnvelopeV1({
      dataKey: key, recipientPublicKey: publicKey, randomBytes: getRandomBytes,
    }));
    const metadata = { host: 'startup', homeDir: '/home/owner', platform: 'linux',
      happyCliVersion: 'test', happyHomeDir: '/home/owner/.happier' };
    let row = { id: 'machine-1', storageMode: 'e2ee', dataEncryptionKey: envelope,
      metadata: encodeBase64(encrypt(key, 'dataKey', metadata)), metadataVersion: 1,
      daemonState: null as string | null, daemonStateVersion: 0 };
    vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/machines/machine-1')) return { status: 200, data: { machine: row } };
      if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'owner' } };
      if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'e2ee', updatedAt: 1 } };
      return { status: 404, data: {} };
    });
    let release!: () => void;
    const heldAcknowledgements = new Promise<void>(resolve => { release = resolve; });
    let publications = 0;
    let metadataCommits = 0;
    const socket = createApiSessionSocketStub({ emitWithAck: async (event, payload) => {
      if (event === MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1) return { result: 'success', revision: 1 };
      if (event === 'machine-update-metadata') {
        const write = MachineUpdateMetadataRequestSchema.parse(payload);
        expect(write.expectedDataEncryptionKey).toBe(envelope);
        publications += 1;
        metadataCommits += 1;
        row = { ...row, metadata: write.metadata, metadataVersion: row.metadataVersion + 1 };
        const answer = { result: 'success', version: row.metadataVersion, metadata: row.metadata };
        await heldAcknowledgements;
        return answer;
      }
      if (event === 'machine-update-state') {
        const write = MachineUpdateStateRequestSchema.parse(payload);
        expect(write.expectedDataEncryptionKey).toBe(envelope);
        publications += 1;
        const result = write.expectedVersion === row.daemonStateVersion ? 'success' : 'version-mismatch';
        if (result === 'success') row = { ...row, daemonState: write.daemonState, daemonStateVersion: row.daemonStateVersion + 1 };
        const answer = { result, version: row.daemonStateVersion, daemonState: row.daemonState };
        await heldAcknowledgements;
        return answer;
      }
      return { result: 'success', version: 1 };
    } });
    bindApiSessionSocketMock(ioMock, socket);
    const { ApiClient } = await import('./api');
    const api = await ApiClient.create({ token: 'token', encryption: { type: 'dataKey', machineKey: accountKey, publicKey } });
    const initial = await api.getMachine(row.id);
    if (!initial) throw new Error('Expected admitted E2EE Machine');
    const client = api.machineSyncClient(initial);
    let summary = { v: 1 as const, state: 'ready' as const, runningCount: 1 };
    const readiness = { status: 'running' as const, pid: 4242, httpPort: 4321, startedAt: 100,
      contributionRegistryProjectionRevision: 0 };
    try {
      client.connect();
      await vi.waitFor(() => expect(socket.connected).toBe(true));
      const pending = Promise.allSettled([
        client.updateMachineMetadata(value => ({ ...value!, displayName: 'Ready host' })),
        client.updateDaemonState(state => ({ ...state, ...readiness })),
        client.updateDaemonState(state => ({ ...state, status: 'running', localServices: summary })),
        client.updateDaemonState(state => ({ ...state, status: 'running',
          contributionRegistryProjectionRevision: (state?.contributionRegistryProjectionRevision ?? 0) + 1 })),
      ]);
      await vi.waitFor(() => expect(publications).toBe(4));
      // A later owner edit and service scan win while the earlier ACKs are held.
      // Retries must merge into this snapshot and read the current summary.
      summary = { ...summary, runningCount: 2 };
      row = { ...row, metadata: encodeBase64(encrypt(key, 'dataKey', { ...metadata, displayName: 'Later owner edit' })),
        metadataVersion: row.metadataVersion + 1,
        daemonState: encodeBase64(encrypt(key, 'dataKey', { ...readiness, localServices: summary })),
        daemonStateVersion: row.daemonStateVersion + 1 };
      // Real authenticated snapshot opening races network ACKs after the Home
      // committed startup writes; this read does not establish another key.
      const refresh: unknown = Reflect.get(client, 'refreshMachineFromServer');
      if (typeof refresh !== 'function') throw new Error('Missing snapshot owner');
      await Reflect.apply(refresh, client, []);
      release();
      // The refreshed snapshot already contains the current service summary;
      // that publication settles without another versioned write.
      expect(await pending).toEqual(['published', 'published', 'unchanged', 'published']
        .map(value => ({ status: 'fulfilled', value })));
      expect(metadataCommits).toBe(1);
      expect(decrypt(key, 'dataKey', decodeBase64(row.metadata))).toMatchObject({ displayName: 'Later owner edit' });
      expect(decrypt(key, 'dataKey', decodeBase64(row.daemonState!))).toMatchObject({
        ...readiness, contributionRegistryProjectionRevision: 1, localServices: summary,
      });
      const installed: unknown = Reflect.get(client, 'machine');
      expect(installed).toMatchObject({ metadata: { displayName: 'Later owner edit' },
        daemonState: { ...readiness, contributionRegistryProjectionRevision: 1, localServices: summary } });
    } finally { release(); await client.shutdown(); }
  });

  it('dispatches non-machine updates to subscribers', async () => {
    const machineSocket = createApiSessionSocketStub();
    bindApiSessionSocketMock(ioMock, machineSocket);

    const { ApiMachineClient } = await import('./apiMachine');
    const client = new ApiMachineClient('token', {
      id: 'machine-1',
      encryptionKey: new Uint8Array(32).fill(1),
      encryptionVariant: 'legacy',
      metadata: null,
      metadataVersion: 0,
      daemonState: null,
      daemonStateVersion: 0,
    });

    const handler = vi.fn(() => true);
    client.onUpdate(handler);

    client.connect();

    const updateHandler = machineSocket.getHandler('update');
    expect(updateHandler).toBeDefined();

    updateHandler?.({
      id: 'u-1',
      seq: 123,
      createdAt: Date.now(),
      body: {
        t: 'automation-assignment-updated',
        machineId: 'machine-1',
        automationId: 'automation-1',
        enabled: true,
        updatedAt: Date.now(),
      },
    });

    expect(handler).toHaveBeenCalledTimes(1);
    await client.shutdown();
  });

  it('notifies policy consumers after installing current metadata and ignores stale publications', async () => {
    const socket = createApiSessionSocketStub();
    bindApiSessionSocketMock(ioMock, socket);
    const { ApiMachineClient } = await import('./apiMachine');
    const key = new Uint8Array(32).fill(21);
    const metadata = { host: 'owner', platform: 'linux', homeDir: '/home/owner', happyHomeDir: '/home/owner/.happier',
      happyCliVersion: 'test', finitePolicyV1: { accepting: true, runAtMost: 1 } };
    const machine = { id: 'machine-1', encryptionKey: key, encryptionVariant: 'dataKey' as const,
      metadata, metadataVersion: 1, daemonState: null, daemonStateVersion: 0 };
    const observations: ReturnType<typeof readMachineFinitePolicyV1>[] = [];
    const client = new ApiMachineClient('token', machine, undefined, {
      onMachineMetadataChanged: () => { observations.push(readMachineFinitePolicyV1(machine.metadata)); },
    });
    client.connect();
    try {
      const current = { ...metadata, finitePolicyV1: { accepting: true, runAtMost: 2 } };
      socket.trigger('update', { id: 'policy-current', seq: 2, createdAt: 2, body: {
        t: 'update-machine', machineId: machine.id,
        metadata: { value: encodeBase64(encrypt(key, 'dataKey', current)), version: 2 },
      } });
      expect(observations).toEqual([{ status: 'ready', source: 'stored', policy: { accepting: true, runAtMost: 2 } }]);
      socket.trigger('update', { id: 'policy-stale', seq: 1, createdAt: 1, body: {
        t: 'update-machine', machineId: machine.id,
        metadata: { value: encodeBase64(encrypt(key, 'dataKey', metadata)), version: 1 },
      } });
      expect(observations).toEqual([{ status: 'ready', source: 'stored', policy: { accepting: true, runAtMost: 2 } }]);
      socket.emitWithAck.mockImplementation(async (event: string, payload: unknown) => {
        if (event !== 'machine-update-metadata') return { result: 'success', version: 1 };
        const write = payload as { metadata: string };
        return { result: 'success', version: 3, metadata: write.metadata };
      });
      await expect(client.updateMachineMetadata(value => ({ ...value!, finitePolicyV1: { accepting: false, runAtMost: 2 } })))
        .resolves.toBe('published');
      expect(observations).toEqual([
        { status: 'ready', source: 'stored', policy: { accepting: true, runAtMost: 2 } },
        { status: 'ready', source: 'stored', policy: { accepting: false, runAtMost: 2 } },
      ]);
    } finally { await client.shutdown(); }
  });

  it('does not overwrite a newer same-key update with a delayed publication acknowledgement', async () => {
    const socket = createApiSessionSocketStub();
    bindApiSessionSocketMock(ioMock, socket);
    const metadata = { host: 'old', platform: 'linux', homeDir: '/home/owner', happyHomeDir: '/home/owner/.happier', happyCliVersion: 'test' };
    const key = new Uint8Array(32).fill(21);
    const accountKey = new Uint8Array(32).fill(11);
    const publicKey = tweetnacl.box.keyPair.fromSecretKey(accountKey).publicKey;
    const row = { id: 'machine-1', storageMode: 'e2ee',
      dataEncryptionKey: encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey: key,
        recipientPublicKey: publicKey, randomBytes: getRandomBytes })),
      metadata: encodeBase64(encrypt(key, 'dataKey', metadata)), metadataVersion: 1,
      daemonState: null, daemonStateVersion: 0 };
    // Exercise real owner-envelope opening before the held publication ACK.
    vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/machines/machine-1')) return { status: 200, data: { machine: row } };
      if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'fixture-owner' } };
      if (url.endsWith('/v2/changes')) return { status: 200, data: { changes: [], nextCursor: 0 } };
      if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'e2ee', updatedAt: 1 } };
      return { status: 404, data: {} };
    });
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json({
      features: {}, capabilities: { serverIdentity: { serverIdentityId: 'fixture-home' } },
    })));
    const { ApiClient } = await import('./api');
    const api = await ApiClient.create({ token: 'token', encryption: { type: 'dataKey', machineKey: accountKey, publicKey } });
    const opened = await api.getMachine(row.id);
    if (!opened) throw new Error('Expected opened Machine');
    const client = api.machineSyncClient(opened);
    client.connect();
    let release: (() => void) | undefined;
    socket.emitWithAck.mockImplementation(async (event: string, payload: unknown) => {
      if (event !== 'machine-update-metadata') return { result: 'success', version: 1 };
      const write = payload as { metadata: string };
      await new Promise<void>(resolve => { release = resolve; });
      return { result: 'success', version: 2, metadata: write.metadata };
    });
    try {
      await vi.waitFor(() => expect(socket.connected).toBe(true));
      const pending = client.updateMachineMetadata(value => ({ ...value!, displayName: 'first edit' }));
      await vi.waitFor(() => expect(release).toBeDefined());
      const newer = { ...metadata, displayName: 'newer edit' };
      socket.trigger('update', { id: 'newer', seq: 3, createdAt: 3, body: { t: 'update-machine', machineId: 'machine-1',
        metadata: { value: encodeBase64(encrypt(key, 'dataKey', newer)), version: 3 } } });
      release?.();
      await expect(pending).resolves.toBe('published');
      socket.emitWithAck.mockImplementation(async (event: string, payload: unknown) => {
        if (event !== 'machine-update-metadata') return { result: 'success', version: 1 };
        const write = payload as { metadata: string; expectedVersion: number };
        expect(write.expectedVersion).toBe(3);
        expect(decrypt(key, 'dataKey', decodeBase64(write.metadata))).toEqual({ ...newer, host: 'new-host' });
        return { result: 'success', version: 4, metadata: write.metadata };
      });
      await expect(client.updateMachineMetadata(value => ({ ...value!, host: 'new-host' }))).resolves.toBe('published');
    } finally { release?.(); await client.shutdown(); }
  });
});
