import { randomUUID } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { MACHINE_PLAIN_DATA_KEY_MARKER, encodePlainMachineStoredContent } from '@happier-dev/protocol';
import { MANAGED_ACTIVITY_READ_RPC_METHOD, MANAGED_ADMISSION_DRAIN_CONFIRM_RPC_METHOD } from '@happier-dev/protocol/machines/managed/managedIntentV1';
import tweetnacl from 'tweetnacl';
import { decodeBase64 } from 'privacy-kit';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { isManagedOpaquePresetReadV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { expect } from 'vitest';
import { db, getActivePrismaRuntime } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { resolveEffectiveMachineRoleInTx } from '@/app/machines/machineAccess';
import { cancelManagedCreation, getManagedMachine, listManagedMachines } from './managedRead';
import { admitManagedControl } from './managedMutations';
import { validateManagedCreationBirthInTx } from './managedCreationBirth';
import { invalidateManagedMachineInTx } from './managedRows';
import { reportMachineSetup, resolveMachineSetup, skipManagedMachineSetup } from './machineSetup';
import { publishManagedGuestActivityAvailable, resolveManagedGuestActivityAdmissionInTx } from './managedGuestActivity';
import { createAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { registerManagedMachineRoutes } from './managedRoutes';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { readExternalActionManagedAcquireResourceInTx } from '@/app/auth/externalActionManagedAdmission';
import { sealManagedMachinePresetContentV1, replaceManagedMachinePresetLaunchNameV1,
    openManagedMachinePresetContentV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetContentV1';
import { computeContentPublicKeyFingerprint } from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';
import { storeOpaquePresetLaunch, readStoredOpaquePresetLaunch } from './managedRows';

export async function exerciseManagedAcquireRootResource() {
    const { homeId, custodian, creator, stranger, controller, row, create } = await createCreatorFixture();
    const binding = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'fixture-root', binding: {
        serverIdentityId: homeId, accountId: creator.id, custodianAccountId: custodian.id,
        authentication: { kind: 'account', tokenEpoch: creator.tokenEpoch }, accountEncryptionMode: creator.encryptionMode,
        machineId: controller.id, installationId: controller.installationId, actionId: 'machines.managed.acquire',
        requestId: row.admittedActionRequestId, target: { kind: 'machine', machineId: controller.id },
        requestEnvelopeDigest: 'a'.repeat(43),
    } }).binding;
    const read = (input = binding) => inTx(tx => readExternalActionManagedAcquireResourceInTx(tx, input));
    expect((await read())?.id).toBe(row.id);
    for (const patch of [{ accountId: stranger.id }, { custodianAccountId: stranger.id },
        { requestId: randomUUID() }, { serverIdentityId: `srv_${'b'.repeat(32)}` },
        { machineId: randomUUID() }, { installationId: randomUUID() }]) {
        expect(await read({ ...binding, ...patch })).toBeNull();
    }
    const legacy = await create();
    expect(await read({ ...binding, requestId: legacy.admittedActionRequestId })).toBeNull();
    expect((await read({ ...binding, requestId: legacy.admittedActionRequestId, accountId: custodian.id }))?.id).toBe(legacy.id);
}

export async function exerciseManagedEnrollmentInstallationContext() {
    const { homeId, custodian, creator, stranger, controller, row } = await createCreatorFixture();
    const publicKey = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(11)).publicKey;
    const guest = await db.machine.create({ data: { id: randomUUID(), accountId: creator.id,
        metadata: '{}', installationId: randomUUID(), installationPublicKey: new Uint8Array(publicKey) } });
    await db.managedMachine.update({ where: { id: row.id }, data: { enrolledMachineId: guest.id } });
    const app = createAuthenticatedTestApp();
    // This fixture supplies verified HTTP authentication; the database/currentness path is real.
    app.addHook('preHandler', async (request: FastifyRequest) => {
        request.externalActionExecutionAuthorized = true;
        request.externalActionExecutionMachineId = controller.id;
        request.externalActionExecutionCustodianAccountId = custodian.id;
        request.externalActionExecutionRequestId = row.admittedActionRequestId;
        request.externalActionEffectActionId = 'machines.managed.acquire';
    });
    registerManagedMachineRoutes(app);
    await app.ready();
    const read = () => app.inject({ method: 'POST', url: '/v1/machines/managed/controller/context',
        headers: { 'x-test-user-id': creator.id }, payload: { homeId, managedId: row.id,
            expectedIntentRevision: 0, controller: { machineId: controller.id, installationId: controller.installationId },
            includeEnrollmentInstallation: true } });
    try {
        const visible = await read();
        expect(visible.statusCode, visible.body).toBe(200);
        expect(visible.json().enrollmentInstallation).toEqual({ machineId: guest.id, installationId: guest.installationId,
            installationPublicKey: encodeBase64(publicKey, 'base64url') });
        const native = await app.inject({ method: 'POST', url: '/v1/machines/managed/controller/context',
            headers: { 'x-test-user-id': creator.id }, payload: { homeId, managedId: row.id,
                expectedIntentRevision: 0, controller: { machineId: controller.id, installationId: controller.installationId },
                includeNativeCredentialBindings: true } });
        expect(native.statusCode, 'Acquire custody must not disclose native binding placeholders or source tickets').toBe(403);
        const nativeReport = await app.inject({ method: 'POST', url: '/v1/machines/managed/controller/report',
            headers: { 'x-test-user-id': creator.id }, payload: { homeId, managedId: row.id,
                expectedIntentRevision: 0, requestId: row.admittedActionRequestId,
                controller: { machineId: controller.id, installationId: controller.installationId },
                credentialDelivery: { request: { homeId, managedId: row.id, sessionId: 'unaccepted', bindingKey: 'unaccepted',
                    expectedResourceRevision: 0, expectedSourceRevision: 'unaccepted', expectedProviderTicket: 'unaccepted' },
                    result: { kind: 'unknown', code: 'credential_unavailable' } } } });
        expect(nativeReport.statusCode, 'Acquire custody must not complete native credential effects').toBe(403);
        await db.machine.update({ where: { id: guest.id }, data: { accountId: stranger.id } });
        expect((await read()).statusCode).toBe(403);
    } finally { await app.close(); }
}

