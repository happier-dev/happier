import { randomUUID } from 'node:crypto';
import tweetnacl from 'tweetnacl';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MACHINE_PLAIN_DATA_KEY_MARKER, decodeBase64, encodePlainMachineStoredContent, signMachineInstallationProof } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { WorkspaceSyncSourceRoutingV1Schema, WorkspaceSyncTargetRoutingV1Schema } from '@happier-dev/protocol/socketRpc';
import { createAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { machinesRoutes } from './machinesRoutes';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { resolveMachineAdmission } from '@/app/machines/machineAccess';

describe('Machine receiver current admission on SQLite', () => {
    let harness: LightSqliteHarness | undefined;
    beforeAll(async () => { harness = await createLightSqliteHarness({
        tempDirPrefix: 'happier-machine-receiver-currentness-', initAuth: false, initEncrypt: false, initFiles: false,
        env: { HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '1' },
    }); }, 120_000);
    afterAll(async () => { await harness?.close(); });

    it('rechecks an owner-hosted approval requester independently of Machine access and refuses revoked Session invocation', async () => {
        const alice = await db.account.create({ data: { publicKey: `alice-${randomUUID()}`, encryptionMode: 'plain' } });
        const bob = await db.account.create({ data: { publicKey: `bob-${randomUUID()}`, encryptionMode: 'plain' } });
        const key = tweetnacl.sign.keyPair();
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: alice.id, active: true,
            metadata: encodePlainMachineStoredContent({ host: 'bot', platform: 'linux', happyCliVersion: 'test',
                homeDir: '/home/bot', happyHomeDir: '/home/bot/.happier' }),
            dataEncryptionKey: new Uint8Array(decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64')),
            installationId: randomUUID(), installationPublicKey: new Uint8Array(key.publicKey),
        } });
        const session = await db.session.create({ data: { id: randomUUID(), accountId: alice.id, tag: randomUUID(),
            metadata: '{}', encryptionMode: 'plain', active: false } });
        const homeId = await getOrCreateServerIdentityId();
        await db.accessKey.create({ data: { accountId: alice.id, sessionId: session.id,
            machineId: machine.id, data: MACHINE_PLAIN_DATA_KEY_MARKER } });
        await db.session.update({ where: { id: session.id }, data: { runtimeMachineTarget: {
            homeId, accountId: alice.id, sessionId: session.id, machineId: machine.id,
            installationId: machine.installationId!,
        } } });
        const share = await db.sessionShare.create({ data: { sessionId: session.id, sharedByUserId: alice.id,
            sharedWithUserId: bob.id, accessLevel: 'edit', canApprovePermissions: false } });
        const context = { actorAccountId: alice.id, custodianAccountId: alice.id, machineId: machine.id,
            installationId: machine.installationId!, role: 'manage' as const, encryptionMode: 'plain' as const };
        const sessionDecision = { sessionId: session.id,
            authentication: { tokenEpoch: bob.tokenEpoch },
            actor: { kind: 'accountUser' as const, accountId: bob.id, relationship: 'sharedApprover' as const } };
        const method = `${session.id}:approval.request.decide`;
        const proof = signMachineInstallationProof({ payload: { version: 1, machineId: machine.id,
            installationId: context.installationId, accountId: alice.id, rpcAdmission: { context, method, sessionDecision } },
            privateKey: key.secretKey });
        const app = createAuthenticatedTestApp();
        let hostingMachineId: string | null = null;
        app.decorate('resolveCurrentSessionMachine', async (input: Readonly<{ accountId: string; sessionId: string }>) =>
            input.accountId === alice.id && input.sessionId === session.id ? hostingMachineId : null);
        machinesRoutes(app);
        try {
            const verify = (body: unknown) => app.inject({ method: 'POST',
                url: `/v1/machines/${machine.id}/admission/verify`,
                headers: { authorization: 'Bearer authenticated-test', 'x-test-user-id': alice.id }, payload: body });
            const body = { v: 1, context, method, sessionDecision, proof };
            expect((await verify(body)).statusCode).toBe(200);
            expect((await verify({ ...body, sessionDecision: { ...sessionDecision,
                actor: { ...sessionDecision.actor, accountId: alice.id } } })).statusCode).toBe(403);
            await db.sessionShare.update({ where: { id: share.id }, data: { accessLevel: 'view' } });
            expect((await verify(body)).statusCode).toBe(403);
            await db.sessionShare.update({ where: { id: share.id }, data: { accessLevel: 'edit' } });
            await db.account.update({ where: { id: bob.id }, data: { tokenEpoch: { increment: 1 } } });
            expect((await verify(body)).statusCode).toBe(403);
            await db.account.update({ where: { id: bob.id }, data: { tokenEpoch: bob.tokenEpoch } });
            await db.sessionShare.delete({ where: { id: share.id } });
            const team = await db.team.create({ data: { name: `Bot Team ${randomUUID()}`,
                authenticationPolicy: { v: 1, mode: 'restricted', accepted: [{ kind: 'home_method', methodId: 'key_challenge' }] } } });
            await db.teamMembership.create({ data: { teamId: team.id, accountId: bob.id, role: 'member' } });
            await db.sessionTeamGrant.create({ data: { sessionId: session.id, teamId: team.id,
                accessLevel: 'edit', canApprovePermissions: false, effectiveAt: new Date() } });
            await db.account.update({ where: { id: bob.id }, data: { encryptionMode: 'e2ee' } });
            expect((await verify(body)).statusCode).toBe(403);
            const qualifiedDecision = { ...sessionDecision, authentication: { ...sessionDecision.authentication,
                evidence: { v: 1 as const, evidence: [{ kind: 'home_method' as const, methodId: 'key_challenge' }] } } };
            const qualifiedProof = signMachineInstallationProof({ payload: { version: 1, machineId: machine.id,
                installationId: context.installationId, accountId: alice.id,
                rpcAdmission: { context, method, sessionDecision: qualifiedDecision } }, privateKey: key.secretKey });
            const qualifiedBody = { ...body, sessionDecision: qualifiedDecision, proof: qualifiedProof };
            expect((await verify(qualifiedBody)).statusCode).toBe(200);
            await db.account.update({ where: { id: bob.id }, data: { encryptionMode: 'plain' } });
            expect((await verify(qualifiedBody)).statusCode).toBe(403);
            await db.account.update({ where: { id: bob.id }, data: { encryptionMode: 'e2ee' } });
            await db.accessKey.delete({ where: { accountId_machineId_sessionId: {
                accountId: alice.id, machineId: machine.id, sessionId: session.id,
            } } });
            expect((await verify(qualifiedBody)).statusCode).toBe(403);
        } finally { await app.close(); }
    });

    it('verifies the exact custodian installation and refuses a forged actor or replaced installation before effect', async () => {
        const custodian = await db.account.create({ data: { publicKey: `custodian-${randomUUID()}`, encryptionMode: 'plain' } });
        const actor = await db.account.create({ data: { publicKey: `actor-${randomUUID()}`, encryptionMode: 'plain' } });
        const stranger = await db.account.create({ data: { publicKey: `stranger-${randomUUID()}`, encryptionMode: 'plain' } });
        const key = tweetnacl.sign.keyPair();
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: custodian.id, active: true,
            metadata: encodePlainMachineStoredContent({ host: 'admitted', platform: 'linux', happyCliVersion: 'test',
                homeDir: '/home/shared', happyHomeDir: '/home/shared/.happier' }),
            dataEncryptionKey: new Uint8Array(decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64')),
            installationId: randomUUID(), installationPublicKey: new Uint8Array(key.publicKey),
        } });
        const grant = { machineId: machine.id, accountId: actor.id, accessLevel: 'view' as const, createdByAccountId: custodian.id };
        await db.machineAccountGrant.create({ data: grant });
        const context = { actorAccountId: actor.id, custodianAccountId: custodian.id, machineId: machine.id,
            installationId: machine.installationId!, role: 'use' as const, encryptionMode: 'plain' as const };
        const method = `${machine.id}:${RPC_METHODS.DAEMON_VOICE_INFERENCE_STATUS}`;
        const proof = signMachineInstallationProof({ payload: { version: 1, machineId: machine.id,
            installationId: context.installationId, accountId: custodian.id, rpcAdmission: { context, method } },
            privateKey: key.secretKey });
        const app = createAuthenticatedTestApp();
        machinesRoutes(app);
        try {
            const verify = (body: unknown, accountId = custodian.id) => app.inject({ method: 'POST',
                url: `/v1/machines/${machine.id}/admission/verify`,
                headers: { authorization: 'Bearer authenticated-test', 'x-test-user-id': accountId }, payload: body,
            });
            const body = { v: 1, context, method, proof };
            const admitted = await verify(body);
            expect(admitted.statusCode).toBe(200);
            expect(admitted.json()).toEqual({ v: 1, ok: true });
            expect((await verify(body, stranger.id)).statusCode).toBe(403);
            expect((await verify({ ...body, context: { ...context, actorAccountId: stranger.id } })).statusCode).toBe(403);
            expect((await verify({ ...body, method: `${machine.id}:${RPC_METHODS.STOP_DAEMON}` })).statusCode).toBe(403);
            const privilegedContext = { ...context, role: 'manage' as const };
            const privilegedMethod = `${machine.id}:${RPC_METHODS.STOP_DAEMON}`;
            const privilegedProof = signMachineInstallationProof({ payload: { version: 1, machineId: machine.id,
                installationId: context.installationId, accountId: custodian.id,
                rpcAdmission: { context: privilegedContext, method: privilegedMethod } }, privateKey: key.secretKey });
            expect((await verify({ v: 1, context: privilegedContext, method: privilegedMethod, proof: privilegedProof })).statusCode).toBe(403);
            await db.machineAccountGrant.delete({ where: { machineId_accountId: { machineId: machine.id, accountId: actor.id } } });
            expect((await verify(body)).statusCode).toBe(403);
            const custodyContext = { ...context, actorAccountId: custodian.id, role: 'manage' as const };
            const custodyMethod = `${machine.id}:${RPC_METHODS.DAEMON_MACHINE_ACCESS_LOSS}`;
            const custodyProof = signMachineInstallationProof({ payload: { version: 1, machineId: machine.id,
                installationId: context.installationId, accountId: custodian.id,
                rpcAdmission: { context: custodyContext, method: custodyMethod, custodySubjectAccountId: actor.id } }, privateKey: key.secretKey });
            const custodyBody = { v: 1, context: custodyContext, method: custodyMethod,
                custodySubjectAccountId: actor.id, proof: custodyProof };
            const censusProof = signMachineInstallationProof({ payload: { version: 1, machineId: machine.id,
                installationId: context.installationId, accountId: custodian.id,
                rpcAdmission: { context: custodyContext, method: custodyMethod } }, privateKey: key.secretKey });
            const censusBody = { v: 1, context: custodyContext, method: custodyMethod, proof: censusProof };
            expect((await verify(censusBody)).statusCode).toBe(200);
            expect((await verify(censusBody, stranger.id)).statusCode).toBe(403);
            expect((await verify(custodyBody)).statusCode).toBe(200);
            expect((await verify({ ...custodyBody, custodySubjectAccountId: stranger.id })).statusCode).toBe(403);
            await db.machineAccountGrant.create({ data: grant });
            expect((await verify(custodyBody)).statusCode).toBe(403);
            await db.machine.update({ where: { id: machine.id }, data: { installationId: randomUUID() } });
            expect((await verify(body)).statusCode).toBe(403);
        } finally { await app.close(); }
    });

    async function createSharedChildParentFixture(requesterOwned = false) {
        const homeId = await getOrCreateServerIdentityId();
        const custodian = await db.account.create({ data: { publicKey: `source-custodian-${randomUUID()}`, encryptionMode: 'plain' } });
        const actor = await db.account.create({ data: { publicKey: `source-actor-${randomUUID()}`, encryptionMode: 'plain' } });
        const parentKey = tweetnacl.sign.keyPair();
        const childKey = tweetnacl.sign.keyPair();
        const createMachine = (key: ReturnType<typeof tweetnacl.sign.keyPair>, accountId = custodian.id) => db.machine.create({ data: {
            id: randomUUID(), accountId, active: true,
            operationProtocolCapabilities: { requesterExecutionIsolation: { protocolVersions: [1] } },
            operationProtocolCapabilitiesRevision: 1,
            metadata: encodePlainMachineStoredContent({ host: 'source-fixture', platform: 'linux', happyCliVersion: 'test',
                homeDir: '/home/source', happyHomeDir: '/home/source/.happier' }),
            dataEncryptionKey: new Uint8Array(decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64')),
            installationId: randomUUID(), installationPublicKey: new Uint8Array(key.publicKey),
        } });
        const parent = await createMachine(parentKey);
        const child = await createMachine(childKey, requesterOwned ? actor.id : custodian.id);
        if (!requesterOwned) await db.machineAccountGrant.create({ data: { machineId: child.id, accountId: actor.id,
            accessLevel: 'view', createdByAccountId: custodian.id } });
        expect(await resolveMachineAdmission({ actorAccountId: actor.id, machineId: parent.id })).toMatchObject({ kind: 'denied' });
        const admitted = await resolveMachineAdmission({ actorAccountId: actor.id, machineId: child.id, requiredRole: 'use' });
        expect(admitted).toMatchObject({ kind: 'admitted' });
        if (admitted.kind !== 'admitted') throw new Error('Real shared-child fixture must admit the actor');
        const { kind: _kind, ...context } = admitted;
        const row = await db.managedMachine.create({ data: {
            homeId, custodianAccountId: custodian.id,
            controllerMachineId: parent.id, controllerInstallationId: parent.installationId!, enrolledMachineId: child.id,
            admittedActionRequestId: randomUUID(), admittedInput: requesterOwned ? { enrollmentAccountId: actor.id } : {}, allocation: 'bound', creationState: 'active',
            launch: { provider: { pluginId: 'happier.devcontainer', localId: 'devcontainer' }, schemaVersion: 1, name: 'Source child', choices: {} },
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            resource: { contributionRef: { pluginId: 'happier.devcontainer', localId: 'devcontainer' }, schemaVersion: 1, value: {},
                devcontainerObservation: { nativeResourceId: 'source-container', user: 'coder', workspaceFolder: '/child/source',
                    storage: { kind: 'bind', hostPath: '/parent/source', childPath: '/child/source' } } },
        } });
        return { homeId, custodian, actor, parentKey, childKey, parent, child, context, row };
    }

    it.each(['source', 'target'] as const)('verifies requester-owned %s workspace admission at its foreign controller and retains only cleanup after rebuild', async kind => {
        const { homeId, custodian, actor, parentKey, childKey, parent, child, context, row } = await createSharedChildParentFixture(true);
        const operationId = randomUUID();
        const body = (phase: 'prepare' | 'abort' | 'preflight' | 'release', rootPath = '/child/source', privateKey = parentKey.secretKey) => {
            const routing = kind === 'source' ? { workspaceSyncSourceRouting: WorkspaceSyncSourceRoutingV1Schema.parse({ v: 1, phase, operationId,
                accountServerId: homeId, sourceMachineId: child.id, sourceRootPath: rootPath,
                sourceContext: { machineAdmission: context, callerAuthority: 'present_user' } }) }
                : { workspaceSyncTargetRouting: WorkspaceSyncTargetRoutingV1Schema.parse({ v: 1, phase, operationId, accountServerId: homeId,
                    targetMachineId: child.id, targetRootPath: rootPath,
                    targetContext: { machineAdmission: context, callerAuthority: 'present_user' } }) };
            const method = `${parent.id}:${kind === 'source' ? RPC_METHODS.DAEMON_WORKSPACE_SYNC_HANDOFF_SOURCE_PHASE
                : phase === 'release' ? RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_RELEASE : RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT}`;
            return { v: 1, context, method, ...routing, proof: signMachineInstallationProof({ payload: {
                version: 1, machineId: parent.id, installationId: parent.installationId!, accountId: custodian.id,
                rpcAdmission: { context, method, ...routing } }, privateKey }) };
        };
        const freshPhase = kind === 'source' ? 'prepare' : 'preflight';
        const releasePhase = kind === 'source' ? 'abort' : 'release';
        const app = createAuthenticatedTestApp();
        machinesRoutes(app);
        try {
            const verify = (payload: unknown, accountId = custodian.id) => app.inject({ method: 'POST',
                url: `/v1/machines/${parent.id}/admission/verify`,
                headers: { authorization: 'Bearer authenticated-test', 'x-test-user-id': accountId }, payload });
            expect((await verify(body(freshPhase))).statusCode).toBe(200);
            expect((await verify(body(freshPhase), actor.id)).statusCode).toBe(403);
            expect((await verify(body(freshPhase, '/unrelated'))).statusCode).toBe(403);
            expect((await verify(body(freshPhase, '/child/source', childKey.secretKey))).statusCode).toBe(403);
            await db.managedMachine.update({ where: { id: row.id }, data: { enrolledMachineId: null,
                admittedInput: { enrollmentAccountId: actor.id, replacementEnrollment: { machineId: child.id } },
                resource: { contributionRef: { pluginId: 'happier.devcontainer', localId: 'devcontainer' }, schemaVersion: 1,
                    value: {}, devcontainerObservation: { nativeResourceId: 'replacement', user: 'coder', workspaceFolder: '/new',
                        storage: { kind: 'child', childPath: '/new' } } } } });
            expect((await verify(body(freshPhase))).statusCode).toBe(403);
            expect((await verify(body(releasePhase))).statusCode).toBe(200);
            await db.managedMachine.update({ where: { id: row.id }, data: { admittedInput: { enrollmentAccountId: custodian.id,
                replacementEnrollment: { machineId: child.id } } } });
            expect((await verify(body(releasePhase))).statusCode).toBe(403);
            expect(await resolveMachineAdmission({ actorAccountId: custodian.id, machineId: child.id })).toMatchObject({ kind: 'denied' });
        } finally { await app.close(); }
    });

    it('verifies original shared-child SOURCE admission with the exact physical parent signer', async () => {
        const { homeId, custodian, actor, parentKey, childKey, parent, child, context, row } = await createSharedChildParentFixture();
        const routing = { v: 1 as const, phase: 'prepare' as const, operationId: randomUUID(), accountServerId: homeId,
            sourceMachineId: child.id, sourceRootPath: '/child/source',
            sourceContext: { machineAdmission: context, callerAuthority: 'account_automation' as const } };
        const method = `${parent.id}:daemon.workspaceSync.handoffSourcePhase.v1`;
        const signRouting = (workspaceSyncSourceRouting: Omit<typeof routing, 'phase'> & { phase: 'prepare' | 'abort' }, privateKey = parentKey.secretKey) => signMachineInstallationProof({
            payload: { version: 1, machineId: parent.id, installationId: parent.installationId!, accountId: custodian.id,
                rpcAdmission: { context, method, workspaceSyncSourceRouting } }, privateKey });
        const proof = signRouting(routing);
        const app = createAuthenticatedTestApp();
        machinesRoutes(app);
        try {
            const body = { v: 1, context, method, workspaceSyncSourceRouting: routing, proof };
            const verify = (payload: unknown) => app.inject({ method: 'POST', url: `/v1/machines/${parent.id}/admission/verify`,
                headers: { authorization: 'Bearer authenticated-test', 'x-test-user-id': custodian.id }, payload });
            const response = await verify(body);
            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({ v: 1, ok: true });
            // Reviewed SOURCE custody grants the physical effect, not permission
            // to use an older receiver's unrestricted daemon filesystem rights.
            await db.machine.update({ where: { id: child.id }, data: {
                operationProtocolCapabilities: { requesterExecutionIsolation: { protocolVersions: [1] } },
                operationProtocolCapabilitiesRevision: 1,
            } });
            await db.machine.update({ where: { id: parent.id }, data: {
                operationProtocolCapabilities: { requesterExecutionIsolation: { protocolVersions: [1] } },
                operationProtocolCapabilitiesRevision: 1,
            } });
            expect((await verify(body)).statusCode).toBe(200);
            await db.machine.update({ where: { id: parent.id }, data: { operationProtocolCapabilities: {} } });
            expect((await verify(body)).statusCode).toBe(403);
            await db.machine.update({ where: { id: parent.id }, data: {
                operationProtocolCapabilities: { requesterExecutionIsolation: { protocolVersions: [1] } },
            } });
            expect((await verify(body)).statusCode).toBe(200);
            const foreignHome = `srv_${'b'.repeat(32)}`;
            const foreignHomeRouting = { ...routing, accountServerId: foreignHome };
            expect((await verify({ ...body, workspaceSyncSourceRouting: foreignHomeRouting,
                proof: signRouting(foreignHomeRouting) })).statusCode).toBe(403);
            await db.managedMachine.update({ where: { id: row.id }, data: { homeId: foreignHome } });
            expect((await verify(body)).statusCode).toBe(403);
            await db.managedMachine.update({ where: { id: row.id }, data: { homeId } });
            const foreignRouting = { ...routing, sourceRootPath: '/child/foreign' };
            expect((await verify({ ...body, workspaceSyncSourceRouting: foreignRouting, proof: signRouting(foreignRouting) })).statusCode).toBe(403);
            const childProof = signRouting(routing, childKey.secretKey);
            expect((await verify({ ...body, proof: childProof })).statusCode).toBe(403);
            await db.managedMachine.update({ where: { id: row.id }, data: { controllerInstallationId: randomUUID() } });
            expect((await verify(body)).statusCode).toBe(403);
            await db.managedMachine.update({ where: { id: row.id }, data: { controllerInstallationId: parent.installationId! } });
            await db.machineAccountGrant.delete({ where: { machineId_accountId: { machineId: child.id, accountId: actor.id } } });
            expect((await verify(body)).statusCode).toBe(403);
            const releaseRouting = { ...routing, phase: 'abort' as const };
            expect((await verify({ ...body, workspaceSyncSourceRouting: releaseRouting,
                proof: signRouting(releaseRouting) })).statusCode).toBe(200);
        } finally { await app.close(); }
    });

    it('verifies original shared-child TARGET admission with the exact physical parent signer', async () => {
        const { homeId, custodian, actor, parentKey, childKey, parent, child, context, row } = await createSharedChildParentFixture();
        const routing = { v: 1 as const, phase: 'preflight' as const, operationId: randomUUID(), accountServerId: homeId,
            targetMachineId: child.id, targetRootPath: '/child/source',
            targetContext: { machineAdmission: context, callerAuthority: 'account_automation' as const } };
        const method = `${parent.id}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT}`;
        const signRouting = (workspaceSyncTargetRouting: typeof routing, privateKey = parentKey.secretKey) => signMachineInstallationProof({
            payload: { version: 1, machineId: parent.id, installationId: parent.installationId!, accountId: custodian.id,
                rpcAdmission: { context, method, workspaceSyncTargetRouting } }, privateKey });
        const app = createAuthenticatedTestApp();
        machinesRoutes(app);
        try {
            const body = { v: 1, context, method, workspaceSyncTargetRouting: routing, proof: signRouting(routing) };
            const verify = (payload: unknown) => app.inject({ method: 'POST', url: `/v1/machines/${parent.id}/admission/verify`,
                headers: { authorization: 'Bearer authenticated-test', 'x-test-user-id': custodian.id }, payload });
            const response = await verify(body);
            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({ v: 1, ok: true });
            const foreignRouting = { ...routing, targetRootPath: '/child/foreign' };
            expect((await verify({ ...body, workspaceSyncTargetRouting: foreignRouting, proof: signRouting(foreignRouting) })).statusCode).toBe(403);
            expect((await verify({ ...body, proof: signRouting(routing, childKey.secretKey) })).statusCode).toBe(403);
            await db.managedMachine.update({ where: { id: row.id }, data: { controllerInstallationId: randomUUID() } });
            expect((await verify(body)).statusCode).toBe(403);
            await db.managedMachine.update({ where: { id: row.id }, data: { controllerInstallationId: parent.installationId! } });
            await db.machineAccountGrant.delete({ where: { machineId_accountId: { machineId: child.id, accountId: actor.id } } });
            expect((await verify(body)).statusCode).toBe(403);
        } finally { await app.close(); }
    });
});
