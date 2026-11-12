import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import nacl from 'tweetnacl';
import { decodeBase64 } from 'privacy-kit';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER, sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol';
import type { ExternalActionExecutionAuthorizationBindingV1 } from '@happier-dev/protocol/actions/externalActionApi';
import type { DeploymentChildRoutingV1 } from '@happier-dev/protocol';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { resolveMachineAdmissionInTx } from '@/app/machines/machineAccess';
import { readDeploymentChildMachineReadInTx } from '@/app/deployments/deploymentChildAuthorization';
import { readAdmittedExternalActionHandoffMachineInTx } from './externalActionHandoffAdmission';

describe('retained Machine codec admissions consume the stored-content mode owner', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-admitted-codec-mode-', initAuth: false });
    }, 180_000);
    afterAll(async () => { await harness?.close(); });

    it.each(['plain', 'e2ee'] as const)('preserves an admitted %s codec and refuses mismatched stored content in both producers', async mode => {
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
        const routing = { v: 1, kind: 'domainDiscover', actionId: 'deployments.domains.add', machineId: machine.id,
            installationId: machine.installationId!, input: { serverId: 'home', environmentId: 'environment', domainId: 'domain',
                expectedRevision: 1, requestKey: 'domain-request', targetLinkId: 'target', expectedTargetLinkRevision: 1,
                contentArtifactId: 'content', contentHeaderVersion: 1, contentBodyVersion: 1 } } satisfies DeploymentChildRoutingV1;
        // These readers consume a Home-verified job: the requester needs no new grant at this boundary.
        const handoff = () => readAdmittedExternalActionHandoffMachineInTx(db, binding);
        const child = () => readDeploymentChildMachineReadInTx(db, { binding, routing }, machine.id);
        const owner = () => resolveMachineAdmissionInTx(db, { actorAccountId: custodian.id, machineId: machine.id });
        expect(await owner()).toMatchObject({ kind: 'admitted', encryptionMode: mode });
        expect(await handoff()).toMatchObject({ kind: 'admitted', actorAccountId: requester.id, encryptionMode: mode });
        expect(await child()).toMatchObject({ codecAdmission: { actorAccountId: requester.id, encryptionMode: mode } });
        const claimed = { machineId: machine.id, installationId: machine.installationId!,
            actorAccountId: requester.id, custodianAccountId: custodian.id, encryptionMode: mode, role: 'use' as const };
        expect(await readAdmittedExternalActionHandoffMachineInTx(db, binding, machine.id, claimed))
            .toMatchObject({ kind: 'admitted', role: 'use' });
        // The retained admission carries its admitted role, including shared Manage
        // for a non-owner receiver (72105c7511a); this reader does not re-derive it.
        expect(await readAdmittedExternalActionHandoffMachineInTx(db, binding, machine.id, { ...claimed, role: 'manage' }))
            .toMatchObject({ kind: 'admitted', role: 'manage' });
        expect(await readAdmittedExternalActionHandoffMachineInTx(db, binding, machine.id, { ...claimed,
            actorAccountId: custodian.id })).toBeNull();
        expect(await readAdmittedExternalActionHandoffMachineInTx(db, binding, machine.id, { ...claimed,
            custodianAccountId: requester.id })).toBeNull();
        const ownerBinding = { ...binding, accountId: custodian.id };
        const ownerClaim = { ...claimed, actorAccountId: custodian.id, role: 'manage' as const };
        expect(await readAdmittedExternalActionHandoffMachineInTx(db, ownerBinding, machine.id, ownerClaim))
            .toMatchObject({ kind: 'admitted', role: 'manage' });

        await db.machine.update({ where: { id: machine.id }, data: {
            metadata: mode === 'plain' ? 'encrypted-content' : encodePlainMachineStoredContent(plainContent),
        } });
        expect(await owner()).toEqual({ kind: 'denied', code: 'encryption_material_unavailable' });
        expect.soft(await handoff()).toBeNull();
        expect.soft(await child()).toBeNull();
    });
});
