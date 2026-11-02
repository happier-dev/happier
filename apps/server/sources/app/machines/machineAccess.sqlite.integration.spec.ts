import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Socket } from 'socket.io';
import tweetnacl from 'tweetnacl';
import { encodeBase64 } from 'privacy-kit';
import { MACHINE_PLAIN_DATA_KEY_MARKER, computeContentPublicKeyFingerprint, sealEncryptedDataKeyEnvelopeV1, encodePlainMachineStoredContent } from '@happier-dev/protocol';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { observePrismaReads } from '@/testkit/observePrismaReads';
import * as access from './machineAccess';
import { ACTION_OPERATION_RPC_METHODS_V1, ACTION_OPERATION_RPC_METHODS_V2 } from '@happier-dev/protocol/actions/operations/v1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { rpcHandler } from '@/app/api/socket/rpcHandler';
import { createAuthenticatedFakeSocket, createSocketRoomDiscoveryHarness, getSocketHandler } from '@/app/api/testkit/socketHarness';
import { evaluateAccountStoredContentCompatibility } from '@/app/clientCompatibility/accountStoredContentCompatibility';
import { CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION } from '@happier-dev/protocol/clientCompatibility/accountStoredContentCompatibilityV1';

describe('Machine current access (real SQLite)', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-machine-access-', initAuth: false }); }, 180_000);
    afterAll(async () => { if (harness) await harness.close(); });
    async function account(mode: 'plain' | 'e2ee' = 'plain') {
        const keys = tweetnacl.box.keyPair();
        const row = await db.account.create({ data: { encryptionMode: mode, ...(mode === 'e2ee' ? createSignedAccountContentBinding(keys.publicKey) : {}) } });
        return { ...row, keys };
    }
    async function fixture(mode: 'plain' | 'e2ee' = 'plain') {
        const owner = await account(mode);
        const key = tweetnacl.randomBytes(32);
        const envelope = mode === 'plain' ? null : new Uint8Array(sealEncryptedDataKeyEnvelopeV1({ dataKey: key, recipientPublicKey: owner.keys.publicKey, randomBytes: tweetnacl.randomBytes }));
        const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: owner.id,
            metadata: mode === 'plain' ? encodePlainMachineStoredContent({ host: 'host', platform: 'linux', happyCliVersion: 'test', homeDir: '/home/test', happyHomeDir: '/home/test/.happier' }) : 'metadata',
            daemonState: mode === 'plain' ? encodePlainMachineStoredContent({ status: 'running' }) : 'state', installationId: 'install', active: false,
            dataEncryptionKey: mode === 'plain' ? new Uint8Array(Buffer.from(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64')) : envelope } });
        return { owner, machine, key };
    }
    const grant = (actorAccountId: string, machineId: string, accountId: string, level: 'view' | 'admin' = 'view') => inTx(tx => access.setMachineAccessGrantInTx(tx, { actorAccountId, machineId, principal: { kind: 'account', accountId }, level }));

    it('admits host Computer controls only for the custodian and Manage grantees', async () => {
        const f = await fixture();
        const viewer = await account();
        const manager = await account();
        await grant(f.owner.id, f.machine.id, viewer.id, 'view');
        await grant(f.owner.id, f.machine.id, manager.id, 'admin');
        for (const rpcMethod of [RPC_METHODS.DAEMON_COMPUTER_ACTION_EXECUTE]) {
            expect(await access.resolveMachineAdmission({ actorAccountId: viewer.id, machineId: f.machine.id, rpcMethod }))
                .toEqual({ kind: 'denied', code: 'access_denied' });
            expect(await access.resolveMachineAdmission({ actorAccountId: manager.id, machineId: f.machine.id, rpcMethod }))
                .toMatchObject({ kind: 'admitted', role: 'manage', custodianAccountId: f.owner.id });
            expect(await access.resolveMachineAdmission({ actorAccountId: f.owner.id, machineId: f.machine.id, rpcMethod }))
                .toMatchObject({ kind: 'admitted', role: 'manage' });
        }
    });

    it('admits reachability inspect (native firewall CHECK) only for the custodian and Manage grantees', async () => {
        const f = await fixture();
        const user = await account();
        const manager = await account();
        await grant(f.owner.id, f.machine.id, user.id, 'view');
        await grant(f.owner.id, f.machine.id, manager.id, 'admin');
        for (const request of [{ rpcMethod: RPC_METHODS.MACHINES_REACHABILITY_INSPECT }, { actionId: 'machines.reachability.inspect' }]) {
            expect(await access.resolveMachineAdmission({ actorAccountId: user.id, machineId: f.machine.id, ...request }))
                .toEqual({ kind: 'denied', code: 'access_denied' });
            expect(await access.resolveMachineAdmission({ actorAccountId: manager.id, machineId: f.machine.id, ...request }))
                .toMatchObject({ kind: 'admitted', role: 'manage', custodianAccountId: f.owner.id });
            expect(await access.resolveMachineAdmission({ actorAccountId: f.owner.id, machineId: f.machine.id, ...request }))
                .toMatchObject({ kind: 'admitted', role: 'manage' });
        }
    });

    it('keeps owned and foreign admission decisions in one mixed batch, including refusals', async () => {
        const owned = await fixture();
        const shared = await fixture();
        const hidden = await fixture();
        await grant(shared.owner.id, shared.machine.id, owned.owner.id);
        const revoked = await db.machine.create({ data: { ...owned.machine, id: crypto.randomUUID(), revokedAt: new Date() } });
        const missingId = crypto.randomUUID();
        const read = () => inTx(tx => access.resolveMachineAdmissionsInTx(tx, { actorAccountId: owned.owner.id,
            machineIds: [owned.machine.id, shared.machine.id, hidden.machine.id, revoked.id, missingId] }));
        const admitted = await read();
        expect(admitted.get(owned.machine.id)).toMatchObject({ kind: 'admitted', role: 'manage', custodianAccountId: owned.owner.id });
        expect(admitted.get(shared.machine.id)).toMatchObject({ kind: 'admitted', role: 'use', custodianAccountId: shared.owner.id });
        expect(admitted.get(hidden.machine.id)).toEqual({ kind: 'denied', code: 'access_denied' });
        expect(admitted.get(revoked.id)).toEqual({ kind: 'denied', code: 'machine_unavailable' });
        expect(admitted.get(missingId)).toEqual({ kind: 'denied', code: 'access_denied' });
        await inTx(tx => access.removeMachineAccessGrantInTx(tx, { actorAccountId: shared.owner.id,
            machineId: shared.machine.id, principal: { kind: 'account', accountId: owned.owner.id } }));
        await db.account.update({ where: { id: owned.owner.id }, data: { status: 'suspended' } });
        const refused = await read();
        expect(refused.get(owned.machine.id)).toEqual({ kind: 'denied', code: 'access_denied' });
        expect(refused.get(shared.machine.id)).toEqual({ kind: 'denied', code: 'access_denied' });
    });

    it('admits the requester-owned spawn Action for Can use while refusing raw private spawn RPCs', async () => {
        const f = await fixture();
        const requester = await account();
        const outsider = await account();
        await grant(f.owner.id, f.machine.id, requester.id);
        const actor = { actorAccountId: requester.id, machineId: f.machine.id };
        for (const actionId of ['session.spawn_new', 'session.open']) {
            expect(await access.resolveMachineAdmission({ ...actor, actionId })).toMatchObject({
                kind: 'admitted', actorAccountId: requester.id, custodianAccountId: f.owner.id, role: 'use',
            });
        }
        for (const rpcMethod of [RPC_METHODS.SPAWN_HAPPY_SESSION, RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE, RPC_METHODS.SESSION_SPAWN_NEW]) {
            expect(await access.resolveMachineAdmission({ ...actor, rpcMethod }))
                .toEqual({ kind: 'denied', code: 'unsupported_operation' });
            expect(await access.resolveMachineAdmission({ ...actor, actionId: 'session.spawn_new', rpcMethod }))
                .toEqual({ kind: 'denied', code: 'unsupported_operation' });
        }
        expect(await access.resolveMachineAdmission({ actorAccountId: outsider.id, machineId: f.machine.id, actionId: 'session.spawn_new' }))
            .toEqual({ kind: 'denied', code: 'access_denied' });
        await inTx(tx => access.removeMachineAccessGrantInTx(tx, { actorAccountId: f.owner.id, machineId: f.machine.id,
            principal: { kind: 'account', accountId: requester.id } }));
        expect(await access.resolveMachineAdmission({ ...actor, actionId: 'session.spawn_new' }))
            .toEqual({ kind: 'denied', code: 'access_denied' });
    });

    it('admits Provider reads through their actual RPC policy without lending private mutation authority', async () => {
        const f = await fixture();
        const requester = await account();
        await grant(f.owner.id, f.machine.id, requester.id);
        const actor = { actorAccountId: requester.id, machineId: f.machine.id };
        for (const actionId of ['providers.models.projection', 'providers.models.refresh']) {
            expect(await access.resolveMachineAdmission({ ...actor, actionId }), actionId).toMatchObject({
                kind: 'admitted', actorAccountId: requester.id, custodianAccountId: f.owner.id, role: 'use',
            });
        }
        for (const actionId of ['providers.connections.describe', 'providers.connections.start_local', 'providers.connections.secrets.bind']) {
            expect(await access.resolveMachineAdmission({ ...actor, actionId }), actionId)
                .toEqual({ kind: 'denied', code: 'unsupported_operation' });
        }
        await inTx(tx => access.removeMachineAccessGrantInTx(tx, { actorAccountId: f.owner.id, machineId: f.machine.id,
            principal: { kind: 'account', accountId: requester.id } }));
        expect(await access.resolveMachineAdmission({ ...actor, actionId: 'providers.models.projection' }))
            .toEqual({ kind: 'denied', code: 'access_denied' });
    });

    it('excludes revoked owned Machines from discovery while retaining explicit historical candidates', async () => {
        const f = await fixture();
        const offline = await db.machine.create({ data: { ...f.machine, id: crypto.randomUUID() } });
        await db.machine.update({ where: { id: f.machine.id }, data: { revokedAt: new Date(), active: false } });
        expect(await inTx(tx => access.listMachineCandidatesInTx(tx, f.owner.id))).toEqual([offline.id]);
        expect(await inTx(tx => access.listMachineCandidatesInTx(tx, f.owner.id, { includeRevokedOwned: true })))
            .toEqual([f.machine.id, offline.id].sort());
    });

    it.each([
        ['providers.legacy.prepare', RPC_METHODS.DAEMON_PROVIDERS_PROFILE_MIGRATION_PREPARE_SOURCE],
        ['providers.models.list', RPC_METHODS.DAEMON_PROVIDERS_MODELS],
        ['providers.probe', RPC_METHODS.DAEMON_PROVIDERS_PROBE],
        ['providers.binding.status', RPC_METHODS.DAEMON_PROVIDERS_BINDING_STATUS],
        ['providers.models.load', RPC_METHODS.DAEMON_PROVIDERS_MODEL_LOAD],
        ['providers.models.experimental.confirm', RPC_METHODS.DAEMON_PROVIDERS_MODEL_SETTINGS_MUTATE],
    ])('keeps private Provider %s with its custodian for both Use and Manage grants', async (actionId, rpcMethod) => {
        const f = await fixture();
        const requester = await account();
        for (const level of ['admin', 'view'] as const) {
            await grant(f.owner.id, f.machine.id, requester.id, level);
            const actor = { actorAccountId: requester.id, machineId: f.machine.id };
            expect(await access.resolveMachineAdmission({ ...actor, actionId }))
                .toEqual({ kind: 'denied', code: 'unsupported_operation' });
            expect(await access.resolveMachineAdmission({ ...actor, rpcMethod }))
                .toEqual({ kind: 'denied', code: 'unsupported_operation' });
        }
        const owner = { actorAccountId: f.owner.id, machineId: f.machine.id };
        expect(await access.resolveMachineAdmission({ ...owner, actionId }))
            .toMatchObject({ kind: 'admitted', role: 'manage' });
        expect(await access.resolveMachineAdmission({ ...owner, rpcMethod }))
            .toMatchObject({ kind: 'admitted', role: 'manage' });
    });

    it.each([
        RPC_METHODS.DAEMON_PROVIDERS_TEAM_CREDENTIAL_REQUEST_POLICY_SUPPORT,
        RPC_METHODS.DAEMON_PROVIDERS_TEAM_CREDENTIAL_RESOURCE_TEST_CANDIDATE,
        RPC_METHODS.DAEMON_PROVIDERS_TEAM_CREDENTIAL_BROKER_ELIGIBILITY,
        RPC_METHODS.DAEMON_CONNECTED_SERVICE_QUOTA_RECOVERY_CREDIT_CONSUME,
    ])('refuses raw private Provider and connected-service operations to Use and Manage grantees: %s', async rpcMethod => {
        const f = await fixture();
        const requester = await account();
        await db.machine.update({ where: { id: f.machine.id }, data: { active: true } });
        const accountStoredContentCompatibility = evaluateAccountStoredContentCompatibility({ status: 'valid',
            declaration: CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION });
        const emitWithAck = vi.fn(async () => ({ status: 'source-result' }));
        const target = { id: 'source-daemon',
            data: { clientType: 'machine-scoped', machineId: f.machine.id, verifiedMachineInstallationId: 'install', accountStoredContentCompatibility },
            timeout: () => ({ emitWithAck }) };
        const io = createSocketRoomDiscoveryHarness(async room => room === `rpc:${f.owner.id}:${f.machine.id}:${rpcMethod}` || room === target.id ? [target] : []);
        const call = async (actorAccountId: string) => {
            const socket = createAuthenticatedFakeSocket({ data: { accountStoredContentCompatibility } });
            rpcHandler(actorAccountId, socket as unknown as Socket, { io });
            const reply = vi.fn();
            await getSocketHandler(socket, SOCKET_RPC_EVENTS.CALL)({ method: `${f.machine.id}:${rpcMethod}`, params: {} }, reply);
            return reply;
        };
        for (const level of ['view', 'admin'] as const) {
            await grant(f.owner.id, f.machine.id, requester.id, level);
            expect(await call(requester.id)).toHaveBeenCalledWith(expect.objectContaining({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN }));
            expect(emitWithAck).not.toHaveBeenCalled();
            expect(await access.resolveMachineAdmission({ actorAccountId: requester.id, machineId: f.machine.id, rpcMethod }))
                .toEqual({ kind: 'denied', code: 'unsupported_operation' });
        }
        expect(await access.resolveMachineAdmission({ actorAccountId: f.owner.id, machineId: f.machine.id, rpcMethod }))
            .toMatchObject({ kind: 'admitted', role: 'manage', custodianAccountId: f.owner.id });
        expect(await call(f.owner.id)).toHaveBeenCalledWith({ ok: true, result: { status: 'source-result' } });
    });

    it('refuses native cookie reads to Use before daemon delivery and admits Manage', async () => {
        const f = await fixture();
        const requester = await account();
        await grant(f.owner.id, f.machine.id, requester.id);
        await db.machine.update({ where: { id: f.machine.id }, data: { active: true } });
        const accountStoredContentCompatibility = evaluateAccountStoredContentCompatibility({ status: 'valid',
            declaration: CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION });
        const emitWithAck = vi.fn(async () => ({ status: 'source-result' }));
        const rpcMethod = RPC_METHODS.DAEMON_BROWSER_PROFILE_COOKIE_SOURCE_READ;
        const target = { id: 'cookie-source-daemon',
            data: { clientType: 'machine-scoped', machineId: f.machine.id, verifiedMachineInstallationId: 'install', accountStoredContentCompatibility },
            timeout: () => ({ emitWithAck }) };
        const io = createSocketRoomDiscoveryHarness(async room => room === `rpc:${f.owner.id}:${f.machine.id}:${rpcMethod}` || room === target.id ? [target] : []);
        const call = async () => {
            const socket = createAuthenticatedFakeSocket({ data: { accountStoredContentCompatibility } });
            rpcHandler(requester.id, socket as unknown as Socket, { io });
            const reply = vi.fn();
            await getSocketHandler(socket, SOCKET_RPC_EVENTS.CALL)({ method: `${f.machine.id}:${rpcMethod}`, params: {} }, reply);
            return reply;
        };
        expect(await call()).toHaveBeenCalledWith(expect.objectContaining({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN }));
        expect(emitWithAck).not.toHaveBeenCalled();
        await grant(f.owner.id, f.machine.id, requester.id, 'admin');
        expect(await call()).toHaveBeenCalledWith({ ok: true, result: { status: 'source-result' } });
        expect(emitWithAck).toHaveBeenCalledOnce();
    });

    it('admits requester-scoped operation reads and cancellation for current Machine Use and Manage', async () => {
        const f = await fixture();
        const requester = await account();
        const outsider = await account();
        const actor = { actorAccountId: requester.id, machineId: f.machine.id };
        for (const level of ['view', 'admin'] as const) {
            await grant(f.owner.id, f.machine.id, requester.id, level);
            for (const methods of [ACTION_OPERATION_RPC_METHODS_V1, ACTION_OPERATION_RPC_METHODS_V2]) {
                for (const rpcMethod of [methods.list, methods.get]) {
                    const admission = await access.resolveMachineAdmission({ ...actor, rpcMethod });
                    expect(admission, `${rpcMethod}: ${JSON.stringify(admission)}`).toMatchObject({
                        kind: 'admitted', actorAccountId: requester.id, custodianAccountId: f.owner.id,
                        machineId: f.machine.id, installationId: 'install', role: level === 'view' ? 'use' : 'manage',
                    });
                    expect(await access.resolveMachineAdmission({ actorAccountId: outsider.id, machineId: f.machine.id, rpcMethod }))
                        .toEqual({ kind: 'denied', code: 'access_denied' });
                }
            }
            expect(await access.resolveMachineAdmission({ ...actor, rpcMethod: ACTION_OPERATION_RPC_METHODS_V1.cancel }))
                .toMatchObject({ kind: 'admitted', actorAccountId: requester.id, custodianAccountId: f.owner.id });
        }
        await inTx(tx => access.removeMachineAccessGrantInTx(tx, { actorAccountId: f.owner.id, machineId: f.machine.id,
            principal: { kind: 'account', accountId: requester.id } }));
        expect(await access.resolveMachineAdmission({ ...actor, rpcMethod: ACTION_OPERATION_RPC_METHODS_V2.get }))
            .toEqual({ kind: 'denied', code: 'access_denied' });
        expect(await access.resolveMachineAdmission({ ...actor, rpcMethod: ACTION_OPERATION_RPC_METHODS_V1.cancel }))
            .toEqual({ kind: 'denied', code: 'access_denied' });
    });

    it('projects safe current requester labels only to the custodian and current Manage holders', async () => {
        const f = await fixture();
        const requester = await account();
        const manager = await account();
        const member = await account();
        const outsider = await account();
        await db.account.update({ where: { id: requester.id }, data: { name: 'Bob Requester', firstName: 'Bob', lastName: 'Requester', username: 'bob', settings: 'private-settings' } });
        await db.account.update({ where: { id: manager.id }, data: { username: 'current-manager' } });
        await db.account.update({ where: { id: member.id }, data: { name: 'Team Requester', firstName: 'Team', lastName: 'Requester' } });
        await db.account.update({ where: { id: outsider.id }, data: { name: 'Never Admitted', firstName: 'Never', lastName: 'Admitted' } });
        await db.session.create({ data: { accountId: requester.id, tag: crypto.randomUUID(), metadata: 'private-requester-session' } });
        await grant(f.owner.id, f.machine.id, requester.id);
        await grant(f.owner.id, f.machine.id, manager.id, 'admin');
        const team = await db.team.create({ data: { name: 'Current requester Team' } });
        await inTx(tx => access.setMachineAccessGrantInTx(tx, { actorAccountId: f.owner.id, machineId: f.machine.id,
            principal: { kind: 'team', teamId: team.id }, level: 'view' }));
        const membership = await db.teamMembership.create({ data: { teamId: team.id, accountId: member.id, role: 'member' } });
        const list = (actorAccountId: string) => inTx(tx => access.listMachineAccessGrantsInTx(tx, { actorAccountId, machineId: f.machine.id }));
        const ownerList = await list(f.owner.id);
        expect(ownerList).toMatchObject({ canManage: true, currentRequesterDisplayIdentities: expect.arrayContaining([
            { accountId: requester.id, displayName: 'Bob Requester' },
            { accountId: manager.id, displayName: 'current-manager' },
            { accountId: member.id, displayName: 'Team Requester' },
        ]) });
        if ('kind' in ownerList) throw new Error(ownerList.code);
        expect(ownerList.currentRequesterDisplayIdentities?.map(identity => identity.accountId).sort())
            .toEqual([f.owner.id, requester.id, manager.id, member.id].sort());
        for (const identity of ownerList.currentRequesterDisplayIdentities ?? []) {
            expect(Object.keys(identity).sort()).toEqual(['accountId', 'displayName']);
        }
        expect(await list(manager.id)).toMatchObject({ currentRequesterDisplayIdentities: ownerList.currentRequesterDisplayIdentities });
        expect(await list(requester.id)).not.toHaveProperty('currentRequesterDisplayIdentities');
        await db.teamMembership.delete({ where: { id: membership.id } });
        await db.account.update({ where: { id: requester.id }, data: { status: 'suspended' } });
        const current = await list(f.owner.id);
        if ('kind' in current) throw new Error(current.code);
        expect(current.currentRequesterDisplayIdentities?.map(identity => identity.accountId).sort()).toEqual([f.owner.id, manager.id].sort());
        expect(await list(outsider.id)).toEqual({ kind: 'refused', code: 'access_denied' });
    });

    it('uses persisted custodian mode and refuses contradictory or malformed material before disclosure or admission', async () => {
        const f = await fixture();
        await db.account.update({ where: { id: f.owner.id }, data: { ...createSignedAccountContentBinding(f.owner.keys.publicKey), encryptionMode: 'e2ee' } });
        const actor = { actorAccountId: f.owner.id, machineId: f.machine.id };
        expect(await inTx(tx => access.readAccessibleMachineAccessInTx(tx, actor))).toMatchObject({ resourceMode: 'e2ee', accessState: 'refused' });
        expect(await inTx(tx => access.readMachineDataKeyForCallerInTx(tx, actor))).toBeNull();
        expect(await access.resolveMachineAdmission(actor)).toEqual({ kind: 'denied', code: 'encryption_material_unavailable' });
        await db.machine.update({ where: { id: f.machine.id }, data: { metadata: 'opaque', daemonState: null, dataEncryptionKey: new Uint8Array([0, 1, 2]) } });
        expect(await access.resolveMachineAdmission(actor)).toEqual({ kind: 'denied', code: 'encryption_material_unavailable' });
        expect(await inTx(tx => access.readMachineDataKeyForCallerInTx(tx, actor))).toBeNull();
        const recipient = await account('e2ee');
        expect(await grant(f.owner.id, f.machine.id, recipient.id)).toEqual({ kind: 'refused', code: 'access_denied' });
        expect(await db.machineAccountGrant.count({ where: { machineId: f.machine.id } })).toBe(0);
    });

    it.each(['plain', 'e2ee'] as const)('Plain Machine admits %s recipients keylessly and Manage can administer offline', async mode => {
        const f = await fixture(); const recipient = await account(mode);
        expect(await grant(f.owner.id, f.machine.id, recipient.id)).toMatchObject({ kind: 'saved', readiness: 'ready' });
        expect(await inTx(tx => access.resolveEffectiveMachineRoleInTx(tx, { actorAccountId: recipient.id, machineId: f.machine.id }))).toBe('use');
        expect(await db.machineKeyEnvelope.count({ where: { machineId: f.machine.id } })).toBe(0);
        expect(await access.resolveMachineAdmission({ actorAccountId: recipient.id, machineId: f.machine.id, requiredRole: 'manage' })).toEqual({ kind: 'denied', code: 'access_denied' });
        await grant(f.owner.id, f.machine.id, recipient.id, 'admin');
        expect(await access.resolveMachineAdmission({ actorAccountId: recipient.id, machineId: f.machine.id, requiredRole: 'manage' })).toMatchObject({ kind: 'admitted', actorAccountId: recipient.id, custodianAccountId: f.owner.id, installationId: 'install', role: 'manage', encryptionMode: 'plain' });
        expect(await grant(recipient.id, f.machine.id, f.owner.id, 'admin')).toEqual({ kind: 'refused', code: 'custodian_protected' });
        expect(await access.resolveMachineAdmission({ actorAccountId: recipient.id, machineId: f.machine.id, actionId: 'unknown.qualified.action' })).toEqual({ kind: 'denied', code: 'unsupported_operation' });
        expect(await access.resolveMachineAdmission({ actorAccountId: f.owner.id, machineId: f.machine.id, actionId: 'unknown.qualified.action' })).toMatchObject({ kind: 'admitted' });
    });

    it('keeps unsafe retained Plain content pending until actual custodian publication, without fabricating keys', async () => {
        const f = await fixture(); const recipient = await account();
        await db.machine.update({ where: { id: f.machine.id }, data: { daemonState: encodePlainMachineStoredContent({ status: 'running', workspaceSync: { relationships: [{ relationshipId: 'private', alphaPath: '/private' }] } }) } });
        expect(await grant(f.owner.id, f.machine.id, recipient.id)).toMatchObject({ kind: 'saved', readiness: 'key_pending' });
        expect(await access.resolveMachineAdmission({ actorAccountId: recipient.id, machineId: f.machine.id })).toEqual({ kind: 'denied', code: 'recipient_key_pending' });
        expect(await inTx(tx => access.readMachineRecipientCensusInTx(tx, { actorAccountId: f.owner.id, machineId: f.machine.id }))).toEqual({ kind: 'refused', code: 'encryption_material_unavailable' });
        await db.machine.update({ where: { id: f.machine.id }, data: { daemonState: encodePlainMachineStoredContent({ status: 'running' }), daemonStateVersion: { increment: 1 } } });
        expect(await access.resolveMachineAdmission({ actorAccountId: recipient.id, machineId: f.machine.id })).toMatchObject({ kind: 'admitted', encryptionMode: 'plain' });
        expect(await db.machineKeyEnvelope.count({ where: { machineId: f.machine.id } })).toBe(0);
    });

    it('current Team/group union follows late join, departure/rejoin and independent direct overlap without Session horizons', async () => {
        const f = await fixture(); const recipient = await account();
        const team = await db.team.create({ data: { name: 'Team' } });
        const group = await db.teamGroup.create({ data: { teamId: team.id, name: 'Group', nameKey: crypto.randomUUID() } });
        await inTx(tx => access.setMachineAccessGrantInTx(tx, { actorAccountId: f.owner.id, machineId: f.machine.id, principal: { kind: 'team', teamId: team.id }, level: 'view' }));
        expect(await inTx(tx => access.resolveEffectiveMachineRoleInTx(tx, { actorAccountId: recipient.id, machineId: f.machine.id }))).toBeNull();
        const member = await db.teamMembership.create({ data: { teamId: team.id, accountId: recipient.id, role: 'member', sessionAccessStartsAt: new Date('2099-01-01') } });
        expect(await inTx(tx => access.resolveEffectiveMachineRoleInTx(tx, { actorAccountId: recipient.id, machineId: f.machine.id }))).toBe('use');
        await db.teamGroupMembership.create({ data: { teamId: team.id, teamGroupId: group.id, teamMembershipId: member.id, nativeContribution: true } });
        await inTx(tx => access.setMachineAccessGrantInTx(tx, { actorAccountId: f.owner.id, machineId: f.machine.id, principal: { kind: 'group', teamId: team.id, groupId: group.id }, level: 'admin' }));
        expect(await inTx(tx => access.resolveEffectiveMachineRoleInTx(tx, { actorAccountId: recipient.id, machineId: f.machine.id }))).toBe('manage');
        await grant(f.owner.id, f.machine.id, recipient.id);
        await grant(f.owner.id, f.machine.id, recipient.id);
        expect(await db.machineAccountGrant.count({ where: { machineId: f.machine.id, accountId: recipient.id } })).toBe(1);
        await db.teamMembership.delete({ where: { id: member.id } });
        expect(await inTx(tx => access.resolveEffectiveMachineRoleInTx(tx, { actorAccountId: recipient.id, machineId: f.machine.id }))).toBe('use');
        await db.teamMembership.create({ data: { teamId: team.id, accountId: recipient.id, role: 'member' } });
        expect(await inTx(tx => access.removeMachineAccessGrantInTx(tx, { actorAccountId: recipient.id, machineId: f.machine.id, principal: { kind: 'account', accountId: recipient.id }, leave: true }))).toEqual({ kind: 'inherited_access_remains', role: 'use' });
        expect(await inTx(tx => access.removeMachineAccessGrantInTx(tx, { actorAccountId: recipient.id, machineId: f.machine.id, principal: { kind: 'account', accountId: recipient.id }, leave: true }))).toEqual({ kind: 'inherited_access_remains', role: 'use' });
        await db.team.update({ where: { id: team.id }, data: { archivedAt: new Date() } });
        expect(await inTx(tx => access.resolveEffectiveMachineRoleInTx(tx, { actorAccountId: recipient.id, machineId: f.machine.id }))).toBeNull();
    });

    it('E2EE refuses Plain, derives pending until current tuple and rejects stale holder, owner and recipient bindings atomically', async () => {
        const f = await fixture('e2ee'); const plain = await account(); const recipient = await account('e2ee');
        expect(await grant(f.owner.id, f.machine.id, plain.id)).toEqual({ kind: 'refused', code: 'recipient_encryption_incompatible' });
        expect(await db.machineAccountGrant.count({ where: { machineId: f.machine.id, accountId: plain.id } })).toBe(0);
        expect(await grant(f.owner.id, f.machine.id, recipient.id, 'admin')).toMatchObject({ kind: 'saved', readiness: 'key_pending' });
        expect(await access.resolveMachineAdmission({ actorAccountId: recipient.id, machineId: f.machine.id })).toEqual({ kind: 'denied', code: 'recipient_key_pending' });
        const third = await account('e2ee');
        expect(await grant(recipient.id, f.machine.id, third.id, 'admin')).toMatchObject({ kind: 'saved', readiness: 'key_pending' });
        expect(await inTx(tx => access.readMachineRecipientCensusInTx(tx, { actorAccountId: recipient.id, machineId: f.machine.id }))).toEqual({ kind: 'refused', code: 'access_denied' });
        expect(await inTx(tx => access.removeMachineAccessGrantInTx(tx, { actorAccountId: recipient.id, machineId: f.machine.id, principal: { kind: 'account', accountId: third.id } }))).toEqual({ kind: 'removed', effectiveAccess: 'none' });
        expect(await grant(recipient.id, f.machine.id, f.owner.id, 'admin')).toEqual({ kind: 'refused', code: 'custodian_protected' });
        const census = await inTx(tx => access.readMachineRecipientCensusInTx(tx, { actorAccountId: f.owner.id, machineId: f.machine.id }));
        if ('kind' in census) throw new Error(census.code);
        const input = { actorAccountId: f.owner.id, machineId: f.machine.id, expectedMachineOwnerEnvelopeFingerprint: census.machineOwnerEnvelopeFingerprint!,
            expectedCallerDataEncryptionKey: census.callerDataEncryptionKey!, expectedMetadataVersion: census.content.metadataVersion, expectedDaemonStateVersion: census.content.daemonStateVersion,
            recipientKeyEnvelopes: [{ recipientAccountId: recipient.id, encryptedDataKey: encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey: f.key, recipientPublicKey: recipient.keys.publicKey, randomBytes: tweetnacl.randomBytes })), recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(recipient.keys.publicKey) }] };
        expect(await inTx(tx => access.commitMachineRecipientKeyEnvelopesInTx(tx, input))).toMatchObject({ appliedRecipientAccountIds: [recipient.id] });
        expect(await access.resolveMachineAdmission({ actorAccountId: recipient.id, machineId: f.machine.id })).toMatchObject({ kind: 'admitted', role: 'manage' });
        const foreignCensus = await inTx(tx => access.readMachineRecipientCensusInTx(tx, { actorAccountId: recipient.id, machineId: f.machine.id }));
        expect(foreignCensus).not.toHaveProperty('dataEncryptionKey');
        expect(foreignCensus).not.toHaveProperty('machineOwnerDataEncryptionKey');
        if ('kind' in foreignCensus) throw new Error(foreignCensus.code);
        expect(foreignCensus.callerDataEncryptionKey).toBe(input.recipientKeyEnvelopes[0].encryptedDataKey);
        expect(await grant(recipient.id, f.machine.id, third.id, 'admin')).toMatchObject({ kind: 'saved', readiness: 'key_pending' });
        const managerCommit = { ...input, actorAccountId: recipient.id, expectedCallerDataEncryptionKey: foreignCensus.callerDataEncryptionKey!,
            recipientKeyEnvelopes: [{ recipientAccountId: third.id, encryptedDataKey: encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey: f.key, recipientPublicKey: third.keys.publicKey, randomBytes: tweetnacl.randomBytes })), recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(third.keys.publicKey) }] };
        await grant(f.owner.id, f.machine.id, recipient.id, 'view');
        expect(await inTx(tx => access.commitMachineRecipientKeyEnvelopesInTx(tx, managerCommit))).toEqual({ kind: 'refused', code: 'access_denied' });
        expect(await db.machineKeyEnvelope.count({ where: { machineId: f.machine.id, recipientAccountId: third.id } })).toBe(0);
        await grant(f.owner.id, f.machine.id, recipient.id, 'admin');
        expect(await inTx(tx => access.commitMachineRecipientKeyEnvelopesInTx(tx, managerCommit))).toMatchObject({ appliedRecipientAccountIds: [third.id] });
        expect(await access.resolveMachineAdmission({ actorAccountId: third.id, machineId: f.machine.id, requiredRole: 'manage' })).toMatchObject({ kind: 'admitted', role: 'manage', custodianAccountId: f.owner.id });
        expect(await inTx(tx => access.commitMachineRecipientKeyEnvelopesInTx(tx, { ...input, expectedDaemonStateVersion: 99 }))).toEqual({ kind: 'refused', code: 'machine_key_changed' });
        await db.account.update({ where: { id: recipient.id }, data: createSignedAccountContentBinding() });
        expect(await inTx(tx => access.commitMachineRecipientKeyEnvelopesInTx(tx, input))).toEqual({ kind: 'refused', code: 'recipient_binding_changed' });
        expect(await access.resolveMachineAdmission({ actorAccountId: recipient.id, machineId: f.machine.id })).toEqual({ kind: 'denied', code: 'recipient_key_pending' });
        await db.machine.update({ where: { id: f.machine.id }, data: { dataEncryptionKey: new Uint8Array(sealEncryptedDataKeyEnvelopeV1({ dataKey: tweetnacl.randomBytes(32), recipientPublicKey: f.owner.keys.publicKey, randomBytes: tweetnacl.randomBytes })) } });
        expect(await inTx(tx => access.commitMachineRecipientKeyEnvelopesInTx(tx, input))).toEqual({ kind: 'refused', code: 'machine_key_changed' });
    });

    it('set-acquires recipient material while preserving exception paging and all-before-write refusal', async () => {
        const f = await fixture('e2ee');
        const recipients = (await Promise.all(Array.from({ length: 13 }, () => account('e2ee')))).sort((a, b) => a.id.localeCompare(b.id));
        await db.machineAccountGrant.createMany({ data: recipients.map(recipient => ({ machineId: f.machine.id,
            accountId: recipient.id, accessLevel: 'view', createdByAccountId: f.owner.id })) });
        const actor = { actorAccountId: f.owner.id, machineId: f.machine.id };
        const read = (cursor?: string, state: 'all' | 'action_required' = 'action_required') => inTx(async tx => {
            const observed = observePrismaReads(tx, ['account', 'machineKeyEnvelope']);
            const value = await access.readMachineRecipientCensusInTx(observed.tx, { ...actor, query: { limit: 2, state, ...(cursor ? { cursor } : {}) } });
            if ('kind' in value) throw new Error(value.code);
            return { value, reads: observed.reads, rows: observed.rows };
        });
        const first = await read();
        expect(first.value.recipients.map(row => row.recipientAccountId)).toEqual(recipients.slice(0, 2).map(row => row.id));
        const pages = [first];
        while (pages[pages.length - 1].value.nextCursor) pages.push(await read(pages[pages.length - 1].value.nextCursor!));
        expect(pages.flatMap(page => page.value.recipients).map(row => row.recipientAccountId))
            .toEqual(recipients.map(row => row.id));
        const accountIds = (page: typeof first) => page.rows.filter(row => row.model === 'account').flatMap(row => row.ids);
        const envelopeIds = (page: typeof first) => page.rows.filter(row => row.model === 'machineKeyEnvelope').flatMap(row => row.ids);
        const entries = recipients.map(recipient => ({ recipientAccountId: recipient.id,
            encryptedDataKey: encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey: f.key,
                recipientPublicKey: recipient.keys.publicKey, randomBytes: tweetnacl.randomBytes })),
            recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(recipient.keys.publicKey) }));
        const input = { ...actor, expectedMachineOwnerEnvelopeFingerprint: first.value.machineOwnerEnvelopeFingerprint!,
            expectedCallerDataEncryptionKey: first.value.callerDataEncryptionKey!, expectedMetadataVersion: first.value.content.metadataVersion,
            expectedDaemonStateVersion: first.value.content.daemonStateVersion, recipientKeyEnvelopes: entries };
        const committed = await inTx(async tx => {
            const observed = observePrismaReads(tx, ['account']);
            const value = await access.commitMachineRecipientKeyEnvelopesInTx(observed.tx, input);
            return { value, reads: observed.reads };
        });
        expect(committed.value).toEqual({ appliedRecipientAccountIds: recipients.map(row => row.id), skippedRecipientAccountIds: [] });
        const healthy = await read();
        expect(healthy.value).toMatchObject({ recipients: [], nextCursor: null });
        const all = await read(undefined, 'all');
        expect(all.value.recipients.map(row => row.encryptedDataKey)).toEqual(entries.slice(0, 2).map(row => row.encryptedDataKey));
        const sparse = [3, 7, 8, 11].map(index => recipients[index].id);
        await db.machineKeyEnvelope.deleteMany({ where: { machineId: f.machine.id, recipientAccountId: { in: sparse } } });
        const sparseFirst = await read();
        const sparseLast = await read(sparseFirst.value.nextCursor!);
        expect([...sparseFirst.value.recipients, ...sparseLast.value.recipients].map(row => row.recipientAccountId)).toEqual(sparse);
        expect(sparseLast.value.nextCursor).toBeNull();
        await inTx(tx => access.commitMachineRecipientKeyEnvelopesInTx(tx, input));
        const healthyTailExceptions = [0, 1, 11, 12].map(index => recipients[index].id);
        await db.machineKeyEnvelope.deleteMany({ where: { machineId: f.machine.id, recipientAccountId: { in: healthyTailExceptions } } });
        const healthyTail = await read();
        const healthyTailLast = await read(healthyTail.value.nextCursor!);
        expect([...healthyTail.value.recipients, ...healthyTailLast.value.recipients].map(row => row.recipientAccountId)).toEqual(healthyTailExceptions);
        expect(healthyTailLast.value.nextCursor).toBeNull();
        // A later stale binding must prevent even earlier valid entries from being written.
        await db.machineKeyEnvelope.deleteMany({ where: { machineId: f.machine.id } });
        await db.account.update({ where: { id: recipients[4].id }, data: createSignedAccountContentBinding() });
        expect(await inTx(tx => access.commitMachineRecipientKeyEnvelopesInTx(tx, input)))
            .toEqual({ kind: 'refused', code: 'recipient_binding_changed' });
        expect(await db.machineKeyEnvelope.count({ where: { machineId: f.machine.id } })).toBe(0);
        await db.machineAccountGrant.delete({ where: { machineId_accountId: { machineId: f.machine.id, accountId: recipients[4].id } } });
        expect(await inTx(tx => access.commitMachineRecipientKeyEnvelopesInTx(tx, input)))
            .toEqual({ kind: 'refused', code: 'access_denied' });
        expect(await db.machineKeyEnvelope.count({ where: { machineId: f.machine.id } })).toBe(0);
        expect(pages.map(accountIds)).toEqual(Array.from({ length: 7 }, (_, page) => recipients.slice(page * 2, page * 2 + 3).map(row => row.id)));
        expect(accountIds(healthy)).toEqual(recipients.map(row => row.id));
        expect(envelopeIds(healthy)).toEqual(recipients.map(row => row.id));
        expect(accountIds(all)).toEqual(recipients.slice(0, 3).map(row => row.id));
        expect(envelopeIds(all)).toEqual(accountIds(all));
        expect(accountIds(sparseFirst)).toEqual(recipients.slice(0, 9).map(row => row.id));
        expect(accountIds(sparseLast)).toEqual(recipients.slice(8).map(row => row.id));
        expect(accountIds(healthyTail)).toEqual(recipients.slice(0, 12).map(row => row.id));
        expect(healthyTail.reads).toHaveLength(8);
        expect({ first: first.reads.length, healthy: healthy.reads.length, commit: committed.reads.length })
            .toEqual({ first: 2, healthy: 10, commit: 1 });
    });

    it('preserves mixed Team member compatibility and key recoverability while allowing grant level edits', async () => {
        const f = await fixture('e2ee');
        const eligible = await account('e2ee');
        const incompatible = await account('plain');
        const unbound = await db.account.create({ data: { encryptionMode: 'e2ee', name: 'Unbound' } });
        await db.account.update({ where: { id: eligible.id }, data: { name: 'Eligible' } });
        await db.account.update({ where: { id: incompatible.id }, data: { name: 'Plain member' } });
        const team = await db.team.create({ data: { name: 'Mixed Team' } });
        const principal = { kind: 'team' as const, teamId: team.id };
        for (const accountId of [eligible.id, incompatible.id, unbound.id]) {
            await db.teamMembership.create({ data: { teamId: team.id, accountId, role: 'member' } });
        }
        const actor = { actorAccountId: f.owner.id, machineId: f.machine.id };
        expect(await inTx(tx => access.setMachineAccessGrantInTx(tx, { ...actor, principal, level: 'view' })))
            .toMatchObject({ kind: 'saved', readiness: 'refused', canPrepareKeys: true });
        const list = () => inTx(tx => access.listMachineAccessGrantsInTx(tx, actor));
        expect(await list()).toMatchObject({ canManage: true, grants: [{ readiness: 'refused', audience: expect.arrayContaining([
            { accountId: eligible.id, displayName: 'Eligible', readiness: 'key_pending', reason: 'recipient_key_pending', canPrepareKeys: true },
            { accountId: incompatible.id, displayName: 'Plain member', readiness: 'refused', reason: 'recipient_encryption_incompatible', canPrepareKeys: false },
            { accountId: unbound.id, displayName: 'Unbound', readiness: 'key_pending', reason: 'encryption_material_unavailable', canPrepareKeys: false },
        ]) }] });
        const census = await inTx(tx => access.readMachineRecipientCensusInTx(tx, actor));
        if ('kind' in census) throw new Error(census.code);
        await inTx(tx => access.commitMachineRecipientKeyEnvelopesInTx(tx, { ...actor,
            expectedMachineOwnerEnvelopeFingerprint: census.machineOwnerEnvelopeFingerprint!,
            expectedCallerDataEncryptionKey: census.callerDataEncryptionKey!,
            expectedMetadataVersion: census.content.metadataVersion, expectedDaemonStateVersion: census.content.daemonStateVersion,
            recipientKeyEnvelopes: [{ recipientAccountId: eligible.id,
                encryptedDataKey: encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey: f.key, recipientPublicKey: eligible.keys.publicKey, randomBytes: tweetnacl.randomBytes })),
                recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(eligible.keys.publicKey) }],
        }));
        expect(await inTx(tx => access.setMachineAccessGrantInTx(tx, { ...actor, principal, level: 'admin' })))
            .toMatchObject({ kind: 'saved', grant: { level: 'admin' }, canPrepareKeys: false });
        expect(await list()).toMatchObject({ grants: [{ level: 'admin', audience: expect.arrayContaining([
            { accountId: eligible.id, displayName: 'Eligible', readiness: 'ready', reason: null, canPrepareKeys: false },
            { accountId: incompatible.id, displayName: 'Plain member', readiness: 'refused', reason: 'recipient_encryption_incompatible', canPrepareKeys: false },
        ]) }] });
        expect(await access.resolveMachineAdmission({ actorAccountId: eligible.id, machineId: f.machine.id, requiredRole: 'manage' }))
            .toMatchObject({ kind: 'admitted', role: 'manage' });
        expect(await access.resolveMachineAdmission({ actorAccountId: incompatible.id, machineId: f.machine.id }))
            .toEqual({ kind: 'denied', code: 'recipient_encryption_incompatible' });
        const own = await inTx(tx => access.listMachineAccessGrantsInTx(tx, { actorAccountId: unbound.id, machineId: f.machine.id }));
        expect(own).toMatchObject({ canManage: true });
    });
});
