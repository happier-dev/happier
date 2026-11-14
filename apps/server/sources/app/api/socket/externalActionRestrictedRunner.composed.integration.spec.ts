import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";

import {
    computeRunnerMachineContentKeyFingerprintV1,
    encodeBase64,
    normalizeActionsSettingsV1,
    sealEncryptedDataKeyEnvelopeV1,
    sealRunnerMachineContentKeyVerifierFactV1,
    signAccountContentKeyBindingV1,
    signMachineInstallationProof,
    signRunnerClaimV1,
    signRunnerMachineContentKeyBindingV1,
    wrapApiTokenEncryptionAccessV1,
    type ExternalActionExecutionAuthorizationV1,
    type ExternalActionTargetV1,
} from "@happier-dev/protocol";
import {
    EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1,
} from "@happier-dev/protocol/actions";
import { formatAccountApiTokenCredentialV1 } from "@happier-dev/protocol/auth/accountApiTokens";
import { SOCKET_RPC_EVENTS, type SocketRpcRequestPayload } from "@happier-dev/protocol/socketRpc";
import { io as ioClient } from "socket.io-client";
import tweetnacl from "tweetnacl";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";

import { auth } from "@/app/auth/auth";
import type { Fastify as AppFastify } from "@/app/api/types";
import { enableAuthentication } from "@/app/api/utils/enableAuthentication";
import { getOrCreateServerIdentityId, initializeServerIdentityCache } from "@/app/serverIdentity/serverIdentity";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { createEnvPatcher } from "@/testkit/env";

import { registerExternalActionRoutes } from "../routes/actions/registerExternalActionRoutes";
import { registerAccountEncryptionRoutes } from "../routes/account/registerAccountEncryptionRoutes";
import { registerAccountSettingsRoutes } from "../routes/account/registerAccountSettingsRoutes";
import { registerAccountApiTokenManagementRoutes } from "../routes/auth/registerAccountApiTokenManagementRoutes";
import { registerSessionListingRoutes } from "../routes/session/registerSessionListingRoutes";
import { registerSessionMessageRoutes } from "../routes/session/registerSessionMessageRoutes";
import { sessionPendingRoutes } from "../routes/session/pendingRoutes";
import { machinesRoutes } from "../routes/machines/machinesRoutes";
import { startSocket } from "../socket";
import { preparePlainAccountApiTokenLabel } from "@/testkit/privateLabelFixture";

type TestRpcHandler = (
    input: unknown,
    context?: Readonly<{ signal: AbortSignal; authorization?: unknown }>,
) => unknown | Promise<unknown>;

type TestExecutionAuthorizationInput = Readonly<{
    authorization: ExternalActionExecutionAuthorizationV1;
    effectActionId: string;
    target: ExternalActionTargetV1;
    signal?: AbortSignal;
}>;

type TestSdkClient = Readonly<{
    actions: Readonly<{
        session: Readonly<{
            message: Readonly<{
                send: (
                    input: Readonly<{ sessionId: string; message: string; localId: string }>,
                    options: Readonly<{ target: Readonly<{ kind: "session"; sessionId: string }> }>,
                ) => Promise<unknown>;
            }>;
        }>;
    }>;
    close: () => Promise<void>;
}>;

async function importTestModule<T>(specifier: string): Promise<T> {
    // This composition deliberately exercises current CLI and SDK source from
    // the server harness. Dynamic import keeps server typechecking rooted in
    // this package while Vitest loads the real neighboring implementations.
    return import(specifier) as Promise<T>;
}

function waitForConnection(socket: ReturnType<typeof ioClient>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const cleanup = () => {
            socket.off("connect", onConnect);
            socket.off("connect_error", onConnectError);
        };
        const onConnect = () => {
            cleanup();
            resolve();
        };
        const onConnectError = (error: unknown) => {
            cleanup();
            reject(error);
        };
        socket.on("connect", onConnect);
        socket.on("connect_error", onConnectError);
    });
}