export async function exerciseManagedRequesterRetention() {
    const { homeId, custodian, creator, stranger, controller, row } = await createCreatorFixture();
    const guest = await db.machine.create({ data: { id: randomUUID(), accountId: creator.id,
        installationId: randomUUID(), active: true,
        metadata: encodePlainMachineStoredContent({ host: 'managed', platform: 'linux', happyCliVersion: 'test',
            homeDir: '/home/guest', happyHomeDir: '/home/guest/.happier' }),
        dataEncryptionKey: new Uint8Array(decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER)) } });
    await db.managedMachine.update({ where: { id: row.id }, data: { enrolledMachineId: guest.id,
        allocation: 'bound', resource: { contributionRef: { pluginId: 'fixture.creator', localId: 'vm' }, schemaVersion: 1, value: {} },
        retention: { kind: 'unused', afterMs: 1000, effect: 'stop' } } });
    const target = { homeId, managedId: row.id, expectedRevision: 0,
        controller: { machineId: controller.id, installationId: controller.installationId! } };
    const input = { actorAccountId: custodian.id, machineId: guest.id, rpcMethod: MANAGED_ACTIVITY_READ_RPC_METHOD, target };
    expect(await inTx(tx => resolveManagedGuestActivityAdmissionInTx(tx, input)))
        .toMatchObject({ actorAccountId: custodian.id, custodianAccountId: creator.id, machineId: guest.id });
    expect(await inTx(tx => resolveEffectiveMachineRoleInTx(tx, { actorAccountId: custodian.id, machineId: guest.id }))).toBe('manage');
    expect(await inTx(tx => resolveManagedGuestActivityAdmissionInTx(tx, { ...input, actorAccountId: creator.id })))
        .toMatchObject({ actorAccountId: creator.id, custodianAccountId: creator.id, machineId: guest.id });
    expect(await inTx(tx => resolveManagedGuestActivityAdmissionInTx(tx, { ...input, target: { ...target, expectedRevision: 1 } }))).toBeNull();
    expect(await inTx(tx => resolveManagedGuestActivityAdmissionInTx(tx, { ...input,
        rpcMethod: MANAGED_ADMISSION_DRAIN_CONFIRM_RPC_METHOD, target: { ...target, expectedRevision: 1, action: 'resume' } })))
        .toMatchObject({ custodianAccountId: creator.id });
    await publishManagedGuestActivityAvailable({ accountId: creator.id, machineId: guest.id, installationId: guest.installationId! });
    expect(await db.accountChange.count({ where: { accountId: custodian.id, entityId: row.id } })).toBe(1);
    await db.machine.update({ where: { id: guest.id }, data: { accountId: stranger.id } });
    expect(await inTx(tx => resolveManagedGuestActivityAdmissionInTx(tx, input))).toBeNull();
}

