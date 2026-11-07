import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { decodeBase64 } from 'privacy-kit';
import { MACHINE_PLAIN_DATA_KEY_MARKER, encodePlainMachineStoredContent } from '@happier-dev/protocol';
import { auth } from '@/app/auth/auth';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { machinesRoutes } from '@/app/api/routes/machines/machinesRoutes';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { readMachineAudienceAccountIdsInTx } from './machineRecipientWork';
import { resolveEffectiveMachineAccessForMachinesInTx } from './machineAccess';

describe('Machine Team-principal guest exclusion (real Accounts and HTTP)', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-machine-guests-', initAuth: true,
            env: { HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional', AUTH_REQUIRED_LOGIN_PROVIDERS: '' } });
    }, 180_000);
    afterAll(async () => { if (harness) await harness.close(); });

    it.each(['team-guest', 'group-guest', 'account-guest', 'team-member'] as const)(
        '%s gets only its authorized Machine access and audience', async scenario => {
            const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
            const peer = await db.account.create({ data: { encryptionMode: 'plain' } });
            const team = await db.team.create({ data: { name: 'Guest grant isolation' } });
            await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: 'owner' } });
            const member = await db.teamMembership.create({ data: { teamId: team.id, accountId: peer.id,
                role: scenario === 'team-member' ? 'member' : 'guest' } });
            const group = await db.teamGroup.create({ data: { teamId: team.id, name: 'Explicit guests', nameKey: 'explicit-guests' } });
            await db.teamGroupMembership.create({ data: { teamId: team.id, teamGroupId: group.id, teamMembershipId: member.id } });
            const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id,
                installationId: randomUUID(), metadata: encodePlainMachineStoredContent({ host: 'Guest grant test', platform: 'linux',
                    homeDir: '/home/test', happyHomeDir: '/home/test/.happier', happyCliVersion: '0.3.0' }),
                daemonState: encodePlainMachineStoredContent({ status: 'running' }),
                dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER) } });
            const principal = scenario === 'group-guest' ? { kind: 'group', teamId: team.id, groupId: group.id }
                : scenario === 'account-guest' ? { kind: 'account', accountId: peer.id }
                    : { kind: 'team', teamId: team.id };
            const allowed = scenario !== 'team-guest';
            const ownerToken = await auth.createToken(owner.id, undefined, { kind: 'account', authority: 'present_user' });
            const peerToken = await auth.createToken(peer.id, undefined, { kind: 'account', authority: 'present_user' });
            const headers = (token: string) => ({ authorization: `Bearer ${token}`, 'x-happier-account-stored-content-protocol': '4' });
            await withAuthenticatedTestApp(machinesRoutes, async app => {
                const grant = await app.inject({ method: 'PUT', url: `/v1/machines/${machine.id}/access`,
                    headers: headers(ownerToken), payload: { principal, level: 'admin' } });
                expect(grant.statusCode).toBe(200);
                expect(grant.json()).toMatchObject({ kind: 'saved' });
                const ownerRead = await app.inject({ method: 'GET', url: `/v1/machines/${machine.id}`, headers: headers(ownerToken) });
                expect(ownerRead.statusCode).toBe(200);
                const read = await app.inject({ method: 'GET', url: `/v1/machines/${machine.id}`, headers: headers(peerToken) });
                expect(read.statusCode).toBe(allowed ? 200 : 404);
                const access = await app.inject({ method: 'GET', url: `/v1/machines/${machine.id}/access`, headers: headers(peerToken) });
                expect(access.json()).toMatchObject(allowed ? { canManage: true } : { kind: 'refused', code: 'access_denied' });
                const list = await app.inject({ method: 'GET', url: '/v1/machines', headers: headers(peerToken) });
                expect(list.statusCode).toBe(200);
                expect(list.body.includes(machine.id)).toBe(allowed);
                const audience = await inTx(tx => readMachineAudienceAccountIdsInTx(tx, machine.id));
                expect(audience).toEqual([owner.id, ...(allowed ? [peer.id] : [])].sort());
                const roles = await inTx(tx => resolveEffectiveMachineAccessForMachinesInTx(tx, { accountIds: [peer.id], machineIds: [machine.id] }));
                expect(roles.get(machine.id)?.get(peer.id) ?? null).toBe(allowed ? 'manage' : null);
            }, { authentication: 'real' });
        });
});
