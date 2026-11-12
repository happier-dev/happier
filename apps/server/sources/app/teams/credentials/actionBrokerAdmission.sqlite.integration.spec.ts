import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import nacl from 'tweetnacl';
import { computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { getMachineDaemonPresenceInventory } from '@/app/machines/machineDaemonPresence';
import { readSessionAccessAuthenticationFromRequest } from '@/app/session/access/sessionAccessAuthentication';
import { verifyProviderBrokerActionRouteGrantSignatureV3 } from '@/app/machines/peer/mediation/signProviderBrokerRouteGrantV1';
import { createTeamDirectActionMaterialFixture } from './directActionMaterial.testkit';
import { openTeamCredentialActionBroker, admitTeamCredentialActionBrokerRequest } from './actionBrokerAdmission';

describe('finite Team Action single-use Home admission', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'finite-action-replay-', initAuth: true, initEncrypt: true, env: {
            HAPPIER_FEATURE_TEAMS__ENABLED: '1', HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES__ENABLED: '1',
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional', HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: '1',
        } });
    }, 180_000);
    afterAll(async () => { await harness?.close(); });

    it('consumes a real admitted grant once across concurrent carriers without rechecking withdrawn membership', async () => {
        const shared = await createTeamDirectActionMaterialFixture({ deliveryMode: 'brokered' });
        if (!shared.broker) throw new Error('Missing fixture broker');
        const broker = shared.broker;
        const keys = nacl.sign.keyPair();
        const signingKey = { keyId: 'test-home', secretKey: keys.secretKey };
        // Socket.IO is the genuine network boundary; use the real presence classifier.
        const readCurrentPresence = async () => {
            const presence = async (accountId: string, machineId: string) => await getMachineDaemonPresenceInventory({
                accountId, machineIds: [machineId], io: { in: () => ({ fetchSockets: async () => [
                    { data: { clientType: 'machine-scoped', userId: accountId, machineId } },
                ] }) },
            });
            return { initiatorPresence: await presence(shared.recipient.id, shared.machine.id),
                brokerPresence: await presence(shared.custodian.id, broker.id) };
        };
        const openInput = { actorAccountId: shared.recipient.id, rootActionId: shared.consumer.actionId,
            authentication: readSessionAccessAuthenticationFromRequest({ authAuthority: 'present_user', authTokenAuthenticationEvidence: [] }),
            request: { v: 3 as const, resourceId: shared.resource.id, initiatorMachineId: shared.machine.id,
                consumer: shared.consumer, inputDigest: computeActionInputApprovalDigestV1(shared.consumer.actionId, {}) },
            readCurrentPresence, nowMs: Date.now(), grantId: crypto.randomUUID(), signingKey };
        const opened = await openTeamCredentialActionBroker(openInput);
        expect(opened).toMatchObject({ ok: true });
        if (!opened.ok) throw new Error('Positive admission failed');
        const admitInput = { authenticatedBrokerAccountId: shared.custodian.id,
            request: { v: 3, authority: opened.authority },
            verifyAuthority: (authority: typeof opened.authority) => verifyProviderBrokerActionRouteGrantSignatureV3({ authority,
                signingCapability: { keyId: signingKey.keyId, publicKey: Buffer.from(keys.publicKey).toString('base64url'), expiresAt: null },
                nowMs: Date.now() }) };
        expect(await admitTeamCredentialActionBrokerRequest({ ...admitInput, authenticatedBrokerAccountId: shared.recipient.id }))
            .toEqual({ ok: false, reasonCode: 'resource_forbidden' });
        // Withdrawal takes effect at the next open; the admitted job can still finish.
        await db.teamCredentialResource.update({ where: { id: shared.resource.id }, data: { memberGrants: { deleteMany: {} } } });
        const results = await Promise.all([admitTeamCredentialActionBrokerRequest(admitInput), admitTeamCredentialActionBrokerRequest(admitInput)]);
        expect(results.filter(result => result.ok)).toHaveLength(1);
        expect(results.find(result => !result.ok)).toEqual({ ok: false, reasonCode: 'operation_not_current' });
        expect(await admitTeamCredentialActionBrokerRequest(admitInput)).toEqual({ ok: false, reasonCode: 'operation_not_current' });
        expect(await openTeamCredentialActionBroker({ ...openInput, grantId: crypto.randomUUID() })).toMatchObject({ ok: false });
    });
});