export async function createCreatorFixture() {
    const homeId = `srv_${'a'.repeat(32)}`;
    const custodian = await db.account.create({ data: { encryptionMode: 'plain' } });
    const creator = await db.account.create({ data: { encryptionMode: 'plain' } });
    const stranger = await db.account.create({ data: { encryptionMode: 'plain' } });
    const controller = await db.machine.create({ data: { id: randomUUID(), accountId: custodian.id,
        metadata: '{}', installationId: randomUUID() } });
    const launch = { provider: { pluginId: 'fixture.creator', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} };
    const presetId = randomUUID();
    const create = (enrollmentAccountId?: string) => db.managedMachine.create({ data: {
        homeId, custodianAccountId: custodian.id, controllerMachineId: controller.id,
        controllerInstallationId: controller.installationId!, admittedActionRequestId: randomUUID(),
        admittedInput: enrollmentAccountId ? { enrollmentAccountId } : {}, presetId, presetRevision: 1,
        launch, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
    } });
    const row = await create(creator.id);
    return { homeId, custodian, creator, stranger, controller, launch, row, create };
}

export async function exerciseManagedCreatorAccess() {
    const { homeId, custodian, creator, stranger, controller, launch, row, create } = await createCreatorFixture();
    const unrelated = await create(stranger.id);
    const legacy = await create();
    const target = { homeId, managedId: row.id };
    expect(await inTx(tx => resolveEffectiveMachineRoleInTx(tx, { actorAccountId: creator.id, machineId: controller.id }))).toBeNull();
    expect(await getManagedMachine({ actorAccountId: creator.id, input: target })).toMatchObject({ id: row.id });
    expect((await listManagedMachines({ actorAccountId: creator.id, input: { homeId } })).machines.map(machine => machine.id)).toEqual([row.id]);
    for (const managedId of [unrelated.id, legacy.id]) {
        await expect(getManagedMachine({ actorAccountId: creator.id, input: { homeId, managedId } })).rejects.toMatchObject({ code: 'permission_denied' });
        await expect(cancelManagedCreation({ actorAccountId: creator.id, input: { homeId, managedId, expectedIntentRevision: 0 } })).rejects.toMatchObject({ code: 'permission_denied' });
    }
    const controlsFor = (managedId: string) => [
        { action: 'machines.managed.power.set', requestId: randomUUID(), input: { homeId, managedId, when: 'now', intent: 'start', expectedRevision: 0 } },
        { action: 'machines.managed.resize', requestId: randomUUID(), input: { homeId, managedId, size: { cpuCores: 2 } } },
    ] as const;
    const controls = controlsFor(row.id);
    for (const input of controls) await expect(admitManagedControl({ actorAccountId: creator.id,
        custodianAccountId: custodian.id, input })).rejects.toMatchObject({ code: 'permission_denied' });
    const recovery = await create(creator.id);
    const remove = { action: 'machines.managed.delete' as const, requestId: randomUUID(), input: {
        homeId, managedId: recovery.id, when: 'now' as const, intent: 'delete' as const,
        expectedRevision: 0, reviewedDependencies: true as const,
    } };
    await expect(admitManagedControl({ actorAccountId: stranger.id, custodianAccountId: custodian.id, input: remove }))
        .rejects.toMatchObject({ code: 'permission_denied' });
    expect(await admitManagedControl({ actorAccountId: creator.id, custodianAccountId: custodian.id, input: remove }))
        .toMatchObject({ machine: { id: recovery.id, creationState: 'canceled', allocation: 'confirmed-absent' } });
    const enrolled = await create(creator.id);
    const guest = await db.machine.create({ data: { id: randomUUID(), accountId: creator.id,
        metadata: '{}', installationId: randomUUID() } });
    await db.machineGrant.create({ data: { principalKind: 'account', machineId: guest.id, accountId: stranger.id,
        accessLevel: 'admin', createdByAccountId: creator.id } });
    await db.managedMachine.update({ where: { id: enrolled.id }, data: { enrolledMachineId: guest.id, allocation: 'bound',
        resource: { contributionRef: launch.provider, schemaVersion: 1, value: { id: 'guest-native-resource' } },
        launch: { ...launch, credentials: [{ purpose: { consumer: launch.provider, purpose: 'native' },
            account: { service: { pluginId: 'fixture.creator', localId: 'native-account' }, accountId: 'private-company-connection' } }] },
        bootstrapCredentialRef: { kind: 'shared_resource', resourceId: 'private-bootstrap' } } });
    for (const actor of [creator, stranger]) {
        expect(await inTx(tx => resolveEffectiveMachineRoleInTx(tx, { actorAccountId: actor.id, machineId: guest.id }))).toBe('manage');
        const visible = await getManagedMachine({ actorAccountId: actor.id, input: { homeId, managedId: enrolled.id } });
        expect(visible.launch).not.toHaveProperty('credentials');
        expect(visible).not.toHaveProperty('bootstrapCredentialRef');
        const listed = (await listManagedMachines({ actorAccountId: actor.id, input: { homeId } })).machines.find(machine => machine.id === enrolled.id);
        expect(listed?.launch).not.toHaveProperty('credentials');
        expect(listed).not.toHaveProperty('bootstrapCredentialRef');
        for (const input of controlsFor(enrolled.id)) await expect(admitManagedControl({ actorAccountId: actor.id,
            custodianAccountId: custodian.id, input }))
            .rejects.toMatchObject({ code: 'permission_denied' });
    }
    expect(await cancelManagedCreation({ actorAccountId: creator.id, input: { ...target, expectedIntentRevision: 0 } }))
        .toMatchObject({ machine: { id: row.id, creationState: 'canceled', desired: 'delete' } });
    expect(await getManagedMachine({ actorAccountId: custodian.id, input: target })).toMatchObject({ id: row.id });
    await db.managedMachine.update({ where: { id: row.id }, data: { archivedAt: new Date() } });
    expect((await listManagedMachines({ actorAccountId: creator.id, input: { homeId, archived: true } })).machines.map(machine => machine.id)).toEqual([row.id]);
}

