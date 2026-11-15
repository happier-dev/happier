import { beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import nacl from 'tweetnacl';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

import { deriveAccountMachineKeyFromRecoverySecret, sealEncryptedDataKeyEnvelopeV1,
  SessionMetadataTuplePatchV1Schema, SessionDisplayProjectionV1Schema,
  openSessionSharedDisplayEnvelopeV1Sync, openSessionOwnerDisplayEnvelopeV1,
  openSessionOwnerMetadataEnvelopeV1, projectSessionOwnerCompatibilityViewV1,
  projectSessionDisplayV1, SessionSharedMetadataV1Schema, createAccountScopedCryptoMaterialSnapshotV1,
  sealSessionOwnerDisplayEnvelopeV1,
  type SessionMetadataTuplePatchV1 } from '@happier-dev/protocol';
import { encodeBase64 } from '@/api/encryption';
import { encryptSessionPayload, decryptStoredSessionPayload, resolveSessionEncryptionContextFromCredentials,
  type SessionStoredContentCryptoContext } from '@/session/transport/encryption/sessionEncryptionContext';
import { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import type { StoredCredentials } from '@/persistence';

import { createAccountEncryptionCurrentnessFixture, createSessionRecordFixture,
  createSessionRuntimeManagedSubtreeRecordFixture } from '@/testkit/backends/sessionFixtures';
import { bindApiSessionSocketMock, createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { getSessionStatus } from './getSessionStatus';
import { SessionStatusActionResultV1Schema } from '@happier-dev/protocol/sessions/control/contract';
import { buildSessionMetadataEnvelopeFields } from '@/session/metadata/buildSessionMetadataEnvelopeCreateFields';
import { runAddedHostedSession } from '@/agent/runtime/lifecycle/hostedSessionScope';

const { mockIo } = vi.hoisted(() => ({ mockIo: vi.fn() }));
vi.mock('axios', async (importOriginal) => {
  const actual = await importOriginal<typeof import('axios')>();
  // Keep the real HTTP client's defaults for the credential transport wrapper.
  return { ...actual, default: { ...actual.default, get: vi.fn(), patch: vi.fn() } };
});
vi.mock('socket.io-client', () => ({ io: mockIo }));

const sessionId = 'c123456789012345678901234';
const credentials = { token: 'test-token', encryption: null } as const;

const secret = new Uint8Array(32).fill(7);
const machineKey = deriveAccountMachineKeyFromRecoverySecret(secret);
const publicKey = nacl.box.keyPair.fromSecretKey(machineKey).publicKey;
const e2eeCredentials = { token: 'test-token', encryption: { type: 'dataKey', machineKey, publicKey } } as const;
const dataEncryptionKey = encodeBase64(sealEncryptedDataKeyEnvelopeV1({
  dataKey: new Uint8Array(32).fill(19),
  recipientPublicKey: publicKey,
  randomBytes: (length) => new Uint8Array(length).fill(11),
}));

// Constructed historical producer vectors, not deployment captures. The fixture
// pins exact 0.2 producer/serializer bytes and its source commit independently.
const retainedSessions = z.object({
  provenance: z.object({ sourceCommit: z.literal('a2c45c86804b24e60ac0b76146a3ef36dfcaa15b') }),
  metadata: z.record(z.string(), z.unknown()), agentState: z.record(z.string(), z.unknown()),
  recipientSecretKeyHex: z.string(), recipientPublicKeyHex: z.string(),
  vectors: z.array(z.object({ variant: z.enum(['plain', 'legacy', 'dataKey']), keyHex: z.string().optional(),
    metadata: z.string(), agentState: z.string(), dataEncryptionKey: z.string().nullable() })),
}).parse(JSON.parse(readFileSync(new URL('../../../../../packages/protocol/fixtures/0.2-retained-session-layout0.json', import.meta.url), 'utf8')));

describe('getSessionStatus awareness acquisition', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(axios.patch).mockImplementation(async (_url, body) => {
      const patch = SessionMetadataTuplePatchV1Schema.parse(body);
      if (patch.mode !== 'owner' && patch.mode !== 'owner_migration') throw new Error('Unexpected status backfill authority');
      return { status: 200, data: { success: true, metadataLayoutVersion: 1,
        sharedMetadata: { version: patch.mode === 'owner' ? patch.sharedMetadata.expectedVersion + 1 : patch.source.metadata.version + 1 },
        agentState: { version: patch.mode === 'owner' ? patch.agentState.expectedVersion : patch.source.agentState.version + 1 },
      } };
    });
  });

  it('backfills a missing display after an authorized full owner status read without refetching the captured tuple', async () => {
    const fields = buildSessionMetadataEnvelopeFields({ credentials, accountEncryptionMode: 'plain', storedContentMode: 'plain',
      metadata: { path: '/retained/repo', host: 'retained-host', summary: { text: 'Retained owner', updatedAt: 1 } },
      agentState: { completedRequests: {} },
    });
    let current = createSessionRecordFixture({ id: sessionId, share: null, encryptionMode: 'plain', metadataLayoutVersion: 1,
      metadata: fields.sharedMetadata.ciphertext, ownerMetadata: fields.ownerMetadata,
      agentState: fields.agentState, metadataVersion: 7, agentStateVersion: 4,
    });
    const patches: SessionMetadataTuplePatchV1[] = [];
    vi.mocked(axios.get).mockImplementation(async url => {
      if (String(url).endsWith('/encryption/currentness')) return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
      if (String(url).endsWith(`/v2/sessions/${sessionId}`)) return { status: 200, data: { session: current } };
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.mocked(axios.patch).mockImplementation(async (_url, body) => {
      const patch = SessionMetadataTuplePatchV1Schema.parse(body);
      if (patch.mode !== 'owner' || !patch.displayProjectionV1) throw new Error('Expected complete owner backfill');
      patches.push(patch);
      current = createSessionRecordFixture({ ...current, metadataVersion: 8, displayProjectionV1: patch.displayProjectionV1 });
      return { status: 200, data: { success: true, metadataLayoutVersion: 1, sharedMetadata: { version: 8 }, agentState: { version: 4 } } };
    });
    const first = await getSessionStatus({ credentials, idOrPrefix: sessionId, live: false });
    expect(first).toMatchObject({ ok: true, session: { id: sessionId, title: 'Retained owner' } });
    expect(patches).toHaveLength(1);
    expect(patches[0]).toMatchObject({ mode: 'owner',
      sharedMetadata: { ciphertext: fields.sharedMetadata.ciphertext, expectedVersion: 7 },
      ownerMetadata: fields.ownerMetadata, agentState: { ciphertext: fields.agentState, expectedVersion: 4 },
    });
    const projection = SessionDisplayProjectionV1Schema.parse(current.displayProjectionV1);
    expect(projection.sourceMetadataVersion).toBe(8);
    expect(openSessionSharedDisplayEnvelopeV1Sync({ sessionMode: 'plain', envelope: projection.shared }))
      .toMatchObject({ ok: true, display: { summaryText: 'Retained owner' } });
    expect(openSessionOwnerDisplayEnvelopeV1({ accountMode: 'plain', envelope: projection.owner }))
      .toMatchObject({ ok: true });
    expect(JSON.stringify(projection.shared)).not.toContain('/retained/repo');
    expect(axios.get).toHaveBeenCalledTimes(2);
    await expect(getSessionStatus({ credentials, idOrPrefix: sessionId, live: false })).resolves.toMatchObject({ ok: true });
    expect(patches).toHaveLength(1);
    expect(axios.get).toHaveBeenCalledTimes(4);
  });

  it.each(retainedSessions.vectors)('backfills the immutable 0.2 $variant tuple through its existing privacy migration', async vector => {
    const ownerCredentials: StoredCredentials = vector.variant === 'plain' ? credentials : vector.variant === 'legacy'
      ? { token: credentials.token, encryption: { type: 'legacy', secret: new Uint8Array(Buffer.from(vector.keyHex ?? '', 'hex')) } }
      : { token: credentials.token, encryption: { type: 'dataKey',
        machineKey: new Uint8Array(Buffer.from(retainedSessions.recipientSecretKeyHex, 'hex')),
        publicKey: new Uint8Array(Buffer.from(retainedSessions.recipientPublicKeyHex, 'hex')) } };
    const mode = vector.variant === 'plain' ? 'plain' : 'e2ee';
    const encryption = ownerCredentials.encryption;
    const accountMode = encryption ? 'e2ee' : 'plain';
    const material = encryption?.type === 'legacy' ? { type: 'legacy' as const, secret: encryption.secret }
      : encryption ? { type: 'dataKey' as const, machineKey: encryption.machineKey } : undefined;
    const currentness = material ? createAccountEncryptionCurrentnessFixture({ mode: 'e2ee',
      contentKeyFingerprint: convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
        createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material,
          ...(encryption?.type === 'dataKey' ? { dataKeyPublicKey: encryption.publicKey } : {}) }).contentPublicKeyFingerprint),
      recipientEnvelopeReadiness: { status: 'available' },
    }) : createAccountEncryptionCurrentnessFixture();
    const raw = createSessionRecordFixture({ id: sessionId, encryptionMode: mode, metadataLayoutVersion: 0,
      metadata: vector.metadata, agentState: vector.agentState,
      metadataVersion: 7, agentStateVersion: 4, dataEncryptionKey: vector.dataEncryptionKey,
    });
    const context = mode === 'e2ee' ? resolveSessionEncryptionContextFromCredentials(ownerCredentials, raw) : null;
    if (mode === 'e2ee' && !context) throw new Error('Historical recipient material must open its stored Session key');
    const crypto: SessionStoredContentCryptoContext = context ? { mode: 'e2ee', ctx: context } : { mode: 'plain', ctx: null };
    expect(decryptStoredSessionPayload({ ...crypto, value: raw.metadata })).toEqual(retainedSessions.metadata);
    expect(decryptStoredSessionPayload({ ...crypto, value: vector.agentState })).toEqual(retainedSessions.agentState);
    vi.mocked(axios.get).mockImplementation(async url => {
      if (String(url).endsWith('/encryption/currentness')) return { status: 200, data: currentness };
      if (String(url).endsWith(`/v2/sessions/${sessionId}`)) return { status: 200, data: { session: raw } };
      throw new Error(`Unexpected request: ${url}`);
    });
    const patches: SessionMetadataTuplePatchV1[] = [];
    vi.mocked(axios.patch).mockImplementation(async (_url, body) => {
      const patch = SessionMetadataTuplePatchV1Schema.parse(body);
      if (patch.mode !== 'owner_migration' || !patch.target.displayProjectionV1) throw new Error('Retained rows must use the existing full privacy migration');
      patches.push(patch);
      return { status: 200, data: { success: true, metadataLayoutVersion: 1, sharedMetadata: { version: 8 }, agentState: { version: 5 } } };
    });
    await expect(getSessionStatus({ credentials: ownerCredentials, idOrPrefix: sessionId, live: false })).resolves.toMatchObject({ ok: true, session: { id: sessionId } });
    expect(patches).toHaveLength(1);
    const patch = patches[0];
    if (!patch || patch.mode !== 'owner_migration') throw new Error('Expected retained owner migration');
    expect(patch.source).toEqual({ metadataLayoutVersion: 0, metadata: { version: 7, ciphertext: vector.metadata },
      ownerMetadata: null, agentState: { version: 4, ciphertext: vector.agentState } });
    const sharedMetadata = SessionSharedMetadataV1Schema.parse(decryptStoredSessionPayload({ ...crypto, value: patch.target.sharedMetadata.ciphertext }));
    const owner = openSessionOwnerMetadataEnvelopeV1({ accountMode, envelope: patch.target.ownerMetadata, material });
    if (!owner.ok) throw new Error('Migrated full owner tuple must remain readable');
    expect(projectSessionOwnerCompatibilityViewV1({ sharedMetadata, ownerMetadata: owner.ownerMetadata })).toMatchObject(retainedSessions.metadata);
    expect(decryptStoredSessionPayload({ ...crypto, value: patch.target.agentState.ciphertext ?? '' })).toEqual(retainedSessions.agentState);
    expect(sharedMetadata).not.toHaveProperty('path');
    const projection = SessionDisplayProjectionV1Schema.parse(patch.target.displayProjectionV1);
    const semantic = projectSessionDisplayV1({ sharedMetadata, ownerMetadata: owner.ownerMetadata });
    expect(openSessionSharedDisplayEnvelopeV1Sync({ sessionMode: mode, envelope: projection.shared,
      decryptPayload: value => decryptStoredSessionPayload({ ...crypto, value }) })).toEqual({ ok: true, display: semantic.shared });
    expect(openSessionOwnerDisplayEnvelopeV1({ accountMode, envelope: projection.owner, material })).toEqual({ ok: true, display: semantic.owner });
    expect(axios.get).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])('uses the winning captured full tuple after a conflict (winner display available: %s)', async available => {
    const initialFields = buildSessionMetadataEnvelopeFields({ credentials, accountEncryptionMode: 'plain', storedContentMode: 'plain',
      metadata: { path: '/before', host: 'host', summary: { text: 'Before', updatedAt: 1 } }, agentState: {} });
    const winnerFields = buildSessionMetadataEnvelopeFields({ credentials, accountEncryptionMode: 'plain', storedContentMode: 'plain',
      metadata: { path: '/winning/workspace', host: 'winner', summary: { text: 'Winning summary', updatedAt: 8 } }, agentState: {} });
    let row = createSessionRecordFixture({ id: sessionId, share: null, encryptionMode: 'plain', metadataLayoutVersion: 1,
      metadata: initialFields.sharedMetadata.ciphertext, ownerMetadata: initialFields.ownerMetadata,
      agentState: initialFields.agentState, metadataVersion: 7, agentStateVersion: 4 });
    vi.mocked(axios.get).mockImplementation(async url => {
      if (String(url).endsWith('/encryption/currentness')) return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
      if (String(url).endsWith(`/v2/sessions/${sessionId}`)) return { status: 200, data: { session: row } };
      throw new Error(`Unexpected request: ${url}`);
    });
    const patches: SessionMetadataTuplePatchV1[] = [];
    vi.mocked(axios.patch).mockImplementation(async (_url, body) => {
      const patch = SessionMetadataTuplePatchV1Schema.parse(body);
      if (patch.mode !== 'owner' || !patch.displayProjectionV1) throw new Error('Expected full owner ensure');
      patches.push(patch);
      if (patches.length === 1) {
        row = createSessionRecordFixture({ ...row, metadata: winnerFields.sharedMetadata.ciphertext,
          ownerMetadata: winnerFields.ownerMetadata, agentState: winnerFields.agentState, metadataVersion: 8,
          ...(available ? { displayProjectionV1: { ...SessionDisplayProjectionV1Schema.parse(winnerFields.displayProjectionV1), sourceMetadataVersion: 8 } } : {}) });
        return { status: 409, data: { code: 'session_metadata_version_conflict', metadataLayoutVersion: 1,
          sharedMetadata: { version: 8 }, agentState: { version: 4 } } };
      }
      return { status: 200, data: { success: true, metadataLayoutVersion: 1, sharedMetadata: { version: 9 }, agentState: { version: 4 } } };
    });
    await expect(getSessionStatus({ credentials, idOrPrefix: sessionId, live: false })).resolves.toMatchObject({ ok: true });
    expect(patches).toHaveLength(available ? 1 : 2);
    if (!available) {
      expect(patches[1]).toMatchObject({ sharedMetadata: { ciphertext: winnerFields.sharedMetadata.ciphertext, expectedVersion: 8 },
        ownerMetadata: winnerFields.ownerMetadata, agentState: { ciphertext: winnerFields.agentState, expectedVersion: 4 } });
      const display = SessionDisplayProjectionV1Schema.parse(Reflect.get(patches[1] ?? {}, 'displayProjectionV1'));
      expect(openSessionSharedDisplayEnvelopeV1Sync({ sessionMode: 'plain', envelope: display.shared }))
        .toMatchObject({ ok: true, display: { summaryText: 'Winning summary' } });
      expect(openSessionOwnerDisplayEnvelopeV1({ accountMode: 'plain', envelope: display.owner }))
        .toMatchObject({ ok: true, display: { path: '/winning/workspace' } });
    }
    expect(axios.get).toHaveBeenCalledTimes(4);
  });

  it.each(['different_current_account_key', 'missing_owner_material', 'custom_authorization'] as const)(
    'keeps the full status fallback without owner backfill for %s', async refusal => {
      const fields = buildSessionMetadataEnvelopeFields({ credentials: e2eeCredentials, accountEncryptionMode: 'e2ee', storedContentMode: 'plain',
        metadata: { path: '/private/retained', host: 'host', summary: { text: 'Readable full fallback', updatedAt: 1 } }, agentState: {},
      });
      const row = createSessionRecordFixture({ id: sessionId, share: null, encryptionMode: 'plain', metadataLayoutVersion: 1,
        metadata: fields.sharedMetadata.ciphertext, ownerMetadata: fields.ownerMetadata,
        agentState: fields.agentState, metadataVersion: 7, agentStateVersion: 4 });
      const actual = createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee',
        material: { type: 'dataKey', machineKey }, dataKeyPublicKey: publicKey });
      const other = createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee',
        material: { type: 'legacy', secret: new Uint8Array(32).fill(99) } });
      const currentness = createAccountEncryptionCurrentnessFixture({ mode: 'e2ee',
        contentKeyFingerprint: convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
          refusal === 'different_current_account_key' ? other.contentPublicKeyFingerprint : actual.contentPublicKeyFingerprint),
        recipientEnvelopeReadiness: { status: 'available' } });
      vi.mocked(axios.get).mockImplementation(async url => {
        if (String(url).endsWith('/encryption/currentness')) return { status: 200, data: currentness };
        if (String(url).endsWith(`/v2/sessions/${sessionId}`)) return { status: 200, data: { session: row } };
        throw new Error(`Unexpected request: ${url}`);
      });
      await expect(getSessionStatus({ credentials: refusal === 'missing_owner_material' ? credentials : e2eeCredentials,
        idOrPrefix: sessionId, live: false,
        ...(refusal === 'custom_authorization' ? { resolveAuthorizationHeaders: () => ({ 'X-Test-Authorization': 'requester' }) } : {}),
      })).resolves.toMatchObject({ ok: true, session: { title: 'Readable full fallback' } });
      expect(axios.patch).not.toHaveBeenCalled();
      expect(axios.get).toHaveBeenCalledTimes(2);
    },
  );

  it('retains the captured full fallback when a conflict changes the Session key under the same codec', async () => {
    const initialKey = new Uint8Array(32).fill(19);
    const winnerKey = new Uint8Array(32).fill(23);
    const fields = (key: Uint8Array, text: string) => buildSessionMetadataEnvelopeFields({ credentials: e2eeCredentials,
      accountEncryptionMode: 'e2ee', storedContentMode: 'e2ee', encryptionKey: key, encryptionVariant: 'dataKey',
      metadata: { path: '/retained', host: 'host', summary: { text, updatedAt: 1 } }, agentState: {} });
    const initial = fields(initialKey, 'Captured full fallback');
    const winner = fields(winnerKey, 'Fresh winner');
    const actual = createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee',
      material: { type: 'dataKey', machineKey }, dataKeyPublicKey: publicKey });
    const currentness = createAccountEncryptionCurrentnessFixture({ mode: 'e2ee',
      contentKeyFingerprint: convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(actual.contentPublicKeyFingerprint),
      recipientEnvelopeReadiness: { status: 'available' } });
    let row = createSessionRecordFixture({ id: sessionId, share: null, encryptionMode: 'e2ee', metadataLayoutVersion: 1,
      dataEncryptionKey, metadata: initial.sharedMetadata.ciphertext, ownerMetadata: initial.ownerMetadata,
      agentState: initial.agentState, metadataVersion: 7, agentStateVersion: 4 });
    vi.mocked(axios.get).mockImplementation(async url => {
      if (String(url).endsWith('/encryption/currentness')) return { status: 200, data: currentness };
      if (String(url).endsWith(`/v2/sessions/${sessionId}`)) return { status: 200, data: { session: row } };
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.mocked(axios.patch).mockImplementation(async () => {
      row = createSessionRecordFixture({ ...row, metadata: winner.sharedMetadata.ciphertext, ownerMetadata: winner.ownerMetadata,
        agentState: winner.agentState, metadataVersion: 8, dataEncryptionKey: encodeBase64(sealEncryptedDataKeyEnvelopeV1({
          dataKey: winnerKey, recipientPublicKey: publicKey, randomBytes: length => new Uint8Array(length).fill(12) })) });
      return { status: 409, data: { code: 'session_metadata_version_conflict', metadataLayoutVersion: 1,
        sharedMetadata: { version: 8 }, agentState: { version: 4 } } };
    });
    await expect(getSessionStatus({ credentials: e2eeCredentials, idOrPrefix: sessionId, live: false }))
      .resolves.toMatchObject({ ok: true, session: { title: 'Captured full fallback' } });
    expect(axios.patch).toHaveBeenCalledTimes(1);
    expect(axios.get).toHaveBeenCalledTimes(4);
  });

  it('repairs an unopenable owner leaf while preserving the available shared bytes', async () => {
    const fields = buildSessionMetadataEnvelopeFields({ credentials: e2eeCredentials, accountEncryptionMode: 'e2ee', storedContentMode: 'plain',
      metadata: { path: '/owner/workspace', host: 'host', summary: { text: 'Retained', updatedAt: 1 } }, agentState: {} });
    const wrongOwner = sealSessionOwnerDisplayEnvelopeV1({ accountMode: 'e2ee', display: { v: 1, path: '/owner/workspace', host: 'host' },
      material: { type: 'legacy', secret: new Uint8Array(32).fill(99) }, randomBytes: length => new Uint8Array(length).fill(12) });
    if (!wrongOwner.ok) throw new Error('Expected real encrypted owner fixture');
    const display = { ...SessionDisplayProjectionV1Schema.parse(fields.displayProjectionV1), sourceMetadataVersion: 7, owner: wrongOwner.envelope };
    const row = createSessionRecordFixture({ id: sessionId, share: null, encryptionMode: 'plain', metadataLayoutVersion: 1,
      metadata: fields.sharedMetadata.ciphertext, ownerMetadata: fields.ownerMetadata, agentState: fields.agentState,
      metadataVersion: 7, agentStateVersion: 4, displayProjectionV1: display });
    const material = { type: 'dataKey' as const, machineKey };
    const currentness = createAccountEncryptionCurrentnessFixture({ mode: 'e2ee',
      contentKeyFingerprint: convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
        createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material, dataKeyPublicKey: publicKey }).contentPublicKeyFingerprint),
      recipientEnvelopeReadiness: { status: 'available' } });
    expect(openSessionOwnerDisplayEnvelopeV1({ accountMode: 'e2ee', envelope: display.owner, material }).ok).toBe(false);
    vi.mocked(axios.get).mockImplementation(async url => {
      if (String(url).endsWith('/encryption/currentness')) return { status: 200, data: currentness };
      if (String(url).endsWith(`/v2/sessions/${sessionId}`)) return { status: 200, data: { session: row } };
      throw new Error(`Unexpected request: ${url}`);
    });
    await expect(getSessionStatus({ credentials: e2eeCredentials, idOrPrefix: sessionId, live: false })).resolves.toMatchObject({ ok: true });
    expect(axios.patch).toHaveBeenCalledTimes(1);
    const patch = SessionMetadataTuplePatchV1Schema.parse(vi.mocked(axios.patch).mock.calls[0]?.[1]);
    if (patch.mode !== 'owner' || !patch.displayProjectionV1) throw new Error('Expected owner display repair');
    expect(patch.displayProjectionV1.shared).toEqual(display.shared);
    expect(patch.ownerMetadata).toEqual(fields.ownerMetadata);
    expect(openSessionOwnerDisplayEnvelopeV1({ accountMode: 'e2ee', envelope: patch.displayProjectionV1.owner, material }))
      .toMatchObject({ ok: true, display: { path: '/owner/workspace' } });
    expect(axios.get).toHaveBeenCalledTimes(2);
  });

  it('does not backfill a runtime recipient using the hosting Account credentials', async () => {
    const row = createSessionRuntimeManagedSubtreeRecordFixture({ id: sessionId, encryptionMode: 'plain',
      metadata: JSON.stringify({ v: 1, summary: { text: 'Shared safe title', updatedAt: 1 } }) });
    vi.mocked(axios.get).mockImplementation(async url => {
      if (String(url).endsWith('/encryption/currentness')) return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
      if (String(url).endsWith(`/v2/sessions/${sessionId}`)) return { status: 200, data: { session: row } };
      throw new Error(`Unexpected request: ${url}`);
    });
    await expect(getSessionStatus({ credentials, idOrPrefix: sessionId, live: false }))
      .resolves.toMatchObject({ ok: true, session: { title: 'Shared safe title' } });
    expect(axios.patch).not.toHaveBeenCalled();
  });

  it('keeps the authorized full fallback when the same admitted Account token cannot write', async () => {
    const readOnlyCredentials = { token: 'read-only-account-token', encryption: null } as const;
    const fields = buildSessionMetadataEnvelopeFields({ credentials: readOnlyCredentials, accountEncryptionMode: 'plain', storedContentMode: 'plain',
      metadata: { path: '/retained', host: 'host', summary: { text: 'Read-only full status', updatedAt: 1 } }, agentState: {} });
    const row = createSessionRecordFixture({ id: sessionId, share: null, encryptionMode: 'plain', metadataLayoutVersion: 1,
      metadata: fields.sharedMetadata.ciphertext, ownerMetadata: fields.ownerMetadata, agentState: fields.agentState,
      metadataVersion: 7, agentStateVersion: 4 });
    vi.mocked(axios.get).mockImplementation(async url => {
      if (String(url).endsWith('/encryption/currentness')) return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
      if (String(url).endsWith(`/v2/sessions/${sessionId}`)) return { status: 200, data: { session: row } };
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.mocked(axios.patch).mockResolvedValue({ status: 403, data: { error: 'Insufficient Account token scope' } });
    await expect(getSessionStatus({ credentials: readOnlyCredentials, idOrPrefix: sessionId, live: false }))
      .resolves.toMatchObject({ ok: true, session: { title: 'Read-only full status' } });
    expect(axios.patch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(axios.patch).mock.calls[0]?.[2]?.headers).toMatchObject({ Authorization: 'Bearer read-only-account-token' });
    expect(axios.get).toHaveBeenCalledTimes(2);
  });

  function serveRow(live: boolean) {
    const now = Date.now();
    const row = createSessionRecordFixture({
      id: sessionId,
      encryptionMode: 'plain',
      metadata: '{}',
      active: true,
      activeAt: now,
      ...(live ? {} : { latestTurnStatus: 'in_progress' as const, latestTurnStatusObservedAt: now }),
      pendingPermissionRequestCount: 0,
      pendingUserActionRequestCount: 0,
      pendingRequestObservedAt: now - 1_000,
    });
    vi.mocked(axios.get).mockImplementation(async (url) => {
      if (String(url).endsWith('/encryption/currentness')) {
        return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
      }
      if (String(url).endsWith(`/v2/sessions/${sessionId}`)) return { status: 200, data: { session: row } };
      throw new Error(`Unexpected request: ${url}`);
    });
    return now;
  }

  it('returns canonical awareness alongside retained status fields without reading a transcript', async () => {
    serveRow(false);
    expect(await getSessionStatus({ credentials, idOrPrefix: sessionId, live: false })).toMatchObject({
      ok: true,
      session: { id: sessionId },
      awareness: { v: 1, sessionId, runtime: 'working', freshness: 'live', operational: { primary: 'working' } },
    });
    expect(axios.get).toHaveBeenCalledWith(expect.stringContaining(`/v2/sessions/${sessionId}`),
      expect.objectContaining({ headers: expect.objectContaining({
        'X-Happier-Request-Purpose': 'session-detail:session-query',
      }) }));
  });

  function serveE2ee(row: Record<string, unknown>) {
    vi.mocked(axios.get).mockImplementation(async (url) => {
      if (String(url).endsWith('/encryption/currentness')) {
        return { status: 200, data: createAccountEncryptionCurrentnessFixture({
          mode: 'e2ee', recipientEnvelopeReadiness: { status: 'available' },
        }) };
      }
      if (String(url).endsWith(`/v2/sessions/${sessionId}`)) {
        return { status: 200, data: { session: createSessionRecordFixture({
          id: sessionId, encryptionMode: 'e2ee', active: true, activeAt: Date.now(), ...row,
        } as never) } };
      }
      throw new Error(`Unexpected request: ${url}`);
    });
  }

  it('reports content the opened key could not authenticate, not an absence of evidence', async () => {
    serveE2ee({
      dataEncryptionKey,
      metadata: encryptSessionPayload({
        ctx: { encryptionKey: new Uint8Array(32).fill(47), encryptionVariant: 'dataKey' },
        payload: { summary: { text: 'Security review', updatedAt: 1 } },
      }),
    });
    const result = await getSessionStatus({ credentials: e2eeCredentials, idOrPrefix: sessionId, live: false });
    expect(result).toMatchObject({ ok: true, awareness: { encryption: 'content_unavailable', availability: 'locked' } });
    expect(result).not.toHaveProperty('awareness.title');
  });

  it('preserves the typed unavailable-material failure instead of hydrating awareness anyway', async () => {
    // Status resolves the Session transport context before projecting, so an undelivered
    // envelope fails here rather than becoming a successful reply carrying a guessed state.
    serveE2ee({
      dataEncryptionKey: null, metadata: 'retained-ciphertext',
      share: { accessLevel: 'view', canApprovePermissions: false },
    });
    const result = await getSessionStatus({ credentials: e2eeCredentials, idOrPrefix: sessionId, live: false });
    expect(result).toEqual({ ok: false, code: 'encryption_material_unavailable' });
  });

  it('merges fresh socket requests before projection, preserving user-action semantics', async () => {
    const now = serveRow(true);
    bindApiSessionSocketMock(mockIo, createApiSessionSocketStub({
      onConnect(socket) {
        queueMicrotask(() => socket.trigger('update', {
          id: 'update-1', seq: 1, createdAt: now,
          body: {
            t: 'update-session', id: sessionId,
            agentState: {
              version: 1,
              value: JSON.stringify({ requests: { ask: { tool: 'AskUserQuestion', kind: 'user_action', arguments: { questions: [] }, createdAt: now } } }),
            },
          },
        }));
      },
    }));
    expect(await getSessionStatus({ credentials, idOrPrefix: sessionId, live: true })).toMatchObject({
      ok: true,
      agentState: { pendingRequestsCount: 1 },
      pendingRequests: [{ requestId: 'ask', kind: 'user_action', tool: 'AskUserQuestion' }],
      awareness: { operational: { primary: 'action_required' } },
    });
  });

  it('settles live status at each concurrent hosted Session deadline', async () => {
    vi.useFakeTimers();
    vi.stubEnv('HAPPIER_SESSION_STATUS_LIVE_WAIT_MS', '9000');
    try {
      serveRow(true);
      mockIo.mockImplementation(() => createApiSessionSocketStub());
      const completed: number[] = [];
      const statuses = [100, 200].map(timeout => runAddedHostedSession({
        environment: { HAPPIER_SESSION_STATUS_LIVE_WAIT_MS: String(timeout) },
        workingDirectory: `/session-${timeout}`, end: () => {},
      }, async () => {
        await Promise.resolve();
        const result = await getSessionStatus({ credentials, idOrPrefix: sessionId, live: true });
        completed.push(timeout);
        return result;
      }));
      await vi.advanceTimersByTimeAsync(100);
      expect(completed).toEqual([100]);
      await vi.advanceTimersByTimeAsync(100);
      expect(completed).toEqual([100, 200]);
      expect(await Promise.all(statuses)).toEqual([expect.objectContaining({ ok: true }), expect.objectContaining({ ok: true })]);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      vi.unstubAllEnvs();
    }
  });

  it('exposes exact pending permission and question identities through the status Action contract', async () => {
    serveE2ee({
      dataEncryptionKey,
      agentState: encryptSessionPayload({
        ctx: { encryptionKey: new Uint8Array(32).fill(19), encryptionVariant: 'dataKey' },
        payload: { requests: {
          'exec-native-pwd': { tool: 'Bash', kind: 'permission', arguments: { command: 'pwd' }, createdAt: 1, turnId: 'native-turn-1' },
          'ask-choice': { tool: 'AskUserQuestion', kind: 'user_action', arguments: { questions: [{ id: 'choice', question: 'Continue?' }] }, createdAt: 2 },
          settled: { tool: 'Bash', kind: 'permission', arguments: { command: 'pwd' }, createdAt: 1 },
        }, completedRequests: {
          settled: { tool: 'Bash', kind: 'permission', arguments: { command: 'pwd' }, createdAt: 1, completedAt: 3, status: 'approved' },
        } },
      }),
    });
    const result = await getSessionStatus({ credentials: e2eeCredentials, idOrPrefix: sessionId, live: false });
    expect(SessionStatusActionResultV1Schema.parse(result)).toMatchObject({
      ok: true,
      pendingRequests: [
        { requestId: 'exec-native-pwd', turnId: 'native-turn-1', kind: 'permission', tool: 'Bash' },
        { requestId: 'ask-choice', kind: 'user_action', tool: 'AskUserQuestion' },
      ],
    });
    expect(result).not.toHaveProperty('pendingRequests.0.arguments');
  });
});
