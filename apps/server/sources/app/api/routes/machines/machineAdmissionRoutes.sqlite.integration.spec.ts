import { randomUUID } from 'node:crypto';
import tweetnacl from 'tweetnacl';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MACHINE_PLAIN_DATA_KEY_MARKER, decodeBase64, encodePlainMachineStoredContent, signMachineInstallationProof } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS, WorkspaceSyncSourceRoutingV1Schema, WorkspaceSyncSourceWriterTargetRoutingV1Schema, WorkspaceSyncTargetRoutingV1Schema } from '@happier-dev/protocol/socketRpc';
import { createAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { db } from '@/storage/db';
import { createAccountTokenForTests, createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createAuthenticatedFakeSocket, createSocketRoomDiscoveryHarness, triggerSocketHandler } from '@/app/api/testkit/socketHarness';
import { registerSocketRpcHandlers } from '@/app/api/socket/rpc/registerSocketRpcHandlers';
import { evaluateAccountStoredContentSocketCompatibility } from '@/app/clientCompatibility/accountStoredContentCompatibility';
import type { Socket } from 'socket.io';
import { machinesRoutes } from './machinesRoutes';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { resolveMachineAdmission } from '@/app/machines/machineAccess';
import { observeSqliteRequests } from '@/testkit/observeSqliteRequests';

describe('Machine receiver current admission on SQLite', () => {
    let harness: LightSqliteHarness | undefined;
    beforeAll(async () => { harness = await createLightSqliteHarness({
        tempDirPrefix: 'happier-machine-receiver-currentness-', initAuth: true, initEncrypt: false, initFiles: false,
        env: { HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '1' },
    }); }, 120_000);
    afterAll(async () => { await harness?.close(); });

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
        await db.machineGrant.create({ data: { ...grant, principalKind: 'account' as const } });
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
            await db.machineGrant.delete({ where: { principalKind: 'account', machineId_accountId: { machineId: machine.id, accountId: actor.id } } });
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
            await db.machineGrant.create({ data: { ...grant, principalKind: 'account' as const } });
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
        if (!requesterOwned) await db.machineGrant.create({ data: { principalKind: 'account' as const, machineId: child.id, accountId: actor.id,
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

    it.each(['source', 'target'] as const)('admits requester-owned %s workspace work on the guest and retains controller cleanup after rebuild', async kind => {
        const { homeId, custodian, actor, parentKey, childKey, parent, child, context, row } = await createSharedChildParentFixture(true);
        const operationId = randomUUID();
        const body = (phase: 'prepare' | 'abort' | 'preflight' | 'release') => {
            const routing = kind === 'source' ? { workspaceSyncSourceRouting: WorkspaceSyncSourceRoutingV1Schema.parse({ v: 1, phase, operationId,
                accountServerId: homeId, sourceMachineId: child.id, sourceRootPath: '/child/source',
                sourceContext: { machineAdmission: context, callerAuthority: 'present_user' } }) }
                : { workspaceSyncTargetRouting: WorkspaceSyncTargetRoutingV1Schema.parse({ v: 1, phase, operationId, accountServerId: homeId,
                    targetMachineId: child.id, targetRootPath: '/child/source',
                    targetContext: { machineAdmission: context, callerAuthority: 'present_user' } }) };
            const method = `${parent.id}:${kind === 'source' ? RPC_METHODS.DAEMON_WORKSPACE_SYNC_HANDOFF_SOURCE_PHASE
                : phase === 'release' ? RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_RELEASE : RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT}`;
            return { v: 1, context, method, ...routing, proof: signMachineInstallationProof({ payload: {
                version: 1, machineId: parent.id, installationId: parent.installationId!, accountId: custodian.id,
                rpcAdmission: { context, method, ...routing } }, privateKey: parentKey.secretKey }) };
        };
        const freshPhase = kind === 'source' ? 'prepare' : 'preflight';
        const releasePhase = kind === 'source' ? 'abort' : 'release';
        const app = createAuthenticatedTestApp();
        machinesRoutes(app);
        try {
            const verify = (machineId: string, accountId: string, payload: unknown) => app.inject({ method: 'POST',
                url: `/v1/machines/${machineId}/admission/verify`,
                headers: { authorization: 'Bearer authenticated-test', 'x-test-user-id': accountId }, payload });
            const method = `${child.id}:${kind === 'source' ? RPC_METHODS.DAEMON_WORKSPACE_SYNC_HANDOFF_SOURCE_PHASE
                : RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT}`;
            const guestProof = signMachineInstallationProof({ payload: { version: 1, machineId: child.id,
                installationId: child.installationId!, accountId: actor.id, rpcAdmission: { context, method } },
                privateKey: childKey.secretKey });
            const guest = await verify(child.id, actor.id, { v: 1, context, method, proof: guestProof });
            expect(guest.statusCode).toBe(200);
            expect(guest.json()).toEqual({ v: 1, ok: true });
            const refused = await verify(parent.id, custodian.id, body(freshPhase));
            expect(refused.statusCode).toBe(403);
            expect(refused.json()).toEqual({ error: 'access_denied' });
            await db.managedMachine.update({ where: { id: row.id }, data: { enrolledMachineId: null,
                admittedInput: { enrollmentAccountId: actor.id, replacementEnrollment: { machineId: child.id } },
                resource: { contributionRef: { pluginId: 'happier.devcontainer', localId: 'devcontainer' }, schemaVersion: 1,
                    value: {}, devcontainerObservation: { nativeResourceId: 'replacement', user: 'coder', workspaceFolder: '/new',
                        storage: { kind: 'child', childPath: '/new' } } } } });
            expect((await verify(parent.id, custodian.id, body(releasePhase))).statusCode).toBe(200);
            await db.managedMachine.update({ where: { id: row.id }, data: { admittedInput: { enrollmentAccountId: custodian.id,
                replacementEnrollment: { machineId: child.id } } } });
            expect((await verify(parent.id, custodian.id, body(releasePhase))).statusCode).toBe(403);
            expect(await resolveMachineAdmission({ actorAccountId: custodian.id, machineId: child.id })).toMatchObject({ kind: 'denied' });
        } finally { await app.close(); }
    });

    it('allows the original shared-child SOURCE custodian to abort after the actor loses access', async () => {
        const { homeId, custodian, actor, parentKey, childKey, parent, child, context } = await createSharedChildParentFixture();
        const routing = { v: 1 as const, phase: 'abort' as const, operationId: randomUUID(), accountServerId: homeId,
            sourceMachineId: child.id, sourceRootPath: '/child/source',
            sourceContext: { machineAdmission: context, callerAuthority: 'account_automation' as const } };
        const method = `${parent.id}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_HANDOFF_SOURCE_PHASE}`;
        const body = (phase: 'prepare' | 'abort', privateKey = parentKey.secretKey) => {
            const workspaceSyncSourceRouting = { ...routing, phase };
            const proof = signMachineInstallationProof({ payload: { version: 1, machineId: parent.id,
                installationId: parent.installationId!, accountId: custodian.id,
                rpcAdmission: { context, method, workspaceSyncSourceRouting } }, privateKey });
            return { v: 1, context, method, workspaceSyncSourceRouting, proof };
        };
        const app = createAuthenticatedTestApp();
        machinesRoutes(app);
        try {
            const verify = (payload: unknown) => app.inject({ method: 'POST',
                url: `/v1/machines/${parent.id}/admission/verify`,
                headers: { authorization: 'Bearer authenticated-test', 'x-test-user-id': custodian.id }, payload });
            const refused = await verify(body('prepare'));
            expect(refused.statusCode).toBe(403);
            expect(refused.json()).toEqual({ error: 'access_denied' });
            await db.machineGrant.delete({ where: { principalKind: 'account', machineId_accountId: { machineId: child.id, accountId: actor.id } } });
            expect((await verify(body('abort', childKey.secretKey))).statusCode).toBe(403);
            const released = await verify(body('abort'));
            expect(released.statusCode).toBe(200);
            expect(released.json()).toEqual({ v: 1, ok: true });
        } finally { await app.close(); }
    });

    it('refuses cross-account sourceWriterTarget cleanup oracle, arbitrary socket forwarding, forged actorAccountId, and methodPrefix mismatch, and revokes immediately', async () => {
        const homeId = await getOrCreateServerIdentityId();
        const attacker = await db.account.create({ data: { publicKey: `attacker-${randomUUID()}`, encryptionMode: 'plain' } });
        const victim = await db.account.create({ data: { publicKey: `victim-${randomUUID()}`, encryptionMode: 'plain' } });
        const bystander = await db.account.create({ data: { publicKey: `bystander-${randomUUID()}`, encryptionMode: 'plain' } });
        const attackerKey = tweetnacl.sign.keyPair();
        const victimKey = tweetnacl.sign.keyPair();
        const bystanderKey = tweetnacl.sign.keyPair();
        const createMachine = (accountId: string, key: ReturnType<typeof tweetnacl.sign.keyPair>) => db.machine.create({ data: {
            id: randomUUID(), accountId, active: true,
            metadata: encodePlainMachineStoredContent({ host: 'cleanup-sec', platform: 'linux', happyCliVersion: 'test',
                homeDir: '/home/test', happyHomeDir: '/home/test/.happier' }),
            dataEncryptionKey: new Uint8Array(decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64')),
            installationId: randomUUID(), installationPublicKey: new Uint8Array(key.publicKey),
        } });
        const attackerMachine = await createMachine(attacker.id, attackerKey);
        const victimMachine = await createMachine(victim.id, victimKey);
        const bystanderMachine = await createMachine(bystander.id, bystanderKey);

        const writerContext = {
            actorAccountId: attacker.id, custodianAccountId: attacker.id, machineId: attackerMachine.id,
            installationId: attackerMachine.installationId!, role: 'manage' as const, encryptionMode: 'plain' as const,
        };
        const buildRouting = (phase: 'release' | 'inspect' | 'dependencies', targetMachineId: string, claimedActorId = attacker.id) =>
            WorkspaceSyncSourceWriterTargetRoutingV1Schema.parse({
                v: 1,
                sourceWriter: { machineId: attackerMachine.id, installationId: attackerMachine.installationId! },
                source: {
                    v: 1, phase: 'abort', operationId: randomUUID(), accountServerId: homeId,
                    sourceMachineId: attackerMachine.id, sourceRootPath: '/attacker/src',
                    sourceContext: {
                        machineAdmission: { ...writerContext, actorAccountId: claimedActorId },
                        callerAuthority: 'present_user',
                    },
                },
                target: {
                    v: 1, phase, operationId: randomUUID(), accountServerId: homeId,
                    targetMachineId, targetRootPath: '/victim/dst',
                },
            });
        const phaseMethod = (phase: 'release' | 'inspect' | 'dependencies') =>
            phase === 'release' ? RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_RELEASE
                : phase === 'inspect' ? RPC_METHODS.DAEMON_WORKSPACE_SYNC_COMMITTED_COPY_INSPECT
                    : RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_DEPENDENCIES_INSPECT;

        const app = createAuthenticatedTestApp();
        machinesRoutes(app);
        const attackerToken = await createAccountTokenForTests(attacker.id, { kind: 'account', authority: 'present_user' });
        try {
            const verifyHttp = (machine: { id: string; installationId: string | null; accountId: string }, key: ReturnType<typeof tweetnacl.sign.keyPair>, method: string, routing: ReturnType<typeof buildRouting>) => {
                const proof = signMachineInstallationProof({
                    payload: {
                        version: 1, machineId: machine.id, installationId: machine.installationId!, accountId: machine.accountId,
                        rpcAdmission: { context: writerContext, method, workspaceSyncSourceWriterTargetRouting: routing },
                    },
                    privateKey: key.secretKey,
                });
                return app.inject({
                    method: 'POST',
                    url: `/v1/machines/${machine.id}/admission/verify`,
                    headers: { authorization: 'Bearer authenticated-test', 'x-test-user-id': machine.accountId },
                    payload: { v: 1, context: writerContext, method, workspaceSyncSourceWriterTargetRouting: routing, proof },
                });
            };

            const callSocket = async (targetMachine: { id: string; installationId: string | null; accountId: string }, method: string, routing: ReturnType<typeof buildRouting>) => {
                const compat = evaluateAccountStoredContentSocketCompatibility({ accountStoredContentCompatibility: { v: 1, protocolVersion: 2 } }).evaluation;
                const forwarded: unknown[] = [];
                const targetDaemon = createAuthenticatedFakeSocket({
                    id: `daemon-${targetMachine.id}`,
                    data: {
                        clientType: 'machine-scoped', userId: targetMachine.accountId, machineId: targetMachine.id,
                        verifiedMachineInstallationId: targetMachine.installationId!,
                        accountStoredContentCompatibility: compat,
                    },
                    timeout: () => ({ emitWithAck: async (_event: string, packet: unknown) => { forwarded.push(packet); return { ok: true }; } }),
                });
                const io = createSocketRoomDiscoveryHarness(async room =>
                    room === targetDaemon.id || room === `rpc:${targetMachine.accountId}:${method}` ? [targetDaemon] : []);
                const caller = Object.assign(createAuthenticatedFakeSocket({
                    id: `attacker-socket-${randomUUID()}`,
                    data: {
                        clientType: 'machine-scoped', userId: attacker.id, machineId: attackerMachine.id,
                        verifiedMachineInstallationId: attackerMachine.installationId!,
                        authTokenKind: 'account', authAuthority: 'present_user',
                        accountStoredContentCompatibility: compat,
                    },
                }), { handshake: { auth: { token: attackerToken } } });
                registerSocketRpcHandlers({ userId: attacker.id, socket: caller as unknown as Socket, io });
                const cb = vi.fn();
                await triggerSocketHandler(caller, SOCKET_RPC_EVENTS.CALL, {
                    method, params: 'opaque', workspaceSyncSourceWriterTargetRouting: routing,
                }, cb);
                return { result: cb.mock.calls[0]?.[0], forwarded };
            };

            // 1. Cross-account attacker M_A -> victim M_B across release, inspect (all inspect methods), dependencies
            for (const [phase, rpcMethod] of [
                ['release', phaseMethod('release')],
                ['inspect', phaseMethod('inspect')],
                ['inspect', RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_ENTRY_OBSERVE],
                ['inspect', RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_FILE_READ],
                ['dependencies', phaseMethod('dependencies')],
            ] as const) {
                const routing = buildRouting(phase, victimMachine.id);
                const method = `${victimMachine.id}:${rpcMethod}`;
                const senderDiscovery = await verifyHttp(attackerMachine, attackerKey, method, routing);
                expect(senderDiscovery.statusCode).toBe(403);
                expect(senderDiscovery.json()).toEqual({ error: 'access_denied' });

                const receiverVerify = await verifyHttp(victimMachine, victimKey, method, routing);
                expect(receiverVerify.statusCode).toBe(403);
                expect(receiverVerify.json()).toEqual({ error: 'access_denied' });

                const socketCall = await callSocket(victimMachine, method, routing);
                expect(socketCall.forwarded).toEqual([]);
                expect(socketCall.result).toMatchObject({ ok: false, errorCode: 'RPC_FORBIDDEN' });
            }

            // 2. Attacker unilaterally grants victim access to M_A and spoofs actorAccountId = victim.id
            await db.machineGrant.create({ data: {
                principalKind: 'account', machineId: attackerMachine.id, accountId: victim.id,
                accessLevel: 'admin', createdByAccountId: attacker.id,
            } });
            const spoofedRouting = buildRouting('release', victimMachine.id, victim.id);
            const victimReleaseMethod = `${victimMachine.id}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_RELEASE}`;
            expect((await verifyHttp(attackerMachine, attackerKey, victimReleaseMethod, spoofedRouting)).statusCode).toBe(403);
            expect((await verifyHttp(victimMachine, victimKey, victimReleaseMethod, spoofedRouting)).statusCode).toBe(403);
            const spoofedSocket = await callSocket(victimMachine, victimReleaseMethod, spoofedRouting);
            expect(spoofedSocket.forwarded).toEqual([]);
            expect(spoofedSocket.result).toMatchObject({ ok: false, errorCode: 'RPC_FORBIDDEN' });

            // 3. Victim grants attacker active use access to M_B: legitimate cleanup works,
            //    but mismatched methodPrefix (bystanderMachine) is STILL refused.
            await db.machineGrant.create({ data: {
                principalKind: 'account', machineId: victimMachine.id, accountId: attacker.id,
                accessLevel: 'view', createdByAccountId: victim.id,
            } });
            const legitimateRouting = buildRouting('release', victimMachine.id);
            const mismatchedMethod = `${bystanderMachine.id}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_RELEASE}`;
            expect((await verifyHttp(attackerMachine, attackerKey, mismatchedMethod, legitimateRouting)).statusCode).toBe(403);
            expect((await verifyHttp(bystanderMachine, bystanderKey, mismatchedMethod, legitimateRouting)).statusCode).toBe(403);
            const mismatchedSocket = await callSocket(bystanderMachine, mismatchedMethod, legitimateRouting);
            expect(mismatchedSocket.forwarded).toEqual([]);
            expect(mismatchedSocket.result).toMatchObject({ ok: false, errorCode: 'RPC_FORBIDDEN' });

            // Legitimate admitted target succeeds on discovery, receiver verify, and socket call
            const okDiscovery = await verifyHttp(attackerMachine, attackerKey, victimReleaseMethod, legitimateRouting);
            expect(okDiscovery.statusCode).toBe(200);
            expect(okDiscovery.json()).toMatchObject({
                v: 1, ok: true,
                destinationInstallation: { machineId: victimMachine.id, installationId: victimMachine.installationId },
            });
            expect((await verifyHttp(victimMachine, victimKey, victimReleaseMethod, legitimateRouting)).statusCode).toBe(200);
            const okSocket = await callSocket(victimMachine, victimReleaseMethod, legitimateRouting);
            expect(okSocket.forwarded, JSON.stringify(okSocket.result)).toHaveLength(1);
            expect(okSocket.result).toMatchObject({ ok: true });

            // 4. Instant revocation: deleting the grant immediately revokes discovery, verify, and socket forwarding
            await db.machineGrant.delete({ where: { principalKind: 'account', machineId_accountId: { machineId: victimMachine.id, accountId: attacker.id } } });
            expect((await verifyHttp(attackerMachine, attackerKey, victimReleaseMethod, legitimateRouting)).statusCode).toBe(403);
            expect((await verifyHttp(victimMachine, victimKey, victimReleaseMethod, legitimateRouting)).statusCode).toBe(403);
            const revokedSocket = await callSocket(victimMachine, victimReleaseMethod, legitimateRouting);
            expect(revokedSocket.forwarded).toEqual([]);
            expect(revokedSocket.result).toMatchObject({ ok: false, errorCode: 'RPC_FORBIDDEN' });
        } finally { await app.close(); }
    });
});