export async function exerciseManagedCreatorControllerProjection() {
    const { homeId, creator, custodian, controller, launch, row } = await createCreatorFixture();
    const installationPublicKey = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(3)).publicKey;
    await db.machine.update({ where: { id: controller.id }, data: { installationPublicKey: new Uint8Array(installationPublicKey) } });
    const credentials = [{ purpose: { consumer: launch.provider, purpose: 'native' },
        account: { service: { pluginId: launch.provider.pluginId, localId: 'native-account' }, accountId: 'private-company-connection' } }];
    await db.managedMachine.update({ where: { id: row.id }, data: { launch: { ...launch, credentials },
        bootstrapCredentialRef: { kind: 'shared_resource', resourceId: 'private-bootstrap' } } });
    const input = { homeId, managedId: row.id };
    const visible = await getManagedMachine({ actorAccountId: creator.id, input });
    expect(visible.controllerAccess).toEqual({ installationPublicKey: encodeBase64(installationPublicKey, 'base64url'),
        custodian: { accountId: custodian.id } });
    expect(visible.launch).not.toHaveProperty('credentials');
    expect(visible).not.toHaveProperty('bootstrapCredentialRef');
    const listed = (await listManagedMachines({ actorAccountId: creator.id, input: { homeId } })).machines.find(machine => machine.id === row.id);
    expect(listed?.launch).not.toHaveProperty('credentials');
    expect(listed).not.toHaveProperty('bootstrapCredentialRef');
    const own = await getManagedMachine({ actorAccountId: custodian.id, input });
    expect(own.launch.credentials).toEqual(credentials);
    expect(own.bootstrapCredentialRef).toEqual({ kind: 'shared_resource', resourceId: 'private-bootstrap' });
    expect((await listManagedMachines({ actorAccountId: custodian.id, input: { homeId } })).machines.find(machine => machine.id === row.id)?.launch.credentials)
        .toEqual(credentials);
    const canceled = await cancelManagedCreation({ actorAccountId: creator.id, input: { ...input, expectedIntentRevision: 0 } });
    expect(canceled.machine.launch).not.toHaveProperty('credentials');
    expect(canceled.machine).not.toHaveProperty('bootstrapCredentialRef');
    const repeated = await cancelManagedCreation({ actorAccountId: creator.id, input: { ...input, expectedIntentRevision: canceled.machine.intentRevision } });
    expect(repeated.machine.launch).not.toHaveProperty('credentials');
    expect(repeated.machine).not.toHaveProperty('bootstrapCredentialRef');
    await db.machine.update({ where: { id: controller.id }, data: { revokedAt: new Date() } });
    expect(await getManagedMachine({ actorAccountId: creator.id, input })).not.toHaveProperty('controllerAccess');
}

