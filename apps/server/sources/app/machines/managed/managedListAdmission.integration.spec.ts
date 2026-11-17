import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as pluginJsonSchemaValidation from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import { ManagedAdmissionInputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { auth } from '@/app/auth/auth';
import { enableAuthentication } from '@/app/api/utils/enableAuthentication';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { seedBundledManagedAvailability } from './managedProjectionVolume.testkit';
import { admitManagedAcquire } from './managedAcquire';
import { listManagedMachines } from './managedRead';
import { registerManagedMachineRoutes } from './managedRoutes';
import { PluginManifestV2Schema } from '@happier-dev/protocol/plugins/manifest/v2';
import { createReleaseLessDeclarationV1 } from '@/app/plugins/availability/currentDeclaration';
import { LIMA_PLUGIN } from '../../../../../../packages/plugins/machine-lima/src/manifest';

describe('managed list admission cost', () => {
    const homeId = `srv_${'a'.repeat(32)}`;
    let harness: LightSqliteHarness;
    let producerDir: string;
    const producerBytes = 'server-owned archive bytes';
    const producerDigest = createHash('sha256').update(producerBytes).digest('hex');
    beforeAll(async () => {
        producerDir = await mkdtemp(join(tmpdir(), 'happier-managed-admission-producer-'));
        const archivePath = join(producerDir, 'guest.tar.gz');
        await writeFile(archivePath, producerBytes);
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-managed-list-admission-', initAuth: true, initEncrypt: true,
            env: { HAPPIER_SERVER_IDENTITY_ID: homeId, HAPPIER_DEV_GUEST_CLI_EXPORT: '1',
                HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: 'true', HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
                HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_METADATA: JSON.stringify({ archives: [
                    { target: { os: 'linux', arch: 'x64' }, sha256: producerDigest, archivePath },
                ] }) } });
    }, 120_000);
    afterAll(async () => {
        if (harness) await harness.close();
        if (producerDir) await rm(producerDir, { recursive: true, force: true });
    });

    it('signs the Home payload snapshot into the existing Retry root', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: account.id,
            metadata: '{}', installationId: randomUUID() } });
        const guestCli = { source: 'home-payload', line: '0.3', channel: 'publicdev', payloads: [
            { target: { os: 'linux', arch: 'x64' }, sha256: producerDigest, url: '/v1/runtime/guest-cli/payloads/linux/x64' },
        ] } as const;
        const input = { homeId, managedId: randomUUID(), expectedIntentRevision: 0,
            guestCli: { ...guestCli, payloads: [{ ...guestCli.payloads[0], sha256: 'a'.repeat(64) }] } };
        const authorization = await auth.mintExternalActionExecutionAuthorization({ serverIdentityId: homeId,
            accountId: account.id, machineId: machine.id, target: { kind: 'machine', machineId: machine.id },
            authentication: { kind: 'account', tokenEpoch: account.tokenEpoch },
            actionId: 'machines.managed.bootstrap.retry', requestId: randomUUID(), requestEnvelopeDigest: 'x'.repeat(43),
            managedAdmission: { actionId: 'machines.managed.bootstrap.retry', input },
        }, { input });
        const admission = authorization.binding.managedAdmission;
        if (admission?.actionId !== 'machines.managed.bootstrap.retry') throw new Error('Expected Retry admission');
        expect(admission.input.guestCli).toEqual(guestCli);
        const previous = process.env.HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_METADATA;
        try {
            delete process.env.HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_METADATA;
            expect((await auth.verifyExternalActionExecutionAuthorization(authorization.token))?.managedAdmission).toEqual(admission);
        } finally { process.env.HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_METADATA = previous; }
    });

    it('pins Home-owned Create and Retry payloads once through Account context', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const controller = { machineId: randomUUID(), installationId: randomUUID() };
        await db.machine.create({ data: { id: controller.machineId, accountId: account.id, metadata: '{}',
            installationId: controller.installationId, pluginMaterializationRevision: 1n } });
        // Use the current-source declaration seam already exercised by preset
        // integration tests; the separate cost test retains its published input.
        const manifest = PluginManifestV2Schema.parse(LIMA_PLUGIN.manifest);
        const declaration = createReleaseLessDeclarationV1(manifest);
        await db.accountPluginIntent.create({ data: { accountId: account.id, pluginId: manifest.id,
            enabled: true, writableCollections: [], releaseLessDeclaration: declaration } });
        await db.pluginMachineMaterialization.create({ data: { accountId: account.id, serverIdentityId: homeId,
            machineId: controller.machineId, materializationId: controller.installationId, pluginId: manifest.id,
            version: manifest.version, sourceClass: 'bundledFirstParty', portableRelease: false,
            archiveDigestSha256: declaration.manifestDigestSha256, uiArtifacts: [], enabled: true,
            trustState: 'trusted', observedAt: new Date() } });
        const launch = { provider: { pluginId: manifest.id, localId: 'lima' }, schemaVersion: 1, name: 'Admitted guest',
            choices: { store: '/tmp/list-admission', image: 'fixture:ubuntu', arch: 'x86_64',
                vmType: 'qemu', cpus: 2, memoryGiB: 4, diskGiB: 16, mounts: [] } };
        const guestCli = { source: 'home-payload', line: '0.3', channel: 'publicdev', payloads: [
            { target: { os: 'linux', arch: 'x64' }, sha256: producerDigest, url: '/v1/runtime/guest-cli/payloads/linux/x64' },
        ] } as const;
        const input = ManagedAdmissionInputV1Schema.parse({ requestId: randomUUID(), continuationPresent: false,
                guestCli: { ...guestCli, payloads: [{ ...guestCli.payloads[0], sha256: 'a'.repeat(64) }] },
                input: { enrollmentIdentity: { kind: 'guestProcess', role: 'sandbox' },
                    selection: { kind: 'one-off', homeId, controller, launch,
                        retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } } });
        const created = await admitManagedAcquire({ requesterAccountId: account.id, custodianAccountId: account.id,
            requestEnvelopeDigest: 'list-admission', input });
        const admitted = await db.managedMachine.findUniqueOrThrow({ where: { id: created.machine.id } });
        const retryInput = { homeId, managedId: created.machine.id, expectedIntentRevision: created.machine.intentRevision,
            guestCli: input.guestCli };
        const target = { kind: 'machine', machineId: controller.machineId } as const;
        const envelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: randomUUID(),
            target, input: retryInput });
        const retry = await auth.mintExternalActionExecutionAuthorization({ serverIdentityId: homeId,
            accountId: account.id, machineId: controller.machineId, target,
            authentication: { kind: 'account', tokenEpoch: account.tokenEpoch },
            actionId: 'machines.managed.bootstrap.retry', requestId: envelope.requestId,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
            managedAdmission: { actionId: 'machines.managed.bootstrap.retry', input: retryInput },
        }, { input: retryInput });
        const retryAdmission = retry.binding.managedAdmission;
        if (retryAdmission?.actionId !== 'machines.managed.bootstrap.retry') throw new Error('Expected the retained Retry admission');
        const replacement = 'new Home archive after admission';
        const archivePath = join(producerDir, 'guest.tar.gz');
        await writeFile(archivePath, replacement);
        const replacementDigest = createHash('sha256').update(replacement).digest('hex');
        process.env.HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_METADATA = JSON.stringify({ archives: [
            { target: { os: 'linux', arch: 'x64' }, sha256: replacementDigest, archivePath },
        ] });
        expect((await auth.verifyExternalActionExecutionAuthorization(retry.token))?.managedAdmission).toEqual(retryAdmission);
        const replay = await admitManagedAcquire({ requesterAccountId: account.id, custodianAccountId: account.id,
            requestEnvelopeDigest: 'list-admission', input: { ...input,
                guestCli: { ...input.guestCli!, payloads: [{ ...input.guestCli!.payloads![0], sha256: 'b'.repeat(64) }] } } });
        expect(replay.replayed).toBe(true);
        // An Account-hosted guest uses its existing authenticated context read,
        // rather than a Machine execution-token mint, for its new Retry snapshot.
        await db.managedMachine.update({ where: { id: created.machine.id }, data: {
            controllerMachineId: null, controllerInstallationId: null,
        } });
        const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        enableAuthentication(app);
        registerManagedMachineRoutes(app);
        try {
            const token = await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' });
            const response = await app.inject({ method: 'POST', url: '/v1/machines/managed/controller/context',
                headers: { authorization: `Bearer ${token}` }, payload: { homeId, managedId: created.machine.id,
                    expectedIntentRevision: created.machine.intentRevision } });
            expect(response.statusCode, response.body).toBe(200);
            const context = response.json();
            expect([created.machine.guestCli, replay.machine.guestCli, retryAdmission.input.guestCli,
                context.machine.guestCli, context.guestCli]).toEqual([guestCli, guestCli, guestCli, guestCli,
                { ...guestCli, payloads: [{ ...guestCli.payloads[0], sha256: replacementDigest }] }]);
            expect(admitted.admittedInput).toMatchObject({ guestCli });
        } finally { await app.close(); }
    });

    it('does not rebuild or run declared admission schemas while listing 128 retained allocations repeatedly', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const controller = { machineId: randomUUID(), installationId: randomUUID() };
        await db.machine.create({ data: { id: controller.machineId, accountId: account.id, metadata: '{}',
            installationId: controller.installationId, pluginMaterializationRevision: 1n } });
        const manifest = await seedBundledManagedAvailability(account.id, homeId, controller, ['machine-lima.json']);
        const launch = { provider: { pluginId: manifest.id, localId: 'lima' }, schemaVersion: 1, name: 'Admitted guest',
            choices: { store: '/tmp/list-admission', image: 'fixture:ubuntu', arch: 'x86_64',
                vmType: 'qemu', cpus: 2, memoryGiB: 4, diskGiB: 16, mounts: [] } };
        const created = await admitManagedAcquire({ requesterAccountId: account.id, custodianAccountId: account.id,
            requestEnvelopeDigest: 'list-admission', input: ManagedAdmissionInputV1Schema.parse({ requestId: randomUUID(), continuationPresent: false,
                input: { enrollmentIdentity: { kind: 'guestProcess', role: 'sandbox' },
                    selection: { kind: 'one-off', homeId, controller, launch,
                        retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } } }) });
        const admitted = await db.managedMachine.findUniqueOrThrow({ where: { id: created.machine.id } });
        // OPEN-S0B's observed census is 128 allocations. Reuse the real ingress's
        // admitted JSON rather than inventing a second persisted admission shape.
        await db.managedMachine.createMany({ data: Array.from({ length: 127 }, () => ({
            homeId, custodianAccountId: account.id, controllerMachineId: controller.machineId,
            controllerInstallationId: controller.installationId, admittedActionRequestId: randomUUID(),
            admittedInput: admitted.admittedInput!, launch, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
        })) });
        // Transparent instrumentation: all admission and schema logic remains real.
        const constructions = vi.spyOn(pluginJsonSchemaValidation, 'createPluginJsonSchemaZodValueAdapter');
        try {
            for (let read = 0; read < 3; read += 1) {
                const result = await listManagedMachines({ actorAccountId: account.id, input: { homeId } });
                expect(result.machines).toHaveLength(128);
                expect(result.machines.find(machine => machine.id === created.machine.id)?.launch).toEqual(launch);
                expect(constructions).toHaveBeenCalledTimes(0);
            }
            await db.managedMachine.update({ where: { id: created.machine.id }, data: { desired: 'stop', intentRevision: 1 } });
            const changed = await listManagedMachines({ actorAccountId: account.id, input: { homeId } });
            expect(changed.machines.find(machine => machine.id === created.machine.id)).toMatchObject({ desired: 'stop', intentRevision: 1 });
            expect(constructions).toHaveBeenCalledTimes(0);
        } finally { constructions.mockRestore(); }
    }, 120_000);

});