function waitForRpcRegistration(
    socket: ReturnType<typeof ioClient>,
    method: string,
): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const retry = setInterval(() => {
            socket.emit(SOCKET_RPC_EVENTS.REGISTER, { method });
        }, 50);
        const cleanup = () => {
            clearInterval(retry);
            socket.off(SOCKET_RPC_EVENTS.REGISTERED, onRegistered);
            socket.off(SOCKET_RPC_EVENTS.ERROR, onError);
            socket.off("disconnect", onDisconnect);
        };
        const onRegistered = (payload: unknown) => {
            if (
                payload
                && typeof payload === "object"
                && (payload as { method?: unknown }).method === method
            ) {
                cleanup();
                resolve();
            }
        };
        const onError = (payload: unknown) => {
            cleanup();
            reject(new Error(`Restricted Runner RPC registration failed: ${JSON.stringify(payload)}`));
        };
        const onDisconnect = (reason: string) => {
            cleanup();
            reject(new Error(`Restricted Runner RPC socket disconnected before registration: ${reason}`));
        };
        socket.on(SOCKET_RPC_EVENTS.REGISTERED, onRegistered);
        socket.on(SOCKET_RPC_EVENTS.ERROR, onError);
        socket.on("disconnect", onDisconnect);
        socket.emit(SOCKET_RPC_EVENTS.REGISTER, { method });
    });
}