export async function exerciseManagedCreatorPublication() {
    const { creator, custodian, stranger, row } = await createCreatorFixture();
    await inTx(tx => invalidateManagedMachineInTx(tx, row));
    expect((await db.accountChange.findMany({ where: { entityId: row.id }, select: { accountId: true } })).map(change => change.accountId).sort())
        .toEqual([creator.id, custodian.id].sort());
    expect(await db.accountChange.count({ where: { entityId: row.id, accountId: stranger.id } })).toBe(0);
}

export async function exerciseManagedCreatorBirth() {
    const { homeId, creator, stranger, controller, launch, row } = await createCreatorFixture();
    const guest = await db.machine.create({ data: { id: randomUUID(), accountId: creator.id, metadata: '{}', installationId: randomUUID() } });
    await db.managedMachine.update({ where: { id: row.id }, data: { allocation: 'bound', enrolledMachineId: guest.id,
        resource: { contributionRef: launch.provider, schemaVersion: 1, value: { id: randomUUID() } } } });
    const birth = { homeId, managedId: row.id, controller: { machineId: controller.id, installationId: controller.installationId! } };
    const validate = (accountId: string, executionMachineId = guest.id) => inTx(tx => validateManagedCreationBirthInTx(tx, { accountId, birth, executionMachineId }));
    expect(await validate(creator.id)).toBeTruthy();
    expect(await validate(stranger.id)).toBe(false);
    expect(await validate(creator.id, controller.id)).toBe(false);
    await db.managedMachine.update({ where: { id: row.id }, data: { creationState: 'canceled' } });
    expect(await validate(creator.id)).toBe(false);
}

export async function exerciseManagedCreatorSetupRecovery() {
    const { homeId, creator, stranger, launch, row } = await createCreatorFixture();
    const guest = await db.machine.create({ data: { id: randomUUID(), accountId: creator.id, metadata: '{}', installationId: randomUUID() } });
    await db.machineGrant.create({ data: { principalKind: 'account', machineId: guest.id, accountId: stranger.id,
        accessLevel: 'admin', createdByAccountId: creator.id } });
    const setup = { scripts: [{ body: 'echo admitted' }] };
    const admittedLaunch = { ...launch, credentials: [{ purpose: { consumer: launch.provider, purpose: 'native' },
        account: { service: { pluginId: launch.provider.pluginId, localId: 'native-account' }, accountId: 'private-company-connection' } }] };
    await db.managedMachine.update({ where: { id: row.id }, data: { allocation: 'bound', enrolledMachineId: guest.id,
        resource: { contributionRef: launch.provider, schemaVersion: 1, value: { id: randomUUID() } },
        launch: storeOpaquePresetLaunch({ contentEncryptionMode: 'plain', recipients: [],
            content: { t: 'plain', v: { v: 1, name: launch.name, launch: admittedLaunch, setup } } }),
        bootstrapCredentialRef: { kind: 'shared_resource', resourceId: 'private-bootstrap' },
        machineSetup: { state: 'failed' } } });
    const source = { kind: 'accountPresetOpaque' as const, presetId: row.presetId!, presetRevision: row.presetRevision!,
        contentEncryptionMode: 'plain' as const };
    const params = { actorAccountId: creator.id, custodianAccountId: creator.id };
    expect(await resolveMachineSetup({ ...params, input: { homeId, machineId: guest.id, purpose: 'creationOrigin', candidates: [source] } }))
        .toMatchObject({ creation: { managedId: row.id } });
    const input = { homeId, machineId: guest.id, managedId: row.id, presetId: source.presetId,
        presetRevision: source.presetRevision, operation: { operationId: randomUUID() } };
    await expect(reportMachineSetup({ ...params, actorAccountId: stranger.id, input: { ...input, state: 'running' } })).rejects.toMatchObject({ code: 'permission_denied' });
    await expect(skipManagedMachineSetup({ actorAccountId: stranger.id, input: { homeId, managedId: row.id, expectedIntentRevision: 0 } }))
        .rejects.toMatchObject({ code: 'permission_denied' });
    const running = await reportMachineSetup({ ...params, input: { ...input, state: 'running' } });
    expect(running).toMatchObject({ machine: { machineSetup: { state: 'running' } } });
    expect(running.machine).not.toHaveProperty('launch');
    expect(running.machine).not.toHaveProperty('bootstrapCredentialRef');
    await reportMachineSetup({ ...params, input: { ...input, state: 'failed', errorCode: 'setup_failed' } });
    const skipped = await skipManagedMachineSetup({ actorAccountId: creator.id, input: { homeId, managedId: row.id, expectedIntentRevision: 0 } });
    const skippedMachine = isManagedOpaquePresetReadV1(skipped) ? skipped.machine : skipped;
    expect(skippedMachine).toMatchObject({ id: row.id, enrolledMachineId: guest.id, machineSetup: { state: 'skipped' } });
    expect(skippedMachine).not.toHaveProperty('launch');
    expect(skippedMachine).not.toHaveProperty('bootstrapCredentialRef');
}

