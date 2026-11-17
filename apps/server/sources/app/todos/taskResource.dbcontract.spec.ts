import { storedPlainPrivateLabel } from "@/testkit/privateLabelFixture";
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, getDbProviderFromEnv, initDbPostgres, initDbMysql } from '@/storage/db';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { kvRoutes } from '@/app/api/routes/kv/kvRoutes';
import { taskRoutes } from '@/app/api/routes/todos/taskRoutes';
import { makeShareEligibleForTest } from '@/testkit/shareEligibility.testkit';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { computeContentPublicKeyFingerprint } from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';
import { sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import * as privacyKit from 'privacy-kit';
import tweetnacl from 'tweetnacl';
import { inReadSnapshot } from '@/storage/inTx';
import { observePrismaReads } from '@/testkit/observePrismaReads';
import { listTaskResourcesInTx } from './taskResourceService';
import { listTaskGrantsInTx } from './taskAccessService';

const plain = (title: string) => ({ t: 'plain' as const, v: { id: 'task', title, done: false, linkedSessions: [] } });
const routes: Parameters<typeof withAuthenticatedTestApp>[0] = app => { kvRoutes(app); taskRoutes(app); };

describe('Task resource HTTP authority (native database)', () => {
    beforeAll(async () => {
        const provider = getDbProviderFromEnv(process.env, 'postgres');
        const testUrl = provider === 'mysql' ? process.env.HAPPIER_TEST_MYSQL_DATABASE_URL : process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL;
        if (!testUrl || process.env.DATABASE_URL !== testUrl) throw new Error('Use the disposable native DB-contract harness');
        if (provider === 'mysql') await initDbMysql();
        else if (provider === 'postgres') initDbPostgres();
        else throw new Error('Task native DB contracts require PostgreSQL or MySQL');
        await db.$connect();
    });
    afterAll(async () => { await db.$disconnect(); });

    it('keeps Team guests outside Task grants while direct and explicit Group grants remain independent through changes and revoke', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const guest = await db.account.create({ data: { encryptionMode: 'plain' } });
        const member = await db.account.create({ data: { encryptionMode: 'plain' } });
        await makeShareEligibleForTest(owner.id, [guest.id]);
        const team = await db.team.create({ data: { name: randomUUID() } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: 'owner' } });
        const guestMembership = await db.teamMembership.create({ data: { teamId: team.id, accountId: guest.id, role: 'guest' } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: member.id, role: 'member' } });
        const group = await db.teamGroup.create({ data: { teamId: team.id, name: 'Invited guests' } });
        await db.teamGroupMembership.create({ data: { teamId: team.id, teamGroupId: group.id, teamMembershipId: guestMembership.id } });
        const taskId = randomUUID();
        const row = await db.userKVStore.create({ data: { accountId: owner.id, key: `todo.${taskId}`,
            value: new TextEncoder().encode(JSON.stringify(plain('Shared task'))) } });
        await withAuthenticatedTestApp(routes, async app => {
            const url = `/v1/tasks/${owner.id}/${taskId}`;
            const ownerHeaders = { 'x-test-user-id': owner.id };
            const guestHeaders = { 'x-test-user-id': guest.id };
            const memberHeaders = { 'x-test-user-id': member.id };
            const teamPrincipal = { kind: 'team', teamId: team.id };
            const groupPrincipal = { kind: 'group', teamId: team.id, groupId: group.id };
            const directPrincipal = { kind: 'account', accountId: guest.id };
            const set = (principal: typeof teamPrincipal | typeof groupPrincipal | typeof directPrincipal, accessLevel: 'view' | 'admin' = 'view') =>
                app.inject({ method: 'PUT', url: `${url}/grants`, headers: ownerHeaders, payload: { principal, accessLevel } });
            const revoke = (principal: typeof teamPrincipal | typeof groupPrincipal | typeof directPrincipal) =>
                app.inject({ method: 'DELETE', url: `${url}/grants`, headers: ownerHeaders, payload: { principal } });
            const read = (headers: typeof guestHeaders) => app.inject({ method: 'GET', url, headers });
            expect((await set(teamPrincipal)).statusCode).toBe(200);
            expect((await read(guestHeaders)).statusCode).toBe(404);
            expect((await app.inject({ method: 'GET', url: '/v1/tasks', headers: guestHeaders })).json()).toEqual({ tasks: [] });
            expect((await read(memberHeaders)).json()).toMatchObject({ access: 'view', encryptedDataKey: null });
            expect((await set(groupPrincipal)).statusCode).toBe(200);
            expect((await read(guestHeaders)).json()).toMatchObject({ access: 'view', content: plain('Shared task'), encryptedDataKey: null });
            expect((await revoke(groupPrincipal)).statusCode).toBe(200);
            expect((await read(guestHeaders)).statusCode).toBe(404);
            expect((await set(directPrincipal)).statusCode).toBe(200);
            expect((await set(teamPrincipal, 'admin')).statusCode).toBe(200);
            expect((await read(guestHeaders)).json()).toMatchObject({ access: 'view' });
            expect((await read(memberHeaders)).json()).toMatchObject({ access: 'admin' });
            expect((await revoke(directPrincipal)).statusCode).toBe(200);
            expect((await read(guestHeaders)).statusCode).toBe(404);
            expect((await revoke(teamPrincipal)).statusCode).toBe(200);
            expect((await read(memberHeaders)).statusCode).toBe(404);
        });
        expect(await db.userKVStore.findUniqueOrThrow({ where: { id: row.id } })).toEqual(row);
        expect(await db.taskKeyEnvelope.findMany({ where: { taskId: row.id } })).toEqual([]);
    });

    it('reads an exact owner-qualified id set in one Task query without unrelated bodies', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        await db.userKVStore.createMany({ data: Array.from({ length: 1_000 }, (_, index) => ({
            accountId: owner.id, key: `todo.task-${index}`, value: new TextEncoder().encode(JSON.stringify(plain(`Task ${index}`))),
        })) });
        const outsider = await db.account.create({ data: { encryptionMode: 'plain' } });
        await db.userKVStore.create({ data: { accountId: outsider.id, key: 'todo.task-17',
            value: new TextEncoder().encode(JSON.stringify(plain('Private same-id task'))) } });
        const selection = { kind: 'ids' as const, tasks: [17, 42].map(index => ({ ownerAccountId: owner.id, taskId: `task-${index}` })) };
        await withAuthenticatedTestApp(routes, async app => {
            const response = await app.inject({ method: 'GET', url: `/v1/tasks?selection=${encodeURIComponent(JSON.stringify(selection))}`,
                headers: { 'x-test-user-id': owner.id } });
            expect(response.statusCode).toBe(200);
            expect(response.json()).toMatchObject({ selectionApplied: true });
            expect(response.json().tasks.map((task: { taskId: string }) => task.taskId).sort()).toEqual(['task-17', 'task-42']);
            const privateSelection = { kind: 'ids', tasks: [{ ownerAccountId: outsider.id, taskId: 'task-17' }] };
            const denied = await app.inject({ method: 'GET', url: `/v1/tasks?selection=${encodeURIComponent(JSON.stringify(privateSelection))}`,
                headers: { 'x-test-user-id': owner.id } });
            expect(denied.json()).toEqual({ tasks: [], selectionApplied: true });
            const empty = await app.inject({ method: 'GET', url: `/v1/tasks?selection=${encodeURIComponent(JSON.stringify({ kind: 'ids', tasks: [] }))}`,
                headers: { 'x-test-user-id': owner.id } });
            expect(empty.json()).toEqual({ tasks: [], selectionApplied: true });
        });
        await inReadSnapshot(async tx => {
            // Omission retains the incumbent authorized inventory and response.
            const incumbent = await listTaskResourcesInTx(tx, owner.id);
            expect(incumbent.ok && incumbent.value.tasks.length).toBe(1_000);
            if (incumbent.ok) expect(incumbent.value).not.toHaveProperty('selectionApplied');
            const observed = observePrismaReads(tx, ['userKVStore']);
            const result = await listTaskResourcesInTx(observed.tx, owner.id, selection);
            expect(result.ok).toBe(true);
            expect(observed.reads).toEqual(['userKVStore.findMany']);
            expect(observed.rows.map(row => row.count)).toEqual([2]);
        });
    });

    it('reads the owner row and refuses missing and inaccessible addresses identically before any CAS disclosure', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain', name: 'Maya' } });
        const outsider = await db.account.create({ data: { encryptionMode: 'plain' } });
        const taskId = randomUUID();
        await db.userKVStore.create({ data: { accountId: owner.id, key: `todo.${taskId}`,
            value: new TextEncoder().encode(JSON.stringify(plain('Private'))), version: 3 } });
        await withAuthenticatedTestApp(routes, async app => {
            const address = `/v1/tasks/${owner.id}/${taskId}`;
            const owned = await app.inject({ method: 'GET', url: address, headers: { 'x-test-user-id': owner.id } });
            expect(owned.statusCode).toBe(200);
            expect(owned.json()).toMatchObject({ ownerAccountId: owner.id, ownerDisplayName: 'Maya', taskId, version: 3, access: 'owner', content: plain('Private') });
            const denied = await app.inject({ method: 'GET', url: address, headers: { 'x-test-user-id': outsider.id } });
            const missing = await app.inject({ method: 'GET', url: `/v1/tasks/${owner.id}/${randomUUID()}`, headers: { 'x-test-user-id': outsider.id } });
            expect(denied.statusCode).toBe(404);
            expect(denied.json()).toEqual({ error: 'task_not_found' });
            expect(missing.json()).toEqual(denied.json());
            const write = await app.inject({ method: 'PUT', url: address, headers: { 'x-test-user-id': outsider.id },
                payload: { expectedVersion: 0, content: plain('Stolen') } });
            expect(write.statusCode).toBe(404);
            expect(write.json()).toEqual(denied.json());
            await db.account.update({ where: { id: owner.id }, data: { name: null, username: 'maya' } });
            expect((await app.inject({ method: 'GET', url: address, headers: { 'x-test-user-id': owner.id } })).json())
                .toMatchObject({ ownerDisplayName: 'maya' });
            await db.account.update({ where: { id: owner.id }, data: { username: null } });
            expect((await app.inject({ method: 'GET', url: address, headers: { 'x-test-user-id': owner.id } })).json())
                .toMatchObject({ ownerDisplayName: null });
        });
    });

    it('shares Plain content through grants only, preserves owner CAS, and refuses a viewer before reporting conflicts', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const viewer = await db.account.create({ data: { encryptionMode: 'plain' } });
        await makeShareEligibleForTest(owner.id, [viewer.id]);
        const taskId = randomUUID();
        const row = await db.userKVStore.create({ data: { accountId: owner.id, key: `todo.${taskId}`,
            value: new TextEncoder().encode(JSON.stringify(plain('Original'))), version: 4 } });
        await db.userKVStore.create({ data: { accountId: owner.id, key: 'todo.index', value: new TextEncoder().encode('private index') } });
        await withAuthenticatedTestApp(routes, async app => {
            const url = `/v1/tasks/${owner.id}/${taskId}`;
            const ownerHeaders = { 'x-test-user-id': owner.id };
            const viewerHeaders = { 'x-test-user-id': viewer.id };
            const principal = { kind: 'account', accountId: viewer.id };
            expect((await app.inject({ method: 'PUT', url: `${url}/grants`, headers: ownerHeaders,
                payload: { principal, accessLevel: 'view' } })).statusCode).toBe(200);
            expect(await db.userKVStore.findUniqueOrThrow({ where: { id: row.id } })).toEqual(row);
            expect((await app.inject({ method: 'GET', url, headers: viewerHeaders })).json())
                .toMatchObject({ ownerDisplayName: null, content: plain('Original'), access: 'view', encryptedDataKey: null });
            expect((await app.inject({ method: 'GET', url: `${url}/grants`, headers: viewerHeaders })).json())
                .toMatchObject({ ownerDisplayName: null, grants: [{ readiness: { readyCount: 1, pendingCount: 0,
                    unavailableCounts: { plain_account: 0, encryption_setup_required: 0, encryption_inconsistent: 0 } } }] });
            const denied = await app.inject({ method: 'PUT', url, headers: viewerHeaders,
                payload: { expectedVersion: 0, content: plain('Forbidden') } });
            expect(denied.statusCode).toBe(404);
            expect(denied.json()).toEqual({ error: 'task_not_found' });
            const changed = await app.inject({ method: 'PUT', url, headers: ownerHeaders,
                payload: { expectedVersion: 4, content: plain('Changed') } });
            expect(changed.statusCode).toBe(200);
            expect(changed.json()).toMatchObject({ version: 5, content: plain('Changed') });
            const conflict = await app.inject({ method: 'PUT', url, headers: ownerHeaders,
                payload: { expectedVersion: 4, content: plain('Old') } });
            expect(conflict.statusCode).toBe(409);
            expect(conflict.json()).toEqual({ error: 'task_version_conflict' });
            expect((await app.inject({ method: 'GET', url: '/v1/tasks', headers: viewerHeaders })).json())
                .toMatchObject({ tasks: [{ ownerAccountId: owner.id, taskId, version: 5 }] });
            expect((await app.inject({ method: 'DELETE', url: `${url}/grants`, headers: ownerHeaders,
                payload: { principal } })).statusCode).toBe(200);
            expect((await app.inject({ method: 'GET', url, headers: viewerHeaders })).json()).toEqual({ error: 'task_not_found' });
            expect((await app.inject({ method: 'PUT', url, headers: viewerHeaders,
                payload: { expectedVersion: 0, content: plain('Forbidden') } })).json()).toEqual({ error: 'task_not_found' });
            expect((await app.inject({ method: 'PUT', url: `${url}/grants`, headers: ownerHeaders,
                payload: { principal, accessLevel: 'view' } })).statusCode).toBe(200);
            expect((await app.inject({ method: 'GET', url, headers: viewerHeaders })).json()).toMatchObject({ content: plain('Changed'), access: 'view' });
        });
    });

    it('summarizes each live grant audience from one captured recipient batch without requiring the caller to hold a task key', async () => {
        const ownerBinding = createSignedAccountContentBinding();
        const owner = await db.account.create({ data: { ...ownerBinding, encryptionMode: 'e2ee', name: 'Shared owner' } });
        const readyBinding = createSignedAccountContentBinding();
        const rotatedBinding = createSignedAccountContentBinding();
        const ready = await db.account.create({ data: { ...readyBinding, encryptionMode: 'e2ee' } });
        const rotated = await db.account.create({ data: { ...rotatedBinding, encryptionMode: 'e2ee' } });
        const keyless = await db.account.create({ data: { encryptionMode: 'plain' } });
        const setup = await db.account.create({ data: { publicKey: createSignedAccountContentBinding().publicKey, encryptionMode: 'e2ee' } });
        const inconsistent = await db.account.create({ data: { ...createSignedAccountContentBinding(),
            contentPublicKeySig: new Uint8Array(64), encryptionMode: 'e2ee' } });
        const team = await db.team.create({ data: { name: randomUUID() } });
        const group = await db.teamGroup.create({ data: { teamId: team.id, name: storedPlainPrivateLabel('Mixed members') } });
        const members = [owner, ready, rotated, keyless, setup, inconsistent];
        const memberships = await Promise.all(members.map(account => db.teamMembership.create({
            data: { teamId: team.id, accountId: account.id, role: account.id === owner.id ? 'owner' : 'member' } })));
        await db.teamGroupMembership.createMany({ data: memberships.filter(member => member.accountId !== ready.id)
            .map(member => ({ teamId: team.id, teamGroupId: group.id, teamMembershipId: member.id })) });
        const taskId = randomUUID();
        const row = await db.userKVStore.create({ data: { accountId: owner.id, key: `todo.${taskId}`,
            value: new TextEncoder().encode(JSON.stringify({ t: 'encrypted', k: 'task', c: 'opaque-resource-content' })) } });
        await db.taskGrant.create({ data: { principalKind: 'account', taskId: row.id, accountId: ready.id, accessLevel: 'view', createdByAccountId: owner.id } });
        await db.taskGrant.create({ data: { principalKind: 'team', taskId: row.id, teamId: team.id, accessLevel: 'view', createdByAccountId: owner.id } });
        await db.taskGrant.create({ data: { principalKind: 'group', taskId: row.id, teamGroupId: group.id, accessLevel: 'edit', createdByAccountId: owner.id } });
        const dataKey = tweetnacl.randomBytes(32);
        for (const [account, binding] of [[owner, ownerBinding], [ready, readyBinding], [rotated, rotatedBinding]] as const) {
            await db.taskKeyEnvelope.create({ data: { taskId: row.id, recipientAccountId: account.id,
                encryptedDataKey: sealEncryptedDataKeyEnvelopeV1({ dataKey, recipientPublicKey: binding.contentPublicKey, randomBytes: tweetnacl.randomBytes }),
                recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(binding.contentPublicKey) } });
        }
        await db.account.update({ where: { id: rotated.id }, data: createSignedAccountContentBinding() });
        const unavailableCounts = { plain_account: 1, encryption_setup_required: 1, encryption_inconsistent: 1 };
        await withAuthenticatedTestApp(routes, async app => {
            const url = `/v1/tasks/${owner.id}/${taskId}`;
            for (const caller of [owner, rotated, keyless]) {
                const response = await app.inject({ method: 'GET', url: `${url}/grants`, headers: { 'x-test-user-id': caller.id } });
                expect(response.statusCode).toBe(200);
                expect(response.json()).toMatchObject({ grants: expect.arrayContaining([
                    expect.objectContaining({ principal: { kind: 'account', accountId: ready.id }, readiness: { readyCount: 1, pendingCount: 0,
                        unavailableCounts: { plain_account: 0, encryption_setup_required: 0, encryption_inconsistent: 0 } } }),
                    expect.objectContaining({ principal: { kind: 'team', teamId: team.id }, readiness: { readyCount: 1, pendingCount: 1, unavailableCounts } }),
                    expect.objectContaining({ principal: { kind: 'group', teamId: team.id, groupId: group.id }, readiness: { readyCount: 0, pendingCount: 1, unavailableCounts } }),
                ]) });
                expect(response.json()).toMatchObject({ ownerDisplayName: 'Shared owner' });
                expect(response.body).not.toContain('encryptedDataKey');
                expect(response.body).not.toContain('contentPublicKey');
            }
            expect((await app.inject({ method: 'GET', url, headers: { 'x-test-user-id': ready.id } })).json())
                .toMatchObject({ ownerDisplayName: 'Shared owner' });
            await db.teamMembership.updateMany({ where: { teamId: team.id, accountId: keyless.id }, data: { status: 'suspended' } });
            expect((await app.inject({ method: 'GET', url: `${url}/grants`, headers: { 'x-test-user-id': owner.id } })).json())
                .toMatchObject({ grants: expect.arrayContaining([
                    expect.objectContaining({ principal: { kind: 'team', teamId: team.id }, readiness: { readyCount: 1, pendingCount: 1,
                        unavailableCounts: { ...unavailableCounts, plain_account: 0 } } }),
                    expect.objectContaining({ principal: { kind: 'group', teamId: team.id, groupId: group.id }, readiness: { readyCount: 0, pendingCount: 1,
                        unavailableCounts: { ...unavailableCounts, plain_account: 0 } } }),
                ]) });
            expect((await app.inject({ method: 'GET', url: `${url}/grants`, headers: { 'x-test-user-id': keyless.id } })).json())
                .toEqual({ error: 'task_not_found' });
            await db.teamMembership.updateMany({ where: { teamId: team.id, accountId: keyless.id }, data: { status: 'active' } });
            const rotatedMembership = memberships.find(member => member.accountId === rotated.id)!;
            await db.teamGroupMembership.deleteMany({ where: { teamGroupId: group.id, teamMembershipId: rotatedMembership.id } });
            expect((await app.inject({ method: 'GET', url: `${url}/grants`, headers: { 'x-test-user-id': owner.id } })).json())
                .toMatchObject({ grants: expect.arrayContaining([expect.objectContaining({
                    principal: { kind: 'group', teamId: team.id, groupId: group.id }, readiness: { readyCount: 0, pendingCount: 0, unavailableCounts },
                })]) });
            await db.account.update({ where: { id: ready.id }, data: { status: 'disabled' } });
            expect((await app.inject({ method: 'GET', url: `${url}/grants`, headers: { 'x-test-user-id': owner.id } })).json())
                .toMatchObject({ grants: expect.arrayContaining([
                    expect.objectContaining({ principal: { kind: 'account', accountId: ready.id }, readiness: { readyCount: 0, pendingCount: 0,
                        unavailableCounts: { plain_account: 0, encryption_setup_required: 0, encryption_inconsistent: 0 } } }),
                    expect.objectContaining({ principal: { kind: 'team', teamId: team.id }, readiness: { readyCount: 0, pendingCount: 1, unavailableCounts } }),
                ]) });
            expect((await app.inject({ method: 'GET', url: `${url}/grants`, headers: { 'x-test-user-id': ready.id } })).json())
                .toEqual({ error: 'task_not_found' });
            await db.account.update({ where: { id: ready.id }, data: { status: 'active' } });
        });
        const capture = () => inReadSnapshot(async tx => {
            const observed = observePrismaReads(tx, ['userKVStore', 'taskGrant', 'account', 'taskKeyEnvelope']);
            const result = await listTaskGrantsInTx(observed.tx, { actorAccountId: owner.id, ownerAccountId: owner.id, taskId });
            return { result, reads: observed.reads };
        });
        const first = await capture();
        const additional = Array.from({ length: 100 }, () => ({ id: randomUUID(), encryptionMode: 'plain' as const }));
        await db.account.createMany({ data: additional });
        await db.teamMembership.createMany({ data: additional.map(account => ({ teamId: team.id, accountId: account.id, role: 'member' as const })) });
        const next = await capture();
        expect(next.reads).toEqual(first.reads);
        expect(next.reads).toEqual(['userKVStore.findFirst', 'taskGrant.findMany', 'account.findMany', 'taskKeyEnvelope.findMany']);
        expect(next.result).toMatchObject({ ok: true, value: { grants: expect.arrayContaining([expect.objectContaining({
            principal: { kind: 'team', teamId: team.id }, readiness: { readyCount: 1, pendingCount: 1,
                unavailableCounts: { ...unavailableCounts, plain_account: 101 } },
        })]) } });
        console.log('TASK_GRANT_READ_COST', JSON.stringify({ addedRecipients: [0, 100], reads: [first.reads.length, next.reads.length] }));
    });

    it('uses live Team and Group membership and keeps the strongest remaining grant effective', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const member = await db.account.create({ data: { encryptionMode: 'plain' } });
        const team = await db.team.create({ data: { name: randomUUID() } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: 'owner' } });
        const membership = await db.teamMembership.create({ data: { teamId: team.id, accountId: member.id, role: 'member' } });
        const group = await db.teamGroup.create({ data: { teamId: team.id, name: storedPlainPrivateLabel('Reviewers') } });
        await db.teamGroupMembership.create({ data: { teamId: team.id, teamGroupId: group.id, teamMembershipId: membership.id } });
        const taskId = randomUUID();
        await db.userKVStore.create({ data: { accountId: owner.id, key: `todo.${taskId}`, value: new TextEncoder().encode(JSON.stringify(plain('Team work'))) } });
        await withAuthenticatedTestApp(routes, async app => {
            const url = `/v1/tasks/${owner.id}/${taskId}`;
            const headers = { 'x-test-user-id': owner.id };
            const memberHeaders = { 'x-test-user-id': member.id };
            const teamPrincipal = { kind: 'team', teamId: team.id };
            const groupPrincipal = { kind: 'group', teamId: team.id, groupId: group.id };
            for (const [principal, accessLevel] of [[teamPrincipal, 'view'], [groupPrincipal, 'edit']] as const) {
                expect((await app.inject({ method: 'PUT', url: `${url}/grants`, headers, payload: { principal, accessLevel } })).statusCode).toBe(200);
            }
            expect((await app.inject({ method: 'GET', url, headers: memberHeaders })).json()).toMatchObject({ access: 'edit' });
            expect((await app.inject({ method: 'PUT', url, headers: memberHeaders, payload: { expectedVersion: 0, content: plain('Member edit') } })).statusCode).toBe(200);
            expect((await app.inject({ method: 'DELETE', url: `${url}/grants`, headers, payload: { principal: groupPrincipal } })).statusCode).toBe(200);
            expect((await app.inject({ method: 'GET', url, headers: memberHeaders })).json()).toMatchObject({ access: 'view' });
            await db.teamMembership.update({ where: { id: membership.id }, data: { status: 'suspended' } });
            expect((await app.inject({ method: 'GET', url, headers: memberHeaders })).json()).toEqual({ error: 'task_not_found' });
            expect((await app.inject({ method: 'PUT', url, headers: memberHeaders, payload: { expectedVersion: 0, content: plain('Revoked') } })).json()).toEqual({ error: 'task_not_found' });
            expect((await app.inject({ method: 'GET', url: '/v1/tasks', headers: memberHeaders })).json()).toEqual({ tasks: [] });
            await db.teamMembership.update({ where: { id: membership.id }, data: { status: 'active' } });
            expect((await app.inject({ method: 'GET', url, headers: memberHeaders })).json()).toMatchObject({ access: 'view', content: plain('Member edit') });
            expect((await app.inject({ method: 'DELETE', url: `${url}/grants`, headers, payload: { principal: teamPrincipal } })).statusCode).toBe(200);
            expect((await app.inject({ method: 'GET', url, headers: memberHeaders })).json()).toEqual({ error: 'task_not_found' });
        });
    });

    it('requires E2EE reseal and a verified owner envelope, leaving stale recipient keys pending without a Plain copy', async () => {
        const ownerBinding = createSignedAccountContentBinding();
        const readerBinding = createSignedAccountContentBinding();
        const owner = await db.account.create({ data: { ...ownerBinding, encryptionMode: 'e2ee' } });
        const reader = await db.account.create({ data: { ...readerBinding, encryptionMode: 'e2ee' } });
        const plainReader = await db.account.create({ data: { encryptionMode: 'plain' } });
        await makeShareEligibleForTest(owner.id, [reader.id, plainReader.id]);
        const taskId = randomUUID();
        const personal = { t: 'encrypted', c: 'personal-account-ciphertext' };
        const row = await db.userKVStore.create({ data: { accountId: owner.id, key: `todo.${taskId}`, value: new TextEncoder().encode(JSON.stringify(personal)), version: 2 } });
        const key = tweetnacl.randomBytes(32);
        const envelope = (recipientAccountId: string, binding: typeof ownerBinding) => ({ recipientAccountId,
            encryptedDataKey: privacyKit.encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey: key, recipientPublicKey: binding.contentPublicKey, randomBytes: tweetnacl.randomBytes })),
            recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(binding.contentPublicKey) });
        const ownerEnvelope = envelope(owner.id, ownerBinding);
        const readerEnvelope = envelope(reader.id, readerBinding);
        await withAuthenticatedTestApp(routes, async app => {
            const url = `/v1/tasks/${owner.id}/${taskId}`;
            const headers = { 'x-test-user-id': owner.id };
            const principal = { kind: 'account', accountId: reader.id };
            const before = await app.inject({ method: 'GET', url, headers });
            expect(before.statusCode).toBe(200);
            expect(before.json()).toMatchObject({ content: personal, encryptedDataKey: null });
            const prospective = await app.inject({ method: 'POST', url: `${url}/recipients/census`, headers, payload: { principal } });
            expect(prospective.statusCode).toBe(200);
            expect(prospective.json()).toMatchObject({ dataEncryptionKey: null, callerDataEncryptionKey: null,
                recipients: expect.arrayContaining([expect.objectContaining({ recipientAccountId: owner.id }), expect.objectContaining({ recipientAccountId: reader.id })]) });
            const unprepared = await app.inject({ method: 'PUT', url: `${url}/grants`, headers, payload: { principal, accessLevel: 'edit' } });
            expect(unprepared.statusCode).toBe(400);
            expect(unprepared.json()).toEqual({ error: 'task_promotion_required' });
            const content = { t: 'encrypted', k: 'task', c: 'resource-data-key-ciphertext' };
            const promotion = { expectedVersion: 2, content, ownerKeyEnvelope: ownerEnvelope, recipientKeyEnvelopes: [] };
            const stale = await app.inject({ method: 'PUT', url: `${url}/grants`, headers,
                payload: { principal, accessLevel: 'edit', promotion: { ...promotion, expectedVersion: 1 } } });
            expect(stale.statusCode).toBe(409);
            expect((await app.inject({ method: 'GET', url, headers: { 'x-test-user-id': reader.id } })).json()).toEqual({ error: 'task_not_found' });
            expect((await db.userKVStore.findUniqueOrThrow({ where: { id: row.id } })).version).toBe(2);
            const invalidOwner = await app.inject({ method: 'PUT', url: `${url}/grants`, headers,
                payload: { principal, accessLevel: 'edit', promotion: { ...promotion,
                    ownerKeyEnvelope: { ...ownerEnvelope, recipientContentPublicKeyFingerprint: readerEnvelope.recipientContentPublicKeyFingerprint } } } });
            expect(invalidOwner.statusCode).toBe(400);
            expect(invalidOwner.json()).toEqual({ error: 'task_invalid_recipient_envelope' });
            const beforePromotion = await db.account.findUniqueOrThrow({ where: { id: owner.id }, select: { seq: true } });
            const promoted = await app.inject({ method: 'PUT', url: `${url}/grants`, headers,
                payload: { principal, accessLevel: 'edit', promotion: { ...promotion,
                    recipientKeyEnvelopes: [{ ...readerEnvelope, recipientContentPublicKeyFingerprint: ownerEnvelope.recipientContentPublicKeyFingerprint }] } } });
            expect(promoted.statusCode).toBe(200);
            expect((await db.account.findUniqueOrThrow({ where: { id: owner.id }, select: { seq: true } })).seq).toBe(beforePromotion.seq + 1);
            expect((await app.inject({ method: 'GET', url, headers: { 'x-test-user-id': reader.id } })).json()).toEqual({ error: 'task_content_unavailable' });
            expect((await app.inject({ method: 'GET', url: '/v1/tasks', headers: { 'x-test-user-id': reader.id } })).json())
                .toEqual({ tasks: [], unavailableTasks: [{ ownerAccountId: owner.id, taskId, error: 'task_content_unavailable', reason: 'recipient_key_pending' }] });
            const wrongKey = await app.inject({ method: 'POST', url: `${url}/recipients/commit`, headers,
                payload: { expectedDataEncryptionKey: readerEnvelope.encryptedDataKey, recipientKeyEnvelopes: [readerEnvelope] } });
            expect(wrongKey.statusCode).toBe(409);
            expect(wrongKey.json()).toEqual({ error: 'task_data_key_changed' });
            const repaired = await app.inject({ method: 'POST', url: `${url}/recipients/commit`, headers,
                payload: { expectedDataEncryptionKey: ownerEnvelope.encryptedDataKey, recipientKeyEnvelopes: [readerEnvelope] } });
            expect(repaired.statusCode).toBe(200);
            expect(repaired.json()).toEqual({ appliedRecipientAccountIds: [reader.id], skippedRecipientAccountIds: [] });
            expect((await app.inject({ method: 'GET', url, headers: { 'x-test-user-id': reader.id } })).json())
                .toMatchObject({ content, encryptedDataKey: readerEnvelope.encryptedDataKey, version: 3 });
            const census = await app.inject({ method: 'POST', url: `${url}/recipients/census`, headers, payload: {} });
            expect(census.json()).toMatchObject({ dataEncryptionKey: ownerEnvelope.encryptedDataKey,
                callerDataEncryptionKey: ownerEnvelope.encryptedDataKey,
                recipients: expect.arrayContaining([expect.objectContaining({ recipientAccountId: owner.id }), expect.objectContaining({ recipientAccountId: reader.id })]) });
            expect((await app.inject({ method: 'PUT', url: `${url}/grants`, headers,
                payload: { principal: { kind: 'account', accountId: plainReader.id }, accessLevel: 'view' } })).statusCode).toBe(200);
            expect((await app.inject({ method: 'GET', url, headers: { 'x-test-user-id': plainReader.id } })).json()).toEqual({ error: 'task_content_unavailable' });
            expect((await app.inject({ method: 'GET', url: '/v1/tasks', headers: { 'x-test-user-id': plainReader.id } })).json())
                .toEqual({ tasks: [], unavailableTasks: [{ ownerAccountId: owner.id, taskId, error: 'task_content_unavailable', reason: 'plain_account' }] });
            const stored = await db.userKVStore.findUniqueOrThrow({ where: { id: row.id } });
            expect(JSON.parse(new TextDecoder().decode(stored.value!))).toEqual(content);
            expect((await app.inject({ method: 'DELETE', url: `${url}/grants`, headers, payload: { principal } })).statusCode).toBe(200);
            expect((await app.inject({ method: 'GET', url, headers: { 'x-test-user-id': reader.id } })).json()).toEqual({ error: 'task_not_found' });
            expect((await app.inject({ method: 'PUT', url: `${url}/grants`, headers, payload: { principal, accessLevel: 'view' } })).statusCode).toBe(200);
            expect((await app.inject({ method: 'GET', url, headers: { 'x-test-user-id': reader.id } })).json())
                .toMatchObject({ encryptedDataKey: readerEnvelope.encryptedDataKey, version: 3 });
        });
    });

    it('preserves own legacy ciphertext and edits unpromoted current E2EE rows without granting another Account access', async () => {
        const owner = await db.account.create({ data: { ...createSignedAccountContentBinding(), encryptionMode: 'e2ee' } });
        const legacyId = randomUUID();
        const currentId = randomUUID();
        const legacy = new Uint8Array(tweetnacl.randomBytes(80));
        await db.userKVStore.create({ data: { accountId: owner.id, key: `todo.${legacyId}`, value: legacy } });
        await db.userKVStore.create({ data: { accountId: owner.id, key: `todo.${currentId}`,
            value: new TextEncoder().encode(JSON.stringify({ t: 'encrypted', c: 'original' })) } });
        await withAuthenticatedTestApp(routes, async app => {
            const headers = { 'x-test-user-id': owner.id };
            expect((await app.inject({ method: 'GET', url: `/v1/tasks/${owner.id}/${legacyId}`, headers })).json())
                .toMatchObject({ content: { t: 'encrypted', c: privacyKit.encodeBase64(legacy) }, encryptedDataKey: null });
            const edit = await app.inject({ method: 'PUT', url: `/v1/tasks/${owner.id}/${currentId}`, headers,
                payload: { expectedVersion: 0, content: { t: 'encrypted', c: 'edited-with-account-key' } } });
            expect(edit.statusCode).toBe(200);
            expect(edit.json()).toMatchObject({ content: { t: 'encrypted', c: 'edited-with-account-key' }, version: 1, encryptedDataKey: null });
        });
        const capture = () => inReadSnapshot(async tx => {
            const observed = observePrismaReads(tx, ['userKVStore', 'account']);
            const result = await listTaskResourcesInTx(observed.tx, owner.id);
            return { result, reads: observed.reads };
        });
        const first = await capture();
        expect(first.result).toMatchObject({ ok: true, value: { tasks: expect.arrayContaining([
            expect.objectContaining({ taskId: legacyId }), expect.objectContaining({ taskId: currentId }),
        ]) } });
        // One Task query per access arm (owner, Account, Team, Group grants), then the caller's readiness.
        expect(first.reads).toEqual([...Array.from({ length: 4 }, () => 'userKVStore.findMany'), 'account.findUnique']);
        const addedId = randomUUID();
        await db.userKVStore.create({ data: { accountId: owner.id, key: `todo.${addedId}`,
            value: new TextEncoder().encode(JSON.stringify({ t: 'encrypted', c: 'new-task' })) } });
        const next = await capture();
        expect(next.reads).toEqual(first.reads);
        expect(next.result).toMatchObject({ ok: true, value: { tasks: expect.arrayContaining([expect.objectContaining({ taskId: addedId })]) } });
    });

    it('reports malformed owned content as unavailable without hiding the authoritative task', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const taskId = randomUUID();
        await db.userKVStore.create({ data: { accountId: owner.id, key: `todo.${taskId}`,
            value: new TextEncoder().encode(JSON.stringify({ t: 'encrypted', k: 'task', c: 'wrong-mode' })) } });
        await withAuthenticatedTestApp(routes, async app => {
            const headers = { 'x-test-user-id': owner.id };
            expect((await app.inject({ method: 'GET', url: `/v1/tasks/${owner.id}/${taskId}`, headers })).json())
                .toEqual({ error: 'task_content_unavailable' });
            const listed = await app.inject({ method: 'GET', url: '/v1/tasks', headers });
            expect(listed.statusCode).toBe(409);
            expect(listed.json()).toEqual({ error: 'task_content_unavailable' });
        });
    });
});
