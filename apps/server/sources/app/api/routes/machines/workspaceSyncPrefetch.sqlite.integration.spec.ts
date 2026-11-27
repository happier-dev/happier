import { randomUUID } from 'node:crypto';
import type { Socket } from 'socket.io';
import tweetnacl from 'tweetnacl';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
    CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
    MACHINE_PLAIN_DATA_KEY_MARKER,
    buildAccountStoredContentCompatibilitySocketAuthV1,
    decodeBase64,
    encodePlainMachineStoredContent,
    signMachineInstallationProof,
} from '@happier-dev/protocol';
import { signExternalActionMachineRpcRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import {
    SOCKET_RPC_EVENTS,
    WorkspaceSyncSeedRoutingV1Schema,
    WorkspaceSyncSourceRoutingV1Schema,
    WorkspaceSyncSourceWriterTargetRoutingV1Schema,
} from '@happier-dev/protocol/socketRpc';
import { createAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { createAuthenticatedFakeSocket, createSocketRoomDiscoveryHarness, triggerSocketHandler } from '@/app/api/testkit/socketHarness';
import { forwardRpcCall } from '@/app/api/socket/rpc/forwardRpcCall';
import { registerSocketRpcHandlers } from '@/app/api/socket/rpc/registerSocketRpcHandlers';
import { auth } from '@/app/auth/auth';
import { evaluateAccountStoredContentSocketCompatibility } from '@/app/clientCompatibility/accountStoredContentCompatibility';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { db } from '@/storage/db';
import { createAccountTokenForTests, createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { observeSqliteRequests } from '@/testkit/observeSqliteRequests';
import { machinesRoutes } from './machinesRoutes';

describe('Workspace-sync canonical Machine prefetch and admission reuse on SQLite', () => {
    let harness: LightSqliteHarness | undefined;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: 'happier-workspace-sync-prefetch-',
            initAuth: true,
            initEncrypt: false,
            initFiles: false,
            env: { HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '1' },
        });
    }, 120_000);

    afterEach(async () => {
        await db.managedMachine.deleteMany();
        await db.accessKey.deleteMany();
        await db.session.deleteMany();
        await db.machine.deleteMany();
        await db.account.deleteMany();
    });

    afterAll(async () => {
        await harness?.close();
    });

    const compat = evaluateAccountStoredContentSocketCompatibility(
        buildAccountStoredContentCompatibilitySocketAuthV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION),
    ).evaluation;

    async function countQueries<T>(run: () => Promise<T>): Promise<{
        value: T;
        machineQueries: Array<{ action: string }>;
        managedMachineQueries: Array<{ action: string }>;
    }> {
        const machineQueries: Array<{ action: string }> = [];
        const managedMachineQueries: Array<{ action: string }> = [];
        const stop = observeSqliteRequests({
            before: request => {
                if (request.model === 'Machine') machineQueries.push({ action: request.action });
                if (request.model === 'ManagedMachine') managedMachineQueries.push({ action: request.action });
            },
        });
        try {
            return { value: await run(), machineQueries, managedMachineQueries };
        } finally {
            stop();
        }
    }

    /**
     * `registerSocketRpcHandlers` starts a fire-and-forget connect-time availability hydration
     * (`hydrateMachineScopedRpcAvailabilityForSocket` -> `readMachineAvailabilityState` -> `Machine.findFirst`)
     * for machine-scoped sockets. Await that single hydration query deterministically before
     * entering `countQueries` so it never races into a subsequent RPC's query budget.
     */
    async function registerMachineScopedRpcHandlers(params: Parameters<typeof registerSocketRpcHandlers>[0]): Promise<void> {
        let resolveHydration!: () => void;
        const hydrated = new Promise<void>(resolve => { resolveHydration = resolve; });
        const stop = observeSqliteRequests({
            after: request => {
                if (request.model === 'Machine' && request.action === 'findFirst') resolveHydration();
            },
        });
        try {
            registerSocketRpcHandlers(params);
            await hydrated;
        } finally {
            stop();
        }
    }

    async function createHandoffFixture() {
        const homeId = await getOrCreateServerIdentityId();
        const owner = await db.account.create({ data: { publicKey: `owner-${randomUUID()}`, encryptionMode: 'plain' } });
        const stranger = await db.account.create({ data: { publicKey: `stranger-${randomUUID()}`, encryptionMode: 'plain' } });
        const sourceKey = tweetnacl.sign.keyPair();
        const targetKey = tweetnacl.sign.keyPair();

        const createMachine = (accountId: string, host: string, key: ReturnType<typeof tweetnacl.sign.keyPair>) =>
            db.machine.create({
                data: {
                    id: randomUUID(),
                    accountId,
                    active: true,
                    metadata: encodePlainMachineStoredContent({
                        host,
                        platform: 'linux',
                        happyCliVersion: 'test',
                        homeDir: `/home/${host}`,
                        happyHomeDir: `/home/${host}/.happier`,
                    }),
                    dataEncryptionKey: new Uint8Array(decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64')),
                    installationId: randomUUID(),
                    installationPublicKey: new Uint8Array(key.publicKey),
                },
            });

        const source = await createMachine(owner.id, 'source', sourceKey);
        const target = await createMachine(owner.id, 'target', targetKey);
        const session = await db.session.create({
            data: { accountId: owner.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain' },
        });
        await db.accessKey.create({
            data: { accountId: owner.id, machineId: source.id, sessionId: session.id, data: 'source' },
        });

        const root = await auth.mintExternalActionExecutionAuthorization({
            accountId: owner.id,
            serverIdentityId: homeId,
            authentication: { kind: 'account', tokenEpoch: owner.tokenEpoch },
            actionId: 'session.handoff',
            machineId: source.id,
            target: { kind: 'machine', machineId: source.id },
            requestId: randomUUID(),
            requestEnvelopeDigest: 'a'.repeat(43),
            handoffAdmission: {
                sessionId: session.id,
                sourceMachineId: source.id,
                sourceInstallationId: source.installationId!,
                targetMachineId: target.id,
                targetInstallationId: target.installationId!,
            },
        });

        const sourceContext = {
            actorAccountId: owner.id,
            custodianAccountId: owner.id,
            machineId: source.id,
            installationId: source.installationId!,
            role: 'manage' as const,
            encryptionMode: 'plain' as const,
        };
        const targetContext = {
            actorAccountId: owner.id,
            custodianAccountId: owner.id,
            machineId: target.id,
            installationId: target.installationId!,
            role: 'manage' as const,
            encryptionMode: 'plain' as const,
        };

        const sourceRouting = WorkspaceSyncSourceRoutingV1Schema.parse({
            v: 1,
            phase: 'prepare',
            operationId: root.binding.requestId,
            accountServerId: homeId,
            sourceMachineId: source.id,
            sourceSessionId: session.id,
            sourceRootPath: '/workspace/source',
            sourceContext: { machineAdmission: sourceContext, callerAuthority: 'present_user' },
        });
        const prepareRouting = WorkspaceSyncSourceWriterTargetRoutingV1Schema.parse({
            v: 1,
            source: sourceRouting,
            sourceWriter: { machineId: source.id, installationId: source.installationId! },
            target: {
                v: 1,
                phase: 'prepare',
                operationId: root.binding.requestId,
                accountServerId: homeId,
                targetMachineId: target.id,
                targetRootPath: '/workspace/target',
            },
        });
        const seedRouting = WorkspaceSyncSeedRoutingV1Schema.parse({
            v: 1,
            sourceWriterTarget: prepareRouting,
            target: {
                ...prepareRouting.target,
                targetContext: { machineAdmission: targetContext, callerAuthority: 'present_user' },
            },
        });
        const releaseRouting = WorkspaceSyncSourceWriterTargetRoutingV1Schema.parse({
            v: 1,
            sourceWriter: { machineId: source.id, installationId: source.installationId! },
            source: {
                v: 1,
                phase: 'abort',
                operationId: randomUUID(),
                accountServerId: homeId,
                sourceMachineId: source.id,
                sourceRootPath: '/workspace/source',
                sourceContext: { machineAdmission: sourceContext, callerAuthority: 'present_user' },
            },
            target: {
                v: 1,
                phase: 'release',
                operationId: randomUUID(),
                accountServerId: homeId,
                targetMachineId: target.id,
                targetRootPath: '/workspace/target',
            },
        });

        const ownerToken = await createAccountTokenForTests(owner.id, { kind: 'account', authority: 'present_user' });
        const strangerToken = await createAccountTokenForTests(stranger.id, { kind: 'account', authority: 'present_user' });

        return {
            owner,
            stranger,
            source,
            target,
            sourceKey,
            targetKey,
            root,
            sourceContext,
            prepareRouting,
            seedRouting,
            releaseRouting,
            ownerToken,
            strangerToken,
        };
    }

    it('batches Machine reads to one findMany across HTTP verify and Socket RPC for prepare, seed, and cleanup', async () => {
        const fx = await createHandoffFixture();
        const app = createAuthenticatedTestApp();
        machinesRoutes(app);
        try {
            const prepareMethod = `${fx.target.id}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_PREPARE}`;
            const seedMethod = `${fx.source.id}:${RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE}`;
            const releaseMethod = `${fx.target.id}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_RELEASE}`;

            // 1. HTTP /v1/machines/:id/admission/verify — handoff prepare (writerRouting)
            const prepareProof = signMachineInstallationProof({
                payload: {
                    version: 1, machineId: fx.source.id, installationId: fx.source.installationId!, accountId: fx.owner.id,
                    rpcAdmission: { context: fx.sourceContext, method: prepareMethod,
                        workspaceSyncSourceWriterTargetRouting: fx.prepareRouting, callerInputAuthorization: fx.root },
                },
                privateKey: fx.sourceKey.secretKey,
            });
            const httpPrepare = await countQueries(() => app.inject({
                method: 'POST', url: `/v1/machines/${fx.source.id}/admission/verify`,
                headers: { authorization: 'Bearer authenticated-test', 'x-test-user-id': fx.owner.id },
                payload: { v: 1, context: fx.sourceContext, method: prepareMethod,
                    workspaceSyncSourceWriterTargetRouting: fx.prepareRouting, callerInputAuthorization: fx.root, proof: prepareProof },
            }));
            expect(httpPrepare.value.statusCode, httpPrepare.value.body).toBe(200);
            expect(httpPrepare.value.json()).toMatchObject({ v: 1, ok: true,
                destinationInstallation: { machineId: fx.target.id, installationId: fx.target.installationId } });
            expect(httpPrepare.machineQueries).toEqual([{ action: 'findMany' }]);
            expect(httpPrepare.managedMachineQueries).toEqual([]);

            // 2. Socket CALL — handoff prepare (single prefetch + reused writerTarget admission + zero forwardRpcCall query)
            const forwardedPrepare: unknown[] = [];
            const targetDaemon = createAuthenticatedFakeSocket({
                id: 'daemon-target',
                data: { clientType: 'machine-scoped', userId: fx.owner.id, machineId: fx.target.id,
                    verifiedMachineInstallationId: fx.target.installationId!, accountStoredContentCompatibility: compat },
                timeout: () => ({ emitWithAck: async (_e: string, p: unknown) => { forwardedPrepare.push(p); return { ok: true, prepared: true }; } }),
            });
            const forwardedSeed: unknown[] = [];
            const sourceDaemon = createAuthenticatedFakeSocket({
                id: 'daemon-source',
                data: { clientType: 'machine-scoped', userId: fx.owner.id, machineId: fx.source.id,
                    verifiedMachineInstallationId: fx.source.installationId!, accountStoredContentCompatibility: compat },
                timeout: () => ({ emitWithAck: async (_e: string, p: unknown) => { forwardedSeed.push(p); return { ok: true, exported: true }; } }),
            });
            const io = createSocketRoomDiscoveryHarness(async room =>
                room === targetDaemon.id || room === `rpc:${fx.owner.id}:${prepareMethod}` || room === `rpc:${fx.owner.id}:${releaseMethod}`
                    ? [targetDaemon]
                    : room === sourceDaemon.id || room === `rpc:${fx.owner.id}:${seedMethod}` ? [sourceDaemon] : []);

            const sourceCaller = Object.assign(createAuthenticatedFakeSocket({
                id: 'caller-source',
                data: { clientType: 'machine-scoped', userId: fx.owner.id, machineId: fx.source.id,
                    verifiedMachineInstallationId: fx.source.installationId!, authTokenKind: 'account',
                    authAuthority: 'present_user', accountStoredContentCompatibility: compat },
            }), { handshake: { auth: { token: fx.ownerToken } } });
            await registerMachineScopedRpcHandlers({ userId: fx.owner.id, socket: sourceCaller as unknown as Socket, io });

            const prepareReqId = randomUUID();
            const prepareExec = {
                v: 1 as const, authorization: fx.root, effectActionId: 'session.handoff',
                target: fx.root.binding.target, installationId: fx.source.installationId!,
                machineSignature: signExternalActionMachineRpcRequestV1({
                    authorizationToken: fx.root.token, effectActionId: 'session.handoff', target: fx.root.binding.target,
                    installationId: fx.source.installationId!, method: prepareMethod, requestId: prepareReqId, params: 'opaque',
                    workspaceSyncSourceWriterTargetRouting: fx.prepareRouting, privateKey: fx.sourceKey.secretKey,
                }),
            };
            const socketPrepare = await countQueries(async () => {
                const cb = vi.fn();
                await triggerSocketHandler(sourceCaller, SOCKET_RPC_EVENTS.CALL, {
                    method: prepareMethod, requestId: prepareReqId, params: 'opaque',
                    externalActionExecution: prepareExec, workspaceSyncSourceWriterTargetRouting: fx.prepareRouting,
                }, cb);
                return cb.mock.calls[0]?.[0];
            });
            expect(socketPrepare.value).toEqual({ ok: true, result: { ok: true, prepared: true } });
            expect(forwardedPrepare).toHaveLength(1);
            expect(socketPrepare.machineQueries).toEqual([{ action: 'findMany' }]);
            expect(socketPrepare.managedMachineQueries).toEqual([]);

            // 3. HTTP /v1/machines/:id/admission/verify — seed key custody (callerIsTarget = true)
            const seedProof = signMachineInstallationProof({
                payload: {
                    version: 1, machineId: fx.target.id, installationId: fx.target.installationId!, accountId: fx.owner.id,
                    rpcAdmission: { context: fx.sourceContext, method: seedMethod,
                        workspaceSyncSeedRouting: fx.seedRouting, callerInputAuthorization: fx.root },
                },
                privateKey: fx.targetKey.secretKey,
            });
            const httpSeed = await countQueries(() => app.inject({
                method: 'POST', url: `/v1/machines/${fx.target.id}/admission/verify`,
                headers: { authorization: 'Bearer authenticated-test', 'x-test-user-id': fx.owner.id },
                payload: { v: 1, context: fx.sourceContext, method: seedMethod,
                    workspaceSyncSeedRouting: fx.seedRouting, callerInputAuthorization: fx.root, proof: seedProof },
            }));
            expect(httpSeed.value.statusCode, httpSeed.value.body).toBe(200);
            expect(httpSeed.value.json()).toMatchObject({ v: 1, ok: true,
                destinationInstallation: { machineId: fx.source.id, installationId: fx.source.installationId } });
            expect(httpSeed.machineQueries).toEqual([{ action: 'findMany' }]);
            expect(httpSeed.managedMachineQueries).toEqual([]);

            // 4. Socket CALL — seed export prepare (target -> source)
            const targetCaller = Object.assign(createAuthenticatedFakeSocket({
                id: 'caller-target',
                data: { clientType: 'machine-scoped', userId: fx.owner.id, machineId: fx.target.id,
                    verifiedMachineInstallationId: fx.target.installationId!, authTokenKind: 'account',
                    authAuthority: 'present_user', accountStoredContentCompatibility: compat },
            }), { handshake: { auth: { token: fx.ownerToken } } });
            await registerMachineScopedRpcHandlers({ userId: fx.owner.id, socket: targetCaller as unknown as Socket, io });

            const seedReqId = randomUUID();
            const seedExec = {
                v: 1 as const, authorization: fx.root, effectActionId: 'session.handoff',
                target: fx.root.binding.target, installationId: fx.target.installationId!,
                machineSignature: signExternalActionMachineRpcRequestV1({
                    authorizationToken: fx.root.token, effectActionId: 'session.handoff', target: fx.root.binding.target,
                    installationId: fx.target.installationId!, method: seedMethod, requestId: seedReqId, params: 'opaque',
                    workspaceSyncSeedRouting: fx.seedRouting, privateKey: fx.targetKey.secretKey,
                }),
            };
            const socketSeed = await countQueries(async () => {
                const cb = vi.fn();
                await triggerSocketHandler(targetCaller, SOCKET_RPC_EVENTS.CALL, {
                    method: seedMethod, requestId: seedReqId, params: 'opaque',
                    externalActionExecution: seedExec, workspaceSyncSeedRouting: fx.seedRouting,
                }, cb);
                return cb.mock.calls[0]?.[0];
            });
            expect(socketSeed.value).toEqual({ ok: true, result: { ok: true, exported: true } });
            expect(forwardedSeed).toHaveLength(1);
            // Workspace-sync seed authz batches its Machine reads into one findMany, and forwardRpcCall
            // skips its encryptionMode Machine.findFirst via admittedMachineTarget (proven in Test 3).
            // The single trailing findFirst is the pre-existing createEphemeralRunnerMachineRpcTargetGuard
            // (`select: { kind: true }`) for DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE (ephemeralRunnerAuthority:
            // 'readTranscript', with transferRouting undefined for workspaceSyncSeedRouting); httpSeed above
            // does 1 findMany + 0 findFirst.
            expect(socketSeed.machineQueries).toEqual([{ action: 'findMany' }, { action: 'findFirst' }]);
            expect(socketSeed.managedMachineQueries).toEqual([]);

            // 5. HTTP & Socket cleanup (phase: 'release')
            const releaseProof = signMachineInstallationProof({
                payload: {
                    version: 1, machineId: fx.source.id, installationId: fx.source.installationId!, accountId: fx.owner.id,
                    rpcAdmission: { context: fx.sourceContext, method: releaseMethod,
                        workspaceSyncSourceWriterTargetRouting: fx.releaseRouting },
                },
                privateKey: fx.sourceKey.secretKey,
            });
            const httpRelease = await countQueries(() => app.inject({
                method: 'POST', url: `/v1/machines/${fx.source.id}/admission/verify`,
                headers: { authorization: 'Bearer authenticated-test', 'x-test-user-id': fx.owner.id },
                payload: { v: 1, context: fx.sourceContext, method: releaseMethod,
                    workspaceSyncSourceWriterTargetRouting: fx.releaseRouting, proof: releaseProof },
            }));
            expect(httpRelease.value.statusCode, httpRelease.value.body).toBe(200);
            expect(httpRelease.machineQueries).toEqual([{ action: 'findMany' }]);

            const socketRelease = await countQueries(async () => {
                const cb = vi.fn();
                await triggerSocketHandler(sourceCaller, SOCKET_RPC_EVENTS.CALL, {
                    method: releaseMethod, params: 'opaque', workspaceSyncSourceWriterTargetRouting: fx.releaseRouting,
                }, cb);
                return cb.mock.calls[0]?.[0];
            });
            expect(socketRelease.value).toEqual({ ok: true, result: { ok: true, prepared: true } });
            expect(socketRelease.machineQueries).toEqual([{ action: 'findMany' }]);
        } finally {
            await app.close();
        }
    });

    it('preserves fail-closed revocation, installation rotation, stranger denial, and managed storage checks', async () => {
        const fx = await createHandoffFixture();
        const app = createAuthenticatedTestApp();
        machinesRoutes(app);
        try {
            const prepareMethod = `${fx.target.id}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_PREPARE}`;
            const seedMethod = `${fx.source.id}:${RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE}`;
            const forwarded: unknown[] = [];
            const targetDaemon = createAuthenticatedFakeSocket({
                id: 'daemon-target-parity',
                data: { clientType: 'machine-scoped', userId: fx.owner.id, machineId: fx.target.id,
                    verifiedMachineInstallationId: fx.target.installationId!, accountStoredContentCompatibility: compat },
                timeout: () => ({ emitWithAck: async (_e: string, p: unknown) => { forwarded.push(p); return { ok: true }; } }),
            });
            const io = createSocketRoomDiscoveryHarness(async room =>
                room === targetDaemon.id || room === `rpc:${fx.owner.id}:${prepareMethod}` ? [targetDaemon] : []);

            const verifyPrepareHttp = (accountId = fx.owner.id) => {
                const proof = signMachineInstallationProof({
                    payload: {
                        version: 1, machineId: fx.source.id, installationId: fx.source.installationId!, accountId,
                        rpcAdmission: { context: fx.sourceContext, method: prepareMethod,
                            workspaceSyncSourceWriterTargetRouting: fx.prepareRouting, callerInputAuthorization: fx.root },
                    },
                    privateKey: fx.sourceKey.secretKey,
                });
                return app.inject({
                    method: 'POST', url: `/v1/machines/${fx.source.id}/admission/verify`,
                    headers: { authorization: 'Bearer authenticated-test', 'x-test-user-id': accountId },
                    payload: { v: 1, context: fx.sourceContext, method: prepareMethod,
                        workspaceSyncSourceWriterTargetRouting: fx.prepareRouting, callerInputAuthorization: fx.root, proof },
                });
            };

            const callPrepareSocket = async (accountId = fx.owner.id, token = fx.ownerToken) => {
                const caller = Object.assign(createAuthenticatedFakeSocket({
                    id: `caller-${randomUUID()}`,
                    data: { clientType: 'machine-scoped', userId: accountId, machineId: fx.source.id,
                        verifiedMachineInstallationId: fx.source.installationId!, authTokenKind: 'account',
                        authAuthority: 'present_user', accountStoredContentCompatibility: compat },
                }), { handshake: { auth: { token } } });
                await registerMachineScopedRpcHandlers({ userId: accountId, socket: caller as unknown as Socket, io });
                const requestId = randomUUID();
                const externalActionExecution = {
                    v: 1 as const, authorization: fx.root, effectActionId: 'session.handoff',
                    target: fx.root.binding.target, installationId: fx.source.installationId!,
                    machineSignature: signExternalActionMachineRpcRequestV1({
                        authorizationToken: fx.root.token, effectActionId: 'session.handoff', target: fx.root.binding.target,
                        installationId: fx.source.installationId!, method: prepareMethod, requestId, params: 'opaque',
                        workspaceSyncSourceWriterTargetRouting: fx.prepareRouting, privateKey: fx.sourceKey.secretKey,
                    }),
                };
                const cb = vi.fn();
                await triggerSocketHandler(caller, SOCKET_RPC_EVENTS.CALL, {
                    method: prepareMethod, requestId, params: 'opaque',
                    externalActionExecution, workspaceSyncSourceWriterTargetRouting: fx.prepareRouting,
                }, cb);
                return cb.mock.calls[0]?.[0];
            };

            // 1. Unowned stranger caller is refused on both HTTP and Socket
            expect((await verifyPrepareHttp(fx.stranger.id)).statusCode).toBe(403);
            expect(await callPrepareSocket(fx.stranger.id, fx.strangerToken)).toMatchObject({ ok: false, errorCode: 'RPC_FORBIDDEN' });

            // 2. Non-null ManagedMachine enrollment MUST still execute canonical hasCurrentMachineWorkspaceSyncStorageInTx
            const staleManaged = await db.managedMachine.create({
                data: {
                    homeId: 'stale-other-home', custodianAccountId: fx.owner.id, enrolledMachineId: fx.target.id,
                    admittedActionRequestId: randomUUID(), admittedInput: {}, launch: {},
                    retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
                },
            });
            const managedCheck = await countQueries(() => verifyPrepareHttp());
            expect(managedCheck.value.statusCode).toBe(403);
            expect(managedCheck.managedMachineQueries.length).toBeGreaterThan(0);
            expect(await callPrepareSocket()).toMatchObject({ ok: false, errorCode: 'RPC_FORBIDDEN' });

            const seedProof = signMachineInstallationProof({
                payload: {
                    version: 1, machineId: fx.target.id, installationId: fx.target.installationId!, accountId: fx.owner.id,
                    rpcAdmission: { context: fx.sourceContext, method: seedMethod,
                        workspaceSyncSeedRouting: fx.seedRouting, callerInputAuthorization: fx.root },
                },
                privateKey: fx.targetKey.secretKey,
            });
            const managedSeedCheck = await countQueries(() => app.inject({
                method: 'POST', url: `/v1/machines/${fx.target.id}/admission/verify`,
                headers: { authorization: 'Bearer authenticated-test', 'x-test-user-id': fx.owner.id },
                payload: { v: 1, context: fx.sourceContext, method: seedMethod,
                    workspaceSyncSeedRouting: fx.seedRouting, callerInputAuthorization: fx.root, proof: seedProof },
            }));
            expect(managedSeedCheck.value.statusCode).toBe(403);
            expect(managedSeedCheck.managedMachineQueries.length).toBeGreaterThan(0);
            await db.managedMachine.delete({ where: { id: staleManaged.id } });

            // 3. Installation rotation immediately refuses both HTTP and Socket
            await db.machine.update({ where: { id: fx.target.id }, data: { installationId: randomUUID() } });
            expect((await verifyPrepareHttp()).statusCode).toBe(403);
            expect(await callPrepareSocket()).toMatchObject({ ok: false, errorCode: 'RPC_FORBIDDEN' });

            // 4. Revocation immediately refuses both HTTP and Socket
            await db.machine.update({
                where: { id: fx.target.id },
                data: { installationId: fx.target.installationId!, revokedAt: new Date() },
            });
            expect((await verifyPrepareHttp()).statusCode).toBe(403);
            expect(await callPrepareSocket()).toMatchObject({ ok: false, errorCode: 'RPC_FORBIDDEN' });
            expect(forwarded).toEqual([]);
        } finally {
            await app.close();
        }
    });

    it('forwardRpcCall skips Machine lookup only when admittedMachineTarget proves encryptionMode and re-verifies DB otherwise', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const machine = await db.machine.create({
            data: {
                id: randomUUID(), accountId: owner.id, active: true, installationId: randomUUID(),
                metadata: encodePlainMachineStoredContent({ host: 'forward-target', platform: 'linux',
                    happyCliVersion: 'test', homeDir: '/home/forward', happyHomeDir: '/home/forward/.happier' }),
                dataEncryptionKey: new Uint8Array(decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64')),
            },
        });
        const method = `${machine.id}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_PREPARE}`;
        const emitWithAck = vi.fn(async () => ({ ok: true }));
        const targetSocket = createAuthenticatedFakeSocket({
            id: 'forward-daemon',
            data: { clientType: 'machine-scoped', userId: owner.id, machineId: machine.id,
                verifiedMachineInstallationId: machine.installationId!, accountStoredContentCompatibility: compat },
            timeout: () => ({ emitWithAck }),
        });
        const callerSocket = createAuthenticatedFakeSocket({
            id: 'forward-caller',
            data: { clientType: 'machine-scoped', accountStoredContentCompatibility: compat },
        });
        const io = createSocketRoomDiscoveryHarness(async room =>
            room === targetSocket.id || room === `rpc:${owner.id}:${method}` ? [targetSocket] : []);

        // 1. Proven encryptionMode on admittedMachineTarget -> 0 Machine DB queries
        const withMode = await countQueries(() => forwardRpcCall({
            io, targetUserId: owner.id, method, callParams: 'opaque',
            callerSocket: callerSocket as unknown as Socket,
            admittedMachineTarget: { machineId: machine.id, custodianAccountId: owner.id,
                installationId: machine.installationId!, encryptionMode: 'plain' },
        }));
        expect(withMode.value).toMatchObject({ ok: true, result: { ok: true } });
        expect(withMode.machineQueries).toEqual([]);
        expect(emitWithAck).toHaveBeenCalledTimes(1);

        // 2. Mismatched installationId still fails closed with 0 emits
        const wrongInstall = await countQueries(() => forwardRpcCall({
            io, targetUserId: owner.id, method, callParams: 'opaque',
            callerSocket: callerSocket as unknown as Socket,
            admittedMachineTarget: { machineId: machine.id, custodianAccountId: owner.id,
                installationId: randomUUID(), encryptionMode: 'plain' },
        }));
        expect(wrongInstall.value).toMatchObject({ ok: false });
        expect(wrongInstall.machineQueries).toEqual([]);
        expect(emitWithAck).toHaveBeenCalledTimes(1);

        // 3. Omitting encryptionMode retains db.machine.findFirst and refuses revoked Machine
        const withoutMode = await countQueries(() => forwardRpcCall({
            io, targetUserId: owner.id, method, callParams: 'opaque',
            callerSocket: callerSocket as unknown as Socket,
            admittedMachineTarget: { machineId: machine.id, custodianAccountId: owner.id,
                installationId: machine.installationId! },
        }));
        expect(withoutMode.value).toMatchObject({ ok: true, result: { ok: true } });
        expect(withoutMode.machineQueries).toEqual([{ action: 'findFirst' }]);
        expect(emitWithAck).toHaveBeenCalledTimes(2);

        await db.machine.update({ where: { id: machine.id }, data: { revokedAt: new Date() } });
        const revokedWithoutMode = await countQueries(() => forwardRpcCall({
            io, targetUserId: owner.id, method, callParams: 'opaque',
            callerSocket: callerSocket as unknown as Socket,
            admittedMachineTarget: { machineId: machine.id, custodianAccountId: owner.id,
                installationId: machine.installationId! },
        }));
        expect(revokedWithoutMode.value).toMatchObject({ ok: false, errorCode: 'target_unavailable' });
        expect(revokedWithoutMode.machineQueries).toEqual([{ action: 'findFirst' }]);
        expect(emitWithAck).toHaveBeenCalledTimes(2);
    });
});
