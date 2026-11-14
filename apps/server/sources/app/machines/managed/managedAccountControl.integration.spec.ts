import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Socket } from 'socket.io';
import type { IncomingHttpHeaders } from 'node:http';
import fastify, { type FastifyRequest, type InjectOptions } from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { MachineProvisionerContributionV1Schema, defineMachineProvisionerSchemas, MachineProvisionerCheckResultProtocolV1Schema,
    MachineProvisionerBootstrapCarrierV1Schema, MachineProvisionerObservationV1Schema, MachineProvisionerPowerResultV1Schema } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { defineProtocolObject, defineProtocolString } from '@happier-dev/protocol/plugins/actions/protocol-composable-schema';
import { narrowCredentialAuthority } from '@/app/auth/effectiveCredentialAuthority';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { registerManagedMachineRoutes } from './managedRoutes';
import { createMachinePreset, getMachinePreset } from './machinePresetService';
import { createManagedMachinePresetAcquireOverrideV1, sealManagedMachinePresetContentV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetContentV1';
import tweetnacl from 'tweetnacl';
import { decodeBase64 } from 'privacy-kit';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER, createManagedPolicyProofV1, encodeManagedPolicyProofV1,
    MANAGED_POLICY_PROOF_HEADER } from '@happier-dev/protocol';
