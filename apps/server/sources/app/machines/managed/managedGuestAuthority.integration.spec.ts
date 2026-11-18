import { storedPlainPrivateLabel } from "@/testkit/privateLabelFixture";
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Server, type Socket } from 'socket.io';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol';
import { decodeBase64 } from 'privacy-kit';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { setEligibleMachineAccessGrantInTx } from '@/testkit/machineAccessGrant.testkit';
import { createAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { machinesRoutes } from '@/app/api/routes/machines/machinesRoutes';
import { createSocketRoomDiscoveryHarness } from '@/app/api/testkit/socketHarness';
import { resolveEffectiveMachineRoleInTx, resolveMachineAdmissionInTx, removeMachineAccessGrantInTx, resolveCurrentMachineRecipientAccountIdsInTx,
    resolveMachinePrincipalAccessForMachinesInTx } from '@/app/machines/machineAccess';
import { readManagedMachinePolicyPublicationAudienceInTx } from './managedRows';
import { publishManagedGuestActivityAvailable } from './managedGuestActivity';
import { managedMachineActionEndpointPathV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { createCreatorFixture } from './managedCreatorAccess.testkit';
import tweetnacl from 'tweetnacl';
import { encodeBase64 } from 'privacy-kit';
import { computeContentPublicKeyFingerprint, sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { readMachineRecipientCensusInTx, commitMachineRecipientKeyEnvelopesInTx, resolveMachineAccessInTx } from '@/app/machines/machineAccess';
import { setTeamMembershipStatusInTx } from '@/app/teams/memberships/membershipService';
import { createProtectedRawSessionTargetGuard } from '@/app/api/socket/rpc/protectedRawSessionTargetGuard';
import { forwardRpcCall } from '@/app/api/socket/rpc/forwardRpcCall';
import { buildRpcMethodRoom } from '@/app/api/socket/rpc/rpcMethodRoom';
import { currentAccountStoredContentCompatibilityHeaders } from '@/app/api/testkit/accountStoredContentCompatibility';

describe('managed guest grants and controller Manage', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-managed-guest-authority-', initAuth: false,
            initEncrypt: true, env: { HAPPIER_SERVER_IDENTITY_ID: `srv_${'a'.repeat(32)}` } });
    }, 120_000);
    afterAll(async () => { if (harness) await harness.close(); });

    it('wakes the controller policy when a same-Account guest publishes activity', async () => {
        const { custodian, stranger, create } = await createCreatorFixture();
        const row = await create(custodian.id);
        const installationId = randomUUID();
        const guest = await db.machine.create({ data: { id: randomUUID(), accountId: custodian.id,
            installationId, metadata: '{}' } });
        await db.managedMachine.update({ where: { id: row.id }, data: { enrolledMachineId: guest.id } });
        const publication = { accountId: custodian.id, machineId: guest.id, installationId };
        const changes = () => db.accountChange.findMany({ where: { entityId: row.id }, select: { accountId: true } });
        await publishManagedGuestActivityAvailable({ ...publication, accountId: stranger.id });
        expect(await changes()).toEqual([]);
        await publishManagedGuestActivityAvailable(publication);
        expect(await changes()).toEqual([{ accountId: custodian.id }]);
    });

    it('keeps controller Use separate, inherits Manage, and retains independent guest grants after controller revocation', async () => {
        const { homeId, custodian, creator, stranger, controller, row } = await createCreatorFixture();
        await db.machine.update({ where: { id: controller.id }, data: {
            metadata: encodePlainMachineStoredContent({ host: 'controller', platform: 'linux' }),
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER),
        } });
        const guest = await db.machine.create({ data: { id: randomUUID(), accountId: creator.id,
            installationId: randomUUID(), metadata: encodePlainMachineStoredContent({ host: 'guest', platform: 'linux',
                happyCliVersion: 'test', homeDir: '/home/guest', happyHomeDir: '/home/guest/.happier' }),
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER) } });
        await db.managedMachine.update({ where: { id: row.id }, data: { enrolledMachineId: guest.id } });
        const grant = (machineId: string, actorAccountId: string, level: 'view' | 'admin') => inTx(tx => setEligibleMachineAccessGrantInTx(tx,
            { actorAccountId, machineId, principal: { kind: 'account', accountId: stranger.id }, level }));
        const role = (actorAccountId = stranger.id) => inTx(tx => resolveEffectiveMachineRoleInTx(tx, { actorAccountId, machineId: guest.id }));
        const admission = (rpcMethod: string, requiredRole: 'use' | 'manage' = 'use') => inTx(tx => resolveMachineAdmissionInTx(tx,
            { actorAccountId: stranger.id, machineId: guest.id, rpcMethod, requiredRole }));
        const session = await db.session.create({ data: { accountId: stranger.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        // A retained exact Session tuple does not confer a fresh Machine grant.
        await db.accessKey.create({ data: { accountId: stranger.id, machineId: guest.id, sessionId: session.id, data: 'opaque' } });
        const emitWithAck = vi.fn(async (_event: string, _request: unknown) => 'session-attachment');
        const receiver = { id: randomUUID(), connected: true, data: { clientType: 'session-scoped', userId: stranger.id,
            sessionScopedBinding: { sessionId: session.id, machineId: guest.id, proof: 'machine-access-key' } },
            timeout: () => ({ emitWithAck }) };
        const io = new Server();
        io.sockets.sockets.set(receiver.id, receiver as unknown as Socket);
        const sessionTransfer = () => {
            const method = `${session.id}:${RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT}`;
            const transferRouting = { method: RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT, sessionId: session.id,
                t: 'session_attachment_download_v1' as const };
            const guard = createProtectedRawSessionTargetGuard({ method, actorAccountId: stranger.id, targetUserId: stranger.id,
                callerSocket: { data: { clientType: 'user-scoped' } }, callerAuthority: 'present_user', knownSessionSource: false, transferRouting });
            if (!guard) throw new Error('Expected protected Session transfer');
            io.sockets.adapter.rooms.set(buildRpcMethodRoom({ userId: stranger.id, method }), new Set([receiver.id]));
            return forwardRpcCall({ io, targetUserId: stranger.id, method, callerSocketId: 'browser', callParams: 'sealed-input', transferRouting, ...guard });
        };
        const app = createAuthenticatedTestApp();
        app.decorate('machineDaemonPresence', createSocketRoomDiscoveryHarness(async () => []));
        machinesRoutes(app);
        await app.ready();
        const get = (url: string) => app.inject({ method: 'GET', url, headers: { 'x-test-user-id': stranger.id, ...currentAccountStoredContentCompatibilityHeaders } });
        const managed = (action: 'machines.managed.list' | 'machines.managed.get', input: object) => app.inject({ method: 'POST',
            url: managedMachineActionEndpointPathV1(action), headers: { 'x-test-user-id': stranger.id }, payload: input });
        try {
            expect(await grant(controller.id, custodian.id, 'view')).toMatchObject({ kind: 'saved' });
            expect(await inTx(tx => resolveCurrentMachineRecipientAccountIdsInTx(tx, guest.id))).not.toContain(stranger.id);
            expect((await inTx(tx => readManagedMachinePolicyPublicationAudienceInTx(tx, { ...row, enrolledMachineId: guest.id }))).resourceAccountIds).not.toContain(stranger.id);
            expect(await db.accountChange.count({ where: { accountId: stranger.id, entityId: guest.id } })).toBe(0);
            expect((await managed('machines.managed.list', { homeId })).json()).toMatchObject({ machines: [] });
            expect((await managed('machines.managed.get', { homeId, managedId: row.id })).statusCode).toBe(403);
            expect((await get(`/v1/machines/${guest.id}`)).statusCode).toBe(404);
            expect(await role()).toBeNull();
            expect(await admission(RPC_METHODS.MACHINES_SERVICE_LIST)).toMatchObject({ kind: 'denied', code: 'access_denied' });
            expect(await sessionTransfer()).toMatchObject({ ok: false });
            expect(emitWithAck).not.toHaveBeenCalled();

            expect(await grant(controller.id, custodian.id, 'admin')).toMatchObject({ kind: 'saved' });
            expect(await role()).toBe('manage');
            expect(await role(custodian.id)).toBe('manage');
            expect(await inTx(tx => resolveCurrentMachineRecipientAccountIdsInTx(tx, guest.id))).toEqual(expect.arrayContaining([creator.id, custodian.id, stranger.id]));
            expect((await inTx(tx => readManagedMachinePolicyPublicationAudienceInTx(tx, { ...row, enrolledMachineId: guest.id }))).resourceAccountIds).toContain(stranger.id);
            expect(await db.accountChange.count({ where: { accountId: stranger.id, entityId: guest.id } })).toBeGreaterThan(0);
            expect((await managed('machines.managed.list', { homeId })).json()).toMatchObject({ machines: [{ id: row.id }] });
            expect((await managed('machines.managed.get', { homeId, managedId: row.id })).statusCode).toBe(200);
            expect((await get(`/v1/machines/${guest.id}`)).statusCode).toBe(200);
            expect((await get('/v1/machines')).json()).toEqual(expect.arrayContaining([expect.objectContaining({ id: guest.id })]));
            expect(await admission(RPC_METHODS.MACHINES_SERVICE_LIST)).toMatchObject({ kind: 'admitted', role: 'manage' });
            expect(await sessionTransfer()).toMatchObject({ ok: true, result: 'session-attachment' });
            expect(emitWithAck.mock.lastCall?.[1]).toMatchObject({ machineAdmission: { machineId: guest.id, role: 'manage' } });

            expect(await grant(guest.id, creator.id, 'view')).toMatchObject({ kind: 'saved' });
            expect(await inTx(tx => removeMachineAccessGrantInTx(tx, { actorAccountId: custodian.id, machineId: controller.id,
                principal: { kind: 'account', accountId: stranger.id } }))).toMatchObject({ kind: 'removed' });
            expect(await role()).toBe('use');
            expect((await managed('machines.managed.list', { homeId })).json()).toMatchObject({ machines: [{ id: row.id }] });
            expect((await managed('machines.managed.get', { homeId, managedId: row.id })).statusCode).toBe(200);
            expect(await admission(RPC_METHODS.MACHINES_SERVICE_LIST)).toMatchObject({ kind: 'admitted', role: 'use' });
            expect(await admission(RPC_METHODS.MACHINES_SERVICE_WATCH, 'manage')).toMatchObject({ kind: 'denied', code: 'access_denied' });
            expect(await sessionTransfer()).toMatchObject({ ok: true, result: 'session-attachment' });
        } finally { await app.close(); }
    });

    it('withdraws inherited Team/group Manage at membership loss while preserving a direct guest Use grant', async () => {
        const { custodian, creator, stranger, controller, row } = await createCreatorFixture();
        await db.machine.update({ where: { id: controller.id }, data: {
            metadata: encodePlainMachineStoredContent({ host: 'controller', platform: 'linux' }),
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER),
        } });
        const guest = await db.machine.create({ data: { id: randomUUID(), accountId: creator.id,
            installationId: randomUUID(), metadata: encodePlainMachineStoredContent({ host: 'guest', platform: 'linux' }),
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER) } });
        await db.managedMachine.update({ where: { id: row.id }, data: { enrolledMachineId: guest.id } });
        const team = await db.team.create({ data: { name: 'Controller sharing' } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: custodian.id, role: 'member' } });
        const member = await db.teamMembership.create({ data: { teamId: team.id, accountId: stranger.id, role: 'member' } });
        const group = await db.teamGroup.create({ data: { teamId: team.id, name: storedPlainPrivateLabel('Managers') } });
        await db.teamGroupMembership.create({ data: { teamId: team.id, teamGroupId: group.id, teamMembershipId: member.id, nativeContribution: true } });
        const role = () => inTx(tx => resolveEffectiveMachineRoleInTx(tx, { actorAccountId: stranger.id, machineId: guest.id }));
        const audience = () => inTx(tx => resolveCurrentMachineRecipientAccountIdsInTx(tx, guest.id));
        const grantTeam = (level: 'view' | 'admin') => inTx(tx => setEligibleMachineAccessGrantInTx(tx, {
            actorAccountId: custodian.id, machineId: controller.id, principal: { kind: 'team', teamId: team.id }, level }));
        expect(await grantTeam('view')).toMatchObject({ kind: 'saved' });
        expect(await role()).toBeNull();
        expect(await audience()).not.toContain(stranger.id);
        expect(await inTx(tx => setEligibleMachineAccessGrantInTx(tx, { actorAccountId: custodian.id, machineId: controller.id,
            principal: { kind: 'group', teamId: team.id, groupId: group.id }, level: 'admin' }))).toMatchObject({ kind: 'saved' });
        expect(await role()).toBe('manage');
        expect(await audience()).toContain(stranger.id);
        await inTx(tx => setEligibleMachineAccessGrantInTx(tx, { actorAccountId: creator.id, machineId: guest.id,
            principal: { kind: 'account', accountId: stranger.id }, level: 'view' }));
        const changes = async () => (await db.accountChange.findFirst({ where: { accountId: stranger.id, entityId: guest.id },
            orderBy: { cursor: 'desc' }, select: { cursor: true } }))?.cursor ?? 0;
        const before = await changes();
        await inTx(tx => setTeamMembershipStatusInTx(tx, { teamId: team.id, membershipId: member.id, accountId: stranger.id, status: 'suspended' }));
        expect(await role()).toBe('use');
        expect(await audience()).toContain(stranger.id);
        expect(await changes()).toBeGreaterThan(before);
        await inTx(tx => removeMachineAccessGrantInTx(tx, { actorAccountId: creator.id, machineId: guest.id,
            principal: { kind: 'account', accountId: stranger.id } }));
        expect(await role()).toBeNull();
        expect(await audience()).not.toContain(stranger.id);
        await grantTeam('admin');
        await inTx(tx => setTeamMembershipStatusInTx(tx, { teamId: team.id, membershipId: member.id, accountId: stranger.id, status: 'active' }));
        expect(await role()).toBe('manage');
        await db.team.update({ where: { id: team.id }, data: { archivedAt: new Date() } });
        expect(await role()).toBeNull();
        expect(await audience()).not.toContain(stranger.id);
    });

    it('requires an actual guest recipient envelope for inherited Manage and refuses key commit after its withdrawal', async () => {
        const { custodian, creator, stranger, controller, row } = await createCreatorFixture();
        const ownerKeys = tweetnacl.box.keyPair();
        const recipientKeys = tweetnacl.box.keyPair();
        await db.account.update({ where: { id: creator.id }, data: { encryptionMode: 'e2ee', ...createSignedAccountContentBinding(ownerKeys.publicKey) } });
        await db.account.update({ where: { id: stranger.id }, data: { encryptionMode: 'e2ee', ...createSignedAccountContentBinding(recipientKeys.publicKey) } });
        await db.machine.update({ where: { id: controller.id }, data: {
            metadata: encodePlainMachineStoredContent({ host: 'controller', platform: 'linux' }),
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER),
        } });
        const key = tweetnacl.randomBytes(32);
        const guest = await db.machine.create({ data: { id: randomUUID(), accountId: creator.id,
            installationId: randomUUID(), metadata: 'opaque-guest-content',
            dataEncryptionKey: sealEncryptedDataKeyEnvelopeV1({ dataKey: key, recipientPublicKey: ownerKeys.publicKey, randomBytes: tweetnacl.randomBytes }) } });
        await db.managedMachine.update({ where: { id: row.id }, data: { enrolledMachineId: guest.id } });
        expect(await inTx(tx => setEligibleMachineAccessGrantInTx(tx, { actorAccountId: custodian.id,
            machineId: controller.id, principal: { kind: 'account', accountId: stranger.id }, level: 'admin' }))).toMatchObject({ kind: 'saved' });
        const access = () => inTx(tx => resolveMachineAccessInTx(tx, { actorAccountId: stranger.id, machineId: guest.id }));
        expect(await access()).toMatchObject({ role: 'manage', accessState: 'key_pending' });
        expect(await inTx(tx => resolveMachineAdmissionInTx(tx, { actorAccountId: stranger.id, machineId: guest.id })))
            .toMatchObject({ kind: 'denied', code: 'recipient_key_pending' });
        const census = await inTx(tx => readMachineRecipientCensusInTx(tx, { actorAccountId: creator.id, machineId: guest.id }));
        if ('kind' in census) throw new Error(census.code);
        expect(census.recipients).toEqual(expect.arrayContaining([expect.objectContaining({ recipientAccountId: stranger.id })]));
        expect(census.recipients.find(recipient => recipient.recipientAccountId === custodian.id)).toMatchObject({ contentKey: { status: 'unavailable' } });
        const commit = { actorAccountId: creator.id, machineId: guest.id,
            expectedMachineOwnerEnvelopeFingerprint: census.machineOwnerEnvelopeFingerprint!, expectedCallerDataEncryptionKey: census.callerDataEncryptionKey!,
            expectedMetadataVersion: census.content.metadataVersion, expectedDaemonStateVersion: census.content.daemonStateVersion,
            recipientKeyEnvelopes: [{ recipientAccountId: stranger.id,
                encryptedDataKey: encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey: key, recipientPublicKey: recipientKeys.publicKey, randomBytes: tweetnacl.randomBytes })),
                recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(recipientKeys.publicKey) }] };
        expect(await inTx(tx => commitMachineRecipientKeyEnvelopesInTx(tx, commit))).toMatchObject({ appliedRecipientAccountIds: [stranger.id] });
        expect(await access()).toMatchObject({ role: 'manage', accessState: 'ready' });
        await inTx(tx => removeMachineAccessGrantInTx(tx, { actorAccountId: custodian.id, machineId: controller.id,
            principal: { kind: 'account', accountId: stranger.id } }));
        expect(await access()).toBeNull();
        expect(await inTx(tx => resolveCurrentMachineRecipientAccountIdsInTx(tx, guest.id))).not.toContain(stranger.id);
        expect(await inTx(tx => commitMachineRecipientKeyEnvelopesInTx(tx, commit))).toMatchObject({ kind: 'refused', code: 'access_denied' });
        expect(await db.machineKeyEnvelope.count({ where: { machineId: guest.id, recipientAccountId: custodian.id } })).toBe(0);
    });

    it('propagates only seeded Manage through nested controllers and never manufactures it in a cycle', async () => {
        const { custodian, stranger, controller, create } = await createCreatorFixture();
        const createMachine = () => db.machine.create({ data: { id: randomUUID(), accountId: custodian.id,
            installationId: randomUUID(), metadata: encodePlainMachineStoredContent({ host: 'nested', platform: 'linux' }),
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER) } });
        await db.machine.update({ where: { id: controller.id }, data: {
            metadata: encodePlainMachineStoredContent({ host: 'root', platform: 'linux' }),
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER),
        } });
        const first = await createMachine();
        const second = await createMachine();
        const firstManaged = await create();
        const secondManaged = await create();
        await db.managedMachine.update({ where: { id: firstManaged.id }, data: { enrolledMachineId: first.id } });
        await db.managedMachine.update({ where: { id: secondManaged.id }, data: { enrolledMachineId: second.id,
            controllerMachineId: first.id, controllerInstallationId: first.installationId } });
        const role = (machineId: string) => inTx(tx => resolveEffectiveMachineRoleInTx(tx, { actorAccountId: stranger.id, machineId }));
        const grant = (machineId: string, level: 'view' | 'admin') => inTx(tx => setEligibleMachineAccessGrantInTx(tx,
            { actorAccountId: custodian.id, machineId, principal: { kind: 'account', accountId: stranger.id }, level }));
        expect(await grant(controller.id, 'view')).toMatchObject({ kind: 'saved' });
        expect(await role(first.id)).toBeNull();
        expect(await role(second.id)).toBeNull();
        expect(await grant(controller.id, 'admin')).toMatchObject({ kind: 'saved' });
        expect(await role(second.id)).toBe('manage');
        expect(await inTx(tx => resolveCurrentMachineRecipientAccountIdsInTx(tx, second.id))).toContain(stranger.id);

        await db.managedMachine.update({ where: { id: firstManaged.id }, data: {
            controllerMachineId: second.id, controllerInstallationId: second.installationId,
        } });
        expect(await role(first.id)).toBeNull();
        expect(await role(second.id)).toBeNull();
        expect(await inTx(tx => resolveCurrentMachineRecipientAccountIdsInTx(tx, second.id))).not.toContain(stranger.id);
        expect(await grant(first.id, 'view')).toMatchObject({ kind: 'saved' });
        expect(await role(first.id)).toBe('use');
        expect(await role(second.id)).toBeNull();
        expect(await grant(first.id, 'admin')).toMatchObject({ kind: 'saved' });
        expect(await role(second.id)).toBe('manage');

        // Team pools consume the Team's grant, never a member's personal Manage.
        const team = await db.team.create({ data: { name: 'Managed guest pool' } });
        const teamRole = async () => (await inTx(tx => resolveMachinePrincipalAccessForMachinesInTx(tx, {
            machineIds: [first.id, second.id], principal: { kind: 'team', teamId: team.id },
        }))).get(second.id);
        expect(await teamRole()).toBeNull();
        await db.machineGrant.create({ data: { principalKind: 'team', machineId: first.id, teamId: team.id,
            createdByAccountId: custodian.id, accessLevel: 'view' } });
        expect(await teamRole()).toBeNull();
        await db.machineGrant.update({ where: { principalKind: 'team', machineId_teamId: { machineId: first.id, teamId: team.id } },
            data: { accessLevel: 'admin' } });
        expect(await teamRole()).toBe('manage');
        await db.team.update({ where: { id: team.id }, data: { archivedAt: new Date() } });
        expect(await teamRole()).toBeNull();
    });
});
