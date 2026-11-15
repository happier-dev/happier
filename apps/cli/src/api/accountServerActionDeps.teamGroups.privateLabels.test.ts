import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fastify from 'fastify';
import tweetnacl from 'tweetnacl';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createAccountScopedCryptoMaterialSnapshotV1 } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { computeContentPublicKeyFingerprint } from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';
import { projectPrivateLabelForRecipientV1 } from '@happier-dev/protocol/crypto/privateLabelV1';
import { TeamGroupUpdateInputV1Schema, TeamGroupV1Schema } from '@happier-dev/protocol/teams/group';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { createAccountServerActionDeps } from './accountServerActionDeps';
import { openCliPrivateLabel } from './privateLabels';

const accountId = 'group-author';
const token = `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
const accountKey = new Uint8Array(32).fill(8);
const publicKey = tweetnacl.box.keyPair.fromSecretKey(accountKey).publicKey;
const encryption = { type: 'dataKey' as const, machineKey: accountKey, publicKey };
const ref = { v: 1 as const, teamId: 'team-1', groupId: 'group-1' };

describe('Group plaintext intent through captured Account Actions', () => {
  let app = fastify();
  let restore = () => {};
  beforeEach(() => {
    app = fastify();
    restore = installAxiosFastifyAdapter({ app, origin: 'http://account.test' });
  });
  afterEach(async () => { vi.unstubAllGlobals(); restore(); await app.close(); });

  it.each(['e2ee', 'plain'] as const)('renames through the %s agent Action preserving null and omitted descriptions without disclosing E2EE text', async mode => {
    const snapshot = createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material: encryption,
      dataKeyPublicKey: publicKey });
    app.get('/v1/account/encryption/currentness', async () => createAccountEncryptionCurrentnessFixture({ mode,
      contentKeyFingerprint: mode === 'e2ee'
        ? convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(snapshot.contentPublicKeyFingerprint) : null }));
    // Both transports are genuine HTTP boundaries; all Action and cipher owners stay real.
    vi.stubGlobal('fetch', async (_url: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({ owner: { kind: 'team', teamId: ref.teamId } });
      return Response.json({ contentEncryptionMode: mode, recipients: mode === 'plain' ? [] : [{
        account: { kind: 'account', accountId, firstName: null, lastName: null, username: null, avatarUrl: null },
        readiness: { status: 'available', contentPublicKey: encodeBase64(publicKey),
          contentPublicKeyFingerprint: computeContentPublicKeyFingerprint(publicKey) }, envelopeStatus: 'missing',
      }] });
    });
    let writes = 0;
    app.post('/v1/teams/groups/update', async request => {
      writes++;
      const wire = TeamGroupUpdateInputV1Schema.parse(request.body);
      expect(wire.description).toBe(mode === 'e2ee' ? null : undefined);
      expect(wire.name?.content.t).toBe(mode === 'plain' ? 'plain' : 'encrypted');
      if (mode === 'e2ee') expect(JSON.stringify(request.body)).not.toContain('Renamed builders');
      const label = projectPrivateLabelForRecipientV1({ stored: wire.name!, recipientAccountId: accountId });
      // The UI uses this same protocol opener/binding and Team read policy.
      expect(openCliPrivateLabel({ binding: { entity: 'team_group', field: 'name', id: ref.groupId }, label,
        readPolicy: { kind: 'team-resource' }, ...(mode === 'e2ee' ? { accountKey } : {}) })).toBe('Renamed builders');
      return TeamGroupV1Schema.parse({ v: 1, id: ref.groupId, teamId: ref.teamId,
        name: { kind: 'available', label }, description: null, archivedAt: null, memberCount: 0,
        management: { kind: 'native' }, capabilities: { updateMetadata: true, archive: true, restore: false, manageNativeMembers: true } });
    });
    const executor = createActionExecutor(createAccountServerActionDeps({ token,
      credentials: { token, encryption: mode === 'e2ee' ? encryption : null },
      serverId: 'home', serverHttpBaseUrl: 'http://account.test' }));
    await expect(executor.execute('teams.groups.update', { ...ref, name: 'Renamed builders', ...(mode === 'e2ee' ? { description: null } : {}) },
      { surface: 'agent', bypassApprovals: true })).resolves.toMatchObject({ ok: true, result: { id: ref.groupId } });
    expect(writes).toBe(1);
  });

  it('rejects invalid authored metadata at Action admission', async () => {
    const executor = createActionExecutor(createAccountServerActionDeps({ token,
      credentials: { token, encryption: null }, serverId: 'home', serverHttpBaseUrl: 'http://account.test' }));
    await expect(executor.execute('teams.groups.update', { ...ref, name: ' \n ' },
      { surface: 'agent' })).resolves.toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
  });

  it('refuses unavailable E2EE Account material before the Group write', async () => {
    app.get('/v1/account/encryption/currentness', async () => createAccountEncryptionCurrentnessFixture({ mode: 'e2ee' }));
    let writes = 0;
    app.post('/v1/teams/groups/update', async () => { writes++; return {}; });
    const executor = createActionExecutor(createAccountServerActionDeps({ token, credentials: { token, encryption: null },
      serverId: 'home', serverHttpBaseUrl: 'http://account.test' }));
    await expect(executor.execute('teams.groups.update', { ...ref, name: 'Never sent' },
      { surface: 'agent', bypassApprovals: true })).resolves.toMatchObject({ ok: false, errorCode: 'account_storage_currentness_unavailable' });
    expect(writes).toBe(0);
  });
});