describe("protected SDK Session-targeted transport dispatch to a restricted Runner", () => {
    let harness: LightSqliteHarness | undefined;
    const openedServers: FastifyInstance[] = [];
    const storagePolicyEnv = createEnvPatcher(["HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY"]);

    beforeAll(async () => {
        storagePolicyEnv.set("HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY", "optional");
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-restricted-runner-action-composition-",
            initAuth: true,
            initEncrypt: true,
        });
    }, 120_000);

    afterAll(async () => {
        await Promise.all(openedServers.map(async (server) => await server.close().catch(() => undefined)));
        process.exitCode = 0;
        await harness?.close();
        storagePolicyEnv.restore();
    });

    it("uses the activation-signed Session claim, Session room, and Runner key for protected Action transport without an Account daemon", async () => {
        const serverIdentityId = await getOrCreateServerIdentityId();
        await initializeServerIdentityCache();

        const accountSigning = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(1));
        const accountContent = tweetnacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(2));
        const account = await db.account.create({
            data: {
                publicKey: Buffer.from(accountSigning.publicKey).toString("hex"),
                encryptionMode: "e2ee",
                contentPublicKey: new Uint8Array(accountContent.publicKey),
                contentPublicKeySig: new Uint8Array(signAccountContentKeyBindingV1({
                    accountSigningSecretKey: accountSigning.secretKey,
                    contentPublicKey: accountContent.publicKey,
                })),
            },
            select: { id: true },
        });

        const tokenId = randomUUID();
        const wrappingSecret = new Uint8Array(32).fill(3);
        const contentPublicKey = encodeBase64(accountContent.publicKey);
        const encryptionAccess = wrapApiTokenEncryptionAccessV1({
            context: {
                serverIdentityId,
                accountId: account.id,
                tokenId,
                contentPublicKey,
            },
            wrappingSecret,
            contentPrivateKey: accountContent.secretKey,
            randomBytes: (length) => new Uint8Array(length).fill(4),
        });
        const apiToken = await auth.createApiToken({
            accountId: account.id,
            tokenId,
            label: await preparePlainAccountApiTokenLabel(account.id, "Restricted Runner composition"),
            encryption: { access: encryptionAccess },
        });
        const credential = formatAccountApiTokenCredentialV1({
            bearer: apiToken.token,
            serverIdentityId,
            accountId: account.id,
            contentPublicKey,
            wrappingSecret: encodeBase64(wrappingSecret, "base64url"),
        });

        const machineId = `runner-${randomUUID()}`;
        const sessionId = `session-${randomUUID()}`;
        const activationId = randomUUID();
        const installationId = `installation-${randomUUID()}`;
        const activationSigning = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(5));
        const installationSigning = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(6));
        const runnerContentKey = new Uint8Array(32).fill(7);
        const activationSigningPublicKey = encodeBase64(activationSigning.publicKey, "base64url");
        const installationPublicKey = encodeBase64(installationSigning.publicKey, "base64url");
        const artifact = {
            product: "happier-runner",
            version: "0.3.0",
            target: "linux-x64",
            sha256: "a".repeat(64),
        } as const;
        const activationBinding = {
            activationId,
            homeServerIdentityId: serverIdentityId,
            creatorAccountId: account.id,
            creatorTokenEpoch: 0,
            activationExpiresAt: null,
            workspace: { kind: "choose_on_endpoint" as const },
            sessionId,
            machineId,
            activationSigningPublicKey,
            authoringCommitment: encodeBase64(new Uint8Array(32).fill(8), "base64url"),
            artifact,
            endpointFactsRecipient: { mode: "plain" as const, creatorAccountId: account.id },
        };
        const claim = signRunnerClaimV1({
            activationSecretKey: activationSigning.secretKey,
            payload: {
                v: 1,
                purpose: "happier.ephemeral-session-runner.claim",
                binding: activationBinding,
                runnerBoxPublicKey: encodeBase64(
                    tweetnacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(9)).publicKey,
                    "base64url",
                ),
                installation: {
                    installationId,
                    publicKey: installationPublicKey,
                    proof: signMachineInstallationProof({
                        payload: { version: 1, installationId, machineId, accountId: account.id },
                        privateKey: installationSigning.secretKey,
                    }),
                },
                protocolEpoch: 1,
            },
        });
        const runnerContentKeyBinding = signRunnerMachineContentKeyBindingV1({
            payload: {
                v: 1,
                purpose: "happier.ephemeral-runner.machine-content-key",
                homeServerIdentityId: serverIdentityId,
                activationId,
                creatorAccountId: account.id,
                machineId,
                installationId,
                machineContentKeyFingerprint: computeRunnerMachineContentKeyFingerprintV1(runnerContentKey),
            },
            activationSigningSecretKey: activationSigning.secretKey,
        });
        const runnerVerifierFact = sealRunnerMachineContentKeyVerifierFactV1({
            payload: {
                v: 1,
                activationId,
                machineId,
                activationSigningPublicKey,
            },
            material: { type: "dataKey", machineKey: accountContent.secretKey },
            randomBytes: (length) => new Uint8Array(length).fill(10),
        });
        const runnerDataEncryptionKey = sealEncryptedDataKeyEnvelopeV1({
            dataKey: runnerContentKey,
            recipientPublicKey: accountContent.publicKey,
            randomBytes: (length) => new Uint8Array(length).fill(11),
        });

        await db.machine.create({
            data: {
                id: machineId,
                accountId: account.id,
                metadata: "restricted-runner-metadata",
                kind: "ephemeral_session_runner",
                dataEncryptionKey: new Uint8Array(runnerDataEncryptionKey),
                installationId,
                installationPublicKey: new Uint8Array(installationSigning.publicKey),
                runnerContentKeyBinding: {
                    ...runnerContentKeyBinding,
                    creatorVerifierFactCiphertext: runnerVerifierFact,
                },
                operationProtocolCapabilities: {
                    externalActionExecutionAuthorization: { protocolVersions: [1] },
                    sessionInputAdmission: { protocolVersions: [1, 2] },
                },
                operationProtocolCapabilitiesRevision: 1,
            },
        });
        const session = await db.session.create({
            data: {
                id: sessionId,
                accountId: account.id,
                tag: sessionId,
                metadata: "restricted-runner-session",
                encryptionMode: "plain",
                active: true,
                lastActiveAt: new Date("2026-01-01T00:00:00.000Z"),
                runtimeActivityState: "unknown",
                runtimeActivityActiveCount: 0,
                runtimeActivityRevision: 0n,
            },
            select: { id: true },
        });
        await db.accessKey.create({
            data: { accountId: account.id, machineId, sessionId: session.id, data: "restricted-runner-access" },
        });
        await db.ephemeralRunnerActivation.create({
            data: {
                id: activationId,
                creatorAccountId: account.id,
                creatorTokenEpoch: 0,
                draftId: `draft-${randomUUID()}`,
                sessionId,
                machineId,
                state: "materialized",
                workspacePolicy: "choose_on_endpoint",
                activationExpiresAt: null,
                homeServerIdentityId: serverIdentityId,
                activationSigningPublicKey,
                authoringCommitment: activationBinding.authoringCommitment,
                artifact,
                endpointFactsRecipient: activationBinding.endpointFactsRecipient,
                claim,
            },
        });
        const runnerToken = await auth.createToken(
            account.id,
            {
                ephemeralSessionRunnerPrincipal: {
                    kind: "ephemeral_session_runner",
                    authority: "session_runtime",
                    accountId: account.id,
                    activationId,
                    sessionId,
                    machineId,
                    installationId,
                    installationPublicKey,
                    creatorTokenEpoch: 0,
                },
            },
            { kind: "ephemeral_session_runner", authority: "session_runtime" },
        );

        const home = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
        openedServers.push(home);
        home.setValidatorCompiler(validatorCompiler);
        home.setSerializerCompiler(serializerCompiler);
        const app = home as unknown as AppFastify;
        enableAuthentication(app);
        registerAccountEncryptionRoutes(app);
        registerAccountSettingsRoutes(app);
        registerAccountApiTokenManagementRoutes(app);
        registerSessionListingRoutes(app);
        registerSessionMessageRoutes(app);
        sessionPendingRoutes(app);
        machinesRoutes(app);
        startSocket(app);
        registerExternalActionRoutes(app);
        let actionDispatchHttpRequests = 0;
        app.addHook("onRequest", async (request) => {
            if (request.url === "/v1/actions/session.message.send") actionDispatchHttpRequests += 1;
        });
        const endpoint = await home.listen({ host: "127.0.0.1", port: 0 });

        const { createCliActionExecutorFromCredentials } = await importTestModule<{
            createCliActionExecutorFromCredentials: (options: unknown) => Readonly<{
                execute: (...args: never[]) => Promise<unknown>;
            }>;
        }>("../../../../../cli/src/session/actions/createCliActionExecutorFromCredentials");
        const { registerExternalActionRpcHandler } = await importTestModule<{
            registerExternalActionRpcHandler: (
                registrar: Readonly<{ registerHandler: (method: string, handler: TestRpcHandler) => void }>,
                options: unknown,
            ) => void;
        }>("../../../../../cli/src/rpc/handlers/externalAction");
        const { verifyExternalActionExecutionAuthorizationCurrent } = await importTestModule<{
            verifyExternalActionExecutionAuthorizationCurrent: (
                input: TestExecutionAuthorizationInput & Readonly<{
                    privateKey: Uint8Array;
                    installationId: string;
                    serverHttpBaseUrl: string;
                }>,
            ) => Promise<boolean>;
        }>("../../../../../cli/src/api/externalActionExecutionAuthorization");
        const { connect } = await importTestModule<{
            connect: (options: Readonly<{ endpoint: string; token: string }>) => TestSdkClient;
        }>("../../../../../../packages/sdk/src/connect");

        const canonicalExecutor = createCliActionExecutorFromCredentials({
            credentials: { token: runnerToken, encryption: null },
            serverId: serverIdentityId,
            serverApiUrl: endpoint,
            machineId,
            serverIdentityId,
            externalActionMachineRequestPrivateKey: installationSigning.secretKey,
            externalActionMachineInstallationId: installationId,
            actionsSettingsProvider: {
                getActionsSettings: () => normalizeActionsSettingsV1({ v: 1, actions: {} }),
            },
            pluginActionExecutionOwner: "current_process",
        });
        let executionCount = 0;
        const handlers = new Map<string, TestRpcHandler>();
        registerExternalActionRpcHandler({
            registerHandler: (method, handler) => handlers.set(method, handler),
        }, {
            machineId,
            sessionId,
            currentServerId: serverIdentityId,
            currentServerHttpBaseUrl: endpoint,
            resolveAccountId: async () => account.id,
            resolveInstallationId: () => installationId,
            verifyExecutionAuthorization: (input: TestExecutionAuthorizationInput) =>
                verifyExternalActionExecutionAuthorizationCurrent({
                    ...input,
                    privateKey: installationSigning.secretKey,
                    installationId,
                    serverHttpBaseUrl: endpoint,
                }),
            resolveTarget: async ({ target }: { target?: unknown }) => target ?? null,
            resolveEncryption: async () => ({
                serverIdentityId,
                material: { type: "dataKey" as const, machineKey: runnerContentKey },
            }),
            executor: {
                execute: async (...args: never[]) => {
                    executionCount += 1;
                    return await canonicalExecutor.execute(...args);
                },
            },
            externalActionMachineRequestPrivateKey: installationSigning.secretKey,
        });

        const sessionSocket = ioClient(endpoint, {
            path: "/v1/updates",
            transports: ["websocket"],
            reconnection: false,
            autoConnect: false,
            auth: {
                token: runnerToken,
                clientType: "session-scoped",
                sessionId,
                machineId,
            },
        });
        const daemonSocket = ioClient(endpoint, {
            path: "/v1/updates",
            transports: ["websocket"],
            reconnection: false,
            autoConnect: false,
            auth: {
                token: runnerToken,
                clientType: "machine-scoped",
                machineId,
                runtimeId: activationId,
                startupSource: "ephemeral-runner",
                installationId,
                installationPublicKey,
                installationProof: signMachineInstallationProof({
                    payload: { version: 1, installationId, machineId, accountId: account.id },
                    privateKey: installationSigning.secretKey,
                }),
            },
        });
        daemonSocket.on(SOCKET_RPC_EVENTS.REQUEST, (
            rawRequest: unknown,
            acknowledge: (response: unknown) => void,
        ) => {
            const request = rawRequest as SocketRpcRequestPayload;
            const method = request.method.slice(`${machineId}:`.length);
            const handler = handlers.get(method);
            if (!handler) {
                acknowledge({ error: "method_not_available" });
                return;
            }
            void Promise.resolve(handler(request.params, {
                signal: new AbortController().signal,
                authorization: request.authorization,
            })).then(acknowledge, (error: unknown) => acknowledge({
                error: error instanceof Error ? error.message : String(error),
            }));
        });

        const sessionConnected = waitForConnection(sessionSocket);
        sessionSocket.connect();
        await sessionConnected;
        await expect.poll(async () => {
            sessionSocket.emit("session-alive", { sid: sessionId, time: Date.now() });
            return (await db.session.findUniqueOrThrow({
                where: { id: sessionId },
                select: { publisherGeneration: true },
            })).publisherGeneration;
        }).toBeGreaterThan(0n);

        const connected = waitForConnection(daemonSocket);
        daemonSocket.connect();
        await connected;
        const rpcMethod = `${machineId}:${EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1}`;
        await waitForRpcRegistration(daemonSocket, rpcMethod);

        const client = connect({ endpoint, token: credential });
        try {
            const localId = `runner-message-${randomUUID()}`;
            const result = await client.actions.session.message.send(
                { sessionId, message: "Hello from the restricted Runner composition", localId },
                { target: { kind: "session", sessionId } },
            );
            expect(result).toEqual({ status: "accepted", localId });
            expect(actionDispatchHttpRequests).toBe(1);
            expect(executionCount).toBe(1);
            await expect(db.sessionPendingMessage.findUnique({
                where: { sessionId_localId: { sessionId, localId } },
                select: { localId: true },
            })).resolves.toEqual({ localId });

            // Re-registering on the already admitted production socket must
            // reread the materialized activation binding. A tampered binding
            // therefore cannot keep the previously proven Runner authority.
            // (The currentness owner intentionally rechecks the persisted
            // activation tuple; it does not trust a mutable claim JSON blob.)
            await db.ephemeralRunnerActivation.update({
                where: { id: activationId },
                data: { machineId: `${machineId}-tampered` },
            });
            await expect(waitForRpcRegistration(daemonSocket, rpcMethod)).rejects.toThrow(/Forbidden/u);

        } finally {
            await client.close();
            daemonSocket.close();
            sessionSocket.close();
        }
    }, 120_000);
});