export async function exerciseManagedBoundSetupRecovery() {
    const { homeId, custodian, creator, stranger, controller, launch, row } = await createCreatorFixture();
    const setup = { scripts: [{ body: 'first' }, { body: 'unfinished' }] };
    await db.managedMachine.update({ where: { id: row.id }, data: { allocation: 'bound',
        admittedInput: { enrollmentAccountId: creator.id, acquisitionMode: 'resource-bound' },
        resource: { contributionRef: launch.provider, schemaVersion: 1, value: { id: randomUUID() } },
        machineSetup: { setup, state: 'pending' } } });
    const params = { actorAccountId: creator.id, custodianAccountId: custodian.id, creationManagedId: row.id };
    const input = { homeId, managedId: row.id, presetId: row.presetId!, presetRevision: row.presetRevision!,
        target: { kind: 'bound' as const, controller: { machineId: controller.id, installationId: controller.installationId! } },
        operation: { operationId: randomUUID() } };
    await expect(reportMachineSetup({ ...params, actorAccountId: stranger.id, input: { ...input, state: 'running' } }))
        .rejects.toMatchObject({ code: 'permission_denied' });
    await expect(reportMachineSetup({ ...params, creationManagedId: randomUUID(), input: { ...input, state: 'running' } }))
        .rejects.toMatchObject({ code: 'permission_denied' });
    const app = createAuthenticatedTestApp();
    // Authentication is the HTTP boundary; the report route and database owner remain real.
    app.addHook('preHandler', async (request: FastifyRequest) => {
        request.externalActionExecutionAuthorized = true;
        request.externalActionExecutionMachineId = controller.id;
        request.externalActionExecutionCustodianAccountId = custodian.id;
        request.externalActionExecutionRequestId = row.admittedActionRequestId;
        request.externalActionEffectActionId = 'machines.managed.acquire';
        request.externalActionExecutionAuthorizationBinding = ExternalActionExecutionAuthorizationV1Schema.parse({
            v: 1, token: 'fixture-bound-setup', binding: {
                serverIdentityId: homeId, accountId: creator.id, custodianAccountId: custodian.id,
                authentication: { kind: 'account', tokenEpoch: creator.tokenEpoch }, accountEncryptionMode: creator.encryptionMode,
                machineId: controller.id, installationId: controller.installationId, actionId: 'machines.managed.acquire',
                requestId: row.admittedActionRequestId, target: { kind: 'machine', machineId: controller.id },
                requestEnvelopeDigest: 'a'.repeat(43),
            },
        }).binding;
    });
    registerManagedMachineRoutes(app);
    try {
        const response = await app.inject({ method: 'POST', url: '/v1/machines/setup/report',
            headers: { 'x-test-user-id': creator.id }, payload: { ...input, state: 'running' } });
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json().machine.machineSetup).toMatchObject({ state: 'running' });
    } finally { await app.close(); }
    const sourceFacts = { 'accountPreset:preset:1': { pendingScripts: [1] } };
    await reportMachineSetup({ ...params, input: { ...input, state: 'failed', errorCode: 'setup_failed', sourceFacts } });
    const stored = await db.managedMachine.findUniqueOrThrow({ where: { id: row.id } });
    expect(stored.enrolledMachineId).toBeNull();
    expect(stored.machineSetup).toMatchObject({ state: 'failed', sourceFacts });
    const retry = { ...input, operation: { operationId: randomUUID() } };
    const running = await reportMachineSetup({ ...params, input: { ...retry, state: 'running' } });
    expect(running.machine.machineSetup).toMatchObject({ state: 'running', sourceFacts });
    await expect(reportMachineSetup({ ...params, input: { ...input, state: 'succeeded' } }))
        .rejects.toMatchObject({ code: 'intent_changed' });
    const settled = await reportMachineSetup({ ...params, input: { ...retry, state: 'succeeded', sourceFacts: {} } });
    expect(settled.machine.machineSetup).toMatchObject({ state: 'succeeded', sourceFacts: {} });
    const accountKey = new Uint8Array(32).fill(73);
    const publicKey = tweetnacl.box.keyPair.fromSecretKey(accountKey).publicKey;
    const randomBytes = (length: number) => new Uint8Array(length).fill(19);
    const sealed = sealManagedMachinePresetContentV1({ presetId: input.presetId, mode: 'e2ee',
        content: { v: 1, name: 'Private bound Setup', launch, setup },
        recipientCensus: [{ account: { kind: 'account', accountId: custodian.id, name: 'Controller', firstName: 'Controller',
            lastName: null, username: null, avatarUrl: null }, readiness: { status: 'available',
            contentPublicKey: encodeBase64(publicKey, 'base64'), contentPublicKeyFingerprint: computeContentPublicKeyFingerprint(publicKey) },
            envelopeStatus: 'missing' }], randomBytes });
    await db.managedMachine.update({ where: { id: row.id }, data: {
        launch: storeOpaquePresetLaunch({ contentEncryptionMode: 'e2ee', ...sealed, recipients: [...sealed.recipients] }), machineSetup: { state: 'pending' } } });
    await reportMachineSetup({ ...params, input: { ...input, state: 'running' } });
    await expect(reportMachineSetup({ ...params, input: { ...input, state: 'failed', sourceFacts } }))
        .rejects.toMatchObject({ code: 'invalid_request' });
    await expect(reportMachineSetup({ ...params, input: { ...input, state: 'failed', presetContent: {
        content: { t: 'plain', v: { v: 1, name: 'Wrong mode', launch, setup, setupSourceFacts: sourceFacts } } } } }))
        .rejects.toMatchObject({ code: 'account_mode_mismatch' });
    const replacement = replaceManagedMachinePresetLaunchNameV1({ presetId: input.presetId, mode: 'e2ee',
        content: sealed.content, recipients: sealed.recipients, accountId: custodian.id, accountKey,
        launchName: launch.name, setupSourceFacts: sourceFacts, randomBytes });
    if (!replacement) throw new Error('Could not seal bound Retry facts');
    const failed = await reportMachineSetup({ ...params, input: { ...input, state: 'failed',
        errorCode: 'setup_failed', presetContent: { content: replacement } } });
    expect(failed.machine.machineSetup).toMatchObject({ state: 'failed' });
    expect(JSON.stringify(failed)).not.toContain('pendingScripts');
    const encrypted = await db.managedMachine.findUniqueOrThrow({ where: { id: row.id } });
    expect(encrypted.machineSetup).not.toHaveProperty('sourceFacts');
    const retained = readStoredOpaquePresetLaunch(encrypted.launch);
    expect(retained.recipients).toEqual(sealed.recipients);
    expect(openManagedMachinePresetContentV1({ presetId: input.presetId, mode: 'e2ee', content: retained.content,
        recipients: retained.recipients, accountId: custodian.id, accountKey })).toMatchObject({ setupSourceFacts: sourceFacts });
    // Installation completion is independent of Setup: no-Setup presets must
    // retain the incumbent Retry marker without inventing a Setup lifecycle.
    await db.managedMachine.update({ where: { id: row.id }, data: { machineSetup: getActivePrismaRuntime().DbNull } });
    const installed = { homeId, managedId: row.id, presetId: input.presetId, presetRevision: input.presetRevision,
        target: { ...input.target, sessionId: randomUUID() }, bootstrapInstalled: true as const };
    for (let attempt = 0; attempt < 2; attempt++) {
        await reportMachineSetup({ ...params, input: installed });
    }
    const completed = await db.managedMachine.findUniqueOrThrow({ where: { id: row.id } });
    expect(completed.admittedInput).toMatchObject({ bootstrapInstalled: true, acquisitionMode: 'resource-bound' });
    expect(completed.machineSetup).toBeNull();
    expect(completed.launch).toEqual(encrypted.launch);
}
