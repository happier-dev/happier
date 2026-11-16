import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import nacl from 'tweetnacl';
import { resolveHomeTargetFromDescriptor } from '@happier-dev/cli-common/homeTarget';
import { signMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { MACHINE_PLAIN_DATA_KEY_MARKER, decodeBase64, encodePlainMachineStoredContent } from '@happier-dev/protocol';
import { createLightSqliteHarness, type LightSqliteHarness } from '../../../../server/sources/testkit/lightSqliteHarness';
import { db } from '../../../../server/sources/storage/db';
import { inTx } from '../../../../server/sources/storage/inTx';
import { auth } from '../../../../server/sources/app/auth/auth';
import { getOrCreateServerIdentityId, initializeServerIdentityCache } from '../../../../server/sources/app/serverIdentity/serverIdentity';
import { createAuthenticatedTestApp } from '../../../../server/sources/app/api/testkit/sqliteFastify';
import { registerManagedMachineRoutes } from '../../../../server/sources/app/machines/managed/managedRoutes';
import { transitionSessionArchiveStateInTx } from '../../../../server/sources/app/session/archive/transitionSessionArchiveStateInTx';
import { projectManagedMachine } from '../../../../server/sources/app/machines/managed/managedRows';
import { createReleaseLessDeclarationV1 } from '../../../../server/sources/app/plugins/availability/currentDeclaration';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { fixture } from '@/plugins/runtime/invocation/actions/managedCustody.testkit';
import { createManagedProviderOperationAuthority } from '@/daemon/connectedServices/purposeBindings/managedProviderOperationAuthority';
import { createConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { createConnectedAccountRequestAuthSubjectRegistry } from '@/daemon/connectedServices/requestAuth/ConnectedAccountRequestAuthSubjectRegistry';
import { createManagedMachineAcquisitionDriver } from './acquire';
import { readManagedMachinePolicyCensus } from '@/daemon/startup/managedMachinePolicyRuntime';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { settleCommittedSessionLaunchFailure } from '@/session/services/settleCommittedSessionLaunchFailure';
import { registerSessionTurnMutationRoute } from '../../../../server/sources/app/api/routes/session/registerSessionTurnMutationRoute';

let database: LightSqliteHarness;
beforeAll(async () => {
    database = await createLightSqliteHarness({ tempDirPrefix: 'happier-archive-retention-', initAuth: true });
    await initializeServerIdentityCache();
}, 120_000);
afterAll(async () => { if (database) await database.close(); });

it.each([{ reopened: false, bound: false }, { reopened: true, bound: false },
    { reopened: false, bound: true }, { reopened: true, bound: true }])(
    'retains failed birth until explicit Archive and executes its retained deletion (bound=$bound, reopened=$reopened)', async ({ reopened, bound }) => {
    const creator = await db.account.create({ data: { encryptionMode: 'plain' } });
    const custodian = bound ? creator : await db.account.create({ data: { encryptionMode: 'plain' } });
    const homeId = await getOrCreateServerIdentityId();
    const controllerKeys = nacl.sign.keyPair(), guestKeys = nacl.sign.keyPair();
    const createMachine = (accountId: string, keys: typeof controllerKeys) => db.machine.create({ data: {
        id: randomUUID(), accountId, installationId: randomUUID(), installationPublicKey: keys.publicKey,
        active: true, lastActiveAt: new Date(),
        metadata: encodePlainMachineStoredContent({ host: 'scope-fixture', platform: 'linux', happyCliVersion: 'test',
            homeDir: '/home/scope', happyHomeDir: '/home/scope/.happier' }),
        dataEncryptionKey: new Uint8Array(decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64')),
    } });
    const controller = await createMachine(custodian.id, controllerKeys), guest = await createMachine(creator.id, guestKeys);
    const effects: string[] = [];
    const native = fixture({ privateNative: true, supportedIntents: ['stop', 'delete'], onNativeRole: role => { effects.push(role); } });
    const manifest = native.runtimeRegistry.contributes.activationTargets[0]!.manifest;
    const declaration = createReleaseLessDeclarationV1(manifest);
    await db.machine.update({ where: { id: controller.id }, data: { pluginMaterializationRevision: BigInt(1) } });
    await db.accountPluginIntent.create({ data: { accountId: custodian.id, pluginId: manifest.id, enabled: true,
        writableCollections: [], releaseLessDeclaration: declaration } });
    await db.pluginMachineMaterialization.create({ data: { accountId: custodian.id, serverIdentityId: homeId,
        machineId: controller.id, materializationId: controller.installationId!, pluginId: manifest.id,
        version: manifest.version, sourceClass: 'bundledFirstParty', portableRelease: false,
        archiveDigestSha256: declaration.manifestDigestSha256, uiArtifacts: [], enabled: true,
        trustState: 'trusted', observedAt: new Date() } });
    const sourceId = randomUUID();
    const row = await db.managedMachine.create({ data: { homeId, custodianAccountId: custodian.id,
        controllerMachineId: controller.id, controllerInstallationId: controller.installationId!, ...(bound ? {} : { enrolledMachineId: guest.id }),
        admittedActionRequestId: randomUUID(), admittedInput: { enrollmentAccountId: creator.id,
            ...(bound ? { acquisitionMode: 'resource-bound' } : {}),
            creationScopeRetention: { effect: 'delete', source: { kind: 'session', sessionId: sourceId } } },
        allocation: 'bound', creationState: 'active', desired: 'stop', retention: { kind: 'until-delete' },
        launch: { provider: { pluginId: manifest.id, localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
        resource: { contributionRef: { pluginId: manifest.id, localId: 'vm' }, schemaVersion: 1, value: {} },
        wakeOnAcceptedMessage: false } });
    await db.session.create({ data: { id: sourceId, accountId: creator.id, managedCreationId: row.id,
        tag: sourceId, metadata: '{}', encryptionMode: 'plain' } });
    const token = await auth.createToken(custodian.id, undefined, { kind: 'account', authority: 'present_user' });
    const app = createAuthenticatedTestApp({ authentication: 'real' });
    const mutationResponses: { status: number; body: unknown }[] = [];
    app.addHook('onSend', (request, reply, payload, done) => {
        if (request.url.endsWith('/turns/mutations') && typeof payload === 'string') {
            mutationResponses.push({ status: reply.statusCode, body: JSON.parse(payload) });
        }
        done(null, payload);
    });
    registerManagedMachineRoutes(app);
    registerSessionTurnMutationRoute(app);
    await app.ready();
    const serverUrl = 'https://archive-retention.example';
    const restore = installAxiosFastifyAdapter({ app, origin: serverUrl });
    const unavailable = async (): Promise<never> => { throw new Error('No provider credentials required by fixture'); };
    const authority = createManagedProviderOperationAuthority({ materializationBaseDir: tmpdir(),
        purposeBindingOwner: createConnectedAccountPurposeBindingOwner({
            store: { read: async () => ({ v: 1, bindings: [] }), update: unavailable, subscribe: () => ({ dispose() {} }) },
            selectTarget: unavailable, resolveTarget: unavailable, materializeAccount: unavailable,
            projectTargetAccounts: unavailable, assertTargetAccountMaterializable: unavailable }),
        requestAuthRegistry: createConnectedAccountRequestAuthSubjectRegistry(), resolveRequestAuthHttpPort: () => 43123,
        createRedactionLease: () => ({ add() {}, close() {} }) });
    // Guest RPC is an OS/network boundary. Home verifies its genuine installation proof.
    const readIdle = async (machine: ManagedMachineV1) => {
        if (bound) throw new Error('An unenrolled Session target has no guest activity RPC');
        const context = { actorAccountId: custodian.id, custodianAccountId: creator.id, machineId: guest.id,
            installationId: guest.installationId!, role: 'manage' as const, encryptionMode: 'plain' as const };
        const method = `${guest.id}:managed.admission.drain.confirm`;
        const managedTarget = { homeId, managedId: row.id, expectedRevision: machine.intentRevision, controller: machine.controller };
        const decision = { kind: 'idle' as const, since: 0, confirmedAt: Date.now() };
        const proof = signMachineInstallationProof({ payload: { version: 1, accountId: creator.id,
            machineId: guest.id, installationId: guest.installationId!, rpcAdmission: { context, method, managedTarget, managedIdleDecision: decision } },
            privateKey: guestKeys.secretKey });
        return { ...decision, evidence: { context, method, managedTarget, decision, proof } };
    };
    const driver = createManagedMachineAcquisitionDriver({ token, serverUrl, homeId,
        controller: { machineId: controller.id, installationId: controller.installationId! },
        externalActionMachineRequestPrivateKey: controllerKeys.secretKey, credentials: { token, encryption: null },
        runtimeRegistry: native.runtimeRegistry, managedProviderOperationAuthority: authority,
        homeTarget: resolveHomeTargetFromDescriptor({ descriptor: { v: 1, homeServerIdentityId: homeId, canonicalServerUrl: serverUrl,
            revision: 1, endpoints: [{ kind: 'https', url: serverUrl }] }, authority: 'current_connection' }),
        readPolicyCurrent: async (managedId, signal) => (await readManagedMachinePolicyCensus({ homeId,
            controller: { machineId: controller.id, installationId: controller.installationId! },
            custodianAccountId: custodian.id, privateKey: controllerKeys.secretKey, token, serverUrl, managedId, signal })).machines[0] ?? null,
        managedGuestActivity: { read: readIdle, confirmIdle: readIdle,
            reopen: async () => undefined, waitForChange: async () => undefined },
    });
    try {
        expect(projectManagedMachine(row).retention).toEqual({ kind: 'until-delete' });
        const creatorToken = bound ? token : await auth.createToken(creator.id, undefined, { kind: 'account', authority: 'present_user' });
        await runWithServerHttpBaseUrl(serverUrl, () => settleCommittedSessionLaunchFailure({ token: creatorToken, sessionId: sourceId,
            failure: { type: 'error', errorCode: 'SPAWN_FAILED', errorMessage: 'Target preparation failed',
                errorDetail: { kind: 'launch_error', code: 'managed_target_unavailable', message: 'Target preparation failed' } } }));
        expect(mutationResponses).toEqual([expect.objectContaining({ status: 200 }), expect.objectContaining({ status: 200 })]);
        expect(await db.sessionTurn.findMany({ where: { sessionId: sourceId }, select: { status: true } })).toEqual([
            { status: 'failed' },
        ]);
        expect(await db.session.findUniqueOrThrow({ where: { id: sourceId } })).toMatchObject({
            archivedAt: null, active: false, runtimeActivityRevision: BigInt(0), latestTurnStatus: 'failed',
        });
        expect((await db.sessionTurn.findFirstOrThrow({ where: { sessionId: sourceId } })).lastRuntimeIssueJson).toBeTruthy();
        expect(projectManagedMachine(await db.managedMachine.findUniqueOrThrow({ where: { id: row.id } })))
            .toMatchObject({ retention: { kind: 'until-delete' }, creationScopeRetention: { effect: 'delete' } });
        expect(projectManagedMachine(await db.managedMachine.findUniqueOrThrow({ where: { id: row.id } })).creationScopeRetention)
            .not.toHaveProperty('endedAt');
        let restoreArchiveDatabaseSpies = () => {};
        try { await inTx(async tx => {
            expect(await tx.managedMachine.findUnique({ where: { id: row.id } })).toMatchObject({
                creationState: 'active', archivedAt: null,
                admittedInput: { enrollmentAccountId: creator.id,
                    creationScopeRetention: { effect: 'delete', source: { kind: 'session', sessionId: sourceId } } },
            });
            // Instrument the database boundary without replacing the archive,
            // source lifecycle, projection or policy owners beneath it.
            const findUnique = tx.managedMachine.findUnique.bind(tx.managedMachine);
            const findMany = tx.managedMachine.findMany.bind(tx.managedMachine);
            const exactRead = vi.spyOn(tx.managedMachine, 'findUnique').mockImplementation(findUnique);
            const enrollmentReads = vi.spyOn(tx.managedMachine, 'findMany').mockImplementation(findMany);
            restoreArchiveDatabaseSpies = () => { exactRead.mockRestore(); enrollmentReads.mockRestore(); };
            const transition = await transitionSessionArchiveStateInTx({ tx, sessionId: sourceId, wasArchived: false, archivedAt: new Date() });
            expect(transition.session).toMatchObject({ id: sourceId, accountId: creator.id, managedCreationId: row.id });
            // Lifecycle and publication reads stay bound to this resource or guest.
            for (const [query] of exactRead.mock.calls) expect(query.where).toEqual({ id: row.id });
            for (const [query] of enrollmentReads.mock.calls) {
                expect(query?.where).toEqual({ enrolledMachineId: { in: [guest.id] } });
            }
        }); } finally {
            // inTx publishes after its callback; keep real delegate methods available through that flush.
            restoreArchiveDatabaseSpies();
        }
        const archived = await db.managedMachine.findUniqueOrThrow({ where: { id: row.id } });
        expect(archived.admittedInput).toMatchObject({ creationScopeRetention: { endedAt: expect.any(Number) } });
        const machine = projectManagedMachine(archived);
        expect(machine).toMatchObject({ desired: 'stop', retention: { kind: 'unused', afterMs: 0, effect: 'delete' } });
        if (reopened) {
            await inTx(tx => transitionSessionArchiveStateInTx({ tx, sessionId: sourceId, wasArchived: true, archivedAt: null }));
            const current = projectManagedMachine(await db.managedMachine.findUniqueOrThrow({ where: { id: row.id } }));
            await expect(driver.executePolicy(current, { kind: 'retention' }, { requestId: randomUUID(),
                context: { operationAcceptance: { operationId: randomUUID(), accept() {} }, operationOwnerUpdate: { update() {} } } }))
                .rejects.toMatchObject({ code: 'intent_changed' });
            expect(effects).toEqual([]);
            expect((await db.managedMachine.findUniqueOrThrow({ where: { id: row.id } })).allocation).toBe('bound');
            return;
        }
        await expect(driver.executePolicy(machine, { kind: 'retention' }, { requestId: randomUUID(),
            context: { operationAcceptance: { operationId: randomUUID(), accept() {} }, operationOwnerUpdate: { update() {} } } }))
            .resolves.toMatchObject({ kind: 'accepted', managedId: row.id });
        expect(effects).toEqual(['destroy']);
        expect((await db.managedMachine.findUniqueOrThrow({ where: { id: row.id } })).allocation).toBe('confirmed-absent');
        expect(await db.automation.count({ where: { accountId: creator.id } })).toBe(0);
    } finally { restore(); await app.close(); }
});
