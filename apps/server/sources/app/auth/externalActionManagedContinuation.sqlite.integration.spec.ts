import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodeBase64 } from 'privacy-kit';
import tweetnacl from 'tweetnacl';
import { MACHINE_PLAIN_DATA_KEY_MARKER, MachineOperationProtocolCapabilitiesV1Schema, encodePlainMachineStoredContent } from '@happier-dev/protocol';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { setEligibleMachineAccessGrantInTx } from '@/testkit/machineAccessGrant.testkit';
import { resolveMachineAccess } from '@/app/machines/machineAccess';
import { verifyCurrentExternalActionPrincipal } from './externalActionExecutionAuthorization';

describe('managed creation continuation authority', () => {
    const homeId = `srv_${'b'.repeat(32)}`;
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-managed-continuation-', initAuth: true,
            env: { HAPPIER_SERVER_IDENTITY_ID: homeId, AUTH_REQUIRED_LOGIN_PROVIDERS: '',
                AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS: '0', HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
                HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: 'true' } });
    }, 120_000);
    afterAll(async () => { if (harness) await harness.close(); });

    it.each([false, true])('accepts the reviewed Account creator/custodian and refuses a guest Machine manager (controller=%s)', async controllerPresent => {
        const owner = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
        const outsider = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
        const keys = tweetnacl.sign.keyPair();
        const capabilities = MachineOperationProtocolCapabilitiesV1Schema.parse({ externalActionExecutionAuthorization: { protocolVersions: [1] } });
        const guest = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: owner.id,
            active: true, installationId: crypto.randomUUID(), installationPublicKey: new Uint8Array(keys.publicKey),
            metadata: encodePlainMachineStoredContent({ host: 'guest', platform: 'linux', happyCliVersion: 'test',
                homeDir: '/home/guest', happyHomeDir: '/home/guest/.happier' }),
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64'),
            operationProtocolCapabilitiesRevision: 1,
            operationProtocolCapabilities: capabilities } });
        const controller = controllerPresent ? await db.machine.create({ data: { id: crypto.randomUUID(), accountId: owner.id,
            active: true, installationId: crypto.randomUUID(), installationPublicKey: new Uint8Array(keys.publicKey),
            metadata: guest.metadata, dataEncryptionKey: guest.dataEncryptionKey,
            operationProtocolCapabilitiesRevision: 1, operationProtocolCapabilities: capabilities } }) : undefined;
        const requestId = crypto.randomUUID();
        const digest = 'a'.repeat(43);
        const provider = { pluginId: 'native.provisioner', localId: 'guest' };
        const row = await db.managedMachine.create({ data: { homeId, custodianAccountId: owner.id,
            ...(controller ? { controllerMachineId: controller.id, controllerInstallationId: controller.installationId } : {}),
            admittedActionRequestId: requestId, admittedInput: { enrollmentAccountId: owner.id,
                continuation: { requestEnvelopeDigest: digest } },
            launch: { provider, schemaVersion: 1, name: 'Reviewed guest', choices: {} },
            allocation: 'bound', resource: { contributionRef: provider, schemaVersion: 1, value: { id: 'reviewed-resource' } },
            enrolledMachineId: guest.id, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } });
        const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-signed-child', binding: {
            serverIdentityId: homeId, accountId: owner.id, custodianAccountId: owner.id,
            authentication: { kind: 'account', tokenEpoch: owner.tokenEpoch }, actionId: 'session.spawn_new',
            machineId: guest.id, installationId: guest.installationId, requestId, requestEnvelopeDigest: digest,
            target: { kind: 'machine', machineId: guest.id }, managedContinuation: { managedId: row.id,
                creationRequestId: requestId, expectedIntentRevision: row.intentRevision, acquireRequestEnvelopeDigest: digest,
                ...(controller ? { controller: { machineId: controller.id, installationId: controller.installationId } } : {}) } } });
        if (!controllerPresent) expect(authorization.binding.managedContinuation).not.toHaveProperty('controller');
        await expect(verifyCurrentExternalActionPrincipal(authorization.binding)).resolves.toMatchObject({ accountId: owner.id });

        await inTx(tx => setEligibleMachineAccessGrantInTx(tx, { actorAccountId: owner.id, machineId: guest.id,
            principal: { kind: 'account', accountId: outsider.id }, level: 'admin' }));
        expect(await resolveMachineAccess({ actorAccountId: outsider.id, machineId: guest.id })).toMatchObject({ role: 'manage', accessState: 'ready' });
        const substitutedRequester = { ...authorization.binding, accountId: outsider.id,
            authentication: { kind: 'account' as const, tokenEpoch: outsider.tokenEpoch } };
        await expect(verifyCurrentExternalActionPrincipal(substitutedRequester)).resolves.toBeNull();
        await expect(verifyCurrentExternalActionPrincipal({ ...authorization.binding, custodianAccountId: outsider.id })).resolves.toBeNull();
        await expect(verifyCurrentExternalActionPrincipal(authorization.binding)).resolves.toMatchObject({ accountId: owner.id });
    });
});
