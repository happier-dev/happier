import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import { inTx } from "@/storage/inTx";
import { requireCurrentManagedMachineInTx, readMachineDevcontainerChildInTx, readMachineDevcontainerChildrenInTx, readManagedAcquisitionIdentity } from "./managedRows";
import { qualifyManagedAcquisitionPolicy } from "./managedAcquire";
import { admitManagedAcquire } from "./managedAcquire";
import { buildManagedConfigurationFactsV1, ManagedConfigurationFactsV1Schema } from '@happier-dev/protocol/machines/managed/managedConfigurationV1';
import { createPluginJsonSchemaZodValueAdapter } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import { createActionExecutor, ManagedAcquireInputV1Schema, PluginManifestV2Schema, signMachineInstallationProof, createManagedPolicyCensusProofV1, createManagedPolicyProofV1, encodeManagedPolicyProofV1, MANAGED_POLICY_PROOF_HEADER, ManagedWakeTargetV1Schema, type ActionExecutorDeps, type ManagedCommittedIdleEvidenceV1 } from "@happier-dev/protocol";
import tweetnacl from 'tweetnacl';
import { defineProtocolObject, defineProtocolString } from "@happier-dev/protocol/plugins/actions/protocol-composable-schema";
import { defineMachineProvisionerSchemas, defineMachineProvisionerReconciliationSchemas, MachineProvisionerCheckResultProtocolV1Schema, MachineProvisionerBootstrapCarrierV1Schema, MachineProvisionerObservationV1Schema, MachineProvisionerPowerResultV1Schema } from "@happier-dev/protocol/plugins/contributions/machineProvisioners";
import { createReleaseLessDeclarationV1 } from "@/app/plugins/availability/currentDeclaration";
import { submitManagedAcquire, reportManagedAcquire, createManagedBootstrapCredential, requireManagedEnrollmentInTx, linkManagedEnrollmentInTx, admitManagedControl, submitManagedIntent, reportManagedIntent, admitManagedPolicy, requireManagedPolicyPurposeInTx } from "./managedMutations";
import { enqueuePendingMessageByAuthenticatedMachine, deletePendingMessage } from '@/app/session/pending/pendingMessageService';
import { cancelManagedCreation, getManagedMachine, listManagedMachines, readManagedResourceDependenciesInTx } from "./managedRead";
import fastify, { type FastifyRequest } from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { registerManagedMachineRoutes } from './managedRoutes';
import { resolveManagedGuestActivityAdmissionInTx } from './managedGuestActivity';
import { readManagedWakeTargets } from './managedWake';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { eventRouter } from '@/app/events/eventRouter';
import { UpdateContainerSchema } from '@happier-dev/protocol/updates';
import { resolveMachineAccessInTx } from '@/app/machines/machineAccess';
import { createAuthenticatedRouteRequest } from '@/app/api/testkit/requestFixtures';
import { machinesRoutes } from '@/app/api/routes/machines/machinesRoutes';
import { ManagedAdmissionOutputV1Schema, ManagedControllerContextOutputV1Schema, ManagedControllerMachineOutputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { ManagedPolicyCensusOutputV1Schema } from '@happier-dev/protocol/machines/managed/managedPolicyV1';
import { LUME_PLUGIN } from '../../../../../../packages/plugins/machine-lume/src/manifest';
import { createLumeNativeClient } from '../../../../../../packages/plugins/machine-lume/src/machine/nativeClient';
import { createLumeProvider } from '../../../../../../packages/plugins/machine-lume/src/machine/provider';
import { resolveMachineSetup, reportMachineSetup } from './machineSetup';

describe("managed acquisition durable authority", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-managed-acquire-", initAuth: false, initEncrypt: true, env: { HAPPIER_SERVER_IDENTITY_ID: `srv_${"a".repeat(32)}` } });
    }, 120_000);
    afterAll(async () => { if (harness) await harness.close(); });

    it('keeps archived managed resources discoverable by the custodian after controller revocation', async () => {
        const homeId = `srv_${'a'.repeat(32)}`;
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const controller = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: account.id,
            metadata: '{}', installationId: crypto.randomUUID(), revokedAt: new Date(), active: false } });
        const row = await db.managedMachine.create({ data: { homeId, custodianAccountId: account.id,
            controllerMachineId: controller.id, controllerInstallationId: controller.installationId!,
            admittedActionRequestId: crypto.randomUUID(), admittedInput: {},
            launch: { provider: { pluginId: 'fixture.setup', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
            allocation: 'confirmed-absent', archivedAt: new Date(), retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } });
        expect((await listManagedMachines({ actorAccountId: account.id, input: { homeId, archived: true } })).machines)
            .toEqual([expect.objectContaining({ id: row.id })]);
    });

    it('resolves the admitted environment after preset edits and keeps retry and skip on the same enrolled resource', async () => {
        const homeId = `srv_${'a'.repeat(32)}`;
        const account = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
        const controller = { machineId: 'setup-controller', installationId: 'setup-controller-install' };
        const guestId = 'setup-guest';
        await db.machine.createMany({ data: [controller.machineId, guestId].map(id => ({ id, accountId: account.id, metadata: '{}',
            installationId: id === guestId ? 'guest-install' : controller.installationId })) });
        const launch = { provider: { pluginId: 'fixture.setup', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} };
        const setup = { scripts: [{ body: 'echo admitted' }] };
        await db.managedMachinePreset.create({ data: { id: 'setup-preset', homeId, custodianAccountId: account.id, name: 'Preset',
            launch, controllerMachineId: controller.machineId, controllerInstallationId: controller.installationId,
            setup: { scripts: [{ body: 'echo changed' }] }, revision: 2 } });
        const row = await db.managedMachine.create({ data: { homeId, custodianAccountId: account.id,
            controllerMachineId: controller.machineId, controllerInstallationId: controller.installationId,
            admittedActionRequestId: 'setup-create', admittedInput: {}, presetId: 'setup-preset', presetRevision: 1,
            launch, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false, allocation: 'bound', enrolledMachineId: guestId,
            resource: { contributionRef: launch.provider, schemaVersion: 1, value: { id: 'same-native' } },
            // CAS must compare the complete retained JSON, not its known-field read projection.
            machineSetup: { setup, state: 'pending', futureStoredMember: { nested: [null, { opaque: true }] } } } });
        expect(row.machineSetup).toEqual({ setup, state: 'pending',
            futureStoredMember: { nested: [null, { opaque: true }] } });
        const app = fastify().withTypeProvider<ZodTypeProvider>();
        app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
        let signer = guestId;
        // Guest setup reports are signed; the person's recovery uses their present-user Account.
        app.decorate('authenticate', async (request: FastifyRequest) => {
            const signedSetup = request.url !== '/v1/machines/managed/actions/setup.skip';
            Object.assign(request, createAuthenticatedRouteRequest({ userId: account.id,
                authTokenLegacy: false,
                ...(signedSetup ? { externalActionExecutionAuthorized: true, externalActionExecutionMachineId: signer,
                externalActionEffectActionId: 'machines.setup.apply', externalActionExecutionRequestId: 'apply',
                externalActionExecutionCustodianAccountId: account.id } : {}),
            }), { headers: request.headers, params: request.params, query: request.query });
        });
        registerManagedMachineRoutes(app);
        onTestFinished(() => app.close());
        const target = { homeId, machineId: guestId, presetId: 'setup-preset', presetRevision: 1 };
        const sources = [{ kind: 'accountPreset', presetId: 'setup-preset', presetRevision: 1, setup },
            { kind: 'direct', setup: {}}];
        const copied = await app.inject({ method: 'POST', url: '/v1/machines/setup/resolve', payload: { homeId, machineId: guestId, sources } });
        expect(copied.statusCode, copied.body).toBe(200);
        const creation = { managedId: row.id, preset: { id: 'setup-preset', revision: 1 } };
        expect(copied.json()).toEqual({ sources, creation });
        const substituted = await app.inject({ method: 'POST', url: '/v1/machines/setup/resolve', payload: { homeId, machineId: guestId,
            sources: [{ ...sources[0], setup: { scripts: [{ body: 'echo client-substitution' }] } }, sources[1]] } });
        expect(substituted.statusCode, substituted.body).toBe(409);
        const report = (state: 'running' | 'failed' | 'succeeded', operationId = 'setup-first') => app.inject({ method: 'POST',
            url: '/v1/machines/setup/report', payload: { ...target, managedId: row.id, state, operation: { operationId },
                ...(state === 'failed' ? { errorCode: 'setup_failed' } : {}) } });
        expect((await report('running')).statusCode).toBe(200);
        expect((await app.inject({ method: 'POST', url: '/v1/machines/managed/actions/setup.skip', payload: {
            homeId, managedId: row.id, expectedIntentRevision: 0 } })).statusCode).toBe(409);
        const failedReport = await report('failed');
        expect(failedReport.statusCode).toBe(200);
        const settledAtMs = failedReport.json().machine.machineSetup.settledAtMs;
        expect(settledAtMs).toEqual(expect.any(Number));
        expect((await report('failed')).json().machine.machineSetup.settledAtMs).toBe(settledAtMs);
        expect((await db.managedMachine.findUniqueOrThrow({ where: { id: row.id } })).machineSetup)
            .toMatchObject({ state: 'failed', operation: { operationId: 'setup-first' }, settledAtMs });
        // A retry reads only the existing creation origin, not a new
        // certification of the Machine-held copy or the edited live Preset.
        const originRequest = { homeId, machineId: guestId, purpose: 'creationOrigin', candidates: [sources[0]] };
        const origin = await app.inject({ method: 'POST', url: '/v1/machines/setup/resolve', payload: originRequest });
        expect(origin.statusCode, origin.body).toBe(200);
        expect(origin.json()).toEqual({ purpose: 'creationOrigin', creation });
        for (const candidate of [{ ...sources[0], presetId: 'unrelated-preset' },
            { ...sources[0], setup: { scripts: [{ body: 'echo substituted' }] } }]) {
            const unrelated = await app.inject({ method: 'POST', url: '/v1/machines/setup/resolve',
                payload: { ...originRequest, candidates: [candidate] } });
            expect(unrelated.statusCode, unrelated.body).toBe(200);
            expect(unrelated.json()).toEqual({ purpose: 'creationOrigin' });
        }
        expect((await report('running', 'setup-retry')).statusCode).toBe(200);
        expect((await report('succeeded', 'setup-first')).statusCode).toBe(409);
        expect((await report('failed', 'setup-retry')).statusCode).toBe(200);
        signer = 'another-machine';
        expect((await report('succeeded', 'setup-retry')).statusCode).toBe(403);
        const skipped = await app.inject({ method: 'POST', url: '/v1/machines/managed/actions/setup.skip', payload: {
            homeId, managedId: row.id, expectedIntentRevision: 0 } });
        expect(skipped.statusCode, skipped.body).toBe(200);
        expect(skipped.json()).toMatchObject({ id: row.id, enrolledMachineId: guestId,
            resource: { value: { id: 'same-native' } }, machineSetup: { setup, state: 'skipped' } });
        signer = guestId;
        expect((await report('succeeded', 'setup-retry')).statusCode).toBe(409);
        expect((await report('running', 'setup-after-skip')).statusCode).toBe(409);
        expect((await app.inject({ method: 'POST', url: '/v1/machines/setup/resolve', payload: originRequest })).json())
            .toEqual({ purpose: 'creationOrigin' });
        expect((await app.inject({ method: 'POST', url: '/v1/machines/setup/resolve', payload: { homeId, machineId: guestId, sources } })).statusCode).toBe(409);
        await db.managedMachine.update({ where: { id: row.id }, data: { desired: 'delete', intentRevision: 1,
            machineSetup: { setup, state: 'running', operation: { operationId: 'setup-delete-race' } } } });
        expect((await report('succeeded', 'setup-delete-race')).statusCode).toBe(409);
        expect(await db.managedMachine.count({ where: { admittedActionRequestId: 'setup-create' } })).toBe(1);
    });

    it('applies admitted setup to the requester guest without granting the custodian guest access', async () => {
        const homeId = `srv_${'a'.repeat(32)}`;
        const custodian = await db.account.create({ data: { encryptionMode: 'plain' } });
        const requester = await db.account.create({ data: { encryptionMode: 'plain' } });
        const controller = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: custodian.id,
            metadata: '{}', installationId: crypto.randomUUID() } });
        const guest = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: requester.id,
            metadata: '{}', installationId: crypto.randomUUID() } });
        await db.machineAccountGrant.create({ data: { machineId: controller.id, accountId: requester.id,
            accessLevel: 'admin', createdByAccountId: custodian.id } });
        const launch = { provider: { pluginId: 'fixture.setup', localId: 'vm' }, schemaVersion: 1, name: 'Requester', choices: {} };
        const setup = { scripts: [{ body: 'echo requester' }] };
        const preset = await db.managedMachinePreset.create({ data: { homeId, custodianAccountId: custodian.id,
            name: 'Admitted', launch, controllerMachineId: controller.id, controllerInstallationId: controller.installationId! } });
        const row = await db.managedMachine.create({ data: { homeId, custodianAccountId: custodian.id,
            controllerMachineId: controller.id, controllerInstallationId: controller.installationId!,
            admittedActionRequestId: crypto.randomUUID(), admittedInput: { enrollmentAccountId: requester.id },
            presetId: preset.id, presetRevision: preset.revision, enrolledMachineId: guest.id, allocation: 'bound', launch,
            resource: { contributionRef: launch.provider, schemaVersion: 1, value: { id: 'requester-setup' } },
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false, machineSetup: { setup, state: 'pending' } } });
        const sources = [{ kind: 'accountPreset' as const, presetId: preset.id, presetRevision: preset.revision, setup },
            { kind: 'direct' as const, setup: {}}];
        const input = { homeId, machineId: guest.id, sources };
        expect(await resolveMachineSetup({ actorAccountId: requester.id, custodianAccountId: requester.id, input }))
            .toMatchObject({ sources, creation: { managedId: row.id } });
        await expect(resolveMachineSetup({ actorAccountId: custodian.id, custodianAccountId: custodian.id, input }))
            .rejects.toMatchObject({ code: 'permission_denied' });
        expect(await reportMachineSetup({ actorAccountId: requester.id, custodianAccountId: requester.id, input: {
            homeId, machineId: guest.id, managedId: row.id, presetId: preset.id, presetRevision: preset.revision,
            state: 'running', operation: { operationId: 'requester-setup' },
        } })).toMatchObject({ machine: { enrollmentAccountId: requester.id, machineSetup: { state: 'running' } } });
        expect(await resolveMachineAccessInTx(db, { actorAccountId: custodian.id, machineId: guest.id })).toBeNull();
    });

    it('includes immutable setup secret references in the retained resource dependency census', async () => {
        const homeId = `srv_${'a'.repeat(32)}`;
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const resourceId = 'immutable-setup-secret';
        const secretOwner = await db.account.create({ data: { encryptionMode: 'plain' } });
        await db.savedSecretResource.create({ data: { id: resourceId, ownerAccountId: secretOwner.id,
            displayName: 'Setup token', kind: 'token', encryptionMode: 'plain',
            storedContent: JSON.stringify({ t: 'plain', v: { v: 1, name: 'Setup token', kind: 'token', value: 'private' } }) } });
        const launch = { provider: { pluginId: 'fixture.setup', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} };
        const preset = await db.managedMachinePreset.create({ data: { homeId, custodianAccountId: account.id, name: 'Preset',
            launch, controllerMachineId: 'immutable-controller', controllerInstallationId: 'immutable-install' } });
        const row = await db.managedMachine.create({ data: { homeId, custodianAccountId: account.id,
            controllerMachineId: 'immutable-controller', controllerInstallationId: 'immutable-install',
            admittedActionRequestId: 'immutable-setup-census', admittedInput: {}, launch, presetId: preset.id, presetRevision: 0,
            allocation: 'may-exist', archivedAt: new Date(), retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            machineSetup: { state: 'pending', setup: { secretRefs: { v: 1,
                bindings: { TOKEN: { ref: `happier:shared-secret:v1:${resourceId}`, revision: 1 } } } } } } });
        expect((await inTx(tx => readManagedResourceDependenciesInTx(tx, { kind: 'saved-secret', resourceId })))
            .map(dependency => dependency.managedId)).toEqual([row.id]);
        expect((await inTx(tx => readManagedResourceDependenciesInTx(tx, { kind: 'account', accountId: secretOwner.id })))
            .map(dependency => dependency.managedId)).toEqual([row.id]);
        expect(await inTx(tx => readManagedResourceDependenciesInTx(tx, { kind: 'saved-secret', resourceId: 'unrelated-secret' }))).toEqual([]);
        await db.managedMachine.update({ where: { id: row.id }, data: { allocation: 'confirmed-absent' } });
        expect(await inTx(tx => readManagedResourceDependenciesInTx(tx, { kind: 'saved-secret', resourceId }))).toEqual([]);
    });

    it("qualifies retained wake against the selected native provisioner at admission", () => {
        expect(qualifyManagedAcquisitionPolicy({ retention: { kind: "unused", afterMs: 17, effect: "stop" }, wakeOnAcceptedMessage: true }, { billing: { location: "cloud", stoppedBilling: "billed" }, retention: { supportedIntents: ["delete"] } })).toMatchObject({ retention: { kind: "unused", afterMs: 17, effect: "delete" }, wakeOnAcceptedMessage: false });
    });

    it("qualifies acquisition against selected native variant capabilities before the descriptor fallback", () => {
        const declaration: Parameters<typeof qualifyManagedAcquisitionPolicy>[1] = { billing: { location: 'cloud', stoppedBilling: 'unknown' },
            retention: { supportedIntents: ['start', 'stop', 'delete'] } };
        const requested = { retention: { kind: 'until-delete' as const }, wakeOnAcceptedMessage: true };
        expect(qualifyManagedAcquisitionPolicy(requested, declaration, { supportedIntents: ['delete'], finiteOnly: true }))
            .toMatchObject({ retention: { kind: 'unused', effect: 'delete' }, wakeOnAcceptedMessage: false });
        expect(qualifyManagedAcquisitionPolicy(requested, declaration, { supportedIntents: ['start', 'stop', 'delete'], finiteOnly: false }))
            .toMatchObject(requested);
        expect(qualifyManagedAcquisitionPolicy(requested, declaration)).toMatchObject(requested);
    });

    it('binds controller capabilities and refuses an inconsistent receipt or another launch', async () => {
        const { account, controller, input, request, launch, manifest } = await createManagedComputeFixture('selected-variant',
            { location: 'cloud', stoppedBilling: 'billed' });
        const reviewedFacts = ManagedConfigurationFactsV1Schema.parse(buildManagedConfigurationFactsV1({ choicesSchema: createPluginJsonSchemaZodValueAdapter(launch.jsonSchema),
            launch: input.selection.launch, controller, optionStatus: 'current', prerequisites: [],
            billing: { location: 'cloud', stoppedBilling: 'billed' }, retentionCapabilities: { supportedIntents: ['delete'], finiteOnly: true },
            machineOverride: { retention: input.selection.retention, wakeOnAcceptedMessage: input.selection.wakeOnAcceptedMessage } }));
        const reviewedRequest = { ...request, input: { ...request.input, input: { ...input, reviewedFacts } } };
        await expect(admitManagedAcquire({ ...reviewedRequest, input: { ...reviewedRequest.input, requestId: 'other-variant-receipt',
            input: { ...input, reviewedFacts: { ...reviewedFacts, launch: { ...reviewedFacts.launch, choices: { image: 'another-image' } } } } } }))
            .rejects.toMatchObject({ code: 'invalid_request' });
        // Controller capabilities now come from its declaration, so a receipt
        // whose policy required requester-only finite capabilities is stale.
        await expect(admitManagedAcquire(reviewedRequest)).rejects.toMatchObject({ code: 'invalid_request' });
        expect(await db.managedMachine.count({ where: { custodianAccountId: account.id } })).toBe(0);
        const provisioner = manifest.contributes?.machineProvisioners?.[0];
        if (!provisioner) throw new Error('Expected controller provisioner');
        const admittedFacts = buildManagedConfigurationFactsV1({ choicesSchema: createPluginJsonSchemaZodValueAdapter(launch.jsonSchema),
            launch: input.selection.launch, controller, optionStatus: 'current', prerequisites: [],
            billing: provisioner.billing, retentionCapabilities: provisioner.retention,
            machineOverride: { retention: input.selection.retention, wakeOnAcceptedMessage: input.selection.wakeOnAcceptedMessage } });
        const currentRequest = { ...reviewedRequest, input: { ...reviewedRequest.input, input: { ...input, reviewedFacts: admittedFacts } } };
        const created = await admitManagedAcquire(currentRequest);
        expect(created.machine).toMatchObject({ retention: input.selection.retention, wakeOnAcceptedMessage: false, reviewedFacts: admittedFacts });
        expect(await db.managedMachine.findUniqueOrThrow({ where: { id: created.machine.id } })).toMatchObject({
            retention: admittedFacts.retention, wakeOnAcceptedMessage: false, reviewedFacts: admittedFacts });
        expect(await admitManagedAcquire(currentRequest)).toMatchObject({ replayed: true, machine: { id: created.machine.id } });
    });

    it("retains managed allocation independently of a Machine or initiating process", async () => {
        const tables = await db.$queryRawUnsafe<Array<{ name: string }>>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('ManagedMachine', 'ManagedMachinePreset')",
        );
        expect(tables.map((table) => table.name).sort()).toEqual(["ManagedMachine", "ManagedMachinePreset"]);
    });

    it("preflights every retained credential purpose once, including archived uncertain allocations", async () => {
        const account = await db.account.create({ data: { publicKey: 'managed-plural-preflight' } });
        const provider = { pluginId: 'fixture.compute', localId: 'compute' };
        const accounts = ['cloud', 'sandbox'].map(accountId => ({
            service: { pluginId: 'fixture.credentials', localId: accountId }, accountId,
        }));
        const row = await db.managedMachine.create({ data: {
            homeId: `srv_${"a".repeat(32)}`, custodianAccountId: account.id,
            controllerMachineId: 'retained-offline-controller', controllerInstallationId: 'retained-installation',
            admittedActionRequestId: 'plural-preflight', admittedInput: {}, allocation: 'may-exist', archivedAt: new Date(),
            launch: { provider, schemaVersion: 1, name: 'Possibly billed', choices: {},
                credentials: accounts.map(ref => ({ purpose: { consumer: provider, purpose: ref.accountId }, account: ref })) },
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
        } });
        for (const ref of accounts) {
            const dependencies = await inTx(tx => readManagedResourceDependenciesInTx(tx, {
                kind: 'connected-account', accountId: account.id, ref,
            }));
            expect(dependencies.map(dependency => dependency.managedId)).toEqual([row.id]);
        }
        const plugin = await inTx(tx => readManagedResourceDependenciesInTx(tx, {
            kind: 'plugin', accountId: account.id, pluginId: 'fixture.credentials',
        }));
        expect(plugin.map(dependency => dependency.managedId)).toEqual([row.id]);
        expect(await inTx(tx => readManagedResourceDependenciesInTx(tx, {
            kind: 'connected-account', accountId: account.id, ref: { ...accounts[0]!, accountId: 'unrelated' },
        }))).toEqual([]);
    });

    it('projects only Home-admitted retention continuations, preserving manual rows in the census', async () => {
        const homeId = `srv_${'a'.repeat(32)}`;
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const keys = tweetnacl.sign.keyPair();
        const controller = { machineId: crypto.randomUUID(), installationId: crypto.randomUUID() };
        await db.machine.create({ data: { id: controller.machineId, accountId: account.id, metadata: '{}',
            installationId: controller.installationId, installationPublicKey: keys.publicKey } });
        const provider = { pluginId: 'fixture.compute', localId: 'vm' };
        const expected: Array<{ managedId: string; requestId: string }> = [];
        const ids: string[] = [];
        for (const kind of ['control', 'policy'] as const) for (const intent of ['stop', 'suspend'] as const) for (const submitted of [false, true]) {
            const requestId = crypto.randomUUID();
            const row = await db.managedMachine.create({ data: { homeId, custodianAccountId: account.id,
                controllerMachineId: controller.machineId, controllerInstallationId: controller.installationId,
                admittedActionRequestId: crypto.randomUUID(), admittedInput: {}, allocation: 'bound', creationState: 'active',
                launch: { provider, schemaVersion: 1, name: 'Guest', choices: {} },
                resource: { contributionRef: provider, schemaVersion: 1, value: {} },
                desired: intent, desiredWhen: 'now', intentRevision: 1,
                retention: { kind: 'unused', afterMs: 3_600_000, effect: 'stop' }, wakeOnAcceptedMessage: true } });
            const correlation = { homeId, managedId: row.id, controller, expectedIntentRevision: 1, requestId };
            await db.managedMachine.update({ where: { id: row.id }, data: { admittedInput: {
                currentAdmission: kind === 'policy' ? { kind, request: { ...correlation, purpose: { kind: 'retention' } } }
                    : { kind, request: { action: 'machines.managed.power.set', requestId,
                        input: { homeId, managedId: row.id, intent, when: 'now', expectedRevision: 0 } } },
                ...(submitted ? { submittedEffect: { ...correlation, intent } } : {}),
            } } });
            ids.push(row.id);
            if (kind === 'policy') expected.push({ managedId: row.id, requestId });
        }
        const app = fastify().withTypeProvider<ZodTypeProvider>();
        app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
        app.decorate('authenticate', async (request: FastifyRequest) => { request.userId = account.id; });
        registerManagedMachineRoutes(app);
        try {
            const response = await app.inject({ method: 'POST', url: '/v1/machines/managed/controller/policies', payload: {
                homeId, controller, proof: createManagedPolicyCensusProofV1({ homeId, controller,
                    custodianAccountId: account.id, privateKey: keys.secretKey }),
            } });
            expect(response.statusCode, response.body).toBe(200);
            const census = ManagedPolicyCensusOutputV1Schema.parse(response.json());
            expect(census.machines.map(machine => machine.id).sort()).toEqual(ids.sort());
            expect(census).toHaveProperty('retentionContinuations', expect.arrayContaining(expected));
            expect(response.json().retentionContinuations).toHaveLength(expected.length);
        } finally { await app.close(); }
    });

    it('includes canceled pending native cleanup in the current controller census before Machine binding', async () => {
        const homeId = `srv_${'a'.repeat(32)}`;
        const account = await db.account.create({ data: { publicKey: 'pending-cleanup-census' } });
        const keys = tweetnacl.sign.keyPair();
        const controller = { machineId: 'pending-census-controller', installationId: 'pending-census-installation' };
        await db.machine.create({ data: { id: controller.machineId, accountId: account.id, metadata: 'ciphertext',
            installationId: controller.installationId, installationPublicKey: Buffer.from(keys.publicKey) } });
        const provider = { pluginId: 'fixture.pending', localId: 'compute' };
        const nativeOperationRef = { contributionRef: provider, schemaVersion: 1, value: { id: 'proven-owned-partial' } };
        const row = await db.managedMachine.create({ data: { homeId, custodianAccountId: account.id,
            controllerMachineId: controller.machineId, controllerInstallationId: controller.installationId,
            admittedActionRequestId: 'pending-census-purchase', admittedInput: {},
            launch: { provider, schemaVersion: 1, name: 'Pending cleanup', choices: {} }, nativeOperationRef,
            allocation: 'may-exist', creationState: 'canceled', desired: 'delete', desiredWhen: 'now',
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            cleanup: { disposition: 'pending', reason: 'creation_canceled' } } });
        const app = fastify().withTypeProvider<ZodTypeProvider>();
        app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
        // Authentication is the boundary; census proof, lifecycle and row projection are real.
        app.decorate('authenticate', async (request: FastifyRequest) => { request.userId = account.id; });
        registerManagedMachineRoutes(app);
        try {
            const response = await app.inject({ method: 'POST', url: '/v1/machines/managed/controller/policies', payload: {
                homeId, controller, proof: createManagedPolicyCensusProofV1({ homeId, controller,
                    custodianAccountId: account.id, privateKey: keys.secretKey }),
            } });
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json().machines).toEqual(expect.arrayContaining([expect.objectContaining({
                id: row.id, allocation: 'may-exist', nativeOperationRef, creationState: 'canceled', desired: 'delete',
            })]));
        } finally { await app.close(); }
    });

    it.each([['retained', 'new-policy'], ['fresh', 'new-policy'], ['retained', 'same-rebuild'], ['fresh', 'requester-account']] as const)(
        "requires fresh managed proof after reviewed rebuild before %s installation reconnects under %s admission", async (installation, settlementAdmission) => {
        const fixtureSuffix = `${installation}-${settlementAdmission}`;
        const sameRebuildAdmission = settlementAdmission === 'same-rebuild';
        const homeId = `srv_${"a".repeat(32)}`;
        // Disposable fixture keys cross the real Account-currentness boundary;
        // an arbitrary public-key label cannot authorize E2EE registration.
        const account = await db.account.create({ data: { ...createSignedAccountContentBinding(), encryptionMode: 'e2ee' } });
        const enrollmentAccount = settlementAdmission === 'requester-account'
            ? await db.account.create({ data: { ...createSignedAccountContentBinding(), encryptionMode: 'e2ee' } }) : account;
        const creationRequestId = `rebuild-creation-${fixtureSuffix}`;
        const controller = { machineId: `managed-rebuild-controller-${fixtureSuffix}`, installationId: `managed-rebuild-controller-install-${fixtureSuffix}` };
        await db.machine.create({ data: { id: controller.machineId, accountId: account.id, metadata: "ciphertext", installationId: controller.installationId,
            pluginMaterializationRevision: BigInt(1) } });
        if (enrollmentAccount.id !== account.id) await db.machineAccountGrant.create({ data: {
            machineId: controller.machineId, accountId: enrollmentAccount.id, accessLevel: 'admin', createdByAccountId: account.id,
        } });
        const native = defineProtocolObject({ id: defineProtocolString({ minLength: 1 }) }, { policy: "closed" });
        const roles = defineMachineProvisionerSchemas({ launch: native, resource: native });
        const definitions = [
            { id: "check", inputSchema: roles.checkInput.jsonSchema, resultSchema: MachineProvisionerCheckResultProtocolV1Schema.jsonSchema },
            { id: "acquire", inputSchema: roles.acquireInput.jsonSchema, resultSchema: roles.acquireResult.jsonSchema },
            { id: "bootstrap", inputSchema: roles.bootstrapInput.jsonSchema, resultSchema: MachineProvisionerBootstrapCarrierV1Schema.jsonSchema },
            { id: "inspect", inputSchema: roles.resourceInput.jsonSchema, resultSchema: MachineProvisionerObservationV1Schema.jsonSchema },
            { id: "destroy", inputSchema: roles.resourceInput.jsonSchema, resultSchema: MachineProvisionerPowerResultV1Schema.jsonSchema },
            { id: "rebuild", inputSchema: roles.rebuildInput.jsonSchema, resultSchema: roles.rebuildResult.jsonSchema },
        ];
        const manifest = PluginManifestV2Schema.parse({ schemaVersion: 2, id: "fixture.rebuild", version: "1.0.0", displayName: "Rebuild fixture", engines: { happier: "^1.0.0" }, runtime: { apiVersion: 1 }, contributes: {
            machineProvisioners: [{ id: "child", title: "Child", icon: "machine", resourceKind: "devcontainer", schemaVersion: 1,
                launchSchema: native.jsonSchema, resourceSchema: native.jsonSchema, platforms: ["linux"], prerequisites: [],
                billing: { location: "local", stoppedBilling: "not-billed" }, retention: { supportedIntents: ["delete", "rebuild"] },
                actions: { check: "check", acquire: "acquire", bootstrap: "bootstrap", inspect: "inspect", destroy: "destroy", rebuild: "rebuild" } }],
            actions: definitions.map(action => ({ ...action, title: action.id, execution: { target: "daemon" }, surfaces: ["plugin"], scopes: ["global"], dangerLevel: "safe" })),
        } });
        const declaration = createReleaseLessDeclarationV1(manifest);
        await db.accountPluginIntent.create({ data: { accountId: account.id, pluginId: manifest.id, enabled: true, writableCollections: [], releaseLessDeclaration: declaration } });
        await db.pluginMachineMaterialization.create({ data: { accountId: account.id, serverIdentityId: homeId, machineId: controller.machineId, materializationId: controller.installationId,
            pluginId: manifest.id, version: manifest.version, sourceClass: "bundledFirstParty", portableRelease: false, archiveDigestSha256: declaration.manifestDigestSha256,
            uiArtifacts: [], enabled: true, trustState: "trusted", observedAt: new Date() } });
        const decoyController = { machineId: `managed-rebuild-decoy-controller-${fixtureSuffix}`, installationId: `managed-rebuild-decoy-installation-${fixtureSuffix}` };
        await db.machine.create({ data: { id: decoyController.machineId, accountId: account.id, metadata: 'ciphertext', installationId: decoyController.installationId,
            pluginMaterializationRevision: BigInt(1) } });
        await db.pluginMachineMaterialization.create({ data: { accountId: account.id, serverIdentityId: homeId, machineId: decoyController.machineId,
            materializationId: decoyController.installationId, pluginId: manifest.id, version: manifest.version, sourceClass: 'bundledFirstParty',
            portableRelease: false, archiveDigestSha256: declaration.manifestDigestSha256, uiArtifacts: [], enabled: true, trustState: 'trusted', observedAt: new Date() } });
        const decoy = await admitManagedAcquire({ requesterAccountId: account.id, custodianAccountId: account.id, requestEnvelopeDigest: 'reviewed-decoy-creation', input: {
            requestId: `rebuild-decoy-${fixtureSuffix}`, continuationPresent: false, input: { enrollmentIdentity: { kind: 'guestProcess', role: 'sandbox' }, selection: { kind: 'one-off', homeId, controller: decoyController,
                launch: { provider: { pluginId: manifest.id, localId: 'child' }, schemaVersion: 1, name: 'Decoy', choices: { id: 'decoy' } },
                retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } },
        } });
        const created = await admitManagedAcquire({ requesterAccountId: enrollmentAccount.id, custodianAccountId: account.id, requestEnvelopeDigest: "reviewed-child-creation", input: {
            requestId: creationRequestId, continuationPresent: false, input: { enrollmentIdentity: { kind: 'guestProcess', role: 'sandbox' }, selection: { kind: "one-off", homeId, controller,
                launch: { provider: { pluginId: manifest.id, localId: "child" }, schemaVersion: 1, name: "child", choices: { id: "config" } },
                retention: { kind: "until-delete" }, wakeOnAcceptedMessage: false } },
        } });
        const original = { homeId, managedId: created.machine.id, expectedIntentRevision: 0, requestId: creationRequestId, controller };
        const resource = { contributionRef: { pluginId: manifest.id, localId: "child" }, schemaVersion: 1, value: { id: "old-native" },
            devcontainerObservation: { nativeResourceId: 'old-native', user: 'coder', workspaceFolder: '/work',
                storage: { kind: 'child' as const, childPath: '/work' } } };
        await submitManagedAcquire(original);
        await reportManagedAcquire({ ...original, result: { kind: "bound", resource }, bootstrapInstalled: true });
        const oldGuestKeys = tweetnacl.sign.keyPair();
        const oldGuest = await db.machine.create({ data: { id: `managed-rebuild-old-guest-${fixtureSuffix}`, accountId: enrollmentAccount.id, metadata: "ciphertext",
            installationId: `old-installation-${fixtureSuffix}`, installationPublicKey: Buffer.from(oldGuestKeys.publicKey) } });
        await inTx(tx => linkManagedEnrollmentInTx(tx, { ...original, resource }, enrollmentAccount.id, oldGuest.id));
        const registrationApp = fastify().withTypeProvider<ZodTypeProvider>();
        registrationApp.setValidatorCompiler(validatorCompiler);
        registrationApp.setSerializerCompiler(serializerCompiler);
        // HTTP authentication is the boundary. The retained installation proof,
        // registration transaction, and managed enrollment owners stay real.
        registrationApp.decorate('authenticate', async (request: FastifyRequest) => {
            Object.assign(request, createAuthenticatedRouteRequest({ userId: enrollmentAccount.id }),
                { headers: request.headers, params: request.params, query: request.query });
        });
        machinesRoutes(registrationApp);
        onTestFinished(() => registrationApp.close());
        const retainedRegistration = {
            id: oldGuest.id, metadata: oldGuest.metadata,
            installationId: oldGuest.installationId!, installationPublicKey: Buffer.from(oldGuestKeys.publicKey).toString('base64url'),
            installationProof: signMachineInstallationProof({ payload: { version: 1, machineId: oldGuest.id,
                installationId: oldGuest.installationId!, accountId: enrollmentAccount.id }, privateKey: oldGuestKeys.secretKey }),
        };
        const originalReconnect = await registrationApp.inject({ method: 'POST', url: '/v1/machines', payload: retainedRegistration });
        expect(originalReconnect.statusCode, originalReconnect.body).toBe(200);
        const session = await db.session.create({ data: { accountId: enrollmentAccount.id, tag: "managed-rebuild-retained-session", metadata: "history-and-draft" } });
        await db.accessKey.create({ data: { accountId: enrollmentAccount.id, machineId: oldGuest.id, sessionId: session.id, data: "retained-key" } });
        const control = { actorAccountId: account.id, custodianAccountId: account.id, input: { action: "machines.managed.rebuild", requestId: "reviewed-rebuild", input: {
            homeId, managedMachineId: created.machine.id, kind: "rebuild", expectedRevision: 0, reviewedEffectDigest: "reviewed-host-child-effects",
        } } } as const;
        const app = fastify().withTypeProvider<ZodTypeProvider>();
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        // The externally verified HTTP principal is the boundary. Controller
        // binding, selected row lookup and admission execute their real owners.
        app.decorate('authenticate', async (request: FastifyRequest) => {
            Object.assign(request, createAuthenticatedRouteRequest({ userId: account.id,
                externalActionExecutionAuthorized: true, externalActionExecutionMachineId: controller.machineId,
                externalActionEffectActionId: control.input.action, externalActionExecutionRequestId: control.input.requestId,
                externalActionExecutionCustodianAccountId: account.id,
            }), { headers: request.headers, params: request.params, query: request.query });
        });
        registerManagedMachineRoutes(app);
        onTestFinished(() => app.close());
        const response = await app.inject({ method: 'POST', url: '/v1/machines/managed/controller/admit-control', payload: control.input });
        expect(response.statusCode, response.body).toBe(200);
        const accepted = response.json<Awaited<ReturnType<typeof admitManagedControl>>>();
        expect(accepted.machine).toMatchObject({ id: created.machine.id, intentRevision: 1, desired: "rebuild", enrolledMachineId: oldGuest.id });
        await expect(admitManagedControl({ ...control, input: { ...control.input, requestId: "stale-rebuild" } })).rejects.toMatchObject({ code: "intent_changed" });
        const current = { ...original, expectedIntentRevision: 1, requestId: "reviewed-rebuild" };
        const submitted = await submitManagedIntent(current);
        expect(submitted.machine.submittedNativeEffect).toMatchObject({ reviewedEffectDigest: 'reviewed-host-child-effects' });
        const uncertain = await reportManagedIntent({ ...current, result: { kind: 'unknown', recovery: { reference: 'old-native', reason: 'native_rebuild_unknown' } },
            observation: { observedAt: 1, availability: 'absent' } });
        expect(uncertain.machine).toMatchObject({ allocation: 'bound', recovery: { reference: 'old-native', reason: 'native_rebuild_unknown' },
            submittedNativeEffect: { intent: 'rebuild' } });
        const stillUncertain = await reportManagedIntent({ ...current, result: { kind: 'unknown', recovery: { reference: 'old-native', reason: 'native_rebuild_unknown' } },
            observation: { observedAt: 2, availability: 'present' } });
        expect(stillUncertain.machine.submittedNativeEffect).toMatchObject({ intent: 'rebuild' });
        await expect(inTx(tx => requireManagedEnrollmentInTx(tx, { ...current, resource }, account.id))).rejects.toMatchObject({ code: 'enrollment_retired' });
        await expect(reportManagedIntent({ ...current, result: { kind: 'bound', resource } })).rejects.toMatchObject({ code: 'resource_mismatch' });
        await expect(reportManagedIntent({ ...current, result: { kind: 'bound', resource: { ...resource,
            devcontainerObservation: { ...resource.devcontainerObservation, user: 'different-user' } } } })).rejects.toMatchObject({ code: 'resource_mismatch' });
        if (!sameRebuildAdmission) {
            const updatedPolicy = await admitManagedControl({ actorAccountId: account.id, custodianAccountId: account.id,
                input: { action: 'machines.managed.retention.update', requestId: 'reviewed-policy', input: { homeId, managedId: created.machine.id,
                    expectedIntentRevision: 1, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } } });
            expect(updatedPolicy.machine.submittedNativeEffect).toMatchObject({ reviewedEffectDigest: 'reviewed-host-child-effects', requestId: 'reviewed-rebuild' });
        }
        const enrollmentRevision = sameRebuildAdmission ? 1 : 2;
        const enrollmentRequestId = sameRebuildAdmission ? current.requestId : 'reviewed-policy';
        const replacement = { ...resource, value: { id: "new-native" },
            devcontainerObservation: { ...resource.devcontainerObservation, nativeResourceId: 'new-native' } };
        const replacementPublications: unknown[] = [];
        eventRouter.setIo({ to: () => ({ emit: (event, payload) => { if (event === 'update') replacementPublications.push(payload); },
            disconnectSockets: () => undefined }) });
        onTestFinished(() => eventRouter.clearIo());
        const reported = await reportManagedIntent({ ...current, result: { kind: "bound", resource: replacement } });
        expect(reported.machine).toMatchObject({ id: created.machine.id, allocation: "bound", resource: replacement, intentRevision: enrollmentRevision });
        expect(reported.machine.enrolledMachineId).toBeUndefined();
        expect(reported.machine.bootstrapInstalled).toBeUndefined();
        expect(replacementPublications.flatMap(value => {
            const parsed = UpdateContainerSchema.safeParse(value);
            return parsed.success ? [parsed.data.body] : [];
        })).toEqual(expect.arrayContaining([expect.objectContaining({
            t: 'update-machine', machineId: oldGuest.id, devcontainerChild: null,
        })]));
        expect((await db.machine.findUniqueOrThrow({ where: { id: oldGuest.id } })).metadata).toBe('ciphertext');
        // A replacement's reviewed startup hook may run a retained-Home daemon
        // before protected fresh enrollment. Ordinary registration must not
        // turn that pending replacement into an unrelated ordinary Machine.
        const unprovedReconnect = await registrationApp.inject({ method: 'POST', url: '/v1/machines', payload: retainedRegistration });
        expect(unprovedReconnect.statusCode, unprovedReconnect.body).toBe(409);
        expect(unprovedReconnect.json()).toMatchObject({ error: 'invalid-params', reason: 'enrollment_retired' });
        expect(await db.managedMachine.findUniqueOrThrow({ where: { id: created.machine.id } })).toMatchObject({ enrolledMachineId: null });
        // A current proof for another managed row is not the replacement's
        // proof, even when its custodian and provisioner are the same.
        const decoyResource = { contributionRef: resource.contributionRef, schemaVersion: 1, value: { id: 'decoy-native' } };
        const decoyCorrelation = { homeId, managedId: decoy.machine.id, expectedIntentRevision: 0,
            requestId: `rebuild-decoy-${fixtureSuffix}`, controller: decoyController };
        await submitManagedAcquire(decoyCorrelation);
        await reportManagedAcquire({ ...decoyCorrelation, result: { kind: 'bound', resource: decoyResource } });
        const unrelatedProof = await registrationApp.inject({ method: 'POST', url: '/v1/machines', payload: {
            ...retainedRegistration, managedEnrollment: { ...decoyCorrelation, resource: decoyResource },
        } });
        expect(unrelatedProof.statusCode, unrelatedProof.body).toBe(409);
        expect(unrelatedProof.json()).toMatchObject({ error: 'invalid-params', reason: 'enrollment_retired' });
        expect(await db.managedMachine.findUniqueOrThrow({ where: { id: decoy.machine.id } })).toMatchObject({ enrolledMachineId: null });
        await expect(inTx(tx => requireManagedEnrollmentInTx(tx, { ...original, resource }, account.id))).rejects.toMatchObject({ code: "intent_changed" });
        if (!sameRebuildAdmission) await expect(inTx(tx => requireManagedEnrollmentInTx(tx, { ...current, resource: replacement }, account.id))).rejects.toMatchObject({ code: "request_conflict" });
        const newGuestKeys = installation === 'retained' ? oldGuestKeys : tweetnacl.sign.keyPair();
        const enrolledGuest = installation === 'retained' ? oldGuest : {
            id: `managed-rebuild-new-guest-${fixtureSuffix}`, accountId: enrollmentAccount.id, metadata: 'ciphertext',
            installationId: `new-installation-${fixtureSuffix}`, installationPublicKey: Buffer.from(newGuestKeys.publicKey),
        };
        let racedCreate = false;
        if (installation === 'fresh') {
            const machineDelegate = db.machine;
            const originalReadMachine = machineDelegate.findFirst;
            const readMachine = originalReadMachine.bind(machineDelegate);
            // Only the database read boundary is interleaved. The winning insert,
            // unique failure, enrollment transaction and identity update are real.
            const interleavedRead = ((args: Parameters<typeof readMachine>[0]) => readMachine(args).then(async currentMachine => {
                if (!currentMachine && args?.where?.id === enrolledGuest.id && !racedCreate) {
                    await db.machine.create({ data: { id: enrolledGuest.id, accountId: enrollmentAccount.id, metadata: enrolledGuest.metadata } });
                    racedCreate = true;
                }
                return currentMachine;
            })) as typeof readMachine;
            // Prisma exposes delegate methods virtually; spy restoration can
            // remove that virtual method for the next fixture. Restore the
            // captured database boundary itself, not its property descriptor.
            machineDelegate.findFirst = interleavedRead;
            onTestFinished(() => { machineDelegate.findFirst = originalReadMachine; });
        }
        const protectedRegistration = {
            id: enrolledGuest.id, metadata: enrolledGuest.metadata,
            installationId: enrolledGuest.installationId!, installationPublicKey: Buffer.from(newGuestKeys.publicKey).toString('base64url'),
            installationProof: signMachineInstallationProof({ payload: { version: 1, machineId: enrolledGuest.id,
                installationId: enrolledGuest.installationId!, accountId: enrollmentAccount.id }, privateKey: newGuestKeys.secretKey }),
            managedEnrollment: { ...current, expectedIntentRevision: enrollmentRevision, requestId: enrollmentRequestId, resource: replacement },
        };
        const protectedReconnect = await registrationApp.inject({ method: 'POST', url: '/v1/machines', payload: protectedRegistration });
        expect(protectedReconnect.statusCode, protectedReconnect.body).toBe(200);
        expect(protectedReconnect.json()).toMatchObject({ machine: { id: enrolledGuest.id,
            installationId: enrolledGuest.installationId,
            installationPublicKey: Buffer.from(newGuestKeys.publicKey).toString('base64'),
            devcontainerChild: { relation: { managedMachineId: created.machine.id }, observation: replacement.devcontainerObservation } } });
        expect(racedCreate).toBe(installation === 'fresh');
        const adoptedGuest = await db.machine.findUniqueOrThrow({ where: { id: enrolledGuest.id } });
        expect(adoptedGuest.installationId).toBe(enrolledGuest.installationId);
        expect(adoptedGuest.installationPublicKey).not.toBeNull();
        if (!adoptedGuest.installationPublicKey) throw new Error('Committed installation proof must retain its public key');
        expect(Buffer.from(adoptedGuest.installationPublicKey)).toEqual(Buffer.from(newGuestKeys.publicKey));
        expect((await getManagedMachine({ actorAccountId: account.id, input: { homeId, managedId: created.machine.id } })).enrolledMachineId).toBe(enrolledGuest.id);
        expect(await db.managedMachine.count({ where: { id: created.machine.id } })).toBe(1);
        expect(await db.session.findUniqueOrThrow({ where: { id: session.id } })).toMatchObject({ metadata: "history-and-draft" });
        expect(await db.accessKey.findFirst({ where: { sessionId: session.id } })).toMatchObject({ machineId: oldGuest.id });
        expect(await db.machine.findUniqueOrThrow({ where: { id: oldGuest.id } })).toMatchObject({
            revokedAt: null, replacedByMachineId: installation === 'retained' ? null : enrolledGuest.id,
            ...(installation === 'fresh' ? { active: false, replacementSource: 'automatic' } : {}),
        });
        const admittedReconnect = await registrationApp.inject({ method: 'POST', url: '/v1/machines', payload: {
            ...protectedRegistration, managedEnrollment: undefined,
        } });
        expect(admittedReconnect.statusCode, admittedReconnect.body).toBe(200);
        if (sameRebuildAdmission) {
            // Public retry keeps the original reviewed request, but successful
            // replacement+fresh proof is not permission to destroy it again.
            const replayResponse = await app.inject({ method: 'POST', url: '/v1/machines/managed/controller/admit-control', payload: control.input });
            expect(replayResponse.statusCode, replayResponse.body).toBe(200);
            const replay = replayResponse.json<Awaited<ReturnType<typeof admitManagedControl>>>();
            expect(replay).toMatchObject({ replayed: true, machine: { id: created.machine.id,
                intentRevision: enrollmentRevision, resource: replacement, enrolledMachineId: enrolledGuest.id } });
            const replaySubmission = await app.inject({ method: 'POST', url: '/v1/machines/managed/controller/submit-intent', payload: current });
            expect(replaySubmission.statusCode, replaySubmission.body).toBe(200);
            expect(replaySubmission.json()).toMatchObject({ submitted: false, machine: {
                intentRevision: enrollmentRevision, resource: replacement, enrolledMachineId: enrolledGuest.id,
            } });
            expect(await db.managedMachine.findUniqueOrThrow({ where: { id: created.machine.id } })).toMatchObject({
                intentRevision: enrollmentRevision, resource: replacement, enrolledMachineId: enrolledGuest.id,
                admittedInput: { currentAdmission: { kind: 'control', request: control.input } },
            });
        }
        if (installation === 'retained') {
            const manualRebuildRequestId = 'reviewed-manual-responsibility-rebuild';
            await admitManagedControl({ actorAccountId: account.id, custodianAccountId: account.id, input: {
                action: 'machines.managed.rebuild', requestId: manualRebuildRequestId, input: {
                    homeId, managedMachineId: created.machine.id, kind: 'rebuild', expectedRevision: enrollmentRevision,
                    reviewedEffectDigest: 'reviewed-manual-rebuild-effects',
                },
            } });
            const manualRevision = enrollmentRevision + 1;
            const manualRebuild = { ...current, expectedIntentRevision: manualRevision, requestId: manualRebuildRequestId };
            await submitManagedIntent(manualRebuild);
            const manualResource = { ...replacement, value: { id: 'manual-native' },
                devcontainerObservation: { ...replacement.devcontainerObservation, nativeResourceId: 'manual-native' } };
            await reportManagedIntent({ ...manualRebuild, result: { kind: 'bound', resource: manualResource } });
            const ordinaryRegistration = { ...protectedRegistration, managedEnrollment: undefined };
            expect((await registrationApp.inject({ method: 'POST', url: '/v1/machines', payload: ordinaryRegistration })).statusCode).toBe(409);
            await admitManagedControl({ actorAccountId: account.id, custodianAccountId: account.id, input: {
                action: 'machines.managed.retire', requestId: 'reviewed-manual-retirement', input: {
                    homeId, managedId: created.machine.id, expectedIntentRevision: manualRevision, manualResponsibility: true,
                },
            } });
            const manuallyOwnedReconnect = await registrationApp.inject({ method: 'POST', url: '/v1/machines', payload: ordinaryRegistration });
            expect(manuallyOwnedReconnect.statusCode, manuallyOwnedReconnect.body).toBe(200);
            expect(await db.managedMachine.findUniqueOrThrow({ where: { id: created.machine.id } })).toMatchObject({
                archivedAt: expect.any(Date), enrolledMachineId: null, resource: manualResource,
                admittedInput: { replacementEnrollment: { machineId: enrolledGuest.id } },
                cleanup: { disposition: 'unavailable', reason: 'manual_responsibility' },
            });
            expect(await db.session.findUniqueOrThrow({ where: { id: session.id } })).toMatchObject({ metadata: 'history-and-draft' });
        }
    });

    async function createManagedComputeFixture(suffix: string,
        billing: { location: 'local' | 'cloud'; stoppedBilling: 'billed' | 'not-billed' } = { location: 'local', stoppedBilling: 'not-billed' }) {
        const homeId = `srv_${"a".repeat(32)}`;
        const account = await db.account.create({ data: { publicKey: `managed-${suffix}-admission` } });
        const controller = { machineId: `managed-${suffix}-controller`, installationId: `${suffix}-installation` };
        const controllerKeys = tweetnacl.sign.keyPair();
        await db.machine.create({ data: { id: controller.machineId, accountId: account.id, metadata: "ciphertext", installationId: controller.installationId,
            installationPublicKey: Buffer.from(controllerKeys.publicKey), pluginMaterializationRevision: BigInt(1) } });
        const launch = defineProtocolObject({ image: defineProtocolString({ minLength: 1 }) }, { policy: "closed" });
        const native = defineProtocolObject({ id: defineProtocolString({ minLength: 1 }) }, { policy: "closed" });
        const roles = defineMachineProvisionerSchemas({ launch, resource: native });
        const actions = [
            { id: "check", inputSchema: roles.checkInput.jsonSchema, resultSchema: MachineProvisionerCheckResultProtocolV1Schema.jsonSchema },
            { id: "acquire", inputSchema: roles.acquireInput.jsonSchema, resultSchema: roles.acquireResult.jsonSchema },
            { id: "bootstrap", inputSchema: roles.bootstrapInput.jsonSchema, resultSchema: MachineProvisionerBootstrapCarrierV1Schema.jsonSchema },
            { id: "inspect", inputSchema: roles.resourceInput.jsonSchema, resultSchema: MachineProvisionerObservationV1Schema.jsonSchema },
            { id: "destroy", inputSchema: roles.resourceInput.jsonSchema, resultSchema: MachineProvisionerPowerResultV1Schema.jsonSchema },
            { id: "power", inputSchema: roles.powerInput.jsonSchema, resultSchema: MachineProvisionerPowerResultV1Schema.jsonSchema },
        ];
        const manifest = PluginManifestV2Schema.parse({ schemaVersion: 2, id: "fixture.compute", version: "1.0.0", displayName: "Managed integration fixture", engines: { happier: "^1.0.0" }, runtime: { apiVersion: 1 }, contributes: {
            machineProvisioners: [{ id: "compute", title: "Guest", icon: "machine", resourceKind: "vm", schemaVersion: 1, launchSchema: launch.jsonSchema, resourceSchema: native.jsonSchema, platforms: ["linux"], prerequisites: [], billing, retention: { supportedIntents: ["start", "stop", "delete", "resume"] }, actions: { check: "check", acquire: "acquire", bootstrap: "bootstrap", inspect: "inspect", power: "power", destroy: "destroy" } }],
            actions: actions.map(action => ({ ...action, title: action.id, execution: { target: "daemon" }, surfaces: ["plugin"], scopes: ["global"], dangerLevel: "safe" })),
        } });
        const declaration = createReleaseLessDeclarationV1(manifest);
        await db.accountPluginIntent.create({ data: { accountId: account.id, pluginId: manifest.id, enabled: true, writableCollections: [], releaseLessDeclaration: declaration } });
        await db.pluginMachineMaterialization.create({ data: { accountId: account.id, serverIdentityId: homeId, machineId: controller.machineId, materializationId: controller.installationId, pluginId: manifest.id, version: manifest.version, sourceClass: "bundledFirstParty", portableRelease: false, archiveDigestSha256: declaration.manifestDigestSha256, uiArtifacts: [], enabled: true, trustState: "trusted", observedAt: new Date() } });
        const input = { enrollmentIdentity: { kind: 'existingUser' as const, role: 'adopted' as const },
            selection: { kind: "one-off" as const, homeId, controller, launch: { provider: { pluginId: manifest.id, localId: "compute" }, schemaVersion: 1, name: "reviewed", choices: { image: "linux" } }, retention: { kind: "until-delete" as const }, wakeOnAcceptedMessage: false } };
        const request = { requesterAccountId: account.id, custodianAccountId: account.id, requestEnvelopeDigest: "verified-original-private-continuation", input: { input, requestId: `managed-${suffix}-request`, continuationPresent: true } };
        return { homeId, account, controller, controllerKeys, manifest, declaration, input, request, launch, native };
    }

    it.each(['account', 'daemon'] as const)('clears only a portable %s cloud controller and retains its admitted descriptor', async target => {
        const selected = await createManagedComputeFixture(`clear-${target}`, { location: 'cloud', stoppedBilling: 'not-billed' });
        const { homeId, account, controller, input } = selected;
        const manifest = PluginManifestV2Schema.parse({ ...selected.manifest, contributes: { ...selected.manifest.contributes,
            actions: selected.manifest.contributes?.actions?.map(action => ({ ...action, execution: target === 'account'
                ? { target, account: { artifactId: 'account-runtime', exportName: 'activateAccount' } } : { target } })) } });
        const declaration = createReleaseLessDeclarationV1(manifest);
        await db.accountPluginIntent.update({ where: { accountId_pluginId: { accountId: account.id, pluginId: manifest.id } },
            data: { releaseLessDeclaration: declaration } });
        await db.pluginMachineMaterialization.updateMany({ where: { machineId: controller.machineId, pluginId: manifest.id },
            data: { archiveDigestSha256: declaration.manifestDigestSha256 } });
        const row = await db.managedMachine.create({ data: { homeId, custodianAccountId: account.id,
            controllerMachineId: controller.machineId, controllerInstallationId: controller.installationId,
            admittedActionRequestId: crypto.randomUUID(), admittedInput: { enrollmentAccountId: account.id },
            launch: input.selection.launch, allocation: 'bound', resource: { contributionRef: input.selection.launch.provider,
                schemaVersion: 1, value: { id: 'same-cloud-resource' } }, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: true } });
        const request = { action: 'machines.managed.controller.update' as const, requestId: crypto.randomUUID(),
            input: { homeId, managedId: row.id, expectedIntentRevision: 0, controller: null, reviewedPendingEffects: true as const } };
        const clear = () => admitManagedControl({ actorAccountId: account.id, custodianAccountId: account.id, input: request });
        if (target === 'daemon') {
            await expect(clear()).rejects.toMatchObject({ code: 'provider_unavailable' });
            expect(await db.managedMachine.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ controllerMachineId: controller.machineId });
            return;
        }
        const changed = await clear();
        expect(changed.machine.controller).toBeUndefined();
        expect(changed.machine.reviewedFacts?.provisioner).toEqual(manifest.contributes!.machineProvisioners![0]);
        await db.machine.update({ where: { id: controller.machineId }, data: { revokedAt: new Date() } });
        expect(await getManagedMachine({ actorAccountId: account.id, input: { homeId, managedId: row.id } }))
            .toMatchObject({ id: row.id, resource: { value: { id: 'same-cloud-resource' } }, reviewedFacts: { provisioner: { id: 'compute' } } });
    });

    it.each(['retained', 'absent'] as const)('preserves the Account Move prerequisite boundary with %s reviewed observations', async observations => {
        const selected = await createManagedComputeFixture(`clear-prerequisite-${observations}`, { location: 'cloud', stoppedBilling: 'not-billed' });
        const { homeId, account, controller, input } = selected;
        const requirement = { kind: 'managedDependency' as const, id: 'fixture-executable' };
        const manifest = PluginManifestV2Schema.parse({ ...selected.manifest, contributes: { ...selected.manifest.contributes,
            machineProvisioners: selected.manifest.contributes?.machineProvisioners?.map(provisioner => ({ ...provisioner, prerequisites: [requirement] })),
            actions: selected.manifest.contributes?.actions?.map(action => ({ ...action,
                execution: { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activateAccount' } } })) } });
        const declaration = createReleaseLessDeclarationV1(manifest);
        await db.accountPluginIntent.update({ where: { accountId_pluginId: { accountId: account.id, pluginId: manifest.id } },
            data: { releaseLessDeclaration: declaration } });
        await db.pluginMachineMaterialization.updateMany({ where: { machineId: controller.machineId, pluginId: manifest.id },
            data: { archiveDigestSha256: declaration.manifestDigestSha256 } });
        const provisioner = manifest.contributes!.machineProvisioners![0];
        const prerequisites = [{ requirement, status: 'unavailable' as const, reason: 'The reviewed executable is unavailable' }];
        const reviewedFacts = buildManagedConfigurationFactsV1({ choicesSchema: createPluginJsonSchemaZodValueAdapter(selected.launch.jsonSchema),
            launch: input.selection.launch, controller, optionStatus: 'current', provisioner, prerequisites,
            billing: provisioner.billing, retentionCapabilities: provisioner.retention,
            machineOverride: { retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: true } });
        const row = await db.managedMachine.create({ data: { homeId, custodianAccountId: account.id,
            controllerMachineId: controller.machineId, controllerInstallationId: controller.installationId,
            admittedActionRequestId: crypto.randomUUID(), admittedInput: { enrollmentAccountId: account.id },
            launch: input.selection.launch, allocation: 'bound', resource: { contributionRef: input.selection.launch.provider,
                schemaVersion: 1, value: { id: 'same-cloud-resource' } }, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: true,
            ...(observations === 'retained' ? { reviewedFacts } : {}) } });
        const request = { action: 'machines.managed.controller.update' as const, requestId: crypto.randomUUID(),
            input: { homeId, managedId: row.id, expectedIntentRevision: 0, controller: null, reviewedPendingEffects: true as const } };
        const move = () => admitManagedControl({ actorAccountId: account.id, custodianAccountId: account.id, input: request });
        if (observations === 'absent') {
            await expect(move()).rejects.toMatchObject({ code: 'provider_unavailable' });
            expect(await db.managedMachine.findUniqueOrThrow({ where: { id: row.id } })).toEqual(row);
            return;
        }
        const changed = await move();
        expect(changed.machine.controller).toBeUndefined();
        expect(changed.machine.reviewedFacts?.prerequisites).toEqual(prerequisites);
        expect(changed.machine.resource).toEqual(row.resource);
        expect((await db.managedMachine.findUniqueOrThrow({ where: { id: row.id } })).reviewedFacts)
            .toMatchObject({ prerequisites, provisioner });
    });

    it('enforces requester-owned idle proof while retaining custodian native policy authority', async () => {
        const { account: custodian, homeId, controller, input } = await createManagedComputeFixture('requester-retention');
        const requester = await db.account.create({ data: { publicKey: 'requester-retention-key' } });
        const keys = tweetnacl.sign.keyPair();
        const guest = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: requester.id,
            metadata: 'ciphertext', installationId: crypto.randomUUID(), installationPublicKey: keys.publicKey } });
        const resource = { contributionRef: input.selection.launch.provider, schemaVersion: 1, value: { id: 'requester-retention-native' } };
        const row = await db.managedMachine.create({ data: { homeId, custodianAccountId: custodian.id,
            controllerMachineId: controller.machineId, controllerInstallationId: controller.installationId,
            admittedActionRequestId: crypto.randomUUID(), admittedInput: { enrollmentAccountId: requester.id },
            launch: input.selection.launch, allocation: 'bound', resource, enrolledMachineId: guest.id,
            retention: { kind: 'unused', afterMs: 17, effect: 'stop' }, wakeOnAcceptedMessage: false } });
        expect(await inTx(tx => resolveMachineAccessInTx(tx, { actorAccountId: custodian.id, machineId: guest.id }))).toBeNull();
        const context = { actorAccountId: custodian.id, custodianAccountId: requester.id, machineId: guest.id,
            installationId: guest.installationId!, role: 'manage' as const, encryptionMode: 'e2ee' as const };
        const managedTarget = { homeId, managedId: row.id, expectedRevision: 0, controller };
        const method = `${guest.id}:managed.admission.drain.confirm`;
        const decision = { kind: 'idle' as const, since: 100, confirmedAt: 118 };
        const evidence: ManagedCommittedIdleEvidenceV1 = { context, method, managedTarget, decision,
            proof: signMachineInstallationProof({ payload: { version: 1, machineId: guest.id,
                installationId: guest.installationId!, accountId: requester.id,
                rpcAdmission: { context, method, managedTarget, managedIdleDecision: decision } }, privateKey: keys.secretKey }) };
        const policyInput = { homeId, managedId: row.id, expectedIntentRevision: 0, requestId: crypto.randomUUID(), controller,
            purpose: { kind: 'retention' as const, evidence } };
        const wrongContext = { ...context, custodianAccountId: custodian.id };
        await expect(admitManagedPolicy({ custodianAccountId: custodian.id, input: { ...policyInput,
            purpose: { kind: 'retention', evidence: { ...evidence, context: wrongContext,
                proof: signMachineInstallationProof({ payload: { version: 1, machineId: guest.id,
                    installationId: guest.installationId!, accountId: custodian.id,
                    rpcAdmission: { context: wrongContext, method, managedTarget, managedIdleDecision: decision } }, privateKey: keys.secretKey }) } } } }))
            .rejects.toMatchObject({ code: 'permission_denied' });
        await expect(admitManagedPolicy({ custodianAccountId: requester.id, input: policyInput })).rejects.toMatchObject({ code: 'permission_denied' });
        expect(await admitManagedPolicy({ custodianAccountId: custodian.id, input: policyInput }))
            .toMatchObject({ machine: { id: row.id, desired: 'stop', intentRevision: 1 } });
    });

    it('binds enrollment to the admitted requester and refuses another Account before Machine writes', async () => {
        const fixture = await createManagedComputeFixture('requester-enrollment');
        const { account: custodian, homeId, controller } = fixture;
        const requester = await db.account.create({ data: { ...createSignedAccountContentBinding(), encryptionMode: 'e2ee' } });
        await db.account.update({ where: { id: custodian.id }, data: createSignedAccountContentBinding() });
        await db.machineAccountGrant.create({ data: { machineId: controller.machineId, accountId: requester.id,
            accessLevel: 'admin', createdByAccountId: custodian.id } });
        const request = { ...fixture.request, requesterAccountId: requester.id };
        const created = await admitManagedAcquire(request);
        expect(created.machine).toMatchObject({ custodianAccountId: custodian.id, enrollmentAccountId: requester.id });
        expect((await db.managedMachine.findUniqueOrThrow({ where: { id: created.machine.id } })).admittedInput)
            .toMatchObject({ enrollmentAccountId: requester.id });
        expect(await admitManagedAcquire(request)).toMatchObject({ replayed: true });
        await expect(admitManagedAcquire({ ...request, requesterAccountId: custodian.id }))
            .rejects.toMatchObject({ code: 'request_conflict' });
        const correlation = { homeId, managedId: created.machine.id, expectedIntentRevision: 0,
            requestId: request.input.requestId, controller };
        const resource = { contributionRef: fixture.input.selection.launch.provider, schemaVersion: 1, value: { id: 'requester-native' } };
        await submitManagedAcquire(correlation);
        await reportManagedAcquire({ ...correlation, result: { kind: 'bound', resource } });
        const app = fastify().withTypeProvider<ZodTypeProvider>();
        app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
        let enrollingAccountId = custodian.id;
        // HTTP authentication is the boundary; registration, installation proof and storage stay real.
        app.decorate('authenticate', async (incoming: FastifyRequest) => {
            Object.assign(incoming, createAuthenticatedRouteRequest({ userId: enrollingAccountId,
                externalActionExecutionAuthorized: true, externalActionExecutionMachineId: controller.machineId,
                externalActionEffectActionId: 'machines.managed.acquire', externalActionExecutionRequestId: request.input.requestId,
                externalActionExecutionCustodianAccountId: custodian.id }),
                { headers: incoming.headers, params: incoming.params, query: incoming.query });
        });
        machinesRoutes(app);
        onTestFinished(() => app.close());
        const enrollmentContext = await app.inject({ method: 'POST', url: '/v1/machines/managed/controller/enrollment-context',
            payload: { ...correlation, resource } });
        expect(enrollmentContext.statusCode, enrollmentContext.body).toBe(200);
        expect(enrollmentContext.json()).toMatchObject({ machine: { enrollmentAccountId: requester.id } });
        const keys = tweetnacl.sign.keyPair();
        const machineId = 'requester-enrolled-guest';
        const installationId = 'requester-enrolled-installation';
        const register = () => app.inject({ method: 'POST', url: '/v1/machines', payload: {
            id: machineId, metadata: 'ciphertext', installationId,
            installationPublicKey: Buffer.from(keys.publicKey).toString('base64url'),
            installationProof: signMachineInstallationProof({ payload: { version: 1, machineId, installationId,
                accountId: enrollingAccountId }, privateKey: keys.secretKey }),
            managedEnrollment: { ...correlation, resource },
        } });
        const refused = await register();
        expect(refused.statusCode, refused.body).toBe(409);
        expect(refused.json()).toMatchObject({ reason: 'resource_mismatch' });
        expect(await db.machine.findUnique({ where: { id: machineId } })).toBeNull();
        enrollingAccountId = requester.id;
        // Installation can finish after acquisition retirement. Registration's
        // transaction remains authoritative even without installer re-reads.
        await db.managedMachine.update({ where: { id: created.machine.id }, data: { creationState: 'canceled' } });
        const retired = await register();
        expect(retired.statusCode, retired.body).toBe(409);
        expect(retired.json()).toMatchObject({ reason: 'enrollment_retired' });
        expect(await db.machine.findUnique({ where: { id: machineId } })).toBeNull();
        expect((await db.managedMachine.findUniqueOrThrow({ where: { id: created.machine.id } })).enrolledMachineId).toBeNull();
        await db.managedMachine.update({ where: { id: created.machine.id }, data: { creationState: 'active' } });
        const enrolled = await register();
        expect(enrolled.statusCode, enrolled.body).toBe(200);
        expect(await db.machine.findUniqueOrThrow({ where: { id: machineId } })).toMatchObject({ accountId: requester.id });
        expect(await register()).toMatchObject({ statusCode: 200 });
        // Guest ownership does not grant native activity authority for until-delete resources.
        expect(await inTx(tx => resolveManagedGuestActivityAdmissionInTx(tx, { actorAccountId: requester.id,
            machineId, rpcMethod: 'managed.activity.read',
            target: { homeId, managedId: created.machine.id, expectedRevision: 0, controller } }))).toBeNull();
        const retained = await db.managedMachine.findUniqueOrThrow({ where: { id: created.machine.id } });
        expect(retained).toMatchObject({ custodianAccountId: custodian.id, enrolledMachineId: machineId,
            admittedInput: { enrollmentAccountId: requester.id } });
    });

    it('rejects malformed retained enrollment identity independently of guest currentness', async () => {
        const fixture = await createManagedComputeFixture('malformed-enrollment');
        const created = await admitManagedAcquire(fixture.request);
        const correlation = { homeId: fixture.homeId, managedId: created.machine.id, expectedIntentRevision: 0,
            requestId: fixture.request.input.requestId, controller: fixture.controller };
        const resource = { contributionRef: fixture.input.selection.launch.provider, schemaVersion: 1,
            value: { id: 'malformed-enrollment-native' } };
        await submitManagedAcquire(correlation);
        await reportManagedAcquire({ ...correlation, result: { kind: 'bound', resource } });
        await expect(inTx(tx => requireManagedEnrollmentInTx(tx, { ...correlation, resource }, fixture.account.id)))
            .resolves.toMatchObject({ id: created.machine.id });
        const retained = await db.managedMachine.findUniqueOrThrow({ where: { id: created.machine.id } });
        await db.managedMachine.update({ where: { id: retained.id }, data: {
            admittedInput: { ...readManagedAcquisitionIdentity(retained.admittedInput), enrollmentAccountId: '' },
        } });
        await expect(inTx(tx => requireManagedEnrollmentInTx(tx, { ...correlation, resource }, fixture.account.id)))
            .rejects.toMatchObject({ code: 'request_conflict' });
    });

    it('returns retained creation context only to the present-user custodian of an Account-owned resource', async () => {
        const homeId = `srv_${'a'.repeat(32)}`;
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const foreign = await db.account.create({ data: { encryptionMode: 'plain' } });
        const row = await db.managedMachine.create({ data: { homeId, custodianAccountId: account.id,
            admittedActionRequestId: crypto.randomUUID(), admittedInput: {},
            launch: { provider: { pluginId: 'fixture.setup', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
            allocation: 'unsubmitted', retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } });
        const app = fastify().withTypeProvider<ZodTypeProvider>();
        app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
        let actor = account.id;
        app.decorate('authenticate', async (request: FastifyRequest) => {
            Object.assign(request, createAuthenticatedRouteRequest({ userId: actor, authTokenLegacy: false }),
                { headers: request.headers, params: request.params, query: request.query });
        });
        registerManagedMachineRoutes(app);
        onTestFinished(() => app.close());
        const payload = { homeId, managedId: row.id, expectedIntentRevision: 0 };
        const own = await app.inject({ method: 'POST', url: '/v1/machines/managed/controller/context', payload });
        expect(own.statusCode, own.body).toBe(200);
        expect(ManagedControllerContextOutputV1Schema.parse(own.json())).toMatchObject({
            requestId: row.admittedActionRequestId, machine: { id: row.id } });
        const wrong = await app.inject({ method: 'POST', url: '/v1/machines/managed/controller/context',
            payload: { ...payload, requestId: 'unrelated-request' } });
        expect(wrong.json()).toMatchObject({ code: 'request_conflict' });
        actor = foreign.id;
        const denied = await app.inject({ method: 'POST', url: '/v1/machines/managed/controller/context', payload });
        expect(denied.json()).toMatchObject({ code: 'permission_denied' });
    });

    it.each(['one-off', 'preset'] as const)('retains reviewed enrollment identity through %s admission, cold read and bootstrap retry after policy admission', async kind => {
        const fixture = await createManagedComputeFixture(`identity-${kind}`);
        const { homeId, account, controller } = fixture;
        const enrollmentIdentity = { kind: 'dedicatedDaemonUser', username: 'happier', serviceMode: 'user',
            role: 'server', adminAccessAtCreation: 'ask', administrator: { username: 'reviewed-admin' } } as const;
        const preset = kind === 'preset' ? await db.managedMachinePreset.create({ data: {
            homeId, custodianAccountId: account.id, name: 'Reviewed preset', launch: fixture.input.selection.launch,
            controllerMachineId: controller.machineId, controllerInstallationId: controller.installationId,
        } }) : undefined;
        const computeInput = preset
            ? { selection: { kind: 'preset' as const, homeId, id: preset.id, revision: preset.revision }, controller,
                retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false, enrollmentIdentity }
            : { ...fixture.input, enrollmentIdentity };
        const request = { ...fixture.request, input: { ...fixture.request.input, input: computeInput } };
        const app = fastify().withTypeProvider<ZodTypeProvider>();
        app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
        let action = 'machines.managed.acquire';
        // Authentication is the boundary; acquisition, cold row, currentness and serializers stay real.
        app.decorate('authenticate', async (incoming: FastifyRequest) => {
            Object.assign(incoming, createAuthenticatedRouteRequest({ userId: account.id,
                externalActionExecutionAuthorized: true, externalActionExecutionMachineId: controller.machineId,
                externalActionEffectActionId: action, externalActionExecutionRequestId: request.input.requestId,
                externalActionExecutionCustodianAccountId: account.id,
            }), { externalActionExecutionRequestEnvelopeDigest: request.requestEnvelopeDigest,
                headers: incoming.headers, params: incoming.params, query: incoming.query });
        });
        registerManagedMachineRoutes(app);
        onTestFinished(() => app.close());
        const admitted = await app.inject({ method: 'POST', url: '/v1/machines/managed/controller/admit', payload: request.input });
        expect(admitted.statusCode, admitted.body).toBe(200);
        const created = ManagedAdmissionOutputV1Schema.parse(admitted.json());
        const original = { homeId, managedId: created.machine.id, expectedIntentRevision: 0,
            requestId: request.input.requestId, controller };
        await submitManagedAcquire(original);
        const resource = { contributionRef: fixture.input.selection.launch.provider, schemaVersion: 1, value: { id: `identity-${kind}` } };
        await reportManagedAcquire({ ...original, result: { kind: 'bound', resource } });
        await admitManagedControl({ actorAccountId: account.id, custodianAccountId: account.id, input: {
            action: 'machines.managed.retention.update', requestId: `identity-${kind}-control`, input: {
                homeId, managedId: created.machine.id, expectedIntentRevision: 0,
                retention: { kind: 'deadline', at: 1, effect: 'stop' }, wakeOnAcceptedMessage: false,
            },
        } });
        const controlled = await db.managedMachine.findUniqueOrThrow({ where: { id: created.machine.id } });
        expect(controlled.admittedInput).toMatchObject({ currentAdmission: { kind: 'control', request: {
            requestId: `identity-${kind}-control` } }, computeInput: { enrollmentIdentity } });
        await admitManagedPolicy({ custodianAccountId: account.id, input: { ...original, expectedIntentRevision: 1,
            requestId: `identity-${kind}-policy`, purpose: { kind: 'retention' } } });
        const cold = await db.managedMachine.findUniqueOrThrow({ where: { id: created.machine.id } });
        expect(readManagedAcquisitionIdentity(cold.admittedInput).computeInput).toEqual(computeInput);
        expect(cold.admittedInput).toMatchObject({ currentAdmission: { kind: 'policy', request: {
            requestId: `identity-${kind}-policy` } }, computeInput: { enrollmentIdentity } });
        expect(JSON.stringify(cold.admittedInput)).not.toContain('password');
        action = 'machines.managed.bootstrap.retry';
        const context = await app.inject({ method: 'POST', url: '/v1/machines/managed/controller/context',
            payload: { homeId, managedId: cold.id, controller, expectedIntentRevision: 2 } });
        expect(context.statusCode, context.body).toBe(200);
        expect(ManagedControllerContextOutputV1Schema.parse(context.json())).toMatchObject({
            requestId: original.requestId, machine: { enrollmentIdentity, enrollmentAccountId: account.id } });
        const bootstrap = await app.inject({ method: 'POST', url: '/v1/machines/managed/controller/enrollment-context',
            payload: { ...original, expectedIntentRevision: 2, resource } });
        expect(bootstrap.statusCode, bootstrap.body).toBe(200);
        expect(ManagedControllerMachineOutputV1Schema.parse(bootstrap.json()).machine).toMatchObject({ enrollmentIdentity, enrollmentAccountId: account.id });
    });

    it('reads retained enrollment without a redundant identity review while strict acquire input remains required', async () => {
        const fixture = await createManagedComputeFixture('identity-missing');
        const { homeId, account, controller } = fixture;
        const resource = { contributionRef: fixture.input.selection.launch.provider, schemaVersion: 1,
            value: { id: 'identity-missing-native' } };
        // This is a retained pre-identity acquisition, not a new-writer request.
        const row = await db.managedMachine.create({ data: { homeId, custodianAccountId: account.id,
            controllerMachineId: controller.machineId, controllerInstallationId: controller.installationId,
            admittedActionRequestId: 'identity-missing-request', admittedInput: {
                computeInput: { selection: fixture.input.selection }, continuation: null },
            launch: fixture.input.selection.launch, allocation: 'bound', resource,
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
        } });
        const correlation = { homeId, managedId: row.id, expectedIntentRevision: 0,
            requestId: row.admittedActionRequestId, controller, resource };
        const app = fastify().withTypeProvider<ZodTypeProvider>();
        app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
        // Only the signed request boundary is substituted; retry reads the real retained row.
        app.decorate('authenticate', async (incoming: FastifyRequest) => {
            Object.assign(incoming, createAuthenticatedRouteRequest({ userId: account.id,
                externalActionExecutionAuthorized: true, externalActionExecutionMachineId: controller.machineId,
                externalActionEffectActionId: 'machines.managed.bootstrap.retry',
                externalActionExecutionRequestId: row.admittedActionRequestId,
                externalActionExecutionCustodianAccountId: account.id,
            }), { headers: incoming.headers, params: incoming.params, query: incoming.query });
        });
        registerManagedMachineRoutes(app);
        onTestFinished(() => app.close());
        const retry = () => app.inject({ method: 'POST', url: '/v1/machines/managed/controller/enrollment-context',
            payload: correlation });
        const missing = await retry();
        expect(missing.statusCode, missing.body).toBe(200);
        expect(ManagedControllerMachineOutputV1Schema.parse(missing.json()).machine).toMatchObject({ id: row.id });
        await expect(admitManagedAcquire({ ...fixture.request, input: { ...fixture.request.input,
            requestId: row.admittedActionRequestId } })).rejects.toMatchObject({ code: 'request_conflict' });
        await db.managedMachine.update({ where: { id: row.id }, data: { admittedInput: {
            computeInput: { selection: fixture.input.selection, enrollmentIdentity: {
                kind: 'dedicatedDaemonUser', username: 'root', role: 'server', serviceMode: 'user',
                adminAccessAtCreation: 'ask', administrator: { username: 'root' },
            } }, continuation: null,
        } } });
        const invalid = await retry();
        expect(invalid.statusCode, invalid.body).toBe(409);
        expect(invalid.json()).toEqual({ code: 'request_conflict' });
        const enrolled = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: account.id,
            metadata: 'ciphertext', installationId: crypto.randomUUID() } });
        await db.managedMachine.update({ where: { id: row.id }, data: { enrolledMachineId: enrolled.id,
            admittedInput: row.admittedInput! } });
        expect(await getManagedMachine({ actorAccountId: account.id, input: { homeId, managedId: row.id } }))
            .toMatchObject({ id: row.id, enrolledMachineId: enrolled.id });
        const historical = await retry();
        expect(historical.statusCode, historical.body).toBe(200);
        expect(ManagedControllerMachineOutputV1Schema.parse(historical.json()).machine)
            .toMatchObject({ id: row.id, enrolledMachineId: enrolled.id });
        expect((await db.managedMachine.findUniqueOrThrow({ where: { id: row.id } })).admittedInput)
            .toEqual(row.admittedInput);
    });

    it('retries approved cleanup of a canceled bound resource through the current controller without reviving creation', async () => {
        const { homeId, account, controller, request } = await createManagedComputeFixture('canceled-cleanup-retry');
        const created = await admitManagedAcquire(request);
        const correlation = { homeId, managedId: created.machine.id, expectedIntentRevision: 0,
            requestId: request.input.requestId, controller };
        const resource = { contributionRef: request.input.input.selection.launch.provider, schemaVersion: 1,
            value: { id: 'canceled-cleanup-resource' } };
        await submitManagedAcquire(correlation);
        await reportManagedAcquire({ ...correlation, result: { kind: 'bound', resource } });
        await cancelManagedCreation({ actorAccountId: account.id, input: { homeId, managedId: created.machine.id, expectedIntentRevision: 0 } });
        const app = fastify().withTypeProvider<ZodTypeProvider>();
        app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
        // Authentication is the HTTP boundary; row/currentness, authorization and schemas stay real.
        app.decorate('authenticate', async (incoming: FastifyRequest) => {
            const body = incoming.body as { action?: string; requestId?: string };
            Object.assign(incoming, createAuthenticatedRouteRequest({ userId: account.id,
                externalActionExecutionAuthorized: true, externalActionExecutionMachineId: controller.machineId,
                externalActionEffectActionId: body.action ?? 'machines.managed.delete',
                externalActionExecutionRequestId: body.requestId,
                externalActionExecutionCustodianAccountId: account.id,
            }), { headers: incoming.headers, body: incoming.body });
        });
        registerManagedMachineRoutes(app);
        onTestFinished(() => app.close());
        const target = { homeId, managedId: created.machine.id, when: 'now' as const, expectedRevision: 1 };
        const revive = await app.inject({ method: 'POST', url: '/v1/machines/managed/controller/admit-control', payload: {
            action: 'machines.managed.power.set', requestId: 'canceled-revive', input: { ...target, intent: 'start' },
        } });
        expect(revive.statusCode).toBe(409);
        expect(revive.json()).toEqual({ code: 'resource_mismatch' });
        const payload = { action: 'machines.managed.delete', requestId: 'canceled-cleanup-approved',
            input: { ...target, intent: 'delete', reviewedDependencies: true } };
        const response = await app.inject({ method: 'POST', url: '/v1/machines/managed/controller/admit-control', payload });
        expect(response.statusCode, response.body).toBe(200);
        const admitted = ManagedAdmissionOutputV1Schema.parse(response.json());
        expect(admitted).toMatchObject({ replayed: false, machine: { creationState: 'canceled', intentRevision: 2,
            desired: 'delete', resource, cleanup: { disposition: 'pending' } } });
        const replay = await app.inject({ method: 'POST', url: '/v1/machines/managed/controller/admit-control', payload });
        expect(ManagedAdmissionOutputV1Schema.parse(replay.json())).toMatchObject({ replayed: true, machine: { intentRevision: 2 } });
        const current = await app.inject({ method: 'POST', url: '/v1/machines/managed/controller/current', payload: {
            ...correlation, expectedIntentRevision: 2, requestId: payload.requestId,
        } });
        expect(current.statusCode, current.body).toBe(200);
        expect(ManagedControllerMachineOutputV1Schema.parse(current.json())).toMatchObject({ machine: { resource, creationState: 'canceled' } });
        expect(await db.managedMachine.count({ where: { custodianAccountId: account.id } })).toBe(1);
    });

    it('settles a Lume Delete from exact native not-found through the report-intent route', async () => {
        const { homeId, account, controller } = await createManagedComputeFixture('lume-delete');
        const manifest = PluginManifestV2Schema.parse(LUME_PLUGIN.manifest);
        const declaration = createReleaseLessDeclarationV1(manifest);
        await db.accountPluginIntent.create({ data: { accountId: account.id, pluginId: manifest.id, enabled: true,
            writableCollections: [], releaseLessDeclaration: declaration } });
        await db.pluginMachineMaterialization.updateMany({ where: { machineId: controller.machineId,
            materializationId: controller.installationId }, data: { pluginId: manifest.id,
            version: manifest.version, archiveDigestSha256: declaration.manifestDigestSha256 } });
        const contributionRef = { pluginId: manifest.id, localId: 'lume' };
        const value = { storage: 'home', vmName: 'happier-cmvo56azi00oomc7ywy8jvmem' };
        const resource = { contributionRef, schemaVersion: 1, value };
        const choices = { storage: 'home', image: { kind: 'catalog', id: 'ghcr.io/trycua/macos:26-slim' },
            cpu: 2, memoryBytes: 4294967296, diskBytes: 161061273600 };
        const row = await db.managedMachine.create({ data: { homeId, custodianAccountId: account.id,
            controllerMachineId: controller.machineId, controllerInstallationId: controller.installationId,
            admittedActionRequestId: 'lume-original-create', admittedInput: {},
            launch: { provider: contributionRef, schemaVersion: 1, name: 'Retained Lume guest', choices },
            resource, allocation: 'bound', retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } });
        const requestId = 'lume-delete-exact';
        await admitManagedControl({ actorAccountId: account.id, custodianAccountId: account.id, input: {
            action: 'machines.managed.delete', requestId, input: { homeId, managedId: row.id,
                expectedRevision: 0, when: 'now', intent: 'delete', reviewedDependencies: true },
        } });
        const correlation = { homeId, managedId: row.id, expectedIntentRevision: 1, requestId, controller };
        expect(await submitManagedIntent(correlation)).toMatchObject({ submitted: true });
        let exists = true;
        const nativeRequests: string[] = [];
        const native = createLumeNativeClient({ baseUrl: 'http://localhost:7777', fetch: async (input, init) => {
            const url = new URL(String(input));
            expect(url.pathname).toBe(`/lume/vms/${value.vmName}`);
            expect(url.searchParams.get('storage')).toBe(value.storage);
            nativeRequests.push(init?.method ?? 'GET');
            if (init?.method === 'DELETE') {
                expect(exists).toBe(true); exists = false;
                return Response.json({});
            }
            return exists ? Response.json({ name: value.vmName, locationName: value.storage, status: 'stopped', os: 'macos',
                cpuCount: choices.cpu, memorySize: choices.memoryBytes, diskSize: { allocated: 1073741824, total: choices.diskBytes } })
                : Response.json({ message: `Virtual machine not found: ${value.vmName}` }, { status: 400 });
        } });
        const provider = createLumeProvider({ native, observedAt: 300 });
        const result = await provider.destroy(value);
        const observation = await provider.inspect(value);
        const app = fastify().withTypeProvider<ZodTypeProvider>();
        app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
        // Only the authenticated HTTP boundary is substituted; the native
        // producer, report schema, authority and SQLite settlement stay real.
        app.decorate('authenticate', async (request: FastifyRequest) => {
            Object.assign(request, createAuthenticatedRouteRequest({ userId: account.id,
                externalActionExecutionAuthorized: true, externalActionExecutionMachineId: controller.machineId,
                externalActionEffectActionId: 'machines.managed.delete', externalActionExecutionRequestId: requestId,
                externalActionExecutionCustodianAccountId: account.id,
            }), { headers: request.headers, body: request.body });
        });
        registerManagedMachineRoutes(app);
        onTestFinished(() => app.close());
        const response = await app.inject({ method: 'POST', url: '/v1/machines/managed/controller/report-intent',
            payload: { ...correlation, result, observation } });
        expect(response.statusCode, response.body).toBe(200);
        const settled = ManagedControllerMachineOutputV1Schema.parse(response.json()).machine;
        expect(settled).toMatchObject({ id: row.id, allocation: 'confirmed-absent',
            observation: { availability: 'absent' }, desired: 'delete', resource });
        expect(settled.cleanup).toBeUndefined();
        expect(settled.submittedNativeEffect).toBeUndefined();
        expect(await db.managedMachine.findUniqueOrThrow({ where: { id: row.id } }))
            .toMatchObject({ allocation: 'confirmed-absent', cleanup: null });
        expect(nativeRequests).toEqual(['GET', 'DELETE', 'GET']);
    });

    it.each(['retry', 'canceled', 'same-admission', 'unavailable', 'stale', 'policy-edit', 'moved-controller'] as const)(
        'settles uncertain Delete custody for %s without replaying the old admission', async mode => {
        const { homeId, account, controller, request } = await createManagedComputeFixture(`delete-${mode}`,
            { location: 'cloud', stoppedBilling: 'billed' });
        const created = await admitManagedAcquire(request);
        const acquisition = { homeId, managedId: created.machine.id, expectedIntentRevision: 0,
            requestId: request.input.requestId, controller };
        await submitManagedAcquire(acquisition);
        const resource = { contributionRef: request.input.input.selection.launch.provider, schemaVersion: 1, value: { id: `delete-${mode}` } };
        await reportManagedAcquire({ ...acquisition, result: { kind: 'bound', resource } });
        const admitDelete = (requestId: string, expectedRevision: number) => admitManagedControl({ actorAccountId: account.id,
            custodianAccountId: account.id, input: { action: 'machines.managed.delete', requestId,
                input: { homeId, managedId: created.machine.id, expectedRevision, when: 'now', intent: 'delete', reviewedDependencies: true } } });
        await admitDelete('old-delete', 0);
        const old = { ...acquisition, expectedIntentRevision: 1, requestId: 'old-delete' };
        expect(await submitManagedIntent(old)).toMatchObject({ submitted: true });
        await reportManagedIntent({ ...old, result: { kind: 'unknown' }, observation: {
            observedAt: 10, availability: 'present', power: 'stopped' } });
        if (mode === 'canceled') await db.managedMachine.update({ where: { id: created.machine.id }, data: { creationState: 'canceled' } });
        if (mode === 'policy-edit') await admitManagedControl({ actorAccountId: account.id, custodianAccountId: account.id,
            input: { action: 'machines.managed.retention.update', requestId: 'policy-edit', input: { homeId,
                managedId: created.machine.id, expectedIntentRevision: 1, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } } });
        else if (mode !== 'same-admission') await admitDelete('fresh-delete', 1);
        if (mode === 'moved-controller') {
            // A destination controller must not release an earlier installation's effect.
            await db.managedMachine.update({ where: { id: created.machine.id }, data: { controllerInstallationId: 'replacement-installation' } });
        }
        const observed = await reportManagedIntent({ ...old, result: { kind: 'unknown' }, observation: {
            observedAt: mode === 'stale' ? 10 : 20, availability: mode === 'unavailable' ? 'unavailable' : 'present',
            ...(mode === 'unavailable' ? {} : { power: 'stopped' as const }) } });
        if (mode === 'retry' || mode === 'canceled') {
            expect(observed.machine.submittedNativeEffect).toBeUndefined();
            expect(observed.machine).toMatchObject({ resource, desired: 'delete', intentRevision: 2, allocation: 'bound' });
            const fresh = { ...old, expectedIntentRevision: 2, requestId: 'fresh-delete' };
            expect(await submitManagedIntent(fresh)).toMatchObject({ submitted: true });
            expect(await submitManagedIntent(fresh)).toMatchObject({ submitted: false });
            const settled = await reportManagedIntent({ ...fresh, result: { kind: 'confirmed' }, observation: {
                observedAt: 30, availability: 'absent' } });
            expect(settled.machine).toMatchObject({ allocation: 'confirmed-absent', observation: { availability: 'absent' } });
            expect(settled.machine.submittedNativeEffect).toBeUndefined();
        } else expect(observed.machine.submittedNativeEffect).toMatchObject({ requestId: 'old-delete', intentRevision: 1 });
    });

    it('refuses pending deletion evidence for a submitted power effect', async () => {
        const { homeId, account, controller, request } = await createManagedComputeFixture('pending-delete-power');
        const created = await admitManagedAcquire(request);
        const acquisition = { homeId, managedId: created.machine.id, expectedIntentRevision: 0,
            requestId: request.input.requestId, controller };
        await submitManagedAcquire(acquisition);
        const resource = { contributionRef: request.input.input.selection.launch.provider, schemaVersion: 1,
            value: { id: 'power-resource' } };
        await reportManagedAcquire({ ...acquisition, result: { kind: 'bound', resource } });
        await admitManagedControl({ actorAccountId: account.id, custodianAccountId: account.id, input: {
            action: 'machines.managed.power.set', requestId: 'start-pending-evidence', input: { homeId,
                managedId: created.machine.id, expectedRevision: 0, when: 'now', intent: 'start' },
        } });
        const correlation = { ...acquisition, expectedIntentRevision: 1, requestId: 'start-pending-evidence' };
        await submitManagedIntent(correlation);
        await expect(reportManagedIntent({ ...correlation, result: { kind: 'pending' } }))
            .rejects.toMatchObject({ code: 'resource_mismatch' });
    });

    it('retains an accepted native destroy operation until the provisioner confirms deletion', async () => {
        const { homeId, account, controller, manifest, request, launch, native } = await createManagedComputeFixture('destroy-custody',
            { location: 'cloud', stoppedBilling: 'billed' });
        const nativeOperation = defineProtocolObject({ operationId: defineProtocolString({ minLength: 1 }) }, { policy: 'closed' });
        const reconciliation = defineMachineProvisionerReconciliationSchemas({ launch, resource: native, nativeOperation });
        const declarationManifest = PluginManifestV2Schema.parse({ ...manifest, contributes: { ...manifest.contributes,
            machineProvisioners: manifest.contributes.machineProvisioners!.map(provider => ({ ...provider,
                reconciliation: { action: 'reconcile', nativeOperationSchema: nativeOperation.jsonSchema } })),
            actions: [...manifest.contributes.actions!.map(action => action.id === 'acquire'
                ? { ...action, resultSchema: reconciliation.result.jsonSchema }
                : action.id === 'destroy'
                    ? { ...action, inputSchema: reconciliation.destroyInput.jsonSchema, resultSchema: reconciliation.destroyResult.jsonSchema }
                    : action),
                { id: 'reconcile', title: 'Reconcile', inputSchema: reconciliation.input.jsonSchema,
                    resultSchema: reconciliation.result.jsonSchema, execution: { target: 'daemon' }, surfaces: ['plugin'],
                    scopes: ['global'], dangerLevel: 'safe' }],
        } });
        const declaration = createReleaseLessDeclarationV1(declarationManifest);
        await db.accountPluginIntent.update({ where: { accountId_pluginId: { accountId: account.id, pluginId: manifest.id } },
            data: { releaseLessDeclaration: declaration } });
        await db.pluginMachineMaterialization.updateMany({ where: { accountId: account.id, pluginId: manifest.id },
            data: { archiveDigestSha256: declaration.manifestDigestSha256 } });

        const created = await admitManagedAcquire(request);
        const acquireCorrelation = { homeId, managedId: created.machine.id, expectedIntentRevision: 0,
            requestId: request.input.requestId, controller };
        const resource = { contributionRef: request.input.input.selection.launch.provider, schemaVersion: 1,
            value: { id: 'destroy-custody-resource' } };
        await submitManagedAcquire(acquireCorrelation);
        await reportManagedAcquire({ ...acquireCorrelation, result: { kind: 'bound', resource } });
        await admitManagedControl({ actorAccountId: account.id, custodianAccountId: account.id, input: {
            action: 'machines.managed.delete', requestId: 'destroy-custody-delete', input: { homeId,
                managedId: created.machine.id, expectedRevision: 0, when: 'now', intent: 'delete', reviewedDependencies: true },
        } });
        const destroyCorrelation = { ...acquireCorrelation, expectedIntentRevision: 1, requestId: 'destroy-custody-delete' };
        await submitManagedIntent(destroyCorrelation);
        const nativeOperationRef = { contributionRef: resource.contributionRef, schemaVersion: 1,
            value: { operationId: 'delete-operation-1' } };

        await expect(reportManagedIntent({ ...destroyCorrelation, result: { kind: 'accepted', nativeOperationRef: {
            ...nativeOperationRef, contributionRef: { pluginId: 'fixture.other', localId: 'compute' },
        } } })).rejects.toMatchObject({ code: 'resource_mismatch' });
        expect(await reportManagedIntent({ ...destroyCorrelation, result: { kind: 'accepted', nativeOperationRef } })).toMatchObject({
            machine: { allocation: 'bound', resource, nativeOperationRef, cleanup: { disposition: 'pending' },
                submittedNativeEffect: { intent: 'delete' } },
        });
        expect(await reportManagedIntent({ ...destroyCorrelation, result: reconciliation.destroyResult.parse({ kind: 'pending' }) }))
            .toMatchObject({ machine: { nativeOperationRef, resource, allocation: 'bound',
                submittedNativeEffect: { requestId: 'destroy-custody-delete', intent: 'delete' } } });
        await admitManagedControl({ actorAccountId: account.id, custodianAccountId: account.id, input: {
            action: 'machines.managed.delete', requestId: 'destroy-custody-retry', input: { homeId,
                managedId: created.machine.id, expectedRevision: 1, when: 'now', intent: 'delete', reviewedDependencies: true },
        } });
        expect(await reportManagedIntent({ ...destroyCorrelation, result: { kind: 'unknown' }, observation: {
            observedAt: 50, availability: 'present', power: 'stopped',
        } })).toMatchObject({ machine: { nativeOperationRef, submittedNativeEffect: { requestId: 'destroy-custody-delete' } } });
        const settled = await reportManagedIntent({ ...destroyCorrelation, result: { kind: 'confirmed' }, observation: {
            observedAt: 100, availability: 'absent',
        } });
        expect(settled).toMatchObject({ machine: { allocation: 'confirmed-absent' } });
        expect(settled.machine.nativeOperationRef).toBeUndefined();
        expect(settled.machine.submittedNativeEffect).toBeUndefined();
    });

    it('admits an offline-controller Move through the destination route while preserving exact resource and pending native effect custody', async () => {
        const { homeId, account, controller, manifest, declaration, request } = await createManagedComputeFixture('offline-move',
            { location: 'cloud', stoppedBilling: 'billed' });
        const created = await admitManagedAcquire(request);
        const correlation = { homeId, managedId: created.machine.id, expectedIntentRevision: 0, requestId: request.input.requestId, controller };
        const resource = { contributionRef: { pluginId: manifest.id, localId: 'compute' }, schemaVersion: 1, value: { id: 'offline-move-native' } };
        await submitManagedAcquire(correlation);
        await reportManagedAcquire({ ...correlation, result: { kind: 'bound', resource } });
        await admitManagedControl({ actorAccountId: account.id, custodianAccountId: account.id, input: {
            action: 'machines.managed.power.set', requestId: 'offline-move-stop', input: { homeId, managedId: created.machine.id,
                when: 'now', intent: 'stop', expectedRevision: 0 },
        } });
        await submitManagedIntent({ ...correlation, expectedIntentRevision: 1, requestId: 'offline-move-stop' });
        const destination = { machineId: 'offline-move-destination', installationId: 'offline-move-destination-installation' };
        await db.machine.create({ data: { id: destination.machineId, accountId: account.id, metadata: 'ciphertext',
            installationId: destination.installationId, pluginMaterializationRevision: BigInt(1) } });
        await db.machine.update({ where: { id: controller.machineId }, data: { active: false } });
        const moveRequest = { action: 'machines.managed.controller.update' as const, requestId: 'offline-move-control', input: {
            homeId, managedId: created.machine.id, expectedIntentRevision: 1, controller: destination, reviewedPendingEffects: true as const,
        } };
        const app = fastify().withTypeProvider<ZodTypeProvider>();
        app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
        let executor = destination.machineId;
        let reportingSubmittedIntent = false;
        // Installed execution authentication is the boundary; actual route,
        // Account custody, current launch admission and row mutation stay real.
        app.decorate('authenticate', async (routeRequest: FastifyRequest) => {
            Object.assign(routeRequest, createAuthenticatedRouteRequest({ userId: account.id,
                externalActionExecutionAuthorized: true, externalActionExecutionMachineId: executor,
                externalActionEffectActionId: reportingSubmittedIntent ? 'machines.managed.power.set' : moveRequest.action,
                externalActionExecutionRequestId: reportingSubmittedIntent ? 'offline-move-stop' : moveRequest.requestId,
                externalActionExecutionCustodianAccountId: account.id,
            }), { headers: routeRequest.headers, params: routeRequest.params, query: routeRequest.query });
        });
        registerManagedMachineRoutes(app);
        onTestFinished(() => app.close());
        const send = (payload: typeof moveRequest = moveRequest) => app.inject({ method: 'POST',
            url: '/v1/machines/managed/controller/admit-control', payload });
        const unavailableLaunch = await send();
        expect(unavailableLaunch.statusCode, unavailableLaunch.body).toBe(409);
        expect(unavailableLaunch.json()).toMatchObject({ code: 'provider_unavailable' });
        await db.pluginMachineMaterialization.create({ data: { accountId: account.id, serverIdentityId: homeId,
            machineId: destination.machineId, materializationId: destination.installationId, pluginId: manifest.id,
            version: manifest.version, sourceClass: 'bundledFirstParty', portableRelease: false,
            archiveDigestSha256: declaration.manifestDigestSha256, uiArtifacts: [], enabled: true, trustState: 'trusted', observedAt: new Date() } });
        const staleRevision = await send({ ...moveRequest, input: { ...moveRequest.input, expectedIntentRevision: 0 } });
        expect(staleRevision.statusCode, staleRevision.body).toBe(409);
        expect(staleRevision.json()).toMatchObject({ code: 'intent_changed' });
        const staleInstallation = await send({ ...moveRequest, input: { ...moveRequest.input,
            controller: { ...destination, installationId: 'replaced-installation' } } });
        expect(staleInstallation.statusCode, staleInstallation.body).toBe(409);
        expect(staleInstallation.json()).toMatchObject({ code: 'controller_retired' });
        const foreignAccount = await db.account.create({ data: { publicKey: 'offline-move-foreign-account' } });
        const foreignController = { machineId: 'offline-move-foreign-controller', installationId: 'offline-move-foreign-installation' };
        await db.machine.create({ data: { id: foreignController.machineId, accountId: foreignAccount.id,
            metadata: 'ciphertext', installationId: foreignController.installationId } });
        executor = foreignController.machineId;
        const foreignCustody = await send({ ...moveRequest, input: { ...moveRequest.input, controller: foreignController } });
        expect(foreignCustody.statusCode, foreignCustody.body).toBe(403);
        expect(foreignCustody.json()).toMatchObject({ code: 'permission_denied' });
        executor = controller.machineId;
        const oldExecutor = await send();
        expect(oldExecutor.statusCode, oldExecutor.body).toBe(403);
        expect(oldExecutor.json()).toMatchObject({ code: 'permission_denied' });
        executor = destination.machineId;
        const response = await send();
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json<Awaited<ReturnType<typeof admitManagedControl>>>()).toMatchObject({ replayed: false,
            machine: { intentRevision: 2, controller: destination, resource,
                submittedNativeEffect: { requestId: 'offline-move-stop', intent: 'stop', controller } } });
        executor = controller.machineId;
        expect((await send()).statusCode).toBe(403);
        expect(await db.managedMachine.findUniqueOrThrow({ where: { id: created.machine.id } })).toMatchObject({
            controllerMachineId: destination.machineId, controllerInstallationId: destination.installationId,
            intentRevision: 2, allocation: 'bound', resource, admittedActionRequestId: request.input.requestId,
            admittedInput: { currentAdmission: { kind: 'control', request: moveRequest },
                submittedEffect: { requestId: 'offline-move-stop', controller } },
        });
        expect(await db.machine.findUniqueOrThrow({ where: { id: controller.machineId } })).toMatchObject({ active: false });
        reportingSubmittedIntent = true;
        const lateReport = await app.inject({ method: 'POST', url: '/v1/machines/managed/controller/report-intent',
            payload: { ...correlation, expectedIntentRevision: 1, requestId: 'offline-move-stop', result: { kind: 'confirmed' } } });
        expect(lateReport.statusCode, lateReport.body).toBe(200);
        expect(lateReport.json()).toMatchObject({ machine: { id: created.machine.id, intentRevision: 2, controller: destination, resource } });
    });

    it('clears acquisition custody on bind without losing a later accepted Delete handle', async () => {
        const { homeId, account, controller, manifest, request, launch, native } = await createManagedComputeFixture('bound-acquisition-custody');
        const nativeOperation = defineProtocolObject({ request: defineProtocolString({ minLength: 1 }) }, { policy: 'closed' });
        const reconciliation = defineMachineProvisionerReconciliationSchemas({ launch, resource: native, nativeOperation });
        const reconcilingManifest = PluginManifestV2Schema.parse({ ...manifest, contributes: { ...manifest.contributes,
            machineProvisioners: manifest.contributes.machineProvisioners!.map(provider => ({ ...provider,
                reconciliation: { action: 'reconcile', nativeOperationSchema: nativeOperation.jsonSchema } })),
            actions: [...manifest.contributes.actions!.map(action => action.id === 'acquire'
                ? { ...action, resultSchema: reconciliation.result.jsonSchema }
                : action.id === 'destroy' ? { ...action, inputSchema: reconciliation.destroyInput.jsonSchema } : action),
                { id: 'reconcile', title: 'Reconcile', inputSchema: reconciliation.input.jsonSchema, resultSchema: reconciliation.result.jsonSchema,
                    execution: { target: 'daemon' }, surfaces: ['plugin'], scopes: ['global'], dangerLevel: 'safe' }],
        } });
        const declaration = createReleaseLessDeclarationV1(reconcilingManifest);
        await db.accountPluginIntent.update({ where: { accountId_pluginId: { accountId: account.id, pluginId: manifest.id } },
            data: { releaseLessDeclaration: declaration } });
        await db.pluginMachineMaterialization.updateMany({ where: { accountId: account.id, pluginId: manifest.id },
            data: { archiveDigestSha256: declaration.manifestDigestSha256 } });
        const created = await admitManagedAcquire(request);
        const correlation = { homeId, managedId: created.machine.id, expectedIntentRevision: 0,
            requestId: request.input.requestId, controller };
        const resource = { contributionRef: request.input.input.selection.launch.provider, schemaVersion: 1, value: { id: 'recovered-native' } };
        const acquisitionHandle = { contributionRef: resource.contributionRef, schemaVersion: 1, value: { request: 'acquisition-request' } };
        await submitManagedAcquire(correlation);
        await reportManagedAcquire({ ...correlation, result: { kind: 'pending', nativeOperationRef: acquisitionHandle } });
        const bound = await reportManagedAcquire({ ...correlation, result: { kind: 'bound', resource } }, { requestAuthority: 'intent' });
        expect(bound.machine).toMatchObject({ allocation: 'bound', resource });
        expect(bound.machine.nativeOperationRef).toBeUndefined();
        expect((await getManagedMachine({ actorAccountId: account.id, input: { homeId, managedId: created.machine.id } })).nativeOperationRef).toBeUndefined();
        expect((await db.managedMachine.findUniqueOrThrow({ where: { id: created.machine.id } })).nativeOperationRef).toBeNull();

        await cancelManagedCreation({ actorAccountId: account.id, input: { homeId, managedId: created.machine.id, expectedIntentRevision: 0 } });
        const deletion = { ...correlation, expectedIntentRevision: 1 };
        expect(await submitManagedIntent(deletion)).toMatchObject({ submitted: true });
        // A lost destroy reply retains its submitted effect, never the old acquisition handle.
        const unknown = await reportManagedIntent({ ...deletion, result: { kind: 'unknown' } });
        expect(unknown.machine.submittedNativeEffect).toMatchObject({ intent: 'delete' });
        expect(unknown.machine.nativeOperationRef).toBeUndefined();
        const deleteHandle = { ...acquisitionHandle, value: { request: 'accepted-delete-request' } };
        await reportManagedIntent({ ...deletion, result: { kind: 'accepted', nativeOperationRef: deleteHandle } });
        // A duplicate late acquisition report cannot discard the newer destroy custody.
        expect(await reportManagedAcquire({ ...correlation, result: { kind: 'bound', resource } }))
            .toMatchObject({ machine: { nativeOperationRef: deleteHandle, submittedNativeEffect: { intent: 'delete' } } });
        await reportManagedIntent({ ...deletion, result: { kind: 'refused', code: 'native_cleanup_unavailable' } });
        const refused = await reportManagedAcquire({ ...correlation, result: { kind: 'bound', resource } });
        expect(refused.machine.nativeOperationRef).toEqual(deleteHandle);
        expect(refused.machine.submittedNativeEffect).toBeUndefined();
        await submitManagedIntent(deletion);
        const settled = await reportManagedIntent({ ...deletion, result: { kind: 'confirmed' },
            observation: { observedAt: 100, availability: 'absent' } });
        expect(settled.machine).toMatchObject({ allocation: 'confirmed-absent' });
        expect(settled.machine.submittedNativeEffect).toBeUndefined();
        expect(settled.machine.nativeOperationRef).toBeUndefined();

        // Unbound canceled acquisition cleanup can acquire Delete custody before binding.
        const cleanupRequest = { ...request, input: { ...request.input, requestId: 'bound-acquisition-late-cleanup' } };
        const cleanup = await admitManagedAcquire(cleanupRequest);
        const originalCleanup = { ...correlation, managedId: cleanup.machine.id, requestId: cleanupRequest.input.requestId };
        await submitManagedAcquire(originalCleanup);
        await reportManagedAcquire({ ...originalCleanup, result: { kind: 'pending', nativeOperationRef: acquisitionHandle } });
        await cancelManagedCreation({ actorAccountId: account.id, input: { homeId, managedId: cleanup.machine.id, expectedIntentRevision: 0 } });
        const currentCleanup = { ...originalCleanup, expectedIntentRevision: 1 };
        await submitManagedIntent(currentCleanup);
        await reportManagedIntent({ ...currentCleanup, result: { kind: 'accepted', nativeOperationRef: deleteHandle } });
        expect(await reportManagedAcquire({ ...originalCleanup, result: { kind: 'bound', resource } }))
            .toMatchObject({ machine: { allocation: 'bound', resource, nativeOperationRef: deleteHandle,
                submittedNativeEffect: { intent: 'delete' } } });
    });

    it('authenticates policy follow-ups after guest retirement without accepting a user Action request', async () => {
        const { homeId, account, controller, controllerKeys, input } = await createManagedComputeFixture('admitted-policy');
        const guestKeys = tweetnacl.sign.keyPair();
        const guest = { machineId: 'admitted-policy-guest', installationId: 'admitted-policy-installation' };
        await db.machine.create({ data: { id: guest.machineId, accountId: account.id, metadata: 'ciphertext',
            installationId: guest.installationId, installationPublicKey: Buffer.from(guestKeys.publicKey) } });
        const resource = { contributionRef: input.selection.launch.provider, schemaVersion: 1, value: { id: 'paid-resource' } };
        const row = await db.managedMachine.create({ data: { homeId, custodianAccountId: account.id,
            controllerMachineId: controller.machineId, controllerInstallationId: controller.installationId,
            admittedActionRequestId: 'admitted-policy-created', admittedInput: {}, launch: input.selection.launch,
            allocation: 'bound', resource, enrolledMachineId: guest.machineId,
            retention: { kind: 'unused', afterMs: 10, effect: 'stop' }, wakeOnAcceptedMessage: false } });
        const context = { actorAccountId: account.id, custodianAccountId: account.id, ...guest,
            role: 'manage' as const, encryptionMode: 'e2ee' as const };
        const managedTarget = { homeId, managedId: row.id, expectedRevision: 0, controller };
        const method = `${guest.machineId}:managed.admission.drain.confirm`;
        const decision = { kind: 'idle' as const, since: 100, confirmedAt: 111 };
        const purpose = { kind: 'retention' as const, evidence: { context, method, managedTarget, decision,
            proof: signMachineInstallationProof({ payload: { version: 1, machineId: guest.machineId,
                installationId: guest.installationId, accountId: account.id,
                rpcAdmission: { context, method, managedTarget, managedIdleDecision: decision } }, privateKey: guestKeys.secretKey }) } };
        const admitted = await admitManagedPolicy({ custodianAccountId: account.id, input: {
            homeId, managedId: row.id, expectedIntentRevision: 0, controller, requestId: 'admitted-policy-stop', purpose,
        } });
        await db.machine.update({ where: { id: guest.machineId }, data: { revokedAt: new Date() } });
        const app = fastify().withTypeProvider<ZodTypeProvider>();
        app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
        let actor = account.id;
        app.decorate('authenticate', async (request: FastifyRequest) => {
            Object.assign(request, createAuthenticatedRouteRequest({ userId: actor }), { headers: request.headers });
        });
        registerManagedMachineRoutes(app);
        const path = '/v1/machines/managed/controller/current';
        const correlation = { homeId, managedId: row.id, expectedIntentRevision: admitted.machine.intentRevision,
            controller, requestId: admitted.requestId };
        const headersFor = (body: typeof correlation, key = controllerKeys.secretKey, route = path,
            signedPurpose: Parameters<typeof createManagedPolicyProofV1>[0]['purpose'] = purpose) => ({ [MANAGED_POLICY_PROOF_HEADER]:
            encodeManagedPolicyProofV1(createManagedPolicyProofV1({ correlation: body, purpose: signedPurpose, resource,
                custodianAccountId: account.id, path: route, body, privateKey: key })) });
        try {
            const owner = await app.inject({ method: 'POST', url: path, payload: correlation, headers: headersFor(correlation) });
            expect(owner.statusCode, owner.body).toBe(200);
            expect(owner.json()).toMatchObject({ machine: { id: row.id, desired: 'stop' } });
            const mismatchedPurposeResponses = [];
            for (const route of [path, '/v1/machines/managed/controller/submit-intent']) {
                const response = await app.inject({ method: 'POST', url: route, payload: correlation,
                    headers: headersFor(correlation, controllerKeys.secretKey, route, { kind: 'creation-cleanup' }) });
                mismatchedPurposeResponses.push({ status: response.statusCode, body: response.json() });
            }
            const otherRequest = { ...correlation, requestId: 'not-admitted' };
            expect((await app.inject({ method: 'POST', url: path, payload: otherRequest, headers: headersFor(otherRequest) })).statusCode).toBe(409);
            expect((await app.inject({ method: 'POST', url: path, payload: correlation,
                headers: headersFor(correlation, tweetnacl.sign.keyPair().secretKey) })).statusCode).toBe(403);
            actor = 'another-account';
            expect((await app.inject({ method: 'POST', url: path, payload: correlation, headers: headersFor(correlation) })).statusCode).toBe(403);
            await expect(admitManagedPolicy({ custodianAccountId: account.id, input: { ...correlation,
                requestId: 'new-policy-stop', purpose } })).rejects.toMatchObject({ code: 'permission_denied' });
            actor = account.id;
            const action = await admitManagedControl({ actorAccountId: account.id, custodianAccountId: account.id,
                input: { action: 'machines.managed.power.set', requestId: 'user-action-stop', input: {
                    homeId, managedId: row.id, when: 'now', intent: 'stop', expectedRevision: admitted.machine.intentRevision,
                } } });
            const actionCorrelation = { ...correlation, expectedIntentRevision: action.machine.intentRevision,
                requestId: 'user-action-stop' };
            const policyResponses = [];
            for (const route of [path, '/v1/machines/managed/controller/submit-intent']) {
                const response = await app.inject({ method: 'POST', url: route, payload: actionCorrelation,
                    headers: headersFor(actionCorrelation, controllerKeys.secretKey, route) });
                policyResponses.push({ status: response.statusCode, body: response.json() });
            }
            expect(policyResponses).toEqual([
                { status: 409, body: { code: 'request_conflict' } },
                { status: 409, body: { code: 'request_conflict' } },
            ]);
            expect(mismatchedPurposeResponses).toEqual([
                { status: 409, body: { code: 'request_conflict' } },
                { status: 409, body: { code: 'request_conflict' } },
            ]);
        } finally { await app.close(); }
    });

    it("creates one durable reviewed allocation through the real current provisioner declaration", async () => {
        const { homeId, account, controller, controllerKeys, manifest, declaration, input, request, launch, native } = await createManagedComputeFixture('first');
        const created = await admitManagedAcquire(request);
        expect(created).toMatchObject({ replayed: false, machine: { allocation: "unsubmitted", custodianAccountId: account.id } });
        expect(await admitManagedAcquire(request)).toMatchObject({ replayed: true, machine: { id: created.machine.id } });
        const retained = await db.managedMachine.findUniqueOrThrow({ where: { id: created.machine.id } });
        expect(retained.admittedInput).toEqual({ computeInput: input, continuation: { requestEnvelopeDigest: request.requestEnvelopeDigest },
            enrollmentAccountId: account.id, requestEnvelopeDigest: request.requestEnvelopeDigest });
        expect(await db.managedMachine.count({ where: { admittedActionRequestId: "managed-first-request" } })).toBe(1);
        await expect(admitManagedAcquire({ ...request, requestEnvelopeDigest: "verified-changed-private-continuation" })).rejects.toMatchObject({ code: "request_conflict" });
        const correlation = { homeId, managedId: created.machine.id, expectedIntentRevision: 0, requestId: request.input.requestId, controller };
        await submitManagedAcquire(correlation);
        const resource = { contributionRef: { pluginId: manifest.id, localId: "compute" }, schemaVersion: 1, value: { id: "native-first" } };
        // A retained generic handle is readable, but a new provider claim must
        // have a declared reconciliation contract before becoming durable.
        await expect(reportManagedAcquire({ ...correlation, result: { kind: "pending", nativeOperationRef: {
            contributionRef: resource.contributionRef, schemaVersion: 1, value: { request: "undeclared-native-request" },
        } } })).rejects.toMatchObject({ code: "provider_unavailable" });
        expect(await db.managedMachine.findUniqueOrThrow({ where: { id: created.machine.id } })).toMatchObject({ allocation: "may-exist", nativeOperationRef: null });
        const retainedPending = { contributionRef: resource.contributionRef, schemaVersion: 1, value: { request: "retained-native-request", legacyField: "manual recovery evidence" } };
        await db.managedMachine.update({ where: { id: created.machine.id }, data: { nativeOperationRef: retainedPending } });
        expect(await getManagedMachine({ actorAccountId: account.id, input: { homeId, managedId: created.machine.id } })).toMatchObject({ allocation: "may-exist", nativeOperationRef: retainedPending });
        await expect(reportManagedAcquire({ ...correlation, result: { kind: "bound", resource: { ...resource, value: { id: "native-first", undeclared: true } } } })).rejects.toMatchObject({ code: "resource_mismatch" });
        expect(await reportManagedAcquire({ ...correlation, result: { kind: "bound", resource } })).toMatchObject({ machine: { allocation: "bound", resource } });
        await db.managedMachine.update({ where: { id: created.machine.id }, data: { launch: { ...input.selection.launch, futureEnvelope: true, choices: { image: "linux", futureChoice: true } }, resource: { ...resource, value: { id: "native-first", futureNative: true } } } });
        const projected = await getManagedMachine({ actorAccountId: account.id, input: { homeId, managedId: created.machine.id } });
        expect(projected).toMatchObject({ launch: input.selection.launch, resource });
        expect(projected.launch).toEqual(input.selection.launch);
        const control = { actorAccountId: account.id, custodianAccountId: account.id };
        const policyEdit = { action: 'machines.managed.retention.update' as const, requestId: 'invalid-destructive-wake', input: {
            homeId, managedId: created.machine.id, expectedIntentRevision: 0,
            retention: { kind: 'unused' as const, afterMs: 17, effect: 'delete' as const }, wakeOnAcceptedMessage: true,
        } };
        await expect(admitManagedControl({ ...control, input: policyEdit })).rejects.toMatchObject({ code: 'provider_unavailable' });
        const finiteManifest = PluginManifestV2Schema.parse({ ...manifest, contributes: { ...manifest.contributes,
            machineProvisioners: manifest.contributes.machineProvisioners!.map(provider => ({ ...provider,
                retention: { ...provider.retention, finiteOnly: true } })) } });
        const finiteDeclaration = createReleaseLessDeclarationV1(finiteManifest);
        await db.accountPluginIntent.update({ where: { accountId_pluginId: { accountId: account.id, pluginId: manifest.id } }, data: { releaseLessDeclaration: finiteDeclaration } });
        await db.pluginMachineMaterialization.updateMany({ where: { accountId: account.id, pluginId: manifest.id }, data: { archiveDigestSha256: finiteDeclaration.manifestDigestSha256 } });
        await expect(admitManagedControl({ ...control, input: { ...policyEdit, requestId: 'invalid-finite-keep', input: {
            ...policyEdit.input, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
        } } })).rejects.toMatchObject({ code: 'provider_unavailable' });
        expect(await db.managedMachine.findUniqueOrThrow({ where: { id: created.machine.id } })).toMatchObject({
            intentRevision: 0, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
        });
        await db.accountPluginIntent.update({ where: { accountId_pluginId: { accountId: account.id, pluginId: manifest.id } }, data: { releaseLessDeclaration: declaration } });
        await db.pluginMachineMaterialization.updateMany({ where: { accountId: account.id, pluginId: manifest.id }, data: { archiveDigestSha256: declaration.manifestDigestSha256 } });
        const stopped = await admitManagedControl({ ...control, input: { action: 'machines.managed.power.set', requestId: 'stop-request', input: { homeId, managedId: created.machine.id, when: 'after-idle', intent: 'stop', afterMs: 17.5 } } });
        expect(stopped.machine).toMatchObject({ id: created.machine.id, intentRevision: 1, desired: 'stop', desiredWhen: 'after-idle', desiredAfterMs: 17.5, resource });
        expect(stopped.machine.observation?.power).not.toBe('stopped');
        const stoppedCorrelation = { ...correlation, expectedIntentRevision: 1, requestId: 'stop-request' };
        expect(await db.managedMachine.findUniqueOrThrow({ where: { id: created.machine.id } })).toMatchObject({
            desiredAfterMs: 17.5,
            admittedActionRequestId: request.input.requestId,
            admittedInput: { computeInput: input, continuation: { requestEnvelopeDigest: request.requestEnvelopeDigest },
                currentAdmission: { kind: 'control', request: { action: 'machines.managed.power.set', requestId: 'stop-request' } } },
        });
        expect(await submitManagedIntent(stoppedCorrelation)).toMatchObject({ submitted: true });
        expect(await submitManagedIntent(stoppedCorrelation)).toMatchObject({ submitted: false });
        const edited = await admitManagedControl({ ...control, input: { action: 'machines.managed.retention.update', requestId: 'policy-request', input: { homeId, managedId: created.machine.id, expectedIntentRevision: 1, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } } });
        expect(edited.machine).toMatchObject({ intentRevision: 2, retention: { kind: 'until-delete' }, resource });
        expect(await reportManagedIntent({ ...stoppedCorrelation, result: { kind: 'unknown' } })).toMatchObject({ machine: { intentRevision: 2, retention: { kind: 'until-delete' }, resource } });
        await expect(admitManagedControl({ ...control, input: { action: 'machines.managed.controller.update', requestId: 'local-move', input: { homeId, managedId: created.machine.id, expectedIntentRevision: 2, controller, reviewedPendingEffects: true } } })).rejects.toMatchObject({ code: 'controller_unavailable' });
        const cloud = PluginManifestV2Schema.parse({ ...manifest, contributes: { ...manifest.contributes,
            machineProvisioners: manifest.contributes.machineProvisioners!.map(provider => ({ ...provider, billing: { location: 'cloud', stoppedBilling: 'billed' } })) } });
        const cloudDeclaration = createReleaseLessDeclarationV1(cloud);
        await db.accountPluginIntent.update({ where: { accountId_pluginId: { accountId: account.id, pluginId: manifest.id } }, data: { releaseLessDeclaration: cloudDeclaration } });
        await db.pluginMachineMaterialization.updateMany({ where: { accountId: account.id, pluginId: manifest.id }, data: { archiveDigestSha256: cloudDeclaration.manifestDigestSha256 } });
        const destination = { machineId: 'managed-cloud-destination', installationId: 'cloud-destination-installation' };
        await db.machine.create({ data: { id: destination.machineId, accountId: account.id, metadata: 'ciphertext', installationId: destination.installationId, pluginMaterializationRevision: BigInt(1) } });
        await db.pluginMachineMaterialization.create({ data: { accountId: account.id, serverIdentityId: homeId, machineId: destination.machineId, materializationId: destination.installationId, pluginId: cloud.id, version: cloud.version, sourceClass: 'bundledFirstParty', portableRelease: false, archiveDigestSha256: cloudDeclaration.manifestDigestSha256, uiArtifacts: [], enabled: true, trustState: 'trusted', observedAt: new Date() } });
        await db.machine.update({ where: { id: controller.machineId }, data: { active: false } });
        const moveRequest = { action: 'machines.managed.controller.update' as const, requestId: 'move-request', input: {
            homeId, managedId: created.machine.id, expectedIntentRevision: 2, controller: destination, reviewedPendingEffects: true as const,
        } };
        const moveApp = fastify().withTypeProvider<ZodTypeProvider>();
        moveApp.setValidatorCompiler(validatorCompiler); moveApp.setSerializerCompiler(serializerCompiler);
        let moveExecutor = destination.machineId;
        // Only installed execution authentication is substituted; the route,
        // destination custody, declaration, launch and row CAS stay real.
        moveApp.decorate('authenticate', async (request: FastifyRequest) => {
            Object.assign(request, createAuthenticatedRouteRequest({ userId: account.id,
                externalActionExecutionAuthorized: true, externalActionExecutionMachineId: moveExecutor,
                externalActionEffectActionId: moveRequest.action, externalActionExecutionRequestId: moveRequest.requestId,
                externalActionExecutionCustodianAccountId: account.id,
            }), { headers: request.headers, params: request.params, query: request.query });
        });
        registerManagedMachineRoutes(moveApp);
        onTestFinished(() => moveApp.close());
        const moveResponse = await moveApp.inject({ method: 'POST', url: '/v1/machines/managed/controller/admit-control', payload: moveRequest });
        expect(moveResponse.statusCode, moveResponse.body).toBe(200);
        const moved = moveResponse.json<Awaited<ReturnType<typeof admitManagedControl>>>();
        expect(moved.machine).toMatchObject({ intentRevision: 3, controller: destination, resource, submittedNativeEffect: { requestId: 'stop-request', intent: 'stop', controller } });
        moveExecutor = controller.machineId;
        const oldExecutorReplay = await moveApp.inject({ method: 'POST', url: '/v1/machines/managed/controller/admit-control', payload: moveRequest });
        expect(oldExecutorReplay.statusCode).toBe(403);
        expect(oldExecutorReplay.json()).toMatchObject({ code: 'permission_denied' });
        await expect(submitManagedIntent(stoppedCorrelation)).rejects.toMatchObject({ code: 'controller_retired' });
        expect(await submitManagedIntent({ ...stoppedCorrelation, controller: destination, expectedIntentRevision: 3, requestId: 'move-request' })).toMatchObject({ submitted: false });
        expect(await reportManagedIntent({ ...stoppedCorrelation, result: { kind: 'confirmed' } })).toMatchObject({ machine: { controller: destination, submittedNativeEffect: { requestId: 'stop-request' } } });
        expect(await reportManagedIntent({ ...stoppedCorrelation, result: { kind: 'confirmed' }, observation: { observedAt: 100, availability: 'present', power: 'stopped' } })).toMatchObject({ machine: { intentRevision: 3, controller: destination, observation: { power: 'stopped' } } });
        const settledRow = await db.managedMachine.findUniqueOrThrow({ where: { id: created.machine.id } });
        expect(settledRow).toMatchObject({ admittedActionRequestId: request.input.requestId, cleanup: null,
            admittedInput: { computeInput: input, continuation: { requestEnvelopeDigest: request.requestEnvelopeDigest },
                currentAdmission: { kind: 'control', request: { requestId: 'move-request' } } } });
        expect(settledRow.admittedInput).not.toHaveProperty('submittedEffect');
        const archived = await admitManagedControl({ ...control, input: { action: 'machines.managed.retire', requestId: 'retire-request', input: { homeId, managedId: created.machine.id, expectedIntentRevision: 3, manualResponsibility: true } } });
        expect(archived.machine).toMatchObject({ intentRevision: 4, allocation: 'bound', resource, archivedAt: expect.any(Number), cleanup: { disposition: 'unavailable', reason: 'manual_responsibility' } });
        expect((await listManagedMachines({ actorAccountId: account.id, input: { homeId, archived: true } })).machines).toEqual(expect.arrayContaining([expect.objectContaining({ id: created.machine.id })]));

        // Native control must not turn an original purchase replay into another
        // unsubmitted allocation by replacing its creation correlation.
        expect(await admitManagedAcquire(request)).toMatchObject({ replayed: true, machine: { id: created.machine.id } });
        expect(await db.managedMachine.count({ where: { custodianAccountId: account.id } })).toBe(1);

        // A provider may return an identity after the user accepts manual
        // retirement of a submitted purchase. Keep that exact paid identity for
        // recovery; retirement must never make it unreportable or buy again.
        const lateRequest = { ...request, input: { ...request.input, requestId: 'managed-retiring-purchase' } };
        const purchasing = await admitManagedAcquire(lateRequest);
        const lateCorrelation = { ...correlation, managedId: purchasing.machine.id, requestId: lateRequest.input.requestId };
        expect(await submitManagedAcquire(lateCorrelation)).toMatchObject({ submitted: true });
        await admitManagedControl({ ...control, input: { action: 'machines.managed.retire', requestId: 'retire-purchasing-request', input: {
            homeId, managedId: purchasing.machine.id, expectedIntentRevision: 0, manualResponsibility: true,
        } } });
        const lateResource = { ...resource, value: { id: 'paid-native-after-retirement' } };
        expect(await reportManagedAcquire({ ...lateCorrelation, result: { kind: 'bound', resource: lateResource } })).toMatchObject({
            machine: { id: purchasing.machine.id, allocation: 'bound', resource: lateResource, archivedAt: expect.any(Number) },
        });
        await expect(inTx(tx => requireManagedEnrollmentInTx(tx, { ...lateCorrelation, resource: lateResource }, account.id))).rejects.toMatchObject({ code: 'enrollment_retired' });
        expect(await db.managedMachine.count({ where: { custodianAccountId: account.id } })).toBe(2);

        // The accepted input keeps its immutable identity while current
        // controller custody and policy revisions change around that input.
        const moveGuest = { machineId: 'managed-pending-move-guest', installationId: 'managed-pending-move-installation' };
        await db.machine.create({ data: { id: moveGuest.machineId, accountId: account.id, metadata: 'ciphertext',
            installationId: moveGuest.installationId, operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1] } }, operationProtocolCapabilitiesRevision: 1 } });
        const moveSession = await db.session.create({ data: { accountId: account.id, tag: 'managed-pending-move', metadata: 'ciphertext' } });
        await db.accessKey.create({ data: { accountId: account.id, machineId: moveGuest.machineId, sessionId: moveSession.id, data: 'encrypted' } });
        const moveInput = { ...input, selection: { ...input.selection, wakeOnAcceptedMessage: true } };
        const moveAcquire = await admitManagedAcquire({ ...request, input: { input: moveInput, requestId: 'managed-pending-move-purchase', continuationPresent: false } });
        const moveCorrelation = { ...correlation, managedId: moveAcquire.machine.id, requestId: 'managed-pending-move-purchase' };
        await submitManagedAcquire(moveCorrelation);
        const devcontainerObservation = { nativeResourceId: 'managed-pending-move-native', user: 'custom-user',
            workspaceFolder: '/work/custom', storage: { kind: 'bind' as const, hostPath: '/host/project', childPath: '/work/custom' } };
        const moveResource = { ...resource, value: { id: 'managed-pending-move-native' }, devcontainerObservation };
        await reportManagedAcquire({ ...moveCorrelation, result: { kind: 'bound', resource: moveResource },
            observation: { observedAt: 300, availability: 'present', power: 'stopped' } });
        await expect(inTx(tx => linkManagedEnrollmentInTx(tx, { ...moveCorrelation, resource: moveResource }, account.id,
            controller.machineId))).rejects.toMatchObject({ code: 'resource_mismatch' });
        const clonedController = await db.machine.create({ data: { id: 'managed-controller-cloned-installation', accountId: account.id,
            metadata: 'ciphertext', installationId: controller.installationId } });
        await expect(inTx(tx => linkManagedEnrollmentInTx(tx, { ...moveCorrelation, resource: moveResource }, account.id,
            clonedController.id))).rejects.toMatchObject({ code: 'resource_mismatch' });
        const pendingRecipient = await db.account.create({ data: { publicKey: 'managed-child-key-pending-recipient' } });
        await db.machineAccountGrant.create({ data: { machineId: moveGuest.machineId, accountId: pendingRecipient.id,
            createdByAccountId: account.id, accessLevel: 'view' } });
        expect(await inTx(tx => resolveMachineAccessInTx(tx, { machineId: moveGuest.machineId,
            actorAccountId: pendingRecipient.id }))).toMatchObject({ accessState: 'key_pending' });
        const childPublications: Array<{ room: string | string[]; payload: unknown }> = [];
        // Only the Socket.IO room transport is replaced; the transaction, current
        // row projection, cursors, recipient decisions and EventRouter stay real.
        eventRouter.setIo({ to: room => ({ emit: (event, payload) => { if (event === 'update') childPublications.push({ room, payload }); },
            disconnectSockets: () => undefined }) });
        onTestFinished(() => eventRouter.clearIo());
        await inTx(tx => linkManagedEnrollmentInTx(tx, { ...moveCorrelation, resource: moveResource }, account.id, moveGuest.machineId));
        expect(await getManagedMachine({ actorAccountId: account.id, input: { homeId, managedId: moveAcquire.machine.id } })).toMatchObject({
            enrolledMachineId: moveGuest.machineId, devcontainerChild: {
                relation: { managedMachineId: moveAcquire.machine.id, managedMachineKind: 'devcontainer', parentMachineId: controller.machineId },
                observation: devcontainerObservation,
            },
        });
        const publishedChild = await inTx(tx => readMachineDevcontainerChildInTx(tx, moveGuest.machineId));
        expect(publishedChild).toEqual({ relation: { managedMachineId: moveAcquire.machine.id,
            managedMachineKind: 'devcontainer', parentMachineId: controller.machineId }, observation: devcontainerObservation });
        expect(await inTx(tx => readMachineDevcontainerChildInTx(tx, controller.machineId))).toBeNull();
        const fleetChildren = await inTx(tx => readMachineDevcontainerChildrenInTx(tx, [moveGuest.machineId, controller.machineId, 'absent-machine']));
        expect(fleetChildren.get(moveGuest.machineId)).toEqual(publishedChild);
        expect(fleetChildren.get(controller.machineId) ?? null).toBeNull();
        expect(fleetChildren.get('absent-machine') ?? null).toBeNull();
        const readChildPublications = (accountId?: string) => childPublications.flatMap(value => {
            if (accountId && ![value.room].flat().includes(`user-scoped:${accountId}`)) return [];
            const parsed = UpdateContainerSchema.safeParse(value.payload);
            return parsed.success ? [parsed.data.body] : [];
        });
        expect(readChildPublications()).toEqual(expect.arrayContaining([expect.objectContaining({
            t: 'update-machine', machineId: moveGuest.machineId, devcontainerChild: publishedChild,
        })]));
        expect(readChildPublications(pendingRecipient.id)).toEqual(expect.arrayContaining([expect.objectContaining({
            t: 'update-machine', machineId: moveGuest.machineId, devcontainerChild: null,
        })]));
        expect(readChildPublications(pendingRecipient.id).some(body => body.t === 'update-machine'
            && body.devcontainerChild !== null && body.devcontainerChild !== undefined)).toBe(false);
        expect((await db.machine.findUniqueOrThrow({ where: { id: moveGuest.machineId } })).metadata).toBe('ciphertext');
        const movedPending = await enqueuePendingMessageByAuthenticatedMachine({ accountId: account.id, sourceMachineId: controller.machineId,
            targetMachineId: moveGuest.machineId, sessionId: moveSession.id, localId: 'managed-pending-move-input',
            content: { t: 'encrypted', c: 'accepted-before-controller-move' }, requestedAction: { v: 1, kind: 'send_now' },
        });
        expect(movedPending, JSON.stringify(movedPending)).toMatchObject({ status: 'accepted' });
        const moveOrigin = ManagedWakeTargetV1Schema.parse((await db.session.findUniqueOrThrow({ where: { id: moveSession.id } })).pendingActivationManagedTarget);
        const census = (currentController: typeof controller) => readManagedWakeTargets({ actorAccountId: account.id,
            request: { homeId, controller: currentController } });
        expect(await census(controller)).toMatchObject({ targets: [moveOrigin] });
        await admitManagedControl({ ...control, input: { action: 'machines.managed.controller.update', requestId: 'managed-pending-move-control',
            input: { homeId, managedId: moveAcquire.machine.id, expectedIntentRevision: 0, controller: destination, reviewedPendingEffects: true } } });
        expect(await census(controller)).toEqual({ targets: [] });
        const movedTarget = { ...moveOrigin, controller: destination, expectedIntentRevision: 1 };
        expect(await census(destination)).toEqual({ targets: [movedTarget] });
        expect(await getManagedMachine({ actorAccountId: account.id, input: { homeId, managedId: moveAcquire.machine.id } })).toMatchObject({ resource: moveResource, controller: destination });
        await admitManagedPolicy({ custodianAccountId: account.id, input: { homeId, managedId: moveAcquire.machine.id,
            expectedIntentRevision: 1, requestId: 'managed-pending-move-wake', controller: destination,
            purpose: { kind: 'accepted-input-start', target: movedTarget } } });
        expect(await census(destination)).toEqual({ targets: [{ ...movedTarget, expectedIntentRevision: 2 }] });
        await admitManagedControl({ ...control, input: { action: 'machines.managed.retention.update', requestId: 'managed-pending-move-wake-off',
            input: { homeId, managedId: moveAcquire.machine.id, expectedIntentRevision: 2, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } } });
        expect(await census(destination)).toEqual({ targets: [] });
        await admitManagedControl({ ...control, input: { action: 'machines.managed.retention.update', requestId: 'managed-pending-move-wake-on',
            input: { homeId, managedId: moveAcquire.machine.id, expectedIntentRevision: 3, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: true } } });
        expect(await census(destination)).toEqual({ targets: [{ ...movedTarget, expectedIntentRevision: 4 }] });
        await db.machine.update({ where: { id: moveGuest.machineId }, data: { revokedAt: new Date() } });
        expect(await census(destination)).toEqual({ targets: [] });
        await db.machine.update({ where: { id: moveGuest.machineId }, data: { revokedAt: null } });
        expect(await census(destination)).toEqual({ targets: [{ ...movedTarget, expectedIntentRevision: 4 }] });
        await expect(deletePendingMessage({ actorUserId: account.id, sessionId: moveSession.id,
            localId: 'managed-pending-move-input', withdraw: true,
            authentication: createPresentUserSessionAccessAuthentication() })).resolves.toMatchObject({ ok: true, outcome: 'removed' });
        expect(await census(destination)).toEqual({ targets: [] });

        const guestKeys = tweetnacl.sign.keyPair();
        const guest = { machineId: 'policy-guest', installationId: 'policy-guest-installation' };
        await db.machine.create({ data: { id: guest.machineId, accountId: account.id, metadata: 'ciphertext', installationId: guest.installationId, installationPublicKey: Buffer.from(guestKeys.publicKey) } });
        const policyRow = await db.managedMachine.create({ data: { homeId, custodianAccountId: account.id,
            controllerMachineId: controller.machineId, controllerInstallationId: controller.installationId,
            admittedActionRequestId: 'policy-created', admittedInput: {}, launch: input.selection.launch,
            allocation: 'bound', resource, enrolledMachineId: guest.machineId,
            retention: { kind: 'unused', afterMs: 17.5, effect: 'stop' }, wakeOnAcceptedMessage: true } });
        const context = { actorAccountId: account.id, custodianAccountId: account.id, ...guest, role: 'manage' as const, encryptionMode: account.encryptionMode === 'plain' ? 'plain' as const : 'e2ee' as const };
        const managedTarget = { homeId, managedId: policyRow.id, expectedRevision: 0, controller };
        const method = `${guest.machineId}:managed.admission.drain.confirm`;
        const decision = { kind: 'idle' as const, since: 100, confirmedAt: 118 };
        const evidence: ManagedCommittedIdleEvidenceV1 = { context, method, managedTarget, decision,
            proof: signMachineInstallationProof({ payload: { version: 1, machineId: guest.machineId,
                installationId: guest.installationId, accountId: account.id,
                rpcAdmission: { context, method, managedTarget, managedIdleDecision: decision } }, privateKey: guestKeys.secretKey }) };
        const policyInput = { homeId, managedId: policyRow.id, expectedIntentRevision: 0, requestId: 'policy-fire', controller,
            purpose: { kind: 'retention' as const, evidence } };
        await expect(admitManagedPolicy({ custodianAccountId: account.id, input: { ...policyInput, purpose: { kind: 'retention', evidence: { ...evidence, decision: { ...decision, since: 0 } } } } })).rejects.toMatchObject({ code: 'permission_denied' });
        expect(await admitManagedPolicy({ custodianAccountId: account.id, input: policyInput })).toMatchObject({
            machine: { id: policyRow.id, intentRevision: 1, desired: 'stop', desiredWhen: 'now', resource }, replayed: false,
        });
        expect(await admitManagedPolicy({ custodianAccountId: account.id, input: policyInput })).toMatchObject({ replayed: true });
        expect(await db.managedMachine.findUniqueOrThrow({ where: { id: policyRow.id } })).toMatchObject({
            admittedActionRequestId: 'policy-created', admittedInput: { currentAdmission: { kind: 'policy', request: policyInput } },
        });
        // A provisioner that parks only with Suspend keeps its data: the unused-Stop policy is carried out as Suspend, never Delete.
        const suspendOnlyManifest = PluginManifestV2Schema.parse({ ...manifest, contributes: { ...manifest.contributes,
            machineProvisioners: manifest.contributes.machineProvisioners!.map(provider => ({ ...provider,
                retention: { ...provider.retention, supportedIntents: ['start', 'suspend', 'resume', 'delete'] } })) } });
        const suspendOnlyDeclaration = createReleaseLessDeclarationV1(suspendOnlyManifest);
        await db.accountPluginIntent.update({ where: { accountId_pluginId: { accountId: account.id, pluginId: manifest.id } }, data: { releaseLessDeclaration: suspendOnlyDeclaration } });
        await db.pluginMachineMaterialization.updateMany({ where: { accountId: account.id, pluginId: manifest.id }, data: { archiveDigestSha256: suspendOnlyDeclaration.manifestDigestSha256 } });
        const suspendGuestKeys = tweetnacl.sign.keyPair();
        const suspendGuest = { machineId: 'policy-suspend-guest', installationId: 'policy-suspend-guest-installation' };
        await db.machine.create({ data: { id: suspendGuest.machineId, accountId: account.id, metadata: 'ciphertext', installationId: suspendGuest.installationId, installationPublicKey: Buffer.from(suspendGuestKeys.publicKey) } });
        const suspendRow = await db.managedMachine.create({ data: { homeId, custodianAccountId: account.id,
            controllerMachineId: controller.machineId, controllerInstallationId: controller.installationId,
            admittedActionRequestId: 'policy-suspend-created', admittedInput: {}, launch: input.selection.launch,
            allocation: 'bound', resource, enrolledMachineId: suspendGuest.machineId,
            retention: { kind: 'unused', afterMs: 17.5, effect: 'stop' }, wakeOnAcceptedMessage: true } });
        const suspendContext = { ...context, ...suspendGuest };
        const suspendTarget = { ...managedTarget, managedId: suspendRow.id };
        const suspendMethod = `${suspendGuest.machineId}:managed.admission.drain.confirm`;
        const suspendEvidence: ManagedCommittedIdleEvidenceV1 = { context: suspendContext, method: suspendMethod, managedTarget: suspendTarget, decision,
            proof: signMachineInstallationProof({ payload: { version: 1, machineId: suspendGuest.machineId,
                installationId: suspendGuest.installationId, accountId: account.id,
                rpcAdmission: { context: suspendContext, method: suspendMethod, managedTarget: suspendTarget, managedIdleDecision: decision } }, privateKey: suspendGuestKeys.secretKey }) };
        expect(await admitManagedPolicy({ custodianAccountId: account.id, input: { homeId, managedId: suspendRow.id, expectedIntentRevision: 0,
            requestId: 'policy-suspend-fire', controller, purpose: { kind: 'retention', evidence: suspendEvidence } } })).toMatchObject({
            machine: { id: suspendRow.id, desired: 'suspend', desiredWhen: 'now', retention: { kind: 'unused', effect: 'stop' }, wakeOnAcceptedMessage: true }, replayed: false,
        });
        await db.accountPluginIntent.update({ where: { accountId_pluginId: { accountId: account.id, pluginId: manifest.id } }, data: { releaseLessDeclaration: declaration } });
        await db.pluginMachineMaterialization.updateMany({ where: { accountId: account.id, pluginId: manifest.id }, data: { archiveDigestSha256: declaration.manifestDigestSha256 } });
        await db.machine.update({ where: { id: guest.machineId }, data: { operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1] } }, operationProtocolCapabilitiesRevision: 1 } });
        const session = await db.session.create({ data: { accountId: account.id, tag: 'managed-resume-accepted-input', metadata: 'ciphertext' } });
        await db.accessKey.create({ data: { accountId: account.id, machineId: guest.machineId, sessionId: session.id, data: 'encrypted' } });
        await db.managedMachine.update({ where: { id: policyRow.id }, data: { retention: { kind: 'until-delete' }, observation: { observedAt: 200, availability: 'present', power: 'suspended' } } });
        await expect(enqueuePendingMessageByAuthenticatedMachine({ accountId: account.id, sourceMachineId: controller.machineId,
            targetMachineId: guest.machineId, sessionId: session.id, localId: 'resume-input', content: { t: 'encrypted', c: 'private-input' },
            requestedAction: { v: 1, kind: 'send_now' } })).resolves.toMatchObject({ status: 'accepted' });
        const acceptedSession = await db.session.findUniqueOrThrow({ where: { id: session.id } });
        const target = ManagedWakeTargetV1Schema.parse(acceptedSession.pendingActivationManagedTarget);
        const wakePurpose = { kind: 'accepted-input-start' as const, target };
        const resumeInput = { ...policyInput, expectedIntentRevision: 1, requestId: 'resume-policy', purpose: wakePurpose };
        expect(await admitManagedPolicy({ custodianAccountId: account.id, input: resumeInput })).toMatchObject({
            machine: { intentRevision: 2, desired: 'resume', resource }, requestId: 'resume-policy', replayed: false,
        });
        expect(await admitManagedPolicy({ custodianAccountId: account.id, input: { ...resumeInput, expectedIntentRevision: 2, requestId: 'duplicate-resume-policy' } })).toMatchObject({
            machine: { intentRevision: 2, desired: 'resume' }, requestId: 'resume-policy', replayed: true,
        });
        await expect(deletePendingMessage({ actorUserId: account.id, sessionId: session.id, localId: 'resume-input', withdraw: true,
            authentication: createPresentUserSessionAccessAuthentication() })).resolves.toMatchObject({ ok: true, outcome: 'removed' });
        const currentResume = await db.managedMachine.findUniqueOrThrow({ where: { id: policyRow.id } });
        await expect(inTx(tx => requireManagedPolicyPurposeInTx(tx, currentResume, wakePurpose))).rejects.toMatchObject({ code: 'admission_unavailable' });

        const nativeOperation = defineProtocolObject({ request: defineProtocolString({ minLength: 1 }), region: defineProtocolString({ minLength: 1 }) }, { policy: 'closed' });
        const reconciliation = defineMachineProvisionerReconciliationSchemas({ launch, resource: native, nativeOperation });
        const reconcilingManifest = PluginManifestV2Schema.parse({ ...cloud, contributes: { ...cloud.contributes,
            machineProvisioners: cloud.contributes.machineProvisioners!.map(provider => ({ ...provider, reconciliation: { action: 'reconcile', nativeOperationSchema: nativeOperation.jsonSchema } })),
            actions: [...cloud.contributes.actions!.map(action => action.id === 'acquire' ? { ...action, resultSchema: reconciliation.result.jsonSchema }
                : action.id === 'destroy' ? { ...action, inputSchema: reconciliation.destroyInput.jsonSchema } : action),
                { id: 'reconcile', title: 'Reconcile', inputSchema: reconciliation.input.jsonSchema, resultSchema: reconciliation.result.jsonSchema,
                    execution: { target: 'daemon' }, surfaces: ['plugin'], scopes: ['global'], dangerLevel: 'safe' }],
        } });
        const reconcilingDeclaration = createReleaseLessDeclarationV1(reconcilingManifest);
        await db.accountPluginIntent.update({ where: { accountId_pluginId: { accountId: account.id, pluginId: manifest.id } }, data: { releaseLessDeclaration: reconcilingDeclaration } });
        await db.pluginMachineMaterialization.updateMany({ where: { accountId: account.id, pluginId: manifest.id }, data: { archiveDigestSha256: reconcilingDeclaration.manifestDigestSha256 } });
        const pendingRequest = { ...request, input: { ...request.input, requestId: 'managed-declared-pending' } };
        const pending = await admitManagedAcquire(pendingRequest);
        const pendingCorrelation = { ...correlation, managedId: pending.machine.id, requestId: pendingRequest.input.requestId };
        await submitManagedAcquire(pendingCorrelation);
        const nativeOperationRef = { contributionRef: resource.contributionRef, schemaVersion: 1, value: { request: 'submitted-request', region: 'reviewed-region' } };
        for (const { cancellation, retainsIdentity } of [
            { cancellation: false, retainsIdentity: true }, { cancellation: true, retainsIdentity: true },
            { cancellation: false, retainsIdentity: false },
        ]) {
            const cleanupRequest = { ...request, input: { ...request.input, requestId: `partial-cleanup-${cancellation}-${retainsIdentity}` } };
            const partial = await admitManagedAcquire(cleanupRequest);
            const original = { ...correlation, managedId: partial.machine.id, requestId: cleanupRequest.input.requestId };
            await submitManagedAcquire(original);
            if (retainsIdentity) await reportManagedAcquire({ ...original, result: { kind: 'pending', nativeOperationRef } });
            const cleanup = cancellation
                ? await cancelManagedCreation({ actorAccountId: account.id, input: { homeId, managedId: partial.machine.id, expectedIntentRevision: 0 } })
                : await admitManagedControl({ ...control, input: { action: 'machines.managed.delete', requestId: 'delete-partial', input: {
                    homeId, managedId: partial.machine.id, when: 'now', expectedRevision: 0, intent: 'delete', reviewedDependencies: true,
                } } });
            expect(cleanup.machine).toMatchObject({ allocation: 'may-exist', desired: 'delete',
                ...(retainsIdentity ? { nativeOperationRef } : {}) });
            expect(cleanup.machine.resource).toBeUndefined();
            const cleanupCorrelation = { ...original, expectedIntentRevision: 1,
                requestId: cancellation ? original.requestId : 'delete-partial' };
            let admittedCleanup: Awaited<ReturnType<typeof admitManagedPolicy>> | undefined;
            if (cancellation) {
                const policyInput = { ...cleanupCorrelation, requestId: 'cancel-partial-policy', purpose: { kind: 'creation-cleanup' as const } };
                const app = fastify().withTypeProvider<ZodTypeProvider>();
                app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
                // HTTP login is the boundary; retained native-target and installation proof checks are real.
                app.decorate('authenticate', async (request: FastifyRequest) => {
                    Object.assign(request, createAuthenticatedRouteRequest({ userId: account.id }), { headers: request.headers });
                });
                registerManagedMachineRoutes(app);
                const path = '/v1/machines/managed/controller/admit-policy';
                const carrier = createManagedPolicyProofV1({ correlation: { ...cleanupCorrelation, requestId: policyInput.requestId },
                    purpose: policyInput.purpose, nativeOperation: nativeOperationRef, custodianAccountId: account.id,
                    path, body: policyInput, privateKey: controllerKeys.secretKey });
                try {
                    const wrongTarget = createManagedPolicyProofV1({ correlation: { ...cleanupCorrelation, requestId: policyInput.requestId },
                        purpose: policyInput.purpose, nativeOperation: { ...nativeOperationRef, value: { ...nativeOperationRef.value, request: 'other-paid-attachment' } },
                        custodianAccountId: account.id, path, body: policyInput, privateKey: controllerKeys.secretKey });
                    const refused = await app.inject({ method: 'POST', url: path, payload: policyInput,
                        headers: { [MANAGED_POLICY_PROOF_HEADER]: encodeManagedPolicyProofV1(wrongTarget) } });
                    expect(refused.statusCode, refused.body).toBe(403);
                    const response = await app.inject({ method: 'POST', url: path, payload: policyInput,
                        headers: { [MANAGED_POLICY_PROOF_HEADER]: encodeManagedPolicyProofV1(carrier) } });
                    expect(response.statusCode, response.body).toBe(200);
                    admittedCleanup = response.json<Awaited<ReturnType<typeof admitManagedPolicy>>>();
                } finally { await app.close(); }
            }
            const currentCleanup = admittedCleanup ? { ...cleanupCorrelation, expectedIntentRevision: admittedCleanup.machine.intentRevision,
                requestId: admittedCleanup.requestId } : cleanupCorrelation;
            if (!retainsIdentity) {
                // Remove first runs the provisioner's existing correlation read.
                // Only that exact admitted report may bind the recovered identity.
                await expect(reportManagedAcquire({ ...currentCleanup, managedId: pending.machine.id,
                    result: { kind: 'bound', resource } }, { requestAuthority: 'intent' })).rejects.toMatchObject({ code: 'request_conflict' });
                await reportManagedAcquire({ ...currentCleanup, result: { kind: 'bound', resource } }, { requestAuthority: 'intent' });
            }
            expect(await submitManagedIntent(currentCleanup)).toMatchObject({ submitted: true });
            expect(await reportManagedIntent({ ...currentCleanup, result: { kind: 'unknown' } })).toMatchObject({
                machine: { allocation: retainsIdentity ? 'may-exist' : 'bound', ...(retainsIdentity ? { nativeOperationRef } : {}), cleanup: { disposition: 'pending' }, submittedNativeEffect: { intent: 'delete' } },
            });
            const settledCleanup = await reportManagedIntent({ ...currentCleanup, result: { kind: 'confirmed' }, observation: {
                observedAt: 900, availability: 'absent',
            } });
            expect(settledCleanup).toMatchObject({ machine: { allocation: 'confirmed-absent' } });
            expect(settledCleanup.machine.nativeOperationRef).toBeUndefined();
            expect(await db.managedMachine.findUniqueOrThrow({ where: { id: partial.machine.id } })).toMatchObject({ cleanup: null, nativeOperationRef: null });
            await expect(submitManagedAcquire(original)).rejects.toMatchObject({ code: cancellation ? 'enrollment_retired' : 'intent_changed' });
        }
        for (const invalid of [
            { ...nativeOperationRef, value: { ...nativeOperationRef.value, undeclared: true } },
            { ...nativeOperationRef, value: { request: 17, region: 'reviewed-region' } },
            { ...nativeOperationRef, schemaVersion: 2 },
            { ...nativeOperationRef, contributionRef: { pluginId: 'fixture.other', localId: 'compute' } },
        ]) await expect(reportManagedAcquire({ ...pendingCorrelation, result: { kind: 'pending', nativeOperationRef: invalid } })).rejects.toMatchObject({ code: 'resource_mismatch' });
        expect(await reportManagedAcquire({ ...pendingCorrelation, result: { kind: 'pending', nativeOperationRef } })).toMatchObject({ machine: { allocation: 'may-exist', nativeOperationRef } });
        await db.managedMachine.update({ where: { id: pending.machine.id }, data: { nativeOperationRef: { ...nativeOperationRef, futureEnvelope: true, value: { ...nativeOperationRef.value, futureNative: true } } } });
        expect((await getManagedMachine({ actorAccountId: account.id, input: { homeId, managedId: pending.machine.id } })).nativeOperationRef).toEqual(nativeOperationRef);
        expect(await admitManagedAcquire(pendingRequest)).toMatchObject({ replayed: true, machine: { id: pending.machine.id, nativeOperationRef } });
        expect(await submitManagedAcquire(pendingCorrelation)).toMatchObject({ submitted: false });
        await admitManagedControl({ ...control, input: { action: 'machines.managed.retire', requestId: 'retire-pending-recovery', input: {
            homeId, managedId: pending.machine.id, expectedIntentRevision: 0, manualResponsibility: true,
        } } });
        // Inspect reconciles with the current intent tuple, while a late
        // original purchase result retains its distinct creation authority.
        const recovered = await reportManagedAcquire({ ...pendingCorrelation, expectedIntentRevision: 1, requestId: 'retire-pending-recovery',
            result: { kind: 'bound', resource: { ...resource, value: { id: 'reconciled-native' } } } }, { requestAuthority: 'intent' });
        expect(recovered).toMatchObject({
            machine: { allocation: 'bound', resource: { value: { id: 'reconciled-native' } }, archivedAt: expect.any(Number),
                cleanup: { disposition: 'unavailable', reason: 'manual_responsibility' } },
        });
        expect(recovered.machine.nativeOperationRef).toBeUndefined();

        // Cancellation cannot unsend native allocation. Its late paid identity
        // must reach the same controller cleanup owner, not stay stranded.
        const canceledRequest = { ...request, input: { ...request.input, requestId: 'managed-canceled-native-purchase' } };
        const canceledPurchase = await admitManagedAcquire(canceledRequest);
        const canceledCorrelation = { ...correlation, managedId: canceledPurchase.machine.id, requestId: canceledRequest.input.requestId };
        await submitManagedAcquire(canceledCorrelation);
        expect(await cancelManagedCreation({ actorAccountId: account.id, input: { homeId, managedId: canceledPurchase.machine.id, expectedIntentRevision: 0 } })).toMatchObject({
            machine: { creationState: 'canceled', allocation: 'may-exist', desired: 'delete', intentRevision: 1, cleanup: { disposition: 'pending' } },
        });
        const canceledResource = { ...resource, value: { id: 'paid-native-after-cancel' } };
        // A known submitted native handle is a cleanup fact even before its
        // resource can be observed; cancellation must not strand that handle.
        expect(await reportManagedAcquire({ ...canceledCorrelation, result: { kind: 'pending', nativeOperationRef } })).toMatchObject({
            machine: { creationState: 'canceled', allocation: 'may-exist', nativeOperationRef, desired: 'delete', intentRevision: 1,
                cleanup: { disposition: 'pending' } },
        });
        expect(await reportManagedAcquire({ ...canceledCorrelation, result: { kind: 'bound', resource: canceledResource } })).toMatchObject({
            machine: { creationState: 'canceled', allocation: 'bound', resource: canceledResource, desired: 'delete', intentRevision: 1 },
        });
        await expect(inTx(tx => requireManagedEnrollmentInTx(tx, { ...canceledCorrelation, expectedIntentRevision: 1, resource: canceledResource }, account.id))).rejects.toMatchObject({ code: 'enrollment_retired' });
        const censusApp = fastify().withTypeProvider<ZodTypeProvider>();
        censusApp.setValidatorCompiler(validatorCompiler);
        censusApp.setSerializerCompiler(serializerCompiler);
        // Authentication is the HTTP boundary; the real installation proof,
        // current row and native-identity projection remain exercised.
        censusApp.decorate('authenticate', async (request: FastifyRequest) => { request.userId = account.id; });
        registerManagedMachineRoutes(censusApp);
        try {
            const response = await censusApp.inject({ method: 'POST', url: '/v1/machines/managed/controller/policies', payload: { homeId, controller,
                proof: createManagedPolicyCensusProofV1({ homeId, controller, custodianAccountId: account.id, privateKey: controllerKeys.secretKey }),
            } });
            expect(response.statusCode).toBe(200);
            expect(response.json().machines).toEqual(expect.arrayContaining([expect.objectContaining({ id: canceledPurchase.machine.id,
                creationState: 'canceled', resource: canceledResource, desired: 'delete', cleanup: expect.objectContaining({ disposition: 'pending' }) })]));
            expect(response.json().machines).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: pending.machine.id })]));
        } finally { await censusApp.close(); }
        const cleanupPurpose = { kind: 'creation-cleanup' as const };
        const cleanupAdmission = { ...canceledCorrelation, expectedIntentRevision: 1, requestId: 'canceled-purchase-cleanup', purpose: cleanupPurpose };
        await expect(admitManagedPolicy({ custodianAccountId: account.id, input: { ...cleanupAdmission, managedId: policyRow.id, expectedIntentRevision: 2 } })).rejects.toMatchObject({ code: 'resource_mismatch' });
        await expect(admitManagedPolicy({ custodianAccountId: account.id, input: { ...cleanupAdmission, managedId: pending.machine.id } })).rejects.toMatchObject({ code: 'resource_mismatch' });
        expect(await admitManagedPolicy({ custodianAccountId: account.id, input: cleanupAdmission })).toMatchObject({
            replayed: false, machine: { id: canceledPurchase.machine.id, creationState: 'canceled', desired: 'delete', intentRevision: 2, resource: canceledResource },
        });
        const cleanupCorrelation = { ...canceledCorrelation, expectedIntentRevision: 2, requestId: cleanupAdmission.requestId };
        expect(await submitManagedIntent(cleanupCorrelation)).toMatchObject({ submitted: true, machine: { submittedNativeEffect: { intent: 'delete' } } });
        expect(await submitManagedIntent(cleanupCorrelation)).toMatchObject({ submitted: false });
        expect(await reportManagedIntent({ ...cleanupCorrelation, result: { kind: 'confirmed' }, observation: { observedAt: 300, availability: 'absent' } })).toMatchObject({
            machine: { creationState: 'canceled', allocation: 'confirmed-absent', desired: 'delete' },
        });
        expect(await db.managedMachine.findUniqueOrThrow({ where: { id: canceledPurchase.machine.id } })).toMatchObject({
            admittedActionRequestId: canceledRequest.input.requestId, cleanup: null,
        });
        expect(await admitManagedAcquire(canceledRequest)).toMatchObject({ replayed: true, machine: { id: canceledPurchase.machine.id } });
    });

    it('preserves manual responsibility while a submitted canceled-creation cleanup remains unknown', async () => {
        const homeId = `srv_${'a'.repeat(32)}`;
        const account = await db.account.create({ data: { publicKey: 'manual-submitted-cancel-cleanup' } });
        const controller = { machineId: 'manual-cleanup-controller', installationId: 'manual-cleanup-installation' };
        await db.machine.create({ data: { id: controller.machineId, accountId: account.id, metadata: 'ciphertext', installationId: controller.installationId } });
        const provider = { pluginId: 'fixture.compute', localId: 'compute' };
        const resource = { contributionRef: provider, schemaVersion: 1, value: { id: 'paid-native' } };
        const row = await db.managedMachine.create({ data: { homeId, custodianAccountId: account.id,
            controllerMachineId: controller.machineId, controllerInstallationId: controller.installationId,
            admittedActionRequestId: 'manual-cleanup-purchase', admittedInput: {},
            launch: { provider, schemaVersion: 1, name: 'Retained cleanup', choices: {} }, resource,
            allocation: 'bound', creationState: 'canceled', desired: 'delete', desiredWhen: 'now', intentRevision: 1,
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            cleanup: { disposition: 'pending', reason: 'creation_canceled' } } });
        const correlation = { homeId, managedId: row.id, expectedIntentRevision: 1, requestId: row.admittedActionRequestId, controller };
        expect(await submitManagedIntent(correlation)).toMatchObject({ submitted: true });
        await admitManagedControl({ actorAccountId: account.id, custodianAccountId: account.id, input: {
            action: 'machines.managed.retire', requestId: 'retire-submitted-cancel-cleanup', input: {
                homeId, managedId: row.id, expectedIntentRevision: 1, manualResponsibility: true,
            },
        } });
        expect(await reportManagedIntent({ ...correlation, result: { kind: 'unknown' },
            observation: { observedAt: 200, availability: 'present', power: 'stopped' } })).toMatchObject({
            machine: { allocation: 'bound', archivedAt: expect.any(Number), resource,
                cleanup: { disposition: 'unavailable', reason: 'manual_responsibility' },
                submittedNativeEffect: { requestId: row.admittedActionRequestId, intent: 'delete' } },
        });
        expect(await reportManagedIntent({ ...correlation, result: { kind: 'confirmed' }, observation: { observedAt: 300, availability: 'absent' } })).toMatchObject({
            machine: { allocation: 'confirmed-absent', archivedAt: expect.any(Number) },
        });
        expect(await db.managedMachine.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ cleanup: null, admittedActionRequestId: row.admittedActionRequestId });
    });

    it('refuses guest activity for a retained resource after manual retirement', async () => {
        const homeId = `srv_${'a'.repeat(32)}`;
        const account = await db.account.create({ data: { publicKey: 'managed-retired-guest-currentness' } });
        const controller = { machineId: 'managed-retired-controller', installationId: 'retired-controller-installation' };
        const guest = { machineId: 'managed-retired-guest', installationId: 'retired-guest-installation' };
        const keys = tweetnacl.sign.keyPair();
        await db.machine.create({ data: { id: controller.machineId, accountId: account.id, metadata: 'ciphertext', installationId: controller.installationId } });
        await db.machine.create({ data: { id: guest.machineId, accountId: account.id, metadata: 'ciphertext', installationId: guest.installationId, installationPublicKey: Buffer.from(keys.publicKey) } });
        const row = await db.managedMachine.create({ data: { homeId, custodianAccountId: account.id,
            controllerMachineId: controller.machineId, controllerInstallationId: controller.installationId,
            enrolledMachineId: guest.machineId, admittedActionRequestId: 'retired-guest-purchase', admittedInput: {},
            launch: { provider: { pluginId: 'fixture.compute', localId: 'compute' }, schemaVersion: 1, name: 'Retained', choices: {} },
            allocation: 'bound', resource: { contributionRef: { pluginId: 'fixture.compute', localId: 'compute' }, schemaVersion: 1, value: { id: 'retained-native' } },
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } });
        const current = (expectedRevision: number, rpcMethod: 'managed.activity.read' | 'managed.admission.drain.confirm') =>
            inTx(tx => resolveManagedGuestActivityAdmissionInTx(tx, { actorAccountId: account.id,
                machineId: guest.machineId, rpcMethod, target: { homeId, managedId: row.id, expectedRevision, controller,
                    ...(rpcMethod === 'managed.admission.drain.confirm' ? { action: 'begin' as const } : {}) } }));
        expect(await current(0, 'managed.admission.drain.confirm')).not.toBeNull();
        await admitManagedControl({ actorAccountId: account.id, custodianAccountId: account.id, input: {
            action: 'machines.managed.retire', requestId: 'retired-guest-manual-responsibility',
            input: { homeId, managedId: row.id, expectedIntentRevision: 0, manualResponsibility: true },
        } });
        expect(await db.managedMachine.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ enrolledMachineId: guest.machineId, resource: row.resource });
        for (const method of ['managed.activity.read', 'managed.admission.drain.confirm'] as const) {
            expect(await current(1, method)).toBeNull();
        }
    });

    it('keeps Account currentness controller-free while preserving its admitted policy signer', async () => {
        const homeId = `srv_${'a'.repeat(32)}`;
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const createController = async () => {
            const installationId = crypto.randomUUID();
            const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: account.id,
                metadata: '{}', installationId } });
            return { machineId: machine.id, installationId };
        };
        const [signer, unrelated] = await Promise.all([createController(), createController()]);
        const row = await db.managedMachine.create({ data: { homeId, custodianAccountId: account.id,
            admittedActionRequestId: 'account-create', admittedInput: {},
            launch: { provider: { pluginId: 'fixture.account', localId: 'cloud' }, schemaVersion: 1, name: 'Cloud', choices: {} },
            allocation: 'bound', retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } });
        const creation = { homeId, managedId: row.id, expectedIntentRevision: 0, requestId: row.admittedActionRequestId };
        expect(await inTx(tx => requireCurrentManagedMachineInTx(tx, creation))).toMatchObject({ id: row.id });
        await expect(inTx(tx => requireCurrentManagedMachineInTx(tx, { ...creation, controller: signer })))
            .rejects.toMatchObject({ code: 'controller_retired' });
        const policy = { ...creation, requestId: 'account-policy', controller: signer, purpose: { kind: 'retention' } };
        await db.managedMachine.update({ where: { id: row.id }, data: {
            admittedInput: { currentAdmission: { kind: 'policy', request: policy } },
        } });
        expect(await inTx(tx => requireCurrentManagedMachineInTx(tx, policy))).toMatchObject({ id: row.id });
        await expect(inTx(tx => requireCurrentManagedMachineInTx(tx, { ...policy, controller: unrelated })))
            .rejects.toMatchObject({ code: 'controller_retired' });
        await expect(inTx(tx => requireCurrentManagedMachineInTx(tx, { ...creation, controller: signer }, { requestAuthority: 'creation' })))
            .rejects.toMatchObject({ code: 'controller_retired' });
        expect(await inTx(tx => requireCurrentManagedMachineInTx(tx, creation, { requestAuthority: 'creation' })))
            .toMatchObject({ id: row.id });
    });

    it('retains original purchase dedupe while one current control owns the row intent', async () => {
        const homeId = `srv_${'a'.repeat(32)}`;
        const account = await db.account.create({ data: { publicKey: 'managed-original-purchase-correlation' } });
        const controller = { machineId: 'managed-original-purchase-controller', installationId: 'original-purchase-installation' };
        await db.machine.create({ data: { id: controller.machineId, accountId: account.id, metadata: 'ciphertext', installationId: controller.installationId } });
        const launch = { provider: { pluginId: 'fixture.compute', localId: 'compute' }, schemaVersion: 1, name: 'Original', choices: {} };
        const input = { enrollmentIdentity: { kind: 'existingUser' as const, role: 'adopted' as const },
            selection: { kind: 'one-off' as const, homeId, controller, launch, retention: { kind: 'until-delete' as const }, wakeOnAcceptedMessage: false } };
        const requestId = 'immutable-purchase';
        const row = await db.managedMachine.create({ data: { homeId, custodianAccountId: account.id,
            controllerMachineId: controller.machineId, controllerInstallationId: controller.installationId,
            // The retained-row read projection drops this member; raw CAS must not.
            admittedActionRequestId: requestId, admittedInput: { computeInput: input, continuation: null,
                futureStoredMember: { nested: [null, { opaque: true }] } }, launch,
            allocation: 'may-exist', retention: input.selection.retention, wakeOnAcceptedMessage: false } });
        expect(row.admittedInput).toEqual({ computeInput: input, continuation: null,
            futureStoredMember: { nested: [null, { opaque: true }] } });
        await admitManagedControl({ actorAccountId: account.id, custodianAccountId: account.id, input: {
            action: 'machines.managed.retire', requestId: 'current-control', input: { homeId, managedId: row.id, expectedIntentRevision: 0, manualResponsibility: true } } });
        expect(await admitManagedAcquire({ custodianAccountId: account.id, requesterAccountId: account.id,
            requestEnvelopeDigest: 'original', input: { input, requestId, continuationPresent: false } })).toMatchObject({ replayed: true, machine: { id: row.id } });
        expect(await db.managedMachine.count({ where: { custodianAccountId: account.id } })).toBe(1);
        expect(await inTx(tx => requireCurrentManagedMachineInTx(tx, { homeId, managedId: row.id,
            expectedIntentRevision: 1, requestId: 'current-control', controller }, { allowInactiveCurrentIntent: true }))).toMatchObject({ id: row.id });
        expect(await inTx(tx => requireCurrentManagedMachineInTx(tx, { homeId, managedId: row.id,
            expectedIntentRevision: 0, requestId, controller }, { allowCanceledResourceReport: true }))).toMatchObject({ id: row.id });
        await expect(inTx(tx => requireCurrentManagedMachineInTx(tx, { homeId, managedId: row.id,
            expectedIntentRevision: 1, requestId, controller }, { requestAuthority: 'creation' }))).rejects.toMatchObject({ code: 'enrollment_retired' });
        await expect(createManagedBootstrapCredential({ homeId, managedId: row.id, expectedIntentRevision: 1, requestId, controller,
            credential: { resourceId: 'archived-bootstrap-refusal', displayName: 'Bootstrap', kind: 'other', encryptionMode: 'plain',
                storedContent: { t: 'plain', v: { v: 1, name: 'Bootstrap', kind: 'other', value: 'private-key' } } },
        })).rejects.toMatchObject({ code: 'enrollment_retired' });
        expect(await db.savedSecretResource.count({ where: { id: 'archived-bootstrap-refusal' } })).toBe(0);
    });

    it("does not accept a stale active intent as a late allocation report", async () => {
        const homeId = `srv_${"a".repeat(32)}`;
        await db.simpleCache.upsert({ where: { key: "server.identity.v1" }, create: { key: "server.identity.v1", value: homeId }, update: { value: homeId } });
        const account = await db.account.create({ data: { publicKey: "managed-currentness" } });
        const controller = await db.machine.create({ data: { id: "managed-controller", accountId: account.id, metadata: "ciphertext", installationId: "installation-1" } });
        const row = await db.managedMachine.create({ data: {
            homeId, custodianAccountId: account.id, controllerMachineId: controller.id,
            controllerInstallationId: "installation-1", admittedActionRequestId: "request-1", admittedInput: {},
            launch: {}, retention: { kind: "until-delete" }, wakeOnAcceptedMessage: false,
            allocation: "may-exist", intentRevision: 2,
        } });
        const correlation = { homeId, managedId: row.id, controller: { machineId: controller.id, installationId: "installation-1" }, requestId: "request-1", expectedIntentRevision: 0 };
        await expect(inTx((tx) => requireCurrentManagedMachineInTx(tx, correlation, { allowCanceledResourceReport: true }))).rejects.toMatchObject({ code: "intent_changed" });
        await db.managedMachine.update({ where: { id: row.id }, data: { creationState: "canceled" } });
        const late = await inTx((tx) => requireCurrentManagedMachineInTx(tx, correlation, { allowCanceledResourceReport: true }));
        expect(late.creationState).toBe("canceled");
        expect(await inTx((tx) => requireCurrentManagedMachineInTx(tx, { ...correlation, expectedIntentRevision: 2 }, { allowInactiveCurrentIntent: true }))).toMatchObject({ creationState: "canceled", intentRevision: 2 });
        await expect(inTx((tx) => requireCurrentManagedMachineInTx(tx, correlation, { allowInactiveCurrentIntent: true }))).rejects.toMatchObject({ code: "intent_changed" });
        // Ordinary creation admission is retired regardless of whether its
        // caller holds the old or current revision; pure intent currentness
        // above still distinguishes a stale revision as intent_changed.
        await expect(inTx((tx) => requireCurrentManagedMachineInTx(tx, correlation))).rejects.toMatchObject({ code: "enrollment_retired" });
        await expect(inTx((tx) => requireCurrentManagedMachineInTx(tx, { ...correlation, expectedIntentRevision: 2 }))).rejects.toMatchObject({ code: "enrollment_retired" });
        await expect(inTx((tx) => requireManagedEnrollmentInTx(tx, { ...correlation, expectedIntentRevision: 2, resource: { contributionRef: { pluginId: "fixture.compute", localId: "compute" }, schemaVersion: 1, value: { id: "native" } } }, account.id))).rejects.toMatchObject({ code: "enrollment_retired" });
    });

    it('claims acquisition using admission-owned account selection without a configuration fence', async () => {
        const homeId = `srv_${"a".repeat(32)}`;
        const account = await db.account.create({ data: { publicKey: 'managed-connection-snapshot' } });
        const controller = { machineId: 'managed-connection-controller', installationId: 'connection-installation' };
        await db.machine.create({ data: { id: controller.machineId, accountId: account.id, metadata: 'ciphertext', installationId: controller.installationId } });
        const credentials = ['cloud', 'cua'].map(purpose => ({
            purpose: { consumer: { pluginId: 'fixture.compute', localId: 'compute' }, purpose },
            account: { service: { pluginId: 'fixture.accounts', localId: purpose }, accountId: `selected-${purpose}` },
        }));
        const launch = { provider: { pluginId: 'fixture.compute', localId: 'compute' }, schemaVersion: 1, name: 'reviewed', choices: {}, credentials };
        const row = await db.managedMachine.create({ data: { homeId, custodianAccountId: account.id,
            controllerMachineId: controller.machineId, controllerInstallationId: controller.installationId,
            admittedActionRequestId: 'connection-request', admittedInput: {}, launch, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } });
        const correlation = { homeId, managedId: row.id, controller, expectedIntentRevision: 0, requestId: 'connection-request' };
        const submitted = await submitManagedAcquire(correlation);
        expect(submitted).toMatchObject({ submitted: true, machine: { allocation: 'may-exist',
            launch: { credentials } } });
        expect((await db.managedMachine.findUniqueOrThrow({ where: { id: row.id } })).launch).toEqual(launch);
        // The old optional carrier cannot replace the admission's account choice.
        const replay = await submitManagedAcquire({ ...correlation, credentials: credentials.map(credential => ({
            ...credential, account: { ...credential.account, accountId: 'different-account' }, configurationRevision: 'rotated',
        })) });
        expect(replay).toMatchObject({ submitted: false, machine: { launch: { credentials } } });
    });

    it('replays migrated setup facts and refuses a changed setup request envelope', async () => {
        const homeId = `srv_${'a'.repeat(32)}`;
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const controller = { machineId: 'migrated-setup-controller', installationId: 'migrated-setup-installation' };
        await db.machine.create({ data: { id: controller.machineId, accountId: account.id,
            metadata: '{}', installationId: controller.installationId } });
        const launch = { provider: { pluginId: 'fixture.setup', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} };
        const setup = { scripts: [{ body: 'echo retained' }] };
        const preset = await db.managedMachinePreset.create({ data: { homeId, custodianAccountId: account.id,
            name: 'Retained setup', launch, setup, controllerMachineId: controller.machineId,
            controllerInstallationId: controller.installationId } });
        const facts = ManagedConfigurationFactsV1Schema.parse({ launch, controller, optionStatus: 'current',
            prerequisites: [], billing: { location: 'local', stoppedBilling: 'not-billed' },
            retentionCapabilities: { supportedIntents: ['start', 'stop', 'delete'] },
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false, setup,
            preset: { id: preset.id, revision: 0 } });
        const input = ManagedAcquireInputV1Schema.parse({ selection: { kind: 'preset', homeId, id: preset.id, revision: 0 },
            enrollmentIdentity: { kind: 'existingUser', role: 'adopted' }, controller,
            retention: facts.retention, wakeOnAcceptedMessage: false, reviewedFacts: facts });
        const { setup: oldDefinition, ...oldFacts } = facts;
        const reviewedFacts = { ...oldFacts, environment: oldDefinition };
        const row = await db.managedMachine.create({ data: { homeId, custodianAccountId: account.id,
            controllerMachineId: controller.machineId, controllerInstallationId: controller.installationId,
            admittedActionRequestId: 'migrated-setup-request', presetId: preset.id, presetRevision: 0, launch,
            retention: facts.retention, wakeOnAcceptedMessage: false, reviewedFacts,
            admittedInput: { computeInput: { ...input, reviewedFacts }, continuation: null,
                environmentSetup: { requestEnvelopeDigest: 'retained-envelope' } },
            machineSetup: { setup, state: 'pending' } } });
        // The provider suite deploys all of D1 to the real old-column database.
        // This already-migrated route harness reuses its exact JSON statements
        // to carry the stored row through the real admission/replay boundary.
        const migration = await readFile(new URL('../../../../prisma/sqlite/migrations/20261026172000_rename_machine_setup_columns/migration.sql', import.meta.url), 'utf8');
        const sqlite = new DatabaseSync(harness.dbPath);
        try { sqlite.exec(migration.slice(migration.indexOf('UPDATE "ManagedMachine"'))); }
        finally { sqlite.close(); }
        const request = { custodianAccountId: account.id, requesterAccountId: account.id,
            requestEnvelopeDigest: 'retained-envelope', input: { requestId: 'migrated-setup-request', continuationPresent: false, input } };
        expect(await admitManagedAcquire(request)).toMatchObject({ replayed: true,
            machine: { id: row.id, reviewedFacts: facts, machineSetup: { setup, state: 'pending' } } });
        await expect(admitManagedAcquire({ ...request, requestEnvelopeDigest: 'changed-envelope' }))
            .rejects.toMatchObject({ code: 'request_conflict' });
        expect(await db.managedMachine.count({ where: { admittedActionRequestId: 'migrated-setup-request' } })).toBe(1);
    });

    it("replays a content-free retained input identity and conflicts on changed compute input", async () => {
        const homeId = `srv_${"a".repeat(32)}`;
        const account = await db.account.create({ data: { publicKey: "managed-replay" } });
        const controller = await db.machine.create({ data: { id: "managed-replay-controller", accountId: account.id, metadata: "ciphertext", installationId: "replay-installation" } });
        const input = ManagedAcquireInputV1Schema.parse({ enrollmentIdentity: { kind: 'existingUser', role: 'adopted' }, selection: { kind: "one-off", homeId, controller: { machineId: controller.id, installationId: "replay-installation" }, launch: { provider: { pluginId: "fixture.compute", localId: "compute" }, schemaVersion: 1, name: "reviewed", choices: { image: "linux" } }, retention: { kind: "until-delete" }, wakeOnAcceptedMessage: false } });
        if (input.selection.kind !== "one-off") throw new Error("Expected explicit launch fixture");
        const identity = { computeInput: input, continuation: null };
        const row = await db.managedMachine.create({ data: { homeId, custodianAccountId: account.id, controllerMachineId: controller.id, controllerInstallationId: "replay-installation", admittedActionRequestId: "replay-request", admittedInput: identity, launch: input.selection.launch, retention: input.selection.retention, wakeOnAcceptedMessage: false } });
        const replay = await admitManagedAcquire({ custodianAccountId: account.id, requesterAccountId: account.id, requestEnvelopeDigest: "verified-digest", input: { requestId: "replay-request", continuationPresent: false, input } });
        expect(replay).toMatchObject({ machine: { id: row.id, allocation: "unsubmitted" }, replayed: true });
        await expect(admitManagedAcquire({ custodianAccountId: account.id, requesterAccountId: account.id, requestEnvelopeDigest: "verified-digest", input: { requestId: "replay-request", continuationPresent: false, input: { ...input, selection: { ...input.selection, wakeOnAcceptedMessage: true } } } })).rejects.toMatchObject({ code: "request_conflict" });
        expect((await db.managedMachine.findUniqueOrThrow({ where: { id: row.id } })).admittedInput).toEqual(identity);
        expect(await db.managedMachine.count({ where: { admittedActionRequestId: "replay-request" } })).toBe(1);
        const currentness = { homeId, managedId: row.id, requestId: "replay-request", expectedIntentRevision: 0, controller: input.selection.controller };
        expect(await submitManagedAcquire(currentness)).toMatchObject({ submitted: true, machine: { id: row.id, allocation: "may-exist" } });
        expect(await submitManagedAcquire(currentness)).toMatchObject({ submitted: false, machine: { id: row.id, allocation: "may-exist" } });
        await expect(submitManagedAcquire({ ...currentness, requestId: "other-request" })).rejects.toMatchObject({ code: "request_conflict" });
        await expect(createManagedBootstrapCredential({ ...currentness, credential: { resourceId: "bootstrap-mode-refusal", displayName: "Bootstrap", kind: "other", encryptionMode: "plain", storedContent: { t: "plain", v: { v: 1, name: "Bootstrap", kind: "other", value: "private-key" } } } })).rejects.toMatchObject({ code: "credential_unavailable" });
        expect(await db.savedSecretResource.count({ where: { id: "bootstrap-mode-refusal" } })).toBe(0);
        await db.machine.update({ where: { id: controller.id }, data: { installationId: "replacement-installation" } });
        await expect(submitManagedAcquire(currentness)).rejects.toMatchObject({ code: "controller_retired" });
    });

    it("atomically creates a bootstrap secret for an unset reference and reuses the winning reference", async () => {
        const homeId = `srv_${"a".repeat(32)}`;
        const account = await db.account.create({ data: { publicKey: "managed-bootstrap-claim", encryptionMode: "plain" } });
        const controller = { machineId: "managed-bootstrap-controller", installationId: "bootstrap-installation" };
        await db.machine.create({ data: { id: controller.machineId, accountId: account.id, metadata: "ciphertext", installationId: controller.installationId } });
        const row = await db.managedMachine.create({ data: {
            homeId, custodianAccountId: account.id, controllerMachineId: controller.machineId, controllerInstallationId: controller.installationId,
            admittedActionRequestId: "bootstrap-request", admittedInput: {},
            launch: { provider: { pluginId: "fixture.compute", localId: "compute" }, schemaVersion: 1, name: "reviewed", choices: {} },
            retention: { kind: "until-delete" }, wakeOnAcceptedMessage: false,
        } });
        expect(row.bootstrapCredentialRef).toBeNull();
        const correlation = { homeId, managedId: row.id, expectedIntentRevision: 0, requestId: "bootstrap-request", controller };
        const credential = {
            resourceId: "bootstrap-claim-winner", displayName: "Bootstrap", kind: "other" as const, encryptionMode: "plain" as const,
            storedContent: { t: "plain" as const, v: { v: 1 as const, name: "Bootstrap", kind: "other" as const, value: "private-bootstrap-key" } },
        };
        expect(await createManagedBootstrapCredential({ ...correlation, credential })).toMatchObject({ machine: {
            id: row.id, intentRevision: 0, bootstrapCredentialRef: { kind: "shared_resource", resourceId: credential.resourceId },
        } });
        expect(await createManagedBootstrapCredential({ ...correlation, credential: { ...credential, resourceId: "bootstrap-claim-retry" } })).toMatchObject({ machine: {
            bootstrapCredentialRef: { kind: "shared_resource", resourceId: credential.resourceId },
        } });
        expect(await db.savedSecretResource.count({ where: { ownerAccountId: account.id } })).toBe(1);
        expect(await db.savedSecretResource.count({ where: { id: "bootstrap-claim-retry" } })).toBe(0);
        expect((await db.managedMachine.findUniqueOrThrow({ where: { id: row.id } })).bootstrapCredentialRef).toEqual({ kind: "shared_resource", resourceId: credential.resourceId });
    });

    it("correlates a private continuation without retaining its text or startup instructions", async () => {
        const homeId = `srv_${"a".repeat(32)}`;
        const account = await db.account.create({ data: { publicKey: "managed-private-continuation" } });
        const controller = await db.machine.create({ data: { id: "managed-private-controller", accountId: account.id, metadata: "ciphertext", installationId: "private-installation" } });
        const input = ManagedAcquireInputV1Schema.parse({ enrollmentIdentity: { kind: 'existingUser', role: 'adopted' }, selection: { kind: "one-off", homeId, controller: { machineId: controller.id, installationId: "private-installation" }, launch: { provider: { pluginId: "fixture.compute", localId: "compute" }, schemaVersion: 1, name: "reviewed", choices: { image: "linux" } }, retention: { kind: "until-delete" }, wakeOnAcceptedMessage: false }, agentStart: { directory: { kind: "path", path: "/work" }, agentTarget: { kind: "agent", identity: { pluginId: "fixture.agent", localId: "agent" } }, initialInput: { text: "private-managed-initial-message" }, agentSessionStartupInstructionsV1: { v: 1, id: "managed.startup", revision: 1, instructions: "private-managed-startup-instructions" } } });
        if (input.selection.kind !== "one-off" || !input.agentStart) throw new Error("Expected explicit launch and continuation fixture");
        const { agentStart: _privateContinuation, ...computeInput } = input;
        const identity = { computeInput, continuation: { requestEnvelopeDigest: "verified-original-envelope" } };
        const row = await db.managedMachine.create({ data: { homeId, custodianAccountId: account.id, controllerMachineId: controller.id, controllerInstallationId: "private-installation", admittedActionRequestId: "private-request", admittedInput: identity, launch: input.selection.launch, retention: input.selection.retention, wakeOnAcceptedMessage: false } });
        const replay = await admitManagedAcquire({ custodianAccountId: account.id, requesterAccountId: account.id, requestEnvelopeDigest: "verified-original-envelope", input: { requestId: "private-request", continuationPresent: true, input: computeInput } });
        expect(replay).toMatchObject({ machine: { id: row.id }, replayed: true });
        const retained = (await db.managedMachine.findUniqueOrThrow({ where: { id: row.id } })).admittedInput;
        expect(retained).toEqual(identity);
        expect(JSON.stringify(retained)).not.toContain("private-managed-initial-message");
        expect(JSON.stringify(retained)).not.toContain("private-managed-startup-instructions");
        await expect(admitManagedAcquire({ custodianAccountId: account.id, requesterAccountId: account.id, requestEnvelopeDigest: "verified-changed-envelope", input: { requestId: "private-request", continuationPresent: true, input: computeInput } })).rejects.toMatchObject({ code: "request_conflict" });
        expect(await db.managedMachine.count({ where: { admittedActionRequestId: "private-request" } })).toBe(1);
    });

    it("reads shared recovery through current Machine grants and restricts cancellation to Manage", async () => {
        const homeId = `srv_${"a".repeat(32)}`;
        const owner = await db.account.create({ data: { publicKey: "managed-reader-owner" } });
        const viewer = await db.account.create({ data: { publicKey: "managed-reader-viewer" } });
        const manager = await db.account.create({ data: { publicKey: "managed-reader-manager" } });
        const controller = await db.machine.create({ data: { id: "managed-reader-controller", accountId: owner.id, metadata: "ciphertext", installationId: "reader-installation" } });
        await db.machineAccountGrant.createMany({ data: [{ machineId: controller.id, accountId: viewer.id, accessLevel: "view", createdByAccountId: owner.id }, { machineId: controller.id, accountId: manager.id, accessLevel: "admin", createdByAccountId: owner.id }] });
        const row = await db.managedMachine.create({ data: { homeId, custodianAccountId: owner.id, controllerMachineId: controller.id, controllerInstallationId: "reader-installation", admittedActionRequestId: "reader-request", admittedInput: { futureStoredMember: true }, launch: { provider: { pluginId: "fixture.compute", localId: "compute" }, schemaVersion: 1, name: "reviewed", choices: {}, futureStoredMember: true }, retention: { kind: "until-delete", futureStoredMember: true }, wakeOnAcceptedMessage: false } });
        expect(await getManagedMachine({ actorAccountId: viewer.id, input: { homeId, managedId: row.id } })).toMatchObject({ id: row.id });
        const cancel = { homeId, managedId: row.id, expectedIntentRevision: 0 };
        await expect(cancelManagedCreation({ actorAccountId: viewer.id, input: cancel })).rejects.toMatchObject({ code: "permission_denied" });
        const app = fastify().withTypeProvider<ZodTypeProvider>();
        // Runtime composition keeps each host's source aliases and compiler root
        // with its owner, as in the shared cross-program testkit loaders.
        const { createAccountServerActionDeps } = await vi.importActual<{
            createAccountServerActionDeps(input: Readonly<{ token: string; serverId: string;
                serverIdentityId: string; serverHttpBaseUrl: string }>): Pick<ActionExecutorDeps, 'managedMachineAction'>;
        }>('../../../../../cli/src/api/accountServerActionDeps');
        const { installAxiosFastifyAdapter } = await vi.importActual<{
            installAxiosFastifyAdapter(input: Readonly<{ app: typeof app; origin: string }>): () => void;
        }>('../../../../../cli/src/testkit/http/axiosAdapter');
        app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
        // Only credential authentication and HTTP delivery are substituted.
        // The CLI port, protocol executor, route, stored reader and mutation stay real.
        app.decorate('authenticate', async (request: FastifyRequest) => {
            Object.assign(request, createAuthenticatedRouteRequest({ userId: manager.id, authTokenLegacy: false }),
                { headers: request.headers, params: request.params, query: request.query });
        });
        registerManagedMachineRoutes(app);
        const restoreHttp = installAxiosFastifyAdapter({ app, origin: 'http://managed-reader.test' });
        try {
            const executor = createActionExecutor(createAccountServerActionDeps({ token: 'interactive',
                serverId: 'managed-reader', serverIdentityId: homeId, serverHttpBaseUrl: 'http://managed-reader.test' }) as Parameters<typeof createActionExecutor>[0]);
            const context = { surface: 'cli', authority: 'present_user', bypassApprovals: true } as const;
            const listed = await executor.execute('machines.managed.list', { homeId }, context);
            expect(listed).toMatchObject({ ok: true, result: { machines: [{ id: row.id,
                allocation: 'unsubmitted', creationState: 'active', desired: 'start', intentRevision: 0 }] } });
            expect(JSON.stringify(listed)).not.toContain('futureStoredMember');
            expect(await executor.execute('machines.managed.cancel', cancel, context)).toMatchObject({ ok: true,
                result: { machine: { id: row.id, creationState: 'canceled', allocation: 'confirmed-absent', intentRevision: 1 } } });
        } finally { restoreHttp(); await app.close(); }
        expect((await db.managedMachine.findUniqueOrThrow({ where: { id: row.id } })).admittedActionRequestId).toBe("reader-request");
        await expect(cancelManagedCreation({ actorAccountId: manager.id, input: cancel })).rejects.toMatchObject({ code: "intent_changed" });
        expect((await db.account.findUniqueOrThrow({ where: { id: viewer.id } })).seq).toBeGreaterThan(0);
        await db.machineAccountGrant.delete({ where: { machineId_accountId: { machineId: controller.id, accountId: viewer.id } } });
        await expect(getManagedMachine({ actorAccountId: viewer.id, input: { homeId, managedId: row.id } })).rejects.toMatchObject({ code: "permission_denied" });
    });
});
