import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fastify, { type FastifyRequest } from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import tweetnacl from 'tweetnacl';
import { PluginManifestV2Schema } from '@happier-dev/protocol/plugins/manifest/v2';
import { PluginJsonSchemaV2Schema } from '@happier-dev/protocol/plugins/contributions/jsonSchema';
import { rehydrateCanonicalProtocolComposableSchema } from '@happier-dev/protocol/plugins/actions/protocol-composable-schema';
import { defineMachineProvisionerSchemas, defineMachineProvisionerReconciliationSchemas } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { createManagedPolicyCensusProofV1 } from '@happier-dev/protocol/machines/managed/managedPolicyV1';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createAuthenticatedRouteRequest } from '@/app/api/testkit/requestFixtures';
import { createPluginAvailabilityOperations } from '@/app/plugins/availability/operations';
import { seedBundledManagedAvailability } from './managedProjectionVolume.testkit';
import { readManagedProjectionFactsInTx } from './managedRows';
import { admitManagedAcquire } from './managedAcquire';
import { admitManagedControl, linkManagedEnrollmentInTx, reportManagedAcquire, reportManagedIntent, submitManagedAcquire, submitManagedIntent } from './managedMutations';
import { registerManagedMachineRoutes } from './managedRoutes';
import { limaAcquisitionResource } from '../../../../../../packages/plugins/machine-lima/src/machine/provider';
import { LimaResourceSchema } from '../../../../../../packages/plugins/machine-lima/src/machine/schemas';
import { buildManagedConfigurationFactsV1 } from '@happier-dev/protocol/machines/managed/managedConfigurationV1';
import { createPluginJsonSchemaZodValueAdapter } from '@happier-dev/protocol/plugins/actions/json-schema-validation';

