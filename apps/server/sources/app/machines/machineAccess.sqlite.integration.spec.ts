import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';
import { encodeBase64 } from 'privacy-kit';
import { MACHINE_PLAIN_DATA_KEY_MARKER, computeContentPublicKeyFingerprint, sealEncryptedDataKeyEnvelopeV1, encodePlainMachineStoredContent } from '@happier-dev/protocol';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import * as access from './machineAccess';
import { ACTION_OPERATION_RPC_METHODS_V1, ACTION_OPERATION_RPC_METHODS_V2 } from '@happier-dev/protocol/actions/operations/v1';

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

    it('admits requester-scoped operation reads for current Machine Use and Manage without widening Stop', async () => {
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
                .toEqual({ kind: 'denied', code: 'unsupported_operation' });
        }
        await inTx(tx => access.removeMachineAccessGrantInTx(tx, { actorAccountId: f.owner.id, machineId: f.machine.id,
            principal: { kind: 'account', accountId: requester.id } }));
        expect(await access.resolveMachineAdmission({ ...actor, rpcMethod: ACTION_OPERATION_RPC_METHODS_V2.get }))
            .toEqual({ kind: 'denied', code: 'access_denied' });
    });

    it('projects safe current requester labels only to the custodian and current Manage holders', async () => {
        const f = await fixture();
        const requester = await account();
        const manager = await account();
        const member = await account();
        const outsider = await account();
        await db.account.update({ where: { id: requester.id }, data: { firstName: 'Bob', lastName: 'Requester', username: 'bob', settings: 'private-settings' } });
        await db.account.update({ where: { id: manager.id }, data: { username: 'current-manager' } });
        await db.account.update({ where: { id: member.id }, data: { firstName: 'Team', lastName: 'Requester' } });
        await db.account.update({ where: { id: outsider.id }, data: { firstName: 'Never', lastName: 'Admitted' } });
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

    it('preserves mixed Team member compatibility and key recoverability while allowing grant level edits', async () => {
        const f = await fixture('e2ee');
        const eligible = await account('e2ee');
        const incompatible = await account('plain');
        const unbound = await db.account.create({ data: { encryptionMode: 'e2ee', firstName: 'Unbound' } });
        await db.account.update({ where: { id: eligible.id }, data: { firstName: 'Eligible' } });
        await db.account.update({ where: { id: incompatible.id }, data: { firstName: 'Plain member' } });
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
