import { beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import nacl from 'tweetnacl';
import { decodeBase64, encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { sealEncryptedDataKeyEnvelopeV1, openEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { signAccountContentKeyBindingV1 } from '@happier-dev/protocol/crypto/accountContentKeyBindingV1';
import { computeContentPublicKeyFingerprint } from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';
import { computeMachineOwnerEnvelopeFingerprintV1 } from '@happier-dev/protocol/machines/machineOwnerEnvelopeFingerprintV1';
import type { MachineAccessRecipientCensusResponseV1 } from '@happier-dev/protocol/machines/machineAccessV1';
import { createMachineContentCodec } from './machine/machineStoredContent';
import { prepareMachineAccessKeyEnvelopes } from './machineAccessGrantEnvelopeHost';
import { ApiClient } from './api';
import { prepareCurrentMachineDataKeyEnvelopes } from '../../../ui/sources/sync/encryption/prepareCurrentMachineDataKeyEnvelopes';

vi.mock('axios', async importOriginal => {
  const actual = await importOriginal<typeof import('axios')>();
  // Replace HTTP dispatch only; the actual client construction and error predicates remain real.
  return { ...actual, default: { ...actual.default, get: vi.fn(), post: vi.fn(), patch: vi.fn() } };
});

const dataKey = new Uint8Array(32).fill(19);
const manager = nacl.box.keyPair();
const recipient = nacl.box.keyPair();
const signing = nacl.sign.keyPair();
const callerDataEncryptionKey = encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey, recipientPublicKey: manager.publicKey, randomBytes: nacl.randomBytes }));
const recipientFingerprint = computeContentPublicKeyFingerprint(recipient.publicKey);
const page: MachineAccessRecipientCensusResponseV1 = {
  machineId: 'machine', custodianAccountId: 'offline-custodian', encryptionMode: 'e2ee',
  machineOwnerEnvelopeFingerprint: computeMachineOwnerEnvelopeFingerprintV1(decodeBase64(callerDataEncryptionKey)), callerDataEncryptionKey,
  nextCursor: null,
  content: { metadata: createMachineContentCodec({ encryptionMode: 'e2ee', encryptionKey: dataKey, encryptionVariant: 'dataKey' }).encodeStored({
    host: 'host', platform: 'linux', happyCliVersion: '0.3', homeDir: '/home/owner', happyHomeDir: '/home/owner/.happier',
  }), metadataVersion: 3, daemonState: null, daemonStateVersion: 4 },
  recipients: [{ recipientAccountId: 'team-member', contentKey: {
    status: 'available', accountSigningPublicKey: Buffer.from(signing.publicKey).toString('hex'),
    contentPublicKey: encodeBase64(recipient.publicKey), contentPublicKeySignature: encodeBase64(signAccountContentKeyBindingV1({ accountSigningSecretKey: signing.secretKey, contentPublicKey: recipient.publicKey })),
  }, contentPublicKeyFingerprint: recipientFingerprint, encryptedDataKey: null, recipientContentPublicKeyFingerprint: null }],
};
const params = { credentials: { token: 'manager-token', encryption: null }, serverHttpBaseUrl: 'https://home.test', serverId: 'home', machineId: 'machine' };

