import Fastify from 'fastify';
import { afterAll, beforeAll, expect, it } from 'vitest';
import nacl from 'tweetnacl';
import { decodeBase64, encodeBase64 } from 'privacy-kit';
import { MACHINE_PLAIN_DATA_KEY_MARKER, encodePlainMachineStoredContent,
    computeContentPublicKeyFingerprint, sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions';
import { sealExternalActionRequestV2 } from '@happier-dev/protocol/actions/externalActionEncryption';
import { projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import type { Fastify as AppFastify } from '@/app/api/types';
import { enableAuthentication } from '@/app/api/utils/enableAuthentication';
import { auth } from '@/app/auth/auth';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { setEligibleMachineAccessGrantInTx } from '@/testkit/machineAccessGrant.testkit';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { commitMachineRecipientKeyEnvelopesInTx, readMachineRecipientCensusInTx,
    removeMachineAccessGrantInTx, resolveMachineAdmission } from '@/app/machines/machineAccess';
import { registerExternalActionRoutes } from './registerExternalActionRoutes';

let harness: LightSqliteHarness;
beforeAll(async () => {
    harness = await createLightSqliteHarness({ tempDirPrefix: 'runtime-surface-grantee-', initAuth: true,
        env: { AUTH_REQUIRED_LOGIN_PROVIDERS: '', HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
            HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: 'true' } });
}, 120_000);
afterAll(async () => { await harness?.close(); });

it.each(['plain', 'e2ee'] as const)('issues requester-bound Browser and Computer authorization on a shared %s Machine', async mode => {
    const createAccount = async () => {
        const keys = nacl.box.keyPair();
        const row = await db.account.create({ data: { encryptionMode: mode,
            ...(mode === 'e2ee' ? createSignedAccountContentBinding(keys.publicKey) : {}) } });
        return { ...row, keys };
    };
    const owner = await createAccount();
    const guest = await createAccount();
    const outsider = await createAccount();
    const dataKey = nacl.randomBytes(32);
    const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: owner.id, active: true,
        metadata: mode === 'plain' ? encodePlainMachineStoredContent({ host: 'shared', platform: 'linux',
            happyCliVersion: 'test', homeDir: '/home/shared', happyHomeDir: '/home/shared/.happier' }) : 'encrypted-metadata',
        dataEncryptionKey: mode === 'plain' ? decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64')
            : sealEncryptedDataKeyEnvelopeV1({ dataKey, recipientPublicKey: owner.keys.publicKey, randomBytes: nacl.randomBytes }),
        installationId: crypto.randomUUID(), installationPublicKey: nacl.sign.keyPair().publicKey,
        operationProtocolCapabilitiesRevision: 1,
        operationProtocolCapabilities: { requesterExecutionIsolation: { protocolVersions: [1] } } } });
    const grant = () => inTx(tx => setEligibleMachineAccessGrantInTx(tx, { actorAccountId: owner.id,
        machineId: machine.id, principal: { kind: 'account', accountId: guest.id }, level: 'view' }));
    expect(await grant()).toMatchObject({ kind: 'saved' });
    if (mode === 'e2ee') {
        const census = await inTx(tx => readMachineRecipientCensusInTx(tx, { actorAccountId: owner.id, machineId: machine.id }));
        if ('kind' in census) throw new Error(census.code);
        expect(await inTx(tx => commitMachineRecipientKeyEnvelopesInTx(tx, { actorAccountId: owner.id, machineId: machine.id,
            expectedMachineOwnerEnvelopeFingerprint: census.machineOwnerEnvelopeFingerprint!,
            expectedCallerDataEncryptionKey: census.callerDataEncryptionKey!, expectedMetadataVersion: census.content.metadataVersion,
            expectedDaemonStateVersion: census.content.daemonStateVersion, recipientKeyEnvelopes: [{ recipientAccountId: guest.id,
                encryptedDataKey: encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey, recipientPublicKey: guest.keys.publicKey,
                    randomBytes: nacl.randomBytes })), recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(guest.keys.publicKey) }] })))
            .toMatchObject({ appliedRecipientAccountIds: [guest.id] });
    }
    expect(await resolveMachineAdmission({ actorAccountId: guest.id, machineId: machine.id }))
        .toMatchObject({ kind: 'admitted', role: 'use' });
    const session = await db.session.create({ data: { tag: crypto.randomUUID(), accountId: guest.id, metadata: 'own-session' } });
    const ownerSession = await db.session.create({ data: { tag: crypto.randomUUID(), accountId: owner.id,
        metadata: 'owner-session', encryptionMode: mode, seq: 4 } });
    const app = Fastify({ logger: false }) as unknown as AppFastify;
    enableAuthentication(app);
    registerExternalActionRoutes(app);
    const tokens = new Map(await Promise.all([owner, guest, outsider].map(async account => [account.id,
        await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' })] as const)));
    const homeId = await getOrCreateServerIdentityId();
    const issue = (accountId: string, actionId = 'browser.view.open', browserSessionId = session.id) => {
        const requestId = crypto.randomUUID();
        const target = { kind: 'machine' as const, machineId: machine.id };
        const input = { kind: 'openView', commandId: crypto.randomUUID(), browserSessionId,
            viewId: 'guest-view', platform: 'web', target: { kind: 'externalUrl', targetId: 'guest-view', url: 'https://example.com/' } };
        const envelope = mode === 'plain' ? { v: 1 as const, requestId, target, input }
            : sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1,
                material: { type: 'dataKey', machineKey: dataKey }, randomBytes: nacl.randomBytes, input,
                binding: { serverIdentityId: homeId, accountId, actionId, requestId, target,
                    authentication: { kind: 'account', tokenEpoch: guest.tokenEpoch } } });
        return app.inject({ method: 'POST', url: `/v1/actions/${actionId}/execution-authorization`,
            headers: { authorization: `Bearer ${tokens.get(accountId)}` }, payload: { v: 1, machineId: machine.id, envelope } });
    };
    try {
        for (const actionId of ['browser.view.open', 'browser.automation.snapshot', 'browser.recording.start',
            'computer.targets.list', 'machines.services.list']) {
            const response = await issue(guest.id, actionId);
            expect(response.statusCode, `${actionId}: ${response.body}`).toBe(200);
            expect(ExternalActionExecutionAuthorizationV1Schema.parse(response.json()).binding)
                .toMatchObject({ accountId: guest.id, machineId: machine.id, installationId: machine.installationId,
                    admittedMachineRole: 'use', actionId });
        }
        expect((await issue(owner.id)).statusCode).toBe(200);
        expect((await issue(outsider.id)).statusCode).toBe(409);
        for (const actionId of ['browser.view.open', 'browser.automation.snapshot', 'browser.recording.start']) {
            expect((await issue(guest.id, actionId, ownerSession.id)).statusCode,
                `unshared owner Session: ${actionId}`).toBe(409);
        }
        const share = await db.sessionShare.create({ data: { sessionId: ownerSession.id,
            sharedByUserId: owner.id, sharedWithUserId: guest.id, accessLevel: 'view' } });
        expect((await issue(guest.id, 'browser.view.open', ownerSession.id)).statusCode).toBe(200);
        await db.sessionShare.delete({ where: { id: share.id } });
        expect((await issue(guest.id, 'browser.view.open', ownerSession.id)).statusCode).toBe(409);
        expect((await issue(guest.id)).statusCode).toBe(200);
        for (const actionId of ['browser.extensions.install', 'browser.profile.logins.import', 'browser.sandbox.install']) {
            expect((await issue(guest.id, actionId)).statusCode, actionId).toBe(409);
            expect((await issue(owner.id, actionId)).statusCode, actionId).toBe(200);
        }
        await db.machine.update({ where: { id: machine.id }, data: { operationProtocolCapabilities: {} } });
        expect((await issue(guest.id, 'computer.targets.list')).statusCode).toBe(409);
        await inTx(tx => removeMachineAccessGrantInTx(tx, { actorAccountId: owner.id, machineId: machine.id,
            principal: { kind: 'account', accountId: guest.id } }));
        expect((await issue(guest.id)).statusCode).toBe(409);
    } finally { await app.close(); }
});
