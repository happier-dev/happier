import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import {
  createLightSqliteHarness,
  type LightSqliteHarness,
} from '@/testkit/lightSqliteHarness';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { admitTeamMemberInTx } from '@/app/teams/memberships/membershipService';
import { hashPasswordMaterial } from '@/app/auth/password/passwordMaterialVerifier';
import { taskRoutes } from './taskRoutes';

// A restricted Team's sign-in policy gates a Team-shared Task exactly as it gates a Team Discussion:
// the real Task routes admit each request once, and the typed refusal reaches the caller unchanged.
describe('Task routes: restricted Team sign-in', () => {
  let harness: LightSqliteHarness;
  let app: ReturnType<typeof createAuthenticatedTestApp>;
  beforeAll(async () => {
    harness = await createLightSqliteHarness({
      tempDirPrefix: 'happier-task-team-auth-',
      initAuth: false,
      env: {
        HAPPIER_FEATURE_TEAMS__ENABLED: '1',
        HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED: '1',
        HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: '1',
        HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
      },
    });
    app = createAuthenticatedTestApp();
    taskRoutes(app);
    await app.ready();
  }, 180_000);
  afterAll(async () => {
    if (app) await app.close();
    if (harness) await harness.close();
  });

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
  const plain = (title: string) => ({
    t: 'plain' as const,
    v: { id: 'shared', title, done: false },
  });
  const storeTask = (accountId: string, taskId: string, title: string) =>
    db.userKVStore.create({
      data: {
        accountId,
        key: `todo.${taskId}`,
        value: new TextEncoder().encode(JSON.stringify(plain(title))),
      },
    });
  const headers = (accountId: string, signedIn = false) => ({
    'x-test-user-id': accountId,
    ...(signedIn
      ? {
          'x-test-authentication-evidence': JSON.stringify([
            { kind: 'home_method', methodId: 'email_password' },
          ]),
        }
      : {}),
  });

  async function sharedTask(mode: 'restricted' | 'open') {
    const owner = await db.account.create({
      data: { encryptionMode: 'plain' },
    });
    const member = await db.account.create({
      data: { encryptionMode: 'plain' },
    });
    const team = await db.team.create({
      data: {
        name: `Task Team ${mode}`,
        ...(mode === 'restricted'
          ? {
              authenticationPolicy: {
                v: 1,
                mode: 'restricted',
                accepted: [{ kind: 'home_method', methodId: 'email_password' }],
              },
            }
          : {}),
      },
    });
    await admit(team.id, owner.id, 'owner');
    await admit(team.id, member.id, 'member');
    // The member holds a real Home password factor, so presented email_password evidence is current.
    await db.accountIdentity.create({ data: { accountId: member.id, provider: 'email',
      providerUserId: `task-member-${member.id}@example.test`, profile: {} } });
    await db.accountPasswordCredential.create({ data: { accountId: member.id, credential: {
      v: 1, kind: 'plain_password_hash', hash: await hashPasswordMaterial(new TextEncoder().encode('task test password factor')),
    } } });
    const taskId = crypto.randomUUID();
    const row = await storeTask(owner.id, taskId, 'Team task');
    await db.taskGrant.create({
      data: {
        taskId: row.id,
        principalKind: 'team',
        teamId: team.id,
        accessLevel: 'edit',
        createdByAccountId: owner.id,
      },
    });
    return { owner, member, taskId, url: `/v1/tasks/${owner.id}/${taskId}` };
  }

  it('refuses list, read and write by a member who has not completed the restricted Team sign-in, and admits after sign-in', async () => {
    const { owner, member, taskId, url } = await sharedTask('restricted');

    const read = await app.inject({
      method: 'GET',
      url,
      headers: headers(member.id),
    });
    expect(read.statusCode).toBe(403);
    expect(read.json()).toEqual({ error: 'team_authentication_required' });
    const write = await app.inject({
      method: 'PUT',
      url,
      headers: headers(member.id),
      payload: { expectedVersion: 0, content: plain('member edit') },
    });
    expect(write.statusCode).toBe(403);
    expect(write.json()).toEqual({ error: 'team_authentication_required' });
    const inventory = await app.inject({
      method: 'GET',
      url: '/v1/tasks',
      headers: headers(member.id),
    });
    expect(inventory.statusCode).toBe(200);
    expect(
      inventory.json().tasks.map((task: { taskId: string }) => task.taskId),
    ).not.toContain(taskId);
    const stored = await db.userKVStore.findFirstOrThrow({
      where: { accountId: owner.id, key: `todo.${taskId}` },
    });
    expect(stored.version).toBe(0);

    const admitted = await app.inject({
      method: 'GET',
      url,
      headers: headers(member.id, true),
    });
    expect(admitted.statusCode, admitted.body).toBe(200);
    expect(admitted.json()).toMatchObject({
      ownerAccountId: owner.id,
      taskId,
      access: 'edit',
    });
    const edited = await app.inject({
      method: 'PUT',
      url,
      headers: headers(member.id, true),
      payload: {
        expectedVersion: admitted.json().version,
        content: plain('member edit'),
      },
    });
    expect(edited.statusCode, edited.body).toBe(200);
    const listed = await app.inject({
      method: 'GET',
      url: '/v1/tasks',
      headers: headers(member.id, true),
    });
    expect(listed.json().tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ownerAccountId: owner.id, taskId }),
      ]),
    );
  });

  it('leaves an unrestricted Team grant and the owner personal Task unchanged without sign-in evidence', async () => {
    const { owner, member, taskId, url } = await sharedTask('open');
    const read = await app.inject({
      method: 'GET',
      url,
      headers: headers(member.id),
    });
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json()).toMatchObject({ taskId, access: 'edit' });

    const restricted = await sharedTask('restricted');
    const ownRead = await app.inject({
      method: 'GET',
      url: restricted.url,
      headers: headers(restricted.owner.id),
    });
    expect(ownRead.statusCode, ownRead.body).toBe(200);
    expect(ownRead.json()).toMatchObject({ access: 'owner' });
    const ownWrite = await app.inject({
      method: 'PUT',
      url: restricted.url,
      headers: headers(restricted.owner.id),
      payload: {
        expectedVersion: ownRead.json().version,
        content: plain('owner edit'),
      },
    });
    expect(ownWrite.statusCode, ownWrite.body).toBe(200);
    const ownList = await app.inject({
      method: 'GET',
      url: '/v1/tasks',
      headers: headers(owner.id),
    });
    expect(ownList.json().tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ownerAccountId: owner.id, taskId }),
      ]),
    );
  });
});