import { inTx } from '@/storage/inTx';
import { setEligibleMachineAccessGrantInTx } from '@/testkit/machineAccessGrant.testkit';
import { resolveEffectiveMachineRoleInTx } from '@/app/machines/machineAccess';
import { getManagedMachine } from './managedRead';
import { readManagedPendingActivationHoldReasonInTx } from './managedWake';
import { validateManagedCreationBirthInTx } from './managedCreationBirth';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { readExternalActionManagedAcquireResourceInTx, resolveManagedActionMachineAdmissionInTx } from '@/app/auth/externalActionManagedAdmission';
import { resolveMachineSetup } from './machineSetup';
import { admitManagedInstallationPurpose } from './managedInstallation';
import { resolveManagedGuestActivityAdmissionInTx } from './managedGuestActivity';
import { readMachineDevcontainerWorkspaceSyncEndpointInTx } from './managedRows';
import { admitManagedControl } from './managedMutations';
import { MANAGED_ACTIVITY_READ_RPC_METHOD, MANAGED_ADMISSION_DRAIN_CONFIRM_RPC_METHOD } from '@happier-dev/protocol/machines/managed/managedIntentV1';
import { managedMachineActionEndpointPathV1, type ManagedControllerIntentReportV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { isOriginalTerminalExecutionAction, resolveExternalActionExecutionMachineAdmissionInTx } from '@/app/auth/externalActionExecutionAuthorization';
import { getActivePrismaRuntime } from '@/storage/prisma';
import { PluginManifestV2Schema } from '@happier-dev/protocol/plugins/manifest';
import { createReleaseLessDeclarationV1 } from '@/app/plugins/availability/currentDeclaration';
import { registerSocketRpcHandlers } from '@/app/api/socket/rpc/registerSocketRpcHandlers';
import { createFakeSocket, createSocketRoomDiscoveryHarness, triggerSocketHandler } from '@/app/api/testkit/socketHarness';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { evaluateAccountStoredContentSocketCompatibility } from '@/app/clientCompatibility/accountStoredContentCompatibility';

describe('Account-owned managed control without a controller', () => {
    const homeId = `srv_${'a'.repeat(32)}`;
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-managed-account-', initAuth: false,
            initEncrypt: true, env: { HAPPIER_SERVER_IDENTITY_ID: homeId } });
    }, 120_000);
    afterAll(async () => { if (harness) await harness.close(); });

    async function createRetainedGuestFixture(withController: boolean) {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const other = await db.account.create({ data: { encryptionMode: 'plain' } });
        const createMachine = () => db.machine.create({ data: { id: randomUUID(), accountId: owner.id,
            installationId: randomUUID(), installationPublicKey: new Uint8Array(tweetnacl.sign.keyPair().publicKey),
            metadata: encodePlainMachineStoredContent({ host: 'guest', platform: 'linux', happyCliVersion: 'test',
                homeDir: '/home/guest', happyHomeDir: '/home/guest/.happier' }),
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64') } });
        const controllerMachine = withController ? await createMachine() : undefined;
        const controller = controllerMachine ? { machineId: controllerMachine.id, installationId: controllerMachine.installationId! } : undefined;
        const guest = await createMachine();
        const resource = { contributionRef: { pluginId: 'fixture.portable', localId: 'cloud' }, schemaVersion: 1,
            value: { id: randomUUID() } };
        const row = await db.managedMachine.create({ data: { homeId, custodianAccountId: owner.id,
            controllerMachineId: controller?.machineId, controllerInstallationId: controller?.installationId,
            admittedActionRequestId: randomUUID(), admittedInput: { enrollmentAccountId: owner.id }, allocation: 'bound',
            creationState: 'active', desired: 'start', desiredWhen: 'now',
            launch: { provider: resource.contributionRef, schemaVersion: 1, name: 'Cloud', choices: {} }, resource,
            retention: { kind: 'unused', afterMs: 1_000, effect: 'stop' }, wakeOnAcceptedMessage: true } });
        await inTx(tx => setEligibleMachineAccessGrantInTx(tx, { actorAccountId: owner.id, machineId: guest.id,
            principal: { kind: 'account', accountId: other.id }, level: 'admin' }));
        return { owner, other, guest, controller, row, resource };
    }

    it.each([false, true])('routes a bound workspace only through its retained native controller (controller present=%s)', async withController => {
        const test = await createRetainedGuestFixture(withController);
        const provider = { pluginId: 'happier.devcontainer', localId: 'devcontainer' };
        await db.managedMachine.update({ where: { id: test.row.id }, data: { enrolledMachineId: test.guest.id,
            launch: { provider, schemaVersion: 1, name: 'Guest', choices: {} },
            resource: { contributionRef: provider, schemaVersion: 1, value: {},
                devcontainerObservation: { nativeResourceId: 'native', user: 'coder', workspaceFolder: '/work',
                    storage: { kind: 'bind', hostPath: '/host/work', childPath: '/work' } } } } });
        expect(await inTx(tx => readMachineDevcontainerWorkspaceSyncEndpointInTx(tx, {
            accountServerId: homeId, machineId: test.guest.id, rootPath: '/work',
            operation: { actorAccountId: test.owner.id, callerAuthority: 'present_user', rpcMethod: 'daemon.workspaceSync.handoffSourcePhase.v1' },
        }))).toEqual(test.controller ? { custodianAccountId: test.owner.id, machineId: test.controller.machineId,
            installationId: test.controller.installationId } : null);
    });

    it.each([false, true])('admits exact installation custody with controller present=%s', async withController => {
        const test = await createRetainedGuestFixture(withController);
        const purpose = { homeId, managedId: test.row.id, controller: test.controller,
            expectedIntentRevision: test.row.intentRevision, requestId: test.row.admittedActionRequestId,
            resource: test.resource, operationId: randomUUID(), taskId: randomUUID(),
            expectedPromptKind: 'auth.approveRemoteProvisioning' as const, phase: 'delivery' as const };
        expect(await admitManagedInstallationPurpose({ actorAccountId: test.owner.id, purpose }))
            .toMatchObject({ actorAccountId: test.owner.id, custodianAccountId: test.owner.id, purpose });
        await expect(admitManagedInstallationPurpose({ actorAccountId: test.other.id, purpose }))
            .rejects.toMatchObject({ code: 'permission_denied' });
        await expect(admitManagedInstallationPurpose({ actorAccountId: test.owner.id,
            purpose: { ...purpose, controller: test.controller ? undefined : { machineId: test.guest.id, installationId: test.guest.installationId! } } }))
            .rejects.toMatchObject({ code: 'permission_denied' });
    });

    it('forwards installation responses using admitted socket authority and retains enrollment and installation refusals', async () => {
        const test = await createRetainedGuestFixture(true);
        if (!test.controller) throw new Error('Installed controller required');
        const method = `${test.controller.machineId}:${RPC_METHODS.CAPABILITIES_INVOKE}`;
        const effect = vi.fn(async () => ({ answered: true }));
        const target = { id: 'installation-controller', data: { clientType: 'machine-scoped', userId: test.owner.id,
            machineId: test.controller.machineId, verifiedMachineInstallationId: test.controller.installationId,
            accountStoredContentCompatibility: evaluateAccountStoredContentSocketCompatibility({
                accountStoredContentCompatibility: { v: 1, protocolVersion: 2 },
            }).evaluation },
            timeout: () => ({ emitWithAck: effect }) };
        const io = createSocketRoomDiscoveryHarness(async room => room === target.id || room === `rpc:${test.owner.id}:${method}` ? [target] : []);
        const caller = createFakeSocket({ data: { userId: test.owner.id, authTokenKind: 'account', authAuthority: 'present_user' } });
        registerSocketRpcHandlers({ userId: test.owner.id, socket: caller as unknown as Socket, io });
        const params = { id: 'tool.systemTasks', method: 'respond', params: { homeId, managedId: test.row.id,
            controller: test.controller, expectedIntentRevision: test.row.intentRevision, requestId: test.row.admittedActionRequestId,
            resource: test.resource, operationId: randomUUID(), taskId: randomUUID(),
            expectedPromptKind: 'auth.approveRemoteProvisioning', answer: { approved: true } } };
        const call = async () => {
            const response = vi.fn();
            await triggerSocketHandler(caller, SOCKET_RPC_EVENTS.CALL, { method, params }, response);
            return response.mock.calls[0]?.[0];
        };
        expect(await call()).toEqual({ ok: true, result: { answered: true } });
        expect(effect).toHaveBeenCalledOnce();
        for (const credential of [
            { userId: test.other.id, authTokenKind: 'account', authAuthority: 'present_user' },
            { userId: test.owner.id, authTokenKind: 'account', authAuthority: 'account_automation' },
            { userId: test.owner.id, authTokenKind: 'terminal', authAuthority: 'present_user' },
        ]) {
            Object.assign(caller.data!, credential);
            expect(await call()).toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN });
        }
        Object.assign(caller.data!, { userId: test.owner.id, authTokenKind: 'account', authAuthority: 'present_user' });
        target.data.verifiedMachineInstallationId = randomUUID();
        expect(await call()).toMatchObject({ ok: false });
        target.data.verifiedMachineInstallationId = test.controller.installationId;
        await db.managedMachine.update({ where: { id: test.row.id }, data: { admittedInput: { enrollmentAccountId: test.other.id } } });
        expect(await call()).toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN });
        expect(effect).toHaveBeenCalledOnce();
    });

    it.each([false, true])('refuses power without revealing controller absence to an Account without a role (guest access=%s)', async guestAccess => {
        const test = await createRetainedGuestFixture(false);
        if (guestAccess) await db.managedMachine.update({ where: { id: test.row.id }, data: { enrolledMachineId: test.guest.id } });
        const app = fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
        app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
        // Authentication is the external boundary; role resolution and Home admission stay real.
        app.decorate('authenticate', async (request: FastifyRequest) => {
            request.userId = test.other.id;
            request.authTokenKind = 'account';
            request.authTokenLegacy = false;
            request.authAuthority = 'account_automation';
        });
        registerManagedMachineRoutes(app as Parameters<typeof registerManagedMachineRoutes>[0]);
        try {
            const response = await app.inject({ method: 'POST', url: '/v1/machines/managed/controller/admit-control',
                payload: { action: 'machines.managed.power.set', requestId: randomUUID(), input: {
                    homeId, managedId: test.row.id, when: 'after-idle', intent: 'stop', afterMs: 0,
                } } });
            // SEC-1111H H2: no role must be refused before controller state can be disclosed.
            expect(response.statusCode, response.body).toBe(guestAccess ? 409 : 403);
            expect(response.json()).toEqual({ code: guestAccess ? 'managed_power_required' : 'permission_denied' });
            expect(await db.managedMachine.findUniqueOrThrow({ where: { id: test.row.id } }))
                .toMatchObject({ desired: 'start', desiredWhen: 'now', intentRevision: test.row.intentRevision });
        } finally { await app.close(); }
    });

    it.each([false, true])('admits content-free guest activity using the managed role with controller present=%s', async withController => {
        const test = await createRetainedGuestFixture(withController);
        await db.managedMachine.update({ where: { id: test.row.id }, data: { enrolledMachineId: test.guest.id } });
        const target = { homeId, managedId: test.row.id, expectedRevision: test.row.intentRevision, controller: test.controller };
        const read = (actorAccountId: string, rpcMethod = MANAGED_ACTIVITY_READ_RPC_METHOD,
            request: typeof target & { action?: 'begin' | 'resume' } = target) => inTx(tx => resolveManagedGuestActivityAdmissionInTx(tx,
                { actorAccountId, machineId: test.guest.id, rpcMethod, target: request }));
        expect(await read(test.owner.id)).toMatchObject({ kind: 'admitted', machineId: test.guest.id, actorAccountId: test.owner.id });
        expect(await read(test.owner.id, MANAGED_ADMISSION_DRAIN_CONFIRM_RPC_METHOD, { ...target, action: 'begin' }))
            .toMatchObject({ kind: 'admitted', machineId: test.guest.id });
        // Guest Manage alone grants no native-resource custody on either path.
        expect(await read(test.other.id)).toBeNull();
        expect(await read(test.owner.id, MANAGED_ACTIVITY_READ_RPC_METHOD, { ...target,
            controller: test.controller ? undefined : { machineId: test.guest.id, installationId: test.guest.installationId! } })).toBeNull();
        await db.managedMachine.update({ where: { id: test.row.id }, data: { intentRevision: test.row.intentRevision + 1 } });
        expect(await read(test.owner.id)).toBeNull();
        expect(await read(test.owner.id, MANAGED_ADMISSION_DRAIN_CONFIRM_RPC_METHOD, { ...target, action: 'resume' }))
            .toMatchObject({ kind: 'admitted', machineId: test.guest.id });
    });

    it('retains reviewed cloud facts before allocation and confines unsigned follow-ups to the present-user custodian', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const other = await db.account.create({ data: { encryptionMode: 'plain' } });
        const provisioner = MachineProvisionerContributionV1Schema.parse({
            id: 'cloud', title: 'Cloud', icon: 'machine', resourceKind: 'vm', schemaVersion: 1,
            launchSchema: { type: 'object', properties: {}, additionalProperties: false },
            resourceSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
            platforms: ['linux'], prerequisites: [], billing: { location: 'cloud', stoppedBilling: 'not-billed' },
            retention: { supportedIntents: ['start', 'stop', 'delete'] },
            actions: { check: 'check', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', power: 'power', destroy: 'destroy' },
        });
        const launch = { provider: { pluginId: 'fixture.portable', localId: provisioner.id }, schemaVersion: 1, name: 'Cloud', choices: {} };
        const reviewedFacts = { launch, provisioner, optionStatus: 'current', billing: provisioner.billing,
            prerequisites: [], retentionCapabilities: provisioner.retention, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: true };
        const requestId = randomUUID();
        const input = { requestId, requestEnvelopeDigest: 'a'.repeat(43), continuationPresent: false, input: { enrollmentIdentity: { kind: 'existingUser' as const, role: 'adopted' as const },
            selection: { kind: 'one-off', homeId, launch, retention: reviewedFacts.retention, wakeOnAcceptedMessage: true }, reviewedFacts } };
        const app = fastify().withTypeProvider<ZodTypeProvider>();
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        // Authentication is the system boundary. All route admission, schemas, storage and publications remain real.
        app.decorate('authenticate', async (request: FastifyRequest) => {
            const kind = request.headers['x-test-auth-token-kind'] ?? request.headers['x-fixture-token-kind'];
            request.authTokenKind = kind === 'terminal' || kind === 'api_token' || kind === 'ephemeral_session_runner' ? kind : 'account';
            request.authTokenLegacy = false;
            request.userId = typeof request.headers['x-test-user-id'] === 'string' ? request.headers['x-test-user-id'] : owner.id;
            request.authAuthority = narrowCredentialAuthority(request.authTokenKind === 'account' ? 'present_user' : 'account_automation',
                request.headers['x-fixture-authority-ceiling']);
        });
        registerManagedMachineRoutes(app);
        await app.ready();
        const headers = { 'x-test-user-id': owner.id };
        const post = (path: string, payload: InjectOptions['payload'], extra: IncomingHttpHeaders = {}) => app.inject({ method: 'POST',
            url: `/v1/machines/managed/controller/${path}`, payload, headers: { ...headers, ...extra } });
        try {
            const admitted = await post('admit', input);
            expect(admitted.statusCode, admitted.body).toBe(200);
            const machine = admitted.json().machine;
            expect(machine).toMatchObject({ custodianAccountId: owner.id, enrollmentAccountId: owner.id,
                allocation: 'unsubmitted', reviewedFacts });
            expect(machine.controller).toBeUndefined();
            expect(await db.machine.count({ where: { accountId: owner.id } })).toBe(0);
            expect(await db.accountPluginIntent.count({ where: { accountId: owner.id } })).toBe(0);
            expect((await post('admit', input)).json()).toMatchObject({ replayed: true, machine: { id: machine.id } });
            expect((await post('admit', { ...input, requestEnvelopeDigest: 'b'.repeat(43) })).statusCode).toBe(409);
            const presetId = randomUUID();
            const sealed = sealManagedMachinePresetContentV1({ presetId, mode: 'plain', content: { v: 1, name: 'Portable cloud', launch } });
            const saved = await createMachinePreset({ accountId: owner.id, input: { id: presetId, homeId,
                owner: { kind: 'account', accountId: owner.id }, contentEncryptionMode: 'plain', ...sealed } });
            if (saved.kind !== 'saved') throw new Error('Expected the owner preset to save');
            const preset = { id: saved.preset.id, revision: saved.preset.revision };
            const presetContentOverride = createManagedMachinePresetAcquireOverrideV1({ presetId, mode: 'plain',
                projection: { content: sealed.content, recipientEnvelope: null },
                enrollmentIdentity: input.input.enrollmentIdentity });
            if (!presetContentOverride) throw new Error('Expected the owner preset acquire override');
            const presetAdmission = await post('admit', { requestId: randomUUID(), requestEnvelopeDigest: 'c'.repeat(43), continuationPresent: false,
                input: { selection: { kind: 'preset', homeId, ...preset }, presetContentOverride,
                    retention: reviewedFacts.retention, wakeOnAcceptedMessage: true } });
            expect(presetAdmission.statusCode, presetAdmission.body).toBe(200);
            expect(presetAdmission.json()).toMatchObject({ machine: { preset, custodianAccountId: owner.id },
                presetContent: sealed, presetContentOverride });
            expect(presetAdmission.json().machine).not.toHaveProperty('launch');
            expect(presetAdmission.json().machine.controller).toBeUndefined();
            expect(await db.machine.count({ where: { accountId: owner.id } })).toBe(0);
            const current = { homeId, managedId: machine.id, expectedIntentRevision: 0, requestId };
            const resource = { contributionRef: launch.provider, schemaVersion: 1, value: { id: 'native-same-resource' } };
            const credential = { resourceId: randomUUID(), displayName: 'Bootstrap', kind: 'other', encryptionMode: 'plain',
                storedContent: { t: 'plain', v: { v: 1, name: 'Bootstrap', kind: 'other', value: 'fixture-private-bootstrap' } } };
            const denied = [{ 'x-test-auth-token-kind': 'terminal' }, { 'x-test-auth-token-kind': 'api_token' },
                { 'x-fixture-token-kind': 'ephemeral_session_runner' }, { 'x-fixture-authority-ceiling': 'account_automation' },
                { 'x-test-user-id': other.id }];
            for (const credentials of denied) {
                expect((await post('current', current, credentials)).statusCode).toBe(403);
                expect((await post('submit', current, credentials)).statusCode).toBe(403);
                expect((await post('report', { ...current, result: { kind: 'bound', resource } }, credentials)).statusCode).toBe(403);
                expect((await post('create-bootstrap-credential', { ...current, credential }, credentials)).statusCode).toBe(403);
            }
            expect((await post('current', { ...current, requestId: randomUUID() })).statusCode).toBe(409);
            expect((await post('submit', current)).json()).toMatchObject({ submitted: true, machine: { allocation: 'may-exist' } });
            const report = await post('report', { ...current, result: { kind: 'bound', resource } });
            expect(report.statusCode, report.body).toBe(200);
            expect(report.json().machine).toMatchObject({ id: machine.id, resource, allocation: 'bound' });
            const bootstrap = await post('create-bootstrap-credential', { ...current, credential });
            expect(bootstrap.statusCode, bootstrap.body).toBe(200);
            expect(bootstrap.json().machine).toMatchObject({ bootstrapCredentialRef: { kind: 'shared_resource', resourceId: credential.resourceId } });
            const keys = tweetnacl.sign.keyPair();
            const guest = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id, installationId: randomUUID(),
                installationPublicKey: new Uint8Array(keys.publicKey), metadata: encodePlainMachineStoredContent({ host: 'guest', platform: 'linux', happyCliVersion: 'test',
                    homeDir: '/home/guest', happyHomeDir: '/home/guest/.happier' }),
                dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64') } });
            await db.managedMachine.update({ where: { id: machine.id }, data: { enrolledMachineId: guest.id,
                retention: { kind: 'deadline', at: 1, effect: 'stop' },
                observation: { observedAt: 1, availability: 'present', power: 'stopped', storage: 'retained' } } });
            const binding = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'fixture-signed-root', binding: {
                serverIdentityId: homeId, accountId: owner.id, custodianAccountId: owner.id,
                authentication: { kind: 'account', tokenEpoch: owner.tokenEpoch }, accountEncryptionMode: 'plain',
                machineId: guest.id, installationId: guest.installationId, actionId: 'machines.managed.acquire', requestId,
                target: { kind: 'machine', machineId: guest.id }, requestEnvelopeDigest: input.requestEnvelopeDigest,
            } }).binding;
            expect(await inTx(tx => readExternalActionManagedAcquireResourceInTx(tx, binding))).toMatchObject({ id: machine.id });
            expect(await inTx(tx => resolveManagedActionMachineAdmissionInTx(tx, { actorAccountId: owner.id, machineId: guest.id,
                actionId: 'machines.managed.acquire', executionBinding: binding }))).toMatchObject({ kind: 'admitted', custodianAccountId: owner.id });
            await inTx(tx => setEligibleMachineAccessGrantInTx(tx, { actorAccountId: owner.id, machineId: guest.id,
                principal: { kind: 'account', accountId: other.id }, level: 'admin' }));
            expect(await inTx(tx => resolveEffectiveMachineRoleInTx(tx, { actorAccountId: other.id, machineId: guest.id }))).toBe('manage');
            await expect(getManagedMachine({ actorAccountId: other.id, input: { homeId, managedId: machine.id } })).rejects.toMatchObject({ code: 'permission_denied' });
            expect(await inTx(tx => readManagedPendingActivationHoldReasonInTx(tx, { actorAccountId: other.id, machineId: guest.id,
                homeId, resumeRequested: true }))).toBeUndefined();
            await db.managedMachine.update({ where: { id: machine.id }, data: { wakeOnAcceptedMessage: false } });
            expect(await inTx(tx => readManagedPendingActivationHoldReasonInTx(tx, { actorAccountId: other.id, machineId: guest.id,
                homeId, resumeRequested: true }))).toBe('managed_power_required');
            await db.managedMachine.update({ where: { id: machine.id }, data: { wakeOnAcceptedMessage: true } });
            expect(await inTx(tx => validateManagedCreationBirthInTx(tx, { accountId: owner.id,
                birth: { homeId, managedId: machine.id }, executionMachineId: guest.id }))).toMatchObject({ id: machine.id });
            const unrelated = await db.managedMachine.create({ data: { homeId, custodianAccountId: owner.id,
                admittedActionRequestId: randomUUID(), admittedInput: { enrollmentAccountId: owner.id }, launch, reviewedFacts,
                allocation: 'bound', resource: { ...resource, value: { id: 'other-paid-resource' } },
                retention: { kind: 'deadline', at: 1, effect: 'stop' }, wakeOnAcceptedMessage: true } });
            const purpose = { kind: 'retention' as const };
            const policy = { ...current, requestId: randomUUID(), controller: { machineId: guest.id, installationId: guest.installationId! }, purpose };
            const policyPost = (path: string, body: typeof policy | Omit<typeof policy, 'purpose'> | ManagedControllerIntentReportV1 & { controller: typeof policy.controller },
                nativeResource = resource) => post(path, body, { 'x-test-auth-token-kind': 'terminal',
                    [MANAGED_POLICY_PROOF_HEADER]: encodeManagedPolicyProofV1(createManagedPolicyProofV1({ correlation: {
                        homeId: body.homeId, managedId: body.managedId, expectedIntentRevision: body.expectedIntentRevision,
                        requestId: body.requestId, controller: body.controller }, purpose,
                        resource: nativeResource, custodianAccountId: owner.id, path: `/v1/machines/managed/controller/${path}`, body, privateKey: keys.secretKey })) });
            const foreignPolicy = await policyPost('admit-policy', { ...policy, managedId: unrelated.id }, { ...resource, value: { id: 'other-paid-resource' } });
            expect(foreignPolicy.statusCode, foreignPolicy.body).toBe(403);
            const ownPolicy = await policyPost('admit-policy', policy);
            expect(ownPolicy.statusCode, ownPolicy.body).toBe(200);
            expect(ownPolicy.json().machine).toMatchObject({ id: machine.id, desired: 'stop' });
            const activePolicy = { ...policy, expectedIntentRevision: ownPolicy.json().machine.intentRevision };
            const { purpose: _purpose, ...correlation } = activePolicy;
            expect((await policyPost('submit-intent', correlation)).statusCode).toBe(200);
            const observation = { observedAt: Date.now(), availability: 'present' as const, power: 'stopped' as const };
            const observed = await policyPost('report-intent', { ...correlation, result: { kind: 'unknown' }, observation });
            expect(observed.statusCode, observed.body).toBe(200);
            expect(observed.json().machine.submittedNativeEffect).toBeUndefined();
            const settled = await policyPost('report-intent', { ...correlation, result: { kind: 'confirmed' }, observation });
            expect(settled.statusCode, settled.body).toBe(200);
            expect(settled.json().machine).toMatchObject({ desired: 'stop', observation });
            expect((await policyPost('report-intent', { ...correlation, requestId: randomUUID(), result: { kind: 'confirmed' }, observation })).statusCode).toBe(409);
        } finally { await app.close(); }
    });

    const securityProvisioner = MachineProvisionerContributionV1Schema.parse({
        id: 'cloud', title: 'Cloud', icon: 'machine', resourceKind: 'vm', schemaVersion: 1,
        launchSchema: { type: 'object', properties: {}, additionalProperties: false },
        resourceSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
        platforms: ['linux'], prerequisites: [], billing: { location: 'cloud', stoppedBilling: 'not-billed' },
        retention: { supportedIntents: ['start', 'stop', 'delete'] },
        actions: { check: 'check', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', power: 'power', destroy: 'destroy' },
    });
    const securityLaunch = { provider: { pluginId: 'fixture.portable', localId: 'cloud' }, schemaVersion: 1, name: 'Cloud', choices: {} };
    const securityFacts = { launch: securityLaunch, provisioner: securityProvisioner, optionStatus: 'current', billing: securityProvisioner.billing,
        prerequisites: [], retentionCapabilities: securityProvisioner.retention, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: true };
    const securityResource = { contributionRef: securityLaunch.provider, schemaVersion: 1, value: { id: 'paid' } };
    const securityRoles = defineMachineProvisionerSchemas({ launch: defineProtocolObject({}, { policy: 'closed' }),
        resource: defineProtocolObject({ id: defineProtocolString() }, { policy: 'closed' }) });
    const securityRoleActions = [
        { id: 'check', inputSchema: securityRoles.checkInput.jsonSchema, resultSchema: MachineProvisionerCheckResultProtocolV1Schema.jsonSchema },
        { id: 'acquire', inputSchema: securityRoles.acquireInput.jsonSchema, resultSchema: securityRoles.acquireResult.jsonSchema },
        { id: 'bootstrap', inputSchema: securityRoles.bootstrapInput.jsonSchema, resultSchema: MachineProvisionerBootstrapCarrierV1Schema.jsonSchema },
        { id: 'inspect', inputSchema: securityRoles.resourceInput.jsonSchema, resultSchema: MachineProvisionerObservationV1Schema.jsonSchema },
        { id: 'power', inputSchema: securityRoles.powerInput.jsonSchema, resultSchema: MachineProvisionerPowerResultV1Schema.jsonSchema },
        { id: 'destroy', inputSchema: securityRoles.resourceInput.jsonSchema, resultSchema: MachineProvisionerPowerResultV1Schema.jsonSchema },
    ];
    const securityDeclaration = createReleaseLessDeclarationV1(PluginManifestV2Schema.parse({
        schemaVersion: 2, id: securityLaunch.provider.pluginId, version: '1.0.0', displayName: 'Security fixture',
        engines: { happier: '^1.0.0' }, runtime: { apiVersion: 1 }, contributes: { machineProvisioners: [securityProvisioner],
            actions: securityRoleActions.map(action => ({ ...action, title: action.id, execution: { target: 'daemon' },
                surfaces: ['plugin'], scopes: ['global'], dangerLevel: 'safe' })) },
    }));
    const securityMachine = async (accountId: string) => {
        const host = await db.machine.create({ data: { id: randomUUID(), accountId, installationId: randomUUID(),
        pluginMaterializationRevision: BigInt(1),
        installationPublicKey: new Uint8Array(tweetnacl.sign.keyPair().publicKey),
        metadata: encodePlainMachineStoredContent({ host: 'host', platform: 'linux', happyCliVersion: 'test', homeDir: '/home/test', happyHomeDir: '/home/test/.happier' }),
        dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64') } });
        await db.accountPluginIntent.upsert({ where: { accountId_pluginId: { accountId, pluginId: securityLaunch.provider.pluginId } },
            create: { accountId, pluginId: securityLaunch.provider.pluginId, enabled: true, writableCollections: [], releaseLessDeclaration: securityDeclaration },
            update: {} });
        await db.pluginMachineMaterialization.create({ data: { accountId, serverIdentityId: homeId, machineId: host.id,
            materializationId: host.installationId!, pluginId: securityLaunch.provider.pluginId, version: '1.0.0', sourceClass: 'bundledFirstParty',
            portableRelease: false, archiveDigestSha256: securityDeclaration.manifestDigestSha256, uiArtifacts: [], enabled: true,
            trustState: 'trusted', observedAt: new Date() } });
        return host;
    };
    const securityRow = (custodianAccountId: string, controller?: { id: string; installationId: string | null }, enrolledMachineId?: string) =>
        db.managedMachine.create({ data: { homeId, custodianAccountId, admittedActionRequestId: randomUUID(),
            admittedInput: { enrollmentAccountId: custodianAccountId }, launch: securityLaunch, reviewedFacts: securityFacts,
            allocation: 'bound', resource: securityResource, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: true,
            ...(controller ? { controllerMachineId: controller.id, controllerInstallationId: controller.installationId } : {}),
            ...(enrolledMachineId ? { enrolledMachineId } : {}) } });
    const securityServer = async () => {
        const app = fastify().withTypeProvider<ZodTypeProvider>();
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        // Verified authentication/signature is the boundary; real admission, rows and mutations remain underneath.
        app.decorate('authenticate', async (request: FastifyRequest) => {
            const read = (name: string) => { const value = request.headers[name]; return typeof value === 'string' ? value : undefined; };
            request.userId = read('x-user')!;
            request.authTokenKind = read('x-kind') === 'account' ? 'account' : 'terminal';
            request.authTokenLegacy = read('x-legacy') === 'true';
            request.authAuthority = request.authTokenKind === 'account' ? 'present_user' : 'account_automation';
            if (!read('x-machine')) return;
            request.externalActionExecutionAuthorized = true;
            request.externalActionExecutionMachineId = read('x-machine');
            request.externalActionExecutionCustodianAccountId = read('x-custodian');
            request.externalActionExecutionRequestId = read('x-request');
            request.externalActionEffectActionId = read('x-effect');
        });
        registerManagedMachineRoutes(app);
        await app.ready();
        return app;
    };
    const signedHeaders = (accountId: string, machineId: string, action: string, requestId: string = randomUUID()) => ({
        'x-user': accountId, 'x-custodian': accountId, 'x-machine': machineId, 'x-effect': action, 'x-request': requestId,
    });

    it.each(['submit-intent', 'submit', 'report', 'create-bootstrap-credential'])('refuses stranger-signed %s without changing the row or creating a credential', async path => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const stranger = await db.account.create({ data: { encryptionMode: 'plain' } });
        const host = await securityMachine(stranger.id);
        const row = await securityRow(owner.id);
        await db.managedMachine.update({ where: { id: row.id }, data: { desired: 'stop', desiredWhen: 'now',
            ...(path === 'submit-intent' ? {} : { allocation: 'may-exist', resource: getActivePrismaRuntime().DbNull }) } });
        const before = await db.managedMachine.findUniqueOrThrow({ where: { id: row.id } });
        const resourceId = randomUUID();
        const current = { homeId, managedId: row.id, expectedIntentRevision: 0, requestId: row.admittedActionRequestId };
        const payload = path === 'report' ? { ...current, result: { kind: 'bound', resource: securityResource } }
            : path === 'create-bootstrap-credential' ? { ...current, credential: { resourceId, displayName: 'Bootstrap', kind: 'other', encryptionMode: 'plain',
                storedContent: { t: 'plain', v: { v: 1, name: 'Bootstrap', kind: 'other', value: 'fixture-private-bootstrap' } } } } : current;
        const app = await securityServer();
        try {
            const response = await app.inject({ method: 'POST', url: `/v1/machines/managed/controller/${path}`, payload,
                headers: signedHeaders(stranger.id, host.id, path === 'submit-intent' ? 'machines.managed.power.set' : 'machines.managed.acquire') });
            expect(response.statusCode, response.body).toBe(403);
            expect(response.json()).toEqual({ code: 'permission_denied' });
            expect(await db.managedMachine.findUniqueOrThrow({ where: { id: row.id } })).toEqual(before);
            expect(await db.savedSecretResource.count({ where: { id: resourceId } })).toBe(0);
        } finally { await app.close(); }
    });

    it.each([false, true])('refuses a shared guest controlling another row with controller present=%s', async pairPresent => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const recipient = await db.account.create({ data: { encryptionMode: 'plain' } });
        const guest = await securityMachine(owner.id);
        await securityRow(owner.id, undefined, guest.id);
        await inTx(tx => setEligibleMachineAccessGrantInTx(tx, { actorAccountId: owner.id, machineId: guest.id,
            principal: { kind: 'account', accountId: recipient.id }, level: 'admin' }));
        expect(isOriginalTerminalExecutionAction('machines.managed.delete')).toBe(true);
        expect(await inTx(tx => resolveExternalActionExecutionMachineAdmissionInTx(tx, { actorAccountId: owner.id, machineId: guest.id,
            actionId: 'machines.managed.delete', callerAuthority: 'account_automation' }))).toMatchObject({ kind: 'admitted' });
        const controller = pairPresent ? await securityMachine(owner.id) : undefined;
        const row = await securityRow(owner.id, controller);
        const before = await db.managedMachine.findUniqueOrThrow({ where: { id: row.id } });
        const app = await securityServer();
        try {
            for (const action of ['machines.managed.delete', 'machines.managed.controller.update'] as const) {
                const requestId = randomUUID();
                const input = action === 'machines.managed.delete'
                    ? { homeId, managedId: row.id, when: 'now', expectedRevision: 0, intent: 'delete', reviewedDependencies: true }
                    : { homeId, managedId: row.id, expectedIntentRevision: 0, controller: { machineId: guest.id, installationId: guest.installationId! }, reviewedPendingEffects: true };
                const response = await app.inject({ method: 'POST', url: '/v1/machines/managed/controller/admit-control',
                    headers: signedHeaders(owner.id, guest.id, action, requestId), payload: { action, requestId, input } });
                expect(response.statusCode, response.body).toBe(403);
                expect(await db.managedMachine.findUniqueOrThrow({ where: { id: row.id } })).toEqual(before);
            }
        } finally { await app.close(); }
    });

    it.each([false, true])('refuses shared own daemon at null-row %s admission', async initial => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const recipient = await db.account.create({ data: { encryptionMode: 'plain' } });
        const daemon = await securityMachine(owner.id);
        await inTx(tx => setEligibleMachineAccessGrantInTx(tx, { actorAccountId: owner.id, machineId: daemon.id,
            principal: { kind: 'account', accountId: recipient.id }, level: 'admin' }));
        const row = await securityRow(owner.id);
        const before = await db.managedMachine.findUniqueOrThrow({ where: { id: row.id } });
        const requestId = initial ? randomUUID() : row.admittedActionRequestId;
        const payload = initial ? { requestId, requestEnvelopeDigest: 'a'.repeat(43), continuationPresent: false, input: {
            enrollmentIdentity: { kind: 'existingUser', role: 'adopted' }, selection: { kind: 'one-off', homeId, launch: securityLaunch,
                retention: securityFacts.retention, wakeOnAcceptedMessage: true }, reviewedFacts: securityFacts } }
            : { homeId, managedId: row.id, expectedIntentRevision: 0, requestId };
        const app = await securityServer();
        try {
            const response = await app.inject({ method: 'POST', url: `/v1/machines/managed/controller/${initial ? 'admit' : 'current'}`,
                headers: signedHeaders(owner.id, daemon.id, 'machines.managed.acquire', requestId), payload });
            expect(response.statusCode, response.body).toBe(403);
            expect(await db.managedMachine.findUniqueOrThrow({ where: { id: row.id } })).toEqual(before);
            expect(await db.managedMachine.count({ where: { custodianAccountId: owner.id } })).toBe(1);
        } finally { await app.close(); }
    });

    it.each(['daemon', 'guest'] as const)('retains signed %s access to its own null row', async executor => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const host = await securityMachine(owner.id);
        const row = await securityRow(owner.id, undefined, executor === 'guest' ? host.id : undefined);
        const app = await securityServer();
        try {
            const response = await app.inject({ method: 'POST', url: '/v1/machines/managed/controller/current',
                headers: signedHeaders(owner.id, host.id, 'machines.managed.acquire'),
                payload: { homeId, managedId: row.id, expectedIntentRevision: 0, requestId: row.admittedActionRequestId } });
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json().machine.id).toBe(row.id);
        } finally { await app.close(); }
    });

    it('retains signed unshared own-daemon initial acquire admission', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const daemon = await securityMachine(owner.id);
        const requestId = randomUUID();
        const app = await securityServer();
        try {
            const response = await app.inject({ method: 'POST', url: '/v1/machines/managed/controller/admit',
                headers: signedHeaders(owner.id, daemon.id, 'machines.managed.acquire', requestId), payload: {
                    requestId, requestEnvelopeDigest: 'a'.repeat(43), continuationPresent: false, input: {
                        enrollmentIdentity: { kind: 'existingUser', role: 'adopted' }, selection: { kind: 'one-off', homeId, launch: securityLaunch,
                            retention: securityFacts.retention, wakeOnAcceptedMessage: true }, reviewedFacts: securityFacts } } });
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json().machine).toMatchObject({ custodianAccountId: owner.id, allocation: 'unsubmitted' });
            const conflict = await app.inject({ method: 'POST', url: '/v1/machines/managed/controller/admit',
                headers: signedHeaders(owner.id, daemon.id, 'machines.managed.acquire', requestId), payload: {
                    requestId: randomUUID(), requestEnvelopeDigest: 'a'.repeat(43), continuationPresent: false, input: {
                        enrollmentIdentity: { kind: 'existingUser', role: 'adopted' }, selection: { kind: 'one-off', homeId, launch: securityLaunch,
                            retention: securityFacts.retention, wakeOnAcceptedMessage: true }, reviewedFacts: securityFacts } } });
            expect(conflict.statusCode, conflict.body).toBe(409);
            expect(conflict.json()).toMatchObject({ code: 'request_conflict' });
            expect(await db.managedMachine.count({ where: { custodianAccountId: owner.id } })).toBe(1);
        } finally { await app.close(); }
    });

    it.each([false, true])('retains a new unshared own daemon as Move destination, current controller present=%s', async pairPresent => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const current = pairPresent ? await securityMachine(owner.id) : undefined;
        const destination = await securityMachine(owner.id);
        const row = await securityRow(owner.id, current);
        const requestId = randomUUID();
        const app = await securityServer();
        try {
            const response = await app.inject({ method: 'POST', url: '/v1/machines/managed/controller/admit-control',
                headers: signedHeaders(owner.id, destination.id, 'machines.managed.controller.update', requestId), payload: {
                    action: 'machines.managed.controller.update', requestId, input: { homeId, managedId: row.id,
                        expectedIntentRevision: 0, controller: { machineId: destination.id, installationId: destination.installationId! }, reviewedPendingEffects: true } } });
            expect(response.statusCode, response.body).toBe(200);
            expect(await db.managedMachine.findUniqueOrThrow({ where: { id: row.id } }))
                .toMatchObject({ controllerMachineId: destination.id, controllerInstallationId: destination.installationId });
        } finally { await app.close(); }
    });

    it.each([false, true].flatMap(pairPresent => [
        { suffix: 'cancel', positive: 'account', pairPresent },
        { suffix: 'cancel', positive: 'signed', pairPresent },
        { suffix: 'setup.skip', positive: 'account', pairPresent },
        { suffix: 'setup.skip', positive: 'signed', pairPresent },
    ] as const))(
        'requires present-user or signed custody for $suffix and retains $positive access with controller present=$pairPresent', async ({ suffix, positive, pairPresent }) => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const guest = await securityMachine(owner.id);
        const controller = pairPresent ? await securityMachine(owner.id) : undefined;
        const row = await securityRow(owner.id, controller, suffix === 'setup.skip' ? guest.id : undefined);
        await db.managedMachine.update({ where: { id: row.id }, data: suffix === 'cancel'
            ? { allocation: 'may-exist', resource: getActivePrismaRuntime().DbNull }
            : { creationState: 'active', presetId: randomUUID(), presetRevision: 0, machineSetup: { setup: {}, state: 'pending' } } });
        const before = await db.managedMachine.findUniqueOrThrow({ where: { id: row.id } });
        const payload = { homeId, managedId: row.id, expectedIntentRevision: 0 };
        const app = await securityServer();
        try {
            const denied = [{ 'x-user': owner.id }, { 'x-user': owner.id, 'x-kind': 'account', 'x-legacy': 'true' },
                ...(pairPresent ? [signedHeaders(owner.id, guest.id, `machines.managed.${suffix}`)] : [])];
            for (const headers of denied) {
                const response = await app.inject({ method: 'POST', url: managedMachineActionEndpointPathV1(`machines.managed.${suffix}`), payload, headers });
                expect(response.statusCode, response.body).toBe(403);
                expect(await db.managedMachine.findUniqueOrThrow({ where: { id: row.id } })).toEqual(before);
            }
            const response = await app.inject({ method: 'POST', url: managedMachineActionEndpointPathV1(`machines.managed.${suffix}`), payload,
                headers: positive === 'account' ? { 'x-user': owner.id, 'x-kind': 'account' }
                    : signedHeaders(owner.id, controller?.id ?? guest.id, `machines.managed.${suffix}`) });
            expect(response.statusCode, response.body).toBe(200);
        } finally { await app.close(); }
    });

    it('refuses a legacy present-user token at Account acquire admission', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const app = await securityServer();
        try {
            const response = await app.inject({ method: 'POST', url: '/v1/machines/managed/controller/admit',
                headers: { 'x-user': owner.id, 'x-kind': 'account', 'x-legacy': 'true' }, payload: {
                    requestId: randomUUID(), requestEnvelopeDigest: 'a'.repeat(43), continuationPresent: false, input: {
                        enrollmentIdentity: { kind: 'existingUser', role: 'adopted' }, selection: { kind: 'one-off', homeId, launch: securityLaunch,
                            retention: securityFacts.retention, wakeOnAcceptedMessage: true }, reviewedFacts: securityFacts } } });
            expect(response.statusCode, response.body).toBe(403);
            expect(await db.managedMachine.count({ where: { custodianAccountId: owner.id } })).toBe(0);
        } finally { await app.close(); }
    });

    it('saves an Account launch preset without installed Machines and keeps it private to its owner', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const other = await db.account.create({ data: { encryptionMode: 'plain' } });
        const id = randomUUID();
        const input = { id, homeId, owner: { kind: 'account' as const, accountId: owner.id }, contentEncryptionMode: 'plain' as const,
            ...sealManagedMachinePresetContentV1({ presetId: id, mode: 'plain', content: { v: 1, name: 'Cloud preset',
                launch: { provider: { pluginId: 'fixture.portable', localId: 'cloud' }, schemaVersion: 1, name: 'Cloud', choices: {} } } }) };
        const saved = await createMachinePreset({ accountId: owner.id, input });
        expect(saved).toMatchObject({ kind: 'saved', preset: input });
        expect(await getMachinePreset({ accountId: owner.id, input: { homeId, id: input.id } })).toMatchObject({ kind: 'found', preset: { id: input.id } });
        expect(await getMachinePreset({ accountId: other.id, input: { homeId, id: input.id } })).toMatchObject({ kind: 'refused', code: 'preset_not_found' });
        expect(await db.machine.count({ where: { accountId: owner.id } })).toBe(0);
    });

    it('resolves opaque portable setup only for its preset owner, including on a shared target', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const other = await db.account.create({ data: { encryptionMode: 'plain' } });
        const metadata = encodePlainMachineStoredContent({ host: 'guest', platform: 'linux', happyCliVersion: 'test', homeDir: '/home/guest', happyHomeDir: '/home/guest/.happier' });
        const dataEncryptionKey = decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64');
        const guest = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id, installationId: randomUUID(), metadata, dataEncryptionKey } });
        const shared = await db.machine.create({ data: { id: randomUUID(), accountId: other.id, installationId: randomUUID(), metadata, dataEncryptionKey } });
        await inTx(tx => setEligibleMachineAccessGrantInTx(tx, { actorAccountId: other.id, machineId: shared.id,
            principal: { kind: 'account', accountId: owner.id }, level: 'admin' }));
        expect(await inTx(tx => resolveEffectiveMachineRoleInTx(tx, { actorAccountId: owner.id, machineId: shared.id }))).toBe('manage');
        const setup = { secretRefs: { v: 1 as const, bindings: { TOKEN: { ref: 'personal-token' } } } };
        const presetId = randomUUID();
        const sealed = sealManagedMachinePresetContentV1({ presetId, mode: 'plain', content: { v: 1, name: 'Portable private setup', setup } });
        const saved = await createMachinePreset({ accountId: owner.id, input: { id: presetId, homeId,
            owner: { kind: 'account', accountId: owner.id }, contentEncryptionMode: 'plain', ...sealed } });
        if (saved.kind !== 'saved') throw new Error('Expected the owner setup preset to save');
        const sources = [{ kind: 'accountPresetOpaque' as const, presetId, presetRevision: saved.preset.revision, contentEncryptionMode: 'plain' as const },
            { kind: 'direct' as const, setup: {} }];
        expect(await resolveMachineSetup({ actorAccountId: owner.id, custodianAccountId: owner.id, input: { homeId, machineId: guest.id, sources } }))
            .toMatchObject({ sources: [{ ...sources[0], presetContent: { content: sealed.content, recipientEnvelope: null } }, sources[1]] });
        expect(await resolveMachineSetup({ actorAccountId: owner.id, custodianAccountId: other.id,
            input: { homeId, machineId: shared.id, sources } }))
            .toMatchObject({ sources: [{ ...sources[0], presetContent: { content: sealed.content, recipientEnvelope: null } }, sources[1]] });
        await expect(resolveMachineSetup({ actorAccountId: other.id, custodianAccountId: other.id,
            input: { homeId, machineId: shared.id, sources } })).rejects.toMatchObject({ code: 'preset_not_found' });
    });
});