describe('retained managed rows across declaration changes', () => {
    const homeId = `srv_${'a'.repeat(32)}`;
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-managed-row-skew-', initEncrypt: true,
            env: { HAPPIER_SERVER_IDENTITY_ID: homeId } });
    }, 120_000);
    afterAll(async () => { if (harness) await harness.close(); });

    it('reads the selected controller declaration when another Machine claims fewer provisioners', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const keys = tweetnacl.sign.keyPair();
        const controller = { machineId: randomUUID(), installationId: randomUUID() };
        await db.machine.create({ data: { id: controller.machineId, accountId: account.id, metadata: '{}', active: true,
            installationId: controller.installationId, installationPublicKey: new Uint8Array(keys.publicKey), pluginMaterializationRevision: 1n } });
        const manifest = await seedBundledManagedAvailability(account.id, homeId, controller, ['machine-lima.json']);
        const availability = createPluginAvailabilityOperations();
        await availability.claimCollectionWriters({ accountId: account.id, input: { manifest }, publisher: controller });
        const sibling = { machineId: randomUUID(), installationId: randomUUID() };
        await availability.claimCollectionWriters({ accountId: account.id, publisher: sibling,
            input: { manifest: { ...manifest, contributes: { ...manifest.contributes, machineProvisioners: [] } } } });
        const input = { homeId, controller, provider: { pluginId: manifest.id, localId: 'lima' } };
        const facts = await inTx(tx => readManagedProjectionFactsInTx(tx, [input]));
        expect(facts.declarationFor(input)).not.toBeNull();
    });

    it('publishes retained guest observations after its controller replaces the declaration', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const keys = tweetnacl.sign.keyPair();
        const controller = { machineId: randomUUID(), installationId: randomUUID() };
        await db.machine.create({ data: { id: controller.machineId, accountId: account.id, metadata: '{}', active: true,
            installationId: controller.installationId, installationPublicKey: new Uint8Array(keys.publicKey), pluginMaterializationRevision: 1n } });
        const manifest = await seedBundledManagedAvailability(account.id, homeId, controller, ['machine-lima.json']);
        const choices = { store: '/tmp/managed-observation-reload', image: 'fixture:ubuntu', arch: 'x86_64' as const,
            vmType: 'qemu' as const, cpus: 2, memoryGiB: 4, diskGiB: 16, mounts: [] };
        const input = { enrollmentIdentity: { kind: 'existingUser' as const, role: 'adopted' as const },
            selection: { kind: 'one-off' as const, homeId, controller,
                launch: { provider: { pluginId: manifest.id, localId: 'lima' }, schemaVersion: 1, name: 'Reload guest', choices },
                retention: { kind: 'until-delete' as const }, wakeOnAcceptedMessage: false } };
        const requestId = randomUUID();
        const created = await admitManagedAcquire({ requesterAccountId: account.id, custodianAccountId: account.id,
            requestEnvelopeDigest: 'observation-reload', input: { requestId, input, continuationPresent: false } });
        const current = { homeId, managedId: created.machine.id, requestId, controller, expectedIntentRevision: 0 };
        const resource = { contributionRef: input.selection.launch.provider, schemaVersion: 1,
            value: { ...limaAcquisitionResource(choices, created.machine.id), mounts: [] } };
        await submitManagedAcquire(current);
        await reportManagedAcquire({ ...current, result: { kind: 'bound', resource },
            configurationFacts: buildManagedConfigurationFactsV1({
                choicesSchema: createPluginJsonSchemaZodValueAdapter(manifest.contributes.machineProvisioners![0].launchSchema),
                launch: input.selection.launch, controller, provisioner: manifest.contributes.machineProvisioners![0],
                optionStatus: 'unavailable', prerequisites: [], billing: manifest.contributes.machineProvisioners![0].billing,
                retentionCapabilities: manifest.contributes.machineProvisioners![0].retention,
                machineOverride: { retention: input.selection.retention, wakeOnAcceptedMessage: false },
            }),
            observation: { availability: 'unavailable', reason: 'bootstrap.incomplete', observedAt: 1 } });
        const guest = await db.machine.create({ data: { id: randomUUID(), accountId: account.id,
            metadata: '{}', installationId: randomUUID() } });
        await inTx(tx => linkManagedEnrollmentInTx(tx, { ...current, resource }, account.id, guest.id));

        const availability = createPluginAvailabilityOperations();
        await availability.claimCollectionWriters({ accountId: account.id, publisher: controller,
            input: { manifest: { ...manifest, contributes: { ...manifest.contributes, machineProvisioners: [] } } } });
        const factsInput = { homeId, controller, provider: input.selection.launch.provider };
        const facts = await inTx(tx => readManagedProjectionFactsInTx(tx, [factsInput]));
        expect(facts.declarationFor(factsInput)).toBeNull();

        const app = fastify().withTypeProvider<ZodTypeProvider>();
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        // Only the HTTP authentication boundary is replaced; publication, retained
        // native-schema validation and the response's status are real.
        app.decorate('authenticate', async (request: FastifyRequest) => {
            Object.assign(request, createAuthenticatedRouteRequest({ userId: account.id,
                externalActionExecutionAuthorized: true, externalActionExecutionMachineId: controller.machineId,
                externalActionEffectActionId: 'machines.managed.acquire', externalActionExecutionRequestId: requestId,
                externalActionExecutionCustodianAccountId: account.id }),
            { headers: request.headers, params: request.params, query: request.query });
        });
        registerManagedMachineRoutes(app);
        try {
            const report = (value: unknown) => app.inject({ method: 'POST', url: '/v1/machines/managed/controller/report', payload: value });
            const present = await report({ ...current, result: { kind: 'bound', resource },
                observation: { availability: 'present', observedAt: 2 } });
            expect(present.statusCode, present.body).toBe(200);
            expect(present.json()).toMatchObject({ machine: { enrolledMachineId: guest.id,
                observation: { availability: 'present', observedAt: 2 } } });
            const invalid = await report({ ...current, result: { kind: 'bound',
                resource: { ...resource, value: { ...resource.value, instance: 42 } } } });
            expect(invalid.statusCode).toBe(409);
            expect(invalid.json()).toMatchObject({ code: 'resource_mismatch' });
            // Replacing installed declarations still governs a new admission.
            await expect(admitManagedAcquire({ requesterAccountId: account.id, custodianAccountId: account.id,
                requestEnvelopeDigest: 'new-after-reload', input: { requestId: randomUUID(), input, continuationPresent: false } }))
                .rejects.toMatchObject({ code: 'provider_unavailable' });
        } finally { await app.close(); }
    }, 120_000);

    it('reads and deletes an enrolled nameless launch after a stale host republishes its required-instance declaration', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const keys = tweetnacl.sign.keyPair();
        const controller = { machineId: randomUUID(), installationId: randomUUID() };
        await db.machine.create({ data: { id: controller.machineId, accountId: account.id, metadata: '{}', active: true,
            installationId: controller.installationId, installationPublicKey: new Uint8Array(keys.publicKey), pluginMaterializationRevision: 1n } });
        const manifest = await seedBundledManagedAvailability(account.id, homeId, controller);
        const choices = { store: '/tmp/managed-row-skew', image: 'fixture:ubuntu', arch: 'x86_64' as const,
            vmType: 'qemu' as const, cpus: 2, memoryGiB: 4, diskGiB: 16, mounts: [] };
        const input = { enrollmentIdentity: { kind: 'existingUser' as const, role: 'adopted' as const },
            selection: { kind: 'one-off' as const, homeId, controller,
                launch: { provider: { pluginId: manifest.id, localId: 'lima' }, schemaVersion: 1, name: 'Retained guest', choices },
                retention: { kind: 'until-delete' as const }, wakeOnAcceptedMessage: false } };
        const requestId = randomUUID();
        const created = await admitManagedAcquire({ requesterAccountId: account.id, custodianAccountId: account.id,
            requestEnvelopeDigest: 'original-admission', input: { requestId, input, continuationPresent: false } });
        const current = { homeId, managedId: created.machine.id, requestId, controller, expectedIntentRevision: 0 };
        const resource = { contributionRef: input.selection.launch.provider, schemaVersion: 1,
            value: { ...limaAcquisitionResource(choices, created.machine.id), mounts: [] } };
        await submitManagedAcquire(current);
        await reportManagedAcquire({ ...current, result: { kind: 'bound', resource } });
        const guest = await db.machine.create({ data: { id: randomUUID(), accountId: account.id,
            metadata: '{}', installationId: randomUUID() } });
        await inTx(tx => linkManagedEnrollmentInTx(tx, { ...current, resource }, account.id, guest.id));

        // Captured verbatim from PAY49's linux-x64/assets/bundled-plugin-manifests/
        // machine-lima.json. Both architectures and packaged plugin.json agree;
        // CREF81's current nameless producer supplies the stored launch above.
        const provisioner = manifest.contributes.machineProvisioners![0];
        const staleLaunchSchema = PluginJsonSchemaV2Schema.parse(JSON.parse(await readFile(new URL('./managedRows.pay49Launch.fixture.json', import.meta.url), 'utf8')));
        const staleLaunch = rehydrateCanonicalProtocolComposableSchema(staleLaunchSchema);
        if (!staleLaunch) throw new Error('PAY49 launch schema must retain its canonical parser');
        const roles = defineMachineProvisionerSchemas({ launch: staleLaunch, resource: LimaResourceSchema });
        const reconciliation = defineMachineProvisionerReconciliationSchemas({ launch: staleLaunch,
            resource: LimaResourceSchema, nativeOperation: LimaResourceSchema });
        const stale = PluginManifestV2Schema.parse({ ...manifest, contributes: { ...manifest.contributes,
            machineProvisioners: [{ ...provisioner, launchSchema: staleLaunchSchema }],
            actions: manifest.contributes.actions?.map(action => action.id === provisioner.actions.acquire
                ? { ...action, inputSchema: roles.acquireInput.jsonSchema, resultSchema: reconciliation.result.jsonSchema }
                : action.id === provisioner.reconciliation?.action
                    ? { ...action, inputSchema: reconciliation.input.jsonSchema, resultSchema: reconciliation.result.jsonSchema }
                    : action) } });
        const availability = createPluginAvailabilityOperations({ resolveHostingCapability: () => ({ enabled: false }),
            resolveServerIdentityId: async () => homeId });
        await availability.claimCollectionWriters({ accountId: account.id, input: { manifest: stale } });

        const app = fastify().withTypeProvider<ZodTypeProvider>();
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        // Authentication alone is substituted. Admission, publication, reads,
        // policy proof verification and native-result validation remain real.
        app.decorate('authenticate', async (request: FastifyRequest) => {
            Object.assign(request, createAuthenticatedRouteRequest({ userId: account.id,
                externalActionExecutionAuthorized: true, externalActionExecutionMachineId: controller.machineId,
                externalActionEffectActionId: 'machines.managed.acquire', externalActionExecutionRequestId: requestId,
                externalActionExecutionCustodianAccountId: account.id }),
            { headers: request.headers, params: request.params, query: request.query });
        });
        registerManagedMachineRoutes(app);
        try {
            for (const [url, payload] of [
                ['/v1/machines/managed/actions/get', { homeId, managedId: current.managedId }],
                ['/v1/machines/managed/actions/list', { homeId }],
                ['/v1/machines/managed/controller/current', current],
                ['/v1/machines/managed/controller/policies', { homeId, controller,
                    proof: createManagedPolicyCensusProofV1({ homeId, controller, custodianAccountId: account.id, privateKey: keys.secretKey }) }],
            ] as const) {
                const response = await app.inject({ method: 'POST', url, payload });
                expect(response.statusCode, `${url}: ${response.body}`).toBe(200);
                const result = response.json();
                const machine = 'machines' in result ? result.machines.find((row: { id: string }) => row.id === current.managedId)
                    : result.machine ?? result;
                expect(machine).toMatchObject({ id: current.managedId, enrolledMachineId: guest.id,
                    launch: input.selection.launch, resource });
            }
            await expect(reportManagedAcquire({ ...current, result: { kind: 'bound', resource } }))
                .resolves.toMatchObject({ machine: { launch: input.selection.launch, resource } });
            await expect(inTx(tx => linkManagedEnrollmentInTx(tx, { ...current, resource }, account.id, guest.id)))
                .resolves.toBeUndefined();
            // A native report still admits the new native value, independently
            // of the immutable launch that was accepted before publication.
            await expect(reportManagedAcquire({ ...current, result: { kind: 'bound',
                resource: { ...resource, value: { ...resource.value, instance: 42 } } } }))
                .rejects.toMatchObject({ code: 'resource_mismatch' });
            // New acquisitions still use the current declaration at admission.
            await expect(admitManagedAcquire({ requesterAccountId: account.id, custodianAccountId: account.id,
                requestEnvelopeDigest: 'new-admission', input: { requestId: randomUUID(), input, continuationPresent: false } }))
                .rejects.toMatchObject({ code: 'invalid_request' });
            const deletionId = randomUUID();
            await expect(admitManagedControl({ actorAccountId: account.id, custodianAccountId: account.id,
                input: { action: 'machines.managed.delete', requestId: deletionId,
                    input: { homeId, managedId: current.managedId, expectedRevision: 0, intent: 'delete', when: 'now', reviewedDependencies: true } } }))
                .resolves.toMatchObject({ machine: { desired: 'delete', intentRevision: 1 } });
            const deletion = { ...current, requestId: deletionId, expectedIntentRevision: 1 };
            await submitManagedIntent(deletion);
            await expect(reportManagedIntent({ ...deletion, result: { kind: 'confirmed' },
                observation: { availability: 'absent', observedAt: Date.now() } }))
                .resolves.toMatchObject({ machine: { allocation: 'confirmed-absent' } });
            expect((await db.managedMachine.findUniqueOrThrow({ where: { id: current.managedId } })).launch)
                .toEqual(input.selection.launch);
        } finally { await app.close(); }
    }, 120_000);
});
