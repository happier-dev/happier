import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import nacl from 'tweetnacl';
import { decodeBase64 } from 'privacy-kit';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER, sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol';
import type { ExternalActionExecutionAuthorizationBindingV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { resolveMachineAdmissionInTx } from '@/app/machines/machineAccess';
import { readAdmittedExternalActionHandoffMachineInTx } from './externalActionHandoffAdmission';

describe('retained Machine codec admissions consume the stored-content mode owner', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-admitted-codec-mode-', initAuth: false });
    }, 180_000);
    afterAll(async () => { await harness?.close(); });

    it.each(['plain', 'e2ee'] as const)('preserves an admitted %s codec and refuses mismatched stored content in the retained handoff producer', async mode => {
        const custodian = await db.account.create({ data: { encryptionMode: mode } });
        const requester = await db.account.create({ data: { encryptionMode: mode } });
        const contentKeys = nacl.box.keyPair();
        const plainContent = { host: 'codec', platform: 'linux', happyCliVersion: 'test', homeDir: '/home/codec', happyHomeDir: '/home/codec/.happier' };
        const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: custodian.id,
            installationId: crypto.randomUUID(), metadata: mode === 'plain' ? encodePlainMachineStoredContent(plainContent) : 'encrypted-content',
            dataEncryptionKey: mode === 'plain' ? decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER)
                : sealEncryptedDataKeyEnvelopeV1({ dataKey: nacl.randomBytes(32), recipientPublicKey: contentKeys.publicKey, randomBytes: nacl.randomBytes }) } });
        const binding = {
            accountId: requester.id, custodianAccountId: custodian.id, authentication: { kind: 'account', tokenEpoch: 0 },
            serverIdentityId: 'home', machineId: machine.id, installationId: machine.installationId!,
            actionId: 'session.handoff', requestId: 'handoff', requestEnvelopeDigest: 'a'.repeat(43),
            target: { kind: 'machine', machineId: machine.id },
            handoffAdmission: { sessionId: 'session', sourceMachineId: machine.id, sourceInstallationId: machine.installationId!,
                targetMachineId: 'destination', targetInstallationId: 'destination-installation' },
        } satisfies ExternalActionExecutionAuthorizationBindingV1;
        // These readers consume a Home-verified job: the requester needs no new grant at this boundary.
        const handoff = () => readAdmittedExternalActionHandoffMachineInTx(db, binding);
        const owner = () => resolveMachineAdmissionInTx(db, { actorAccountId: custodian.id, machineId: machine.id });
        expect(await owner()).toMatchObject({ kind: 'admitted', encryptionMode: mode });
        expect(await handoff()).toMatchObject({ kind: 'admitted', actorAccountId: requester.id, encryptionMode: mode });

        await db.machine.update({ where: { id: machine.id }, data: {
            metadata: mode === 'plain' ? 'encrypted-content' : encodePlainMachineStoredContent(plainContent),
        } });
        expect(await owner()).toEqual({ kind: 'denied', code: 'encryption_material_unavailable' });
        expect.soft(await handoff()).toBeNull();
    });
});