describe('trusted Machine key envelope continuation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('delivers a current Machine key from Manage custody using the authenticated HTTP worklist', async () => {
    vi.mocked(axios.get).mockResolvedValueOnce({ status: 200, data: page }).mockResolvedValue({ status: 200, data: { ...page, recipients: [] } });
    vi.mocked(axios.patch).mockResolvedValue({ status: 200, data: { appliedRecipientAccountIds: ['team-member'], skippedRecipientAccountIds: [] } });
    expect(await prepareMachineAccessKeyEnvelopes({ ...params, resolveTransferableMachineDataKey: async current =>
      openEncryptedDataKeyEnvelopeV1({ envelope: decodeBase64(current.callerDataEncryptionKey!), recipientSecretKeyOrSeed: manager.secretKey }),
    })).toEqual({ kind: 'prepared' });
    const request = vi.mocked(axios.patch).mock.calls[0]![1] as { recipientKeyEnvelopes: { encryptedDataKey: string }[]; expectedCallerDataEncryptionKey: string };
    expect(request.expectedCallerDataEncryptionKey).toBe(callerDataEncryptionKey);
    expect(openEncryptedDataKeyEnvelopeV1({ envelope: decodeBase64(request.recipientKeyEnvelopes[0]!.encryptedDataKey), recipientSecretKeyOrSeed: recipient.secretKey })).toEqual(dataKey);
  });

  it('refuses stale recipient bindings returned by the commit owner', async () => {
    vi.mocked(axios.get).mockResolvedValue({ status: 200, data: page });
    vi.mocked(axios.patch).mockResolvedValue({ status: 409, data: { kind: 'refused', code: 'recipient_binding_changed' } });
    expect(await prepareMachineAccessKeyEnvelopes({ ...params, resolveTransferableMachineDataKey: async () => dataKey })).toEqual({ kind: 'unavailable', code: 'recipient_binding_changed' });
  });

  it('a current foreign Manage holder opens only its delivered recipient tuple', async () => {
    vi.mocked(axios.get).mockResolvedValueOnce({ status: 200, data: page }).mockResolvedValue({ status: 200, data: { ...page, recipients: [] } });
    vi.mocked(axios.patch).mockResolvedValue({ status: 200, data: { appliedRecipientAccountIds: ['team-member'], skippedRecipientAccountIds: [] } });
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'manager-account' })).toString('base64url')}.signature`;
    expect(await prepareMachineAccessKeyEnvelopes({ ...params, credentials: { token,
      encryption: { type: 'dataKey', publicKey: manager.publicKey, machineKey: manager.secretKey },
    } })).toEqual({ kind: 'prepared' });
    const body = vi.mocked(axios.patch).mock.calls[0]![1] as { recipientKeyEnvelopes: { encryptedDataKey: string }[] };
    expect(openEncryptedDataKeyEnvelopeV1({ envelope: decodeBase64(body.recipientKeyEnvelopes[0]!.encryptedDataKey), recipientSecretKeyOrSeed: recipient.secretKey })).toEqual(dataKey);
  });

  it('does not turn a readable owner envelope into transferability authority', async () => {
    vi.mocked(axios.get).mockResolvedValue({ status: 200, data: page });
    expect(await prepareMachineAccessKeyEnvelopes(params)).toEqual({ kind: 'pending_holder' });
    expect(axios.patch).not.toHaveBeenCalled();
  });

  it('keeps Plain permission-only and uses signed request authority without client Account material', async () => {
    vi.mocked(axios.get).mockResolvedValue({ status: 200, data: { ...page, encryptionMode: 'plain', callerDataEncryptionKey: null, recipients: [] } });
    const requestHeaders = vi.fn(async () => ({ 'X-Action-Authority': 'signed' }));
    expect(await prepareMachineAccessKeyEnvelopes({ ...params, credentials: undefined, requestHeaders })).toEqual({ kind: 'prepared' });
    expect(vi.mocked(axios.get).mock.calls[0]![1]?.headers).toMatchObject({ 'X-Action-Authority': 'signed' });
    expect(axios.patch).not.toHaveBeenCalled();
  });

  it('suppresses disclosure after async credential retirement during a signed request', async () => {
    let current = true;
    expect(await prepareMachineAccessKeyEnvelopes({ ...params,
      isCredentialCurrent: async () => current,
      requestHeaders: async () => { current = false; return {}; },
      resolveTransferableMachineDataKey: async () => dataKey,
    })).toEqual({ kind: 'unavailable', code: 'machine_key_changed' });
    expect(axios.get).not.toHaveBeenCalled();
    expect(axios.patch).not.toHaveBeenCalled();
  });

  it('refuses a changed owner/caller/content tuple on the final worklist recheck', async () => {
    vi.mocked(axios.get).mockResolvedValueOnce({ status: 200, data: page })
      .mockResolvedValue({ status: 200, data: { ...page, content: { ...page.content, metadataVersion: 4 }, recipients: [] } });
    vi.mocked(axios.patch).mockResolvedValue({ status: 200, data: { appliedRecipientAccountIds: ['team-member'], skippedRecipientAccountIds: [] } });
    expect(await prepareMachineAccessKeyEnvelopes({ ...params, resolveTransferableMachineDataKey: async () => dataKey }))
      .toEqual({ kind: 'unavailable', code: 'machine_key_changed' });
  });

  it('repairs a later Team join from a fresh worklist without another grant mutation', async () => {
    vi.mocked(axios.get).mockResolvedValue({ status: 200, data: { ...page, recipients: [] } });
    expect(await prepareMachineAccessKeyEnvelopes({ ...params, resolveTransferableMachineDataKey: async () => dataKey })).toEqual({ kind: 'prepared' });
    expect(axios.patch).not.toHaveBeenCalled();
    vi.mocked(axios.get).mockReset().mockResolvedValueOnce({ status: 200, data: page })
      .mockResolvedValue({ status: 200, data: { ...page, recipients: [] } });
    vi.mocked(axios.patch).mockResolvedValue({ status: 200, data: { appliedRecipientAccountIds: ['team-member'], skippedRecipientAccountIds: [] } });
    expect(await prepareMachineAccessKeyEnvelopes({ ...params, resolveTransferableMachineDataKey: async () => dataKey })).toEqual({ kind: 'prepared' });
    const body = vi.mocked(axios.patch).mock.calls[0]![1] as { recipientKeyEnvelopes: { encryptedDataKey: string }[] };
    expect(openEncryptedDataKeyEnvelopeV1({ envelope: decodeBase64(body.recipientKeyEnvelopes[0]!.encryptedDataKey), recipientSecretKeyOrSeed: recipient.secretKey })).toEqual(dataKey);
  });

  it('keeps independently keyed retained unsafe ciphertext pending without an envelope PATCH', async () => {
    const unsafeMetadata = createMachineContentCodec({ encryptionMode: 'e2ee', encryptionKey: dataKey, encryptionVariant: 'dataKey' }).encodeStored({
      host: 'host', platform: 'linux', happyCliVersion: '0.3', homeDir: '/home/owner', happyHomeDir: '/home/owner/.happier',
      privateWorkspace: { projectPath: '/private/project', token: 'retained-private-content' },
    });
    vi.mocked(axios.get).mockResolvedValue({ status: 200, data: { ...page, content: { ...page.content, metadata: unsafeMetadata } } });
    expect(await prepareMachineAccessKeyEnvelopes({ ...params, resolveTransferableMachineDataKey: async () => dataKey }))
      .toEqual({ kind: 'pending_holder' });
    expect(axios.patch).not.toHaveBeenCalled();
  });

  it('custodian preparation uses the captured Home transport and refetches the exact prepared basis', async () => {
    let delivered = false;
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'offline-custodian' })).toString('base64url')}.signature`;
    vi.mocked(axios.get).mockImplementation(async url => {
      if (String(url).endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'e2ee', updatedAt: 1 } };
      if (String(url).endsWith('/v1/machines/machine')) return { status: 200, data: { machine: {
        id: 'machine', ...page.content, dataEncryptionKey: callerDataEncryptionKey,
        keyBasis: { dataEncryptionKey: callerDataEncryptionKey, metadataVersion: 3, daemonStateVersion: 4 },
        access: { custodian: { accountId: 'offline-custodian', displayName: 'Owner' }, role: 'manage', resourceMode: 'e2ee', accessState: 'ready' },
      } } };
      return { status: 200, data: { ...page, recipients: delivered ? [] : page.recipients } };
    });
    vi.mocked(axios.patch).mockImplementation(async () => {
      delivered = true;
      return { status: 200, data: { appliedRecipientAccountIds: ['team-member'], skippedRecipientAccountIds: [] } };
    });
    const credentials = { token, encryption: { type: 'dataKey' as const, publicKey: manager.publicKey, machineKey: manager.secretKey } };
    const owner = await ApiClient.create(credentials);
    const prepared = await owner.prepareMachineContentKey('machine', { request: async request =>
      axios.get<unknown>(`https://home.test${request.path}`, { headers: { 'X-Action-Authority': 'signed' } }),
    });
    expect(prepared.encryptionKey).toEqual(dataKey);
    const result = await prepareMachineAccessKeyEnvelopes({ ...params, credentials, requestHeaders: async () => ({ 'X-Action-Authority': 'signed' }) });
    expect(result).toEqual({ kind: 'prepared' });
    expect(delivered).toBe(true);
    for (const [url, config] of vi.mocked(axios.get).mock.calls) {
      expect(String(url).startsWith('https://home.test/')).toBe(true);
      expect(config?.headers).toMatchObject({ 'X-Action-Authority': 'signed' });
    }
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('actual owner conversion preserves private raw bytes and cannot activate recipient delivery', async () => {
    const historicalKey = manager.secretKey;
    const historicalCodec = createMachineContentCodec({ encryptionMode: 'e2ee', encryptionKey: historicalKey, encryptionVariant: 'dataKey' });
    let ownerEnvelope = encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey: historicalKey, recipientPublicKey: manager.publicKey, randomBytes: nacl.randomBytes }));
    let metadata = historicalCodec.encodeStored({ host: 'host', platform: 'linux', happyCliVersion: '0.3',
      homeDir: '/home/owner', happyHomeDir: '/home/owner/.happier', privateWorkspace: { token: 'retained-private-content' } });
    let revision = 3;
    let converted = false;
    const machine = () => ({ id: 'machine', metadata, metadataVersion: revision, daemonState: null, daemonStateVersion: revision,
      dataEncryptionKey: ownerEnvelope, keyBasis: { dataEncryptionKey: ownerEnvelope, metadataVersion: revision, daemonStateVersion: revision },
      access: { custodian: { accountId: 'offline-custodian', displayName: 'Owner' }, role: 'manage', resourceMode: 'e2ee', accessState: 'ready' } });
    vi.mocked(axios.get).mockImplementation(async url => {
      if (String(url).endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'e2ee', updatedAt: 1 } };
      if (String(url).endsWith('/v1/machines/machine')) return { status: 200, data: { machine: machine() } };
      return { status: 200, data: { ...page, callerDataEncryptionKey: ownerEnvelope,
        machineOwnerEnvelopeFingerprint: computeMachineOwnerEnvelopeFingerprintV1(decodeBase64(ownerEnvelope)),
        content: { metadata, metadataVersion: revision, daemonState: null, daemonStateVersion: revision } } };
    });
    vi.mocked(axios.post).mockImplementation(async (_url, body) => {
      const transition = body as { next: { dataEncryptionKey: string; metadata: string } };
      ownerEnvelope = transition.next.dataEncryptionKey;
      metadata = transition.next.metadata;
      revision += 1;
      converted = true;
      const opened = openEncryptedDataKeyEnvelopeV1({ envelope: decodeBase64(ownerEnvelope), recipientSecretKeyOrSeed: manager.secretKey });
      expect(opened).not.toEqual(historicalKey);
      expect(createMachineContentCodec({ encryptionMode: 'e2ee', encryptionKey: opened!, encryptionVariant: 'dataKey' }).decodeStored(metadata))
        .toMatchObject({ privateWorkspace: { token: 'retained-private-content' } });
      return { status: 200, data: { kind: 'committed', machine: machine() } };
    });
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'offline-custodian' })).toString('base64url')}.signature`;
    expect(await prepareMachineAccessKeyEnvelopes({ ...params, credentials: { token,
      encryption: { type: 'dataKey', publicKey: manager.publicKey, machineKey: manager.secretKey },
    } })).toEqual({ kind: 'pending_holder' });
    expect(converted).toBe(true);
    expect(axios.patch).not.toHaveBeenCalled();
  });

  it('the UI holder uses the same current worklist and real recipient crypto', async () => {
    let committed = false;
    expect(await prepareCurrentMachineDataKeyEnvelopes({ serverId: 'home', machineId: 'machine',
      isHostScopeCurrent: () => true,
      resolveTransferableMachineDataKey: async () => dataKey,
      transport: {
        fetchPage: async () => ({ ...page, recipients: committed ? [] : page.recipients }),
        patchPage: async request => {
          expect(openEncryptedDataKeyEnvelopeV1({ envelope: decodeBase64(request.recipientKeyEnvelopes[0]!.encryptedDataKey), recipientSecretKeyOrSeed: recipient.secretKey })).toEqual(dataKey);
          committed = true;
          return { appliedRecipientAccountIds: ['team-member'], skippedRecipientAccountIds: [] };
        },
      },
    })).toEqual({ kind: 'prepared' });
    expect(committed).toBe(true);
  });
});
