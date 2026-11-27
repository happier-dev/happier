import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';
import {
  decodeBase64,
  encodeBase64,
} from '@happier-dev/protocol/crypto/base64';
import { openEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { signAccountContentKeyBindingV1 } from '@happier-dev/protocol';
import { createTaskResourceClientV1 } from '@happier-dev/protocol/todos/todoActionOperationsV1';

import { createAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import {
  createLightSqliteHarness,
  type LightSqliteHarness,
} from '@/testkit/lightSqliteHarness';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { observePrismaReads } from '@/testkit/observePrismaReads';
import { kvRoutes } from '@/app/api/routes/kv/kvRoutes';
import { taskRoutes } from '@/app/api/routes/todos/taskRoutes';
import { admitTeamMemberInTx } from '@/app/teams/memberships/membershipService';
import { backgroundDeliveryAuthentication } from '@/app/session/access/sessionAccessAuthentication';
import { INTERNAL_TASK_SOURCE_V1, internalTaskLocalRefV1 } from '@happier-dev/protocol/tasks/entryRefV1';
import { resolveTaskGrantAccessForAccountsInTx, resolveTaskAnchorInTx, resolveTaskAnchorsInTx } from './taskGrantStorageAdapter';
import { promoteTaskResourceInTx } from './taskAccessService';
import { lockTaskMutationInTx } from './taskResourceService';

// The real Task client drives the real Task routes; only HTTP transport and the
// platform cipher (a symmetric box standing in for the app's Account cipher) are adapters.
describe('Task keys for later Team members', () => {
  let harness: LightSqliteHarness;
  let app: ReturnType<typeof createAuthenticatedTestApp>;
  beforeAll(async () => {
    harness = await createLightSqliteHarness({
      tempDirPrefix: 'happier-task-later-member-',
      initAuth: false,
      env: { HAPPIER_FEATURE_TEAMS__ENABLED: '1' },
    });
    app = createAuthenticatedTestApp();
    kvRoutes(app);
    taskRoutes(app);
    await app.ready();
  }, 180_000);
  afterAll(async () => {
    if (app) await app.close();
    if (harness) await harness.close();
  });

  async function e2eeAccount() {
    const signing = tweetnacl.sign.keyPair();
    const content = tweetnacl.box.keyPair();
    const account = await db.account.create({
      data: {
        encryptionMode: 'e2ee',
        publicKey: Buffer.from(signing.publicKey).toString('hex'),
        contentPublicKey: new Uint8Array(content.publicKey),
        contentPublicKeySig: signAccountContentKeyBindingV1({
          accountSigningSecretKey: signing.secretKey,
          contentPublicKey: content.publicKey,
        }),
      },
    });
    return { id: account.id, contentSecretKey: content.secretKey };
  }
  const admit = (teamId: string, accountId: string, role: 'owner' | 'member') =>
    inTx(async (tx) => {
      const admitted = await admitTeamMemberInTx(tx, {
        teamId,
        accountId,
        role,
        historyAccess: 'all_existing',
      });
      if (!admitted.ok) throw new Error('Team fixture admission failed');
    });
  const accountBoxKey = new Uint8Array(32).fill(5);
  const box = (value: unknown, key: Uint8Array) => {
    const nonce = tweetnacl.randomBytes(24);
    const sealed = tweetnacl.secretbox(
      new TextEncoder().encode(JSON.stringify(value)),
      nonce,
      key,
    );
    return encodeBase64(new Uint8Array([...nonce, ...sealed]));
  };
  const unbox = (ciphertext: string, key: Uint8Array) => {
    const bytes = decodeBase64(ciphertext);
    const opened = tweetnacl.secretbox.open(
      bytes.slice(24),
      bytes.slice(0, 24),
      key,
    );
    if (!opened) throw new Error('box_open_failed');
    return JSON.parse(new TextDecoder().decode(opened)) as unknown;
  };
  const client = (
    account: Readonly<{ id: string; contentSecretKey: Uint8Array }>,
    requests: string[] = [],
  ) =>
    createTaskResourceClientV1({
      accountId: account.id,
      requireCurrent: () => {},
      request: async ({ method, path, body }) => {
        requests.push(`${method} ${path}`);
        const response = await app.inject({
          method,
          url: path,
          headers: { 'x-test-user-id': account.id },
          ...(body === undefined ? {} : { payload: body as object }),
        });
        return {
          status: response.statusCode,
          body: response.json() as unknown,
        };
      },
      crypto: {
        randomBytes: tweetnacl.randomBytes,
        openAccount: async (ciphertext) => ({
          value: unbox(ciphertext, accountBoxKey),
          needsReseal: false,
        }),
        sealAccount: async (value) => box(value, accountBoxKey),
        openKey: async (envelope) =>
          openEncryptedDataKeyEnvelopeV1({
            envelope: decodeBase64(envelope),
            recipientSecretKeyOrSeed: account.contentSecretKey,
          }),
        open: async (ciphertext, key) => unbox(ciphertext, key),
        seal: async (value, key) => box(value, key),
      },
    });

  it('admits only the exact live Task grant at the caller credential across Task and anchor reads', async () => {
    const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
    const member = await db.account.create({ data: { encryptionMode: 'plain' } });
    const team = await db.team.create({ data: { name: 'Restricted Task anchor', authenticationPolicy: {
      v: 1, mode: 'restricted', accepted: [{ kind: 'home_method', methodId: 'key_challenge' }],
    } } });
    await admit(team.id, owner.id, 'owner');
    await admit(team.id, member.id, 'member');
    const taskId = crypto.randomUUID();
    const rows = await Promise.all([owner, member].map(account => db.userKVStore.create({ data: {
      accountId: account.id, key: `todo.${taskId}`,
      value: new TextEncoder().encode(JSON.stringify({ t: 'plain', v: { id: taskId, title: account.id, done: false } })),
    } })));
    const row = rows[0]!;
    await db.taskGrant.create({ data: { taskId: row.id, principalKind: 'team', teamId: team.id, accessLevel: 'admin', createdByAccountId: owner.id } });
    const ref = { source: INTERNAL_TASK_SOURCE_V1, ...internalTaskLocalRefV1(taskId, owner.id) };
    const personal = { source: INTERNAL_TASK_SOURCE_V1, ...internalTaskLocalRefV1(taskId) };
    const external = { ...ref, source: { ...ref.source, localId: 'external' } };
    const request = { actorAccountId: member.id, authentication: backgroundDeliveryAuthentication(), includeAudience: true, includeKey: true };
    const read = () => inTx(tx => resolveTaskAnchorsInTx(tx, { ...request, refs: [ref, personal, external] }));
    const before = await read();
    expect(before.get(ref)).toEqual({ ok: false, error: 'team_authentication_required' });
    expect(before.get(personal)).toMatchObject({ ok: true, value: { row: { id: rows[1]!.id }, access: { level: 'owner' }, key: { kind: 'plain' } } });
    expect(before.get(external)).toEqual({ ok: false, error: 'task_not_found' });
    const taskPath = `/v1/tasks/${owner.id}/${taskId}`;
    const headers = { 'x-test-user-id': member.id, 'x-test-auth-token-kind': 'terminal' };
    const denied = await app.inject({ method: 'GET', url: taskPath, headers });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toEqual({ error: 'team_authentication_required' });
    const deniedCensus = await app.inject({ method: 'POST', url: `${taskPath}/recipients/census`, headers, payload: {} });
    expect(deniedCensus.statusCode).toBe(403);
    expect(deniedCensus.json()).toEqual({ error: 'team_authentication_required' });
    const inventory = await app.inject({ method: 'GET', url: '/v1/tasks', headers });
    expect(inventory.json().tasks).toMatchObject([{ ownerAccountId: member.id, taskId }]);
    await inTx(async tx => {
      const observed = observePrismaReads(tx, ['userKVStore', 'taskKeyEnvelope']);
      const audience = await resolveTaskGrantAccessForAccountsInTx(observed.tx, { resourceIds: rows.map(task => task.id),
        accountIds: [owner.id, member.id], authentication: request.authentication });
      expect(audience.get(row.id)?.get(owner.id)).toMatchObject({ ok: true, value: { level: 'owner' } });
      expect(audience.get(row.id)?.get(member.id)).toEqual({ ok: false, error: 'team_authentication_required' });
      expect(audience.get(rows[1]!.id)?.get(member.id)).toMatchObject({ ok: true, value: { level: 'owner' } });
      expect(observed.reads).toEqual(['userKVStore.findMany']);
    });
    await db.taskGrant.create({ data: { taskId: row.id, principalKind: 'account', accountId: member.id, accessLevel: 'view', createdByAccountId: owner.id } });
    expect((await read()).get(ref)).toMatchObject({ ok: true, value: {
      row: { id: row.id }, access: { level: 'view' }, key: { kind: 'plain' },
      audienceAccountIds: [owner.id, member.id].sort(),
    } });
    const direct = await app.inject({ method: 'GET', url: taskPath, headers });
    expect(direct.statusCode).toBe(200);
    expect(direct.json()).toMatchObject({ ownerAccountId: owner.id, taskId, access: 'view' });
  });

  it('prepares an E2EE Task key through the real Task client and promotes without a grant inside the caller transaction', async () => {
    const owner = await e2eeAccount();
    const outsider = await e2eeAccount();
    const taskId = crypto.randomUUID();
    const todo = { id: taskId, title: 'Personal comment', done: false, createdAt: 1, updatedAt: 1 };
    const original = new TextEncoder().encode(JSON.stringify({ t: 'encrypted', c: box(todo, accountBoxKey) }));
    const row = await db.userKVStore.create({ data: { accountId: owner.id, key: `todo.${taskId}`, value: original } });
    const ref = { source: INTERNAL_TASK_SOURCE_V1, ...internalTaskLocalRefV1(taskId, owner.id) };
    const address = { ownerAccountId: owner.id, taskId };
    const ownerClient = client(owner);
    const current = await ownerClient.read(address);
    const prepared = await ownerClient.preparePromotion(current);
    expect(await db.userKVStore.findUniqueOrThrow({ where: { id: row.id } })).toEqual(row);
    const request = { ref, actorAccountId: owner.id, authentication: backgroundDeliveryAuthentication(), includeKey: true };
    const promote = async (rollback: boolean) => inTx(async tx => {
      expect(await lockTaskMutationInTx(tx, { ...address, actorAccountId: owner.id })).toBe(true);
      const admitted = await resolveTaskAnchorInTx(tx, request);
      expect(admitted).toMatchObject({ ok: true, value: { key: { kind: 'promotion_required' } } });
      if (!admitted.ok) throw new Error(admitted.error);
      expect(await promoteTaskResourceInTx(tx, admitted.value, prepared.promotion)).toEqual({ ok: true, value: true });
      if (rollback) throw new Error('discussion append failed');
    });
    await expect(promote(true)).rejects.toThrow('discussion append failed');
    expect(await db.userKVStore.findUniqueOrThrow({ where: { id: row.id } })).toEqual(row);
    expect(await db.taskKeyEnvelope.count({ where: { taskId: row.id } })).toBe(0);
    await promote(false);
    expect(await db.taskGrant.count({ where: { taskId: row.id } })).toBe(0);
    const after = await inTx(tx => resolveTaskAnchorInTx(tx, request));
    expect(after).toMatchObject({ ok: true, value: { key: { kind: 'task', encryptedDataKey: prepared.promotion.ownerKeyEnvelope.encryptedDataKey } } });
    expect(await inTx(tx => resolveTaskAnchorInTx(tx, { ...request, actorAccountId: outsider.id }))).toEqual({ ok: false, error: 'task_not_found' });
    expect(await ownerClient.read(address)).toMatchObject({ dataKey: prepared.dataKey, todo });
  });

  it('seals an existing shared Task key for a later member, never for an outsider or a removed member', async () => {
    const owner = await e2eeAccount();
    const early = await e2eeAccount();
    const removed = await e2eeAccount();
    const later = await e2eeAccount();
    const outsider = await e2eeAccount();
    const team = await db.team.create({ data: { name: 'Task audience' } });
    await admit(team.id, owner.id, 'owner');
    await admit(team.id, early.id, 'member');
    await admit(team.id, removed.id, 'member');
    const taskId = crypto.randomUUID();
    const todo = {
      id: taskId,
      title: 'Shared before join',
      done: false,
      createdAt: 1,
      updatedAt: 1,
    };
    await db.userKVStore.create({
      data: {
        accountId: owner.id,
        key: `todo.${taskId}`,
        value: new TextEncoder().encode(
          JSON.stringify({ t: 'encrypted', c: box(todo, accountBoxKey) }),
        ),
      },
    });
    const row = await db.userKVStore.findUniqueOrThrow({ where: { accountId_key: { accountId: owner.id, key: `todo.${taskId}` } }, select: { id: true } });
    const address = { ownerAccountId: owner.id, taskId };
    const ownerClient = client(owner);
    await ownerClient.share(address, { kind: 'team', teamId: team.id }, 'view');
    expect((await client(early).read(address)).todo.title).toBe(
      'Shared before join',
    );

    await db.teamMembership.delete({
      where: { teamId_accountId: { teamId: team.id, accountId: removed.id } },
    });
    await admit(team.id, later.id, 'member');
    await expect(client(later).read(address)).rejects.toMatchObject({
      code: 'task_content_unavailable',
    });

    // The membership-change wake's repair: one owed census page, then one fenced commit for the owed Task.
    const wake: string[] = [];
    await client(owner, wake).prepareOwed();
    expect(wake).toEqual(['GET /v1/tasks/recipients/owed',
      `POST /v1/tasks/${owner.id}/${taskId}/recipients/commit`]);

    expect((await client(later).read(address)).todo.title).toBe(
      'Shared before join',
    );
    await expect(client(outsider).read(address)).rejects.toMatchObject({
      code: 'task_not_found',
    });
    await expect(client(removed).read(address)).rejects.toMatchObject({
      code: 'task_not_found',
    });
    const recipients = (await db.taskKeyEnvelope.findMany({ where: { taskId: row.id }, select: { recipientAccountId: true } })).map(row => row.recipientAccountId).sort();
    // The removed member's earlier wrap is kept (no retraction); the outsider never gets one.
    expect(recipients).toEqual([early.id, later.id, owner.id, removed.id].sort());
    // Nothing owed: a second wake is exactly one request and commits nothing.
    const before = await db.taskKeyEnvelope.findMany({ where: { taskId: row.id }, orderBy: { recipientAccountId: 'asc' } });
    const idle: string[] = [];
    await client(owner, idle).prepareOwed();
    expect(idle).toEqual(['GET /v1/tasks/recipients/owed']);
    expect(await db.taskKeyEnvelope.findMany({ where: { taskId: row.id }, orderBy: { recipientAccountId: 'asc' } })).toEqual(before);
    // The owed census is owner-only by query: a member's own wake sees nothing of the owner's Tasks.
    const memberWake: string[] = [];
    await client(later, memberWake).prepareOwed();
    expect(memberWake).toEqual(['GET /v1/tasks/recipients/owed']);
  });
});
