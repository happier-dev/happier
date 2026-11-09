import { createCipheriv, randomUUID } from 'node:crypto';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import axios from 'axios';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Server } from 'socket.io';
import {
    AccountApiTokensCreateActionOutputV1Schema, API_TOKEN_FULL_GRANT_V1, accountSettingsParse,
    normalizeActionsSettingsV1, describeApprovalRequestFields, resolveApprovalExecutor, decodePlainArtifactStoredContent,
    createActionExecutor, EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER, StrictJsonValueSchema,
    type ActionExecutorDeps, type ActionExecuteResult,
} from '@happier-dev/protocol';
import { createAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { auth } from '@/app/auth/auth';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { accountRoutes } from '../account/accountRoutes';
import { artifactsRoutes } from '../artifacts/artifactsRoutes';
import { registerAccountApiTokenManagementRoutes } from './registerAccountApiTokenManagementRoutes';
import { eventRouter } from '@/app/events/connectionEventRouter';
import { getAccountStoredContentV3SocketRoom } from '@/app/api/socketRooms';
import nacl from 'tweetnacl';
import { registerExternalActionRoutes } from '../actions/registerExternalActionRoutes';
import { registerSessionListingRoutes } from '../session/registerSessionListingRoutes';
import { featuresRoutes } from '../features/featuresRoutes';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { createSessionOwnerMetadataV1, encodeSessionOwnerMetadataEnvelopeV1,
    projectSessionSharedMetadataV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER, signAccountContentKeyBindingV1 } from '@happier-dev/protocol';
import { sealSessionOwnerMetadataEnvelopeV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1';
import type { createDaemonSessionAccountActionExecutor as SessionExecutorFactory } from '../../../../../../cli/src/daemon/agentRuntime/createDaemonSessionAccountActionExecutor';
import type { prepareExternalActionRequesterAccountAuthorization as PrepareSessionAuthorization } from '../../../../../../cli/src/api/externalActionExecutionAuthorization';
import type { verifyExternalActionExecutionAuthorizationCurrent as VerifyHumanAuthorization } from '../../../../../../cli/src/api/externalActionExecutionAuthorization';
import { createSessionRecordFixture } from '../../../../../../cli/src/testkit/backends/sessionFixtures';
import { projectSessionAccessCapabilitiesV1 } from '@happier-dev/protocol';
import type { admitRequesterAccountActionContext as AdmitHuman } from '../../../../../../cli/src/daemon/sessionEncryption/requesterAccountActionProjection';
import type { createApprovedApiTokenExecutionPreparer as CreateTokenPreparer } from '../../../../../../cli/src/daemon/externalActions/prepareApprovedApiTokenExecution';
import { createMachineDataEncryptionKeyV1 } from '@happier-dev/protocol/machines/machineStoredContent';
import { packSessionDataKeyBundleV0, serializeSessionDataKeyValue, SESSION_DATA_KEY_NONCE_BYTES } from '@happier-dev/protocol/crypto/sessionDataKeyBundleV0';
import { SessionStoredMessageContentSchema } from '@happier-dev/protocol/sessions/messages/sessionStoredMessageContent';
import { createSessionMessage } from '@/app/session/sessionWriteService';

async function importCli<T>(specifier: string): Promise<T> {
    // Execute the actual CLI source composition without expanding server TS rootDir.
    return import(specifier) as Promise<T>;
}

describe('API-token requests through CLI wiring, approval and real Account storage', () => {
    let sqlite: LightSqliteHarness;
    beforeAll(async () => {
        sqlite = await createLightSqliteHarness({ tempDirPrefix: 'happier-token-act-', initAuth: true, initEncrypt: true,
            env: { HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' } });
    }, 120_000);
    afterAll(async () => { if (sqlite) await sqlite.close(); });

    it.for(['agent', 'mcp', 'signed-session', 'signed-session-e2ee', 'signed-session-runner', 'signed-session-runner-e2ee', 'signed-session-account-change', 'signed-session-miswired', 'signed-session-detached', 'signed-session-disabled', 'signed-session-delayed', 'signed-session-lost-decision-receipt', 'signed-session-refused-decision-write'] as const)(
        'issues only after present-user approval and returns the secret only to %s', async (origin, { task }) => {
        const signedSession = origin.startsWith('signed-session');
        const surface = signedSession ? 'agent' : origin as 'agent' | 'mcp';
        const accountMode = origin.endsWith('-e2ee') ? 'e2ee' : 'plain';
        const material = { type: 'dataKey' as const, machineKey: nacl.randomBytes(32) };
        const contentKey = nacl.box.keyPair.fromSecretKey(material.machineKey).publicKey;
        const signing = nacl.sign.keyPair();
        const home = createAuthenticatedTestApp({ authentication: 'real' });
        const account = await db.account.create({ data: { encryptionMode: accountMode, settingsVersion: 1,
            ...(accountMode === 'e2ee' ? { publicKey: Buffer.from(signing.publicKey).toString('hex'), contentPublicKey: contentKey,
                contentPublicKeySig: signAccountContentKeyBindingV1({ accountSigningSecretKey: signing.secretKey, contentPublicKey: contentKey }) } : {}) } });
        const credentials = { token: await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' }),
            encryption: accountMode === 'plain' ? null : { ...material, publicKey: contentKey }, credentialProvenance: 'stored_session' as const };
        const humanCredentials = { ...credentials, token: await auth.createToken(account.id, { fixture: 'deciding-human' },
            { kind: 'account', authority: 'present_user' }) };
        expect(humanCredentials.token).not.toBe(credentials.token);
        const cancellation = new AbortController();
        let holdHumanVerification: (() => Promise<void>) | undefined;
        let tokenListProof: Record<string, string> | undefined;
        home.addHook('onRequest', async request => {
            if (request.url === '/v1/actions/approval.request.decide/execution-authorization/verify') await holdHumanVerification?.();
            if (request.url === '/v1/auth/api-tokens/list' && typeof request.headers[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER] === 'string') {
                tokenListProof = {};
                for (const [key, value] of Object.entries(request.headers)) {
                    if (key.startsWith('x-happier-') && typeof value === 'string') tokenListProof[key] = value;
                }
            }
        });
        const nativeMintAttempts: Array<{ status: number; signed: boolean; bearer: boolean; human: boolean; error?: string }> = [];
        let lostDecisionReceipt = false;
        let refusedDecisionWrite = false;
        home.addHook('preHandler', async (request, reply) => {
            // A failed write without a commit must never be treated as consent.
            if (origin !== 'signed-session-refused-decision-write' || refusedDecisionWrite
                || request.method !== 'POST' || !/^\/v1\/artifacts\/[^/]+$/.test(request.url)
                || !request.body || typeof request.body !== 'object'
                || !('body' in request.body) || typeof request.body.body !== 'string') return;
            const body = decodePlainArtifactStoredContent(request.body.body);
            const approval: unknown = body && typeof body === 'object' && 'body' in body && typeof body.body === 'string'
                ? JSON.parse(body.body) : null;
            if (approval && typeof approval === 'object' && 'status' in approval && approval.status === 'approved') {
                refusedDecisionWrite = true;
                return reply.code(500).send({ error: 'Failed to update artifact' });
            }
        });
        home.addHook('onSend', async (request, reply, payload) => {
            // Lose only the HTTP receipt after the real Artifact owner committed
            // approval. The live requester and its execution/custody stay real.
            if (origin === 'signed-session-lost-decision-receipt' && !lostDecisionReceipt
                && request.method === 'POST' && /^\/v1\/artifacts\/[^/]+$/.test(request.url)
                && reply.statusCode === 200 && request.body && typeof request.body === 'object'
                && 'body' in request.body && typeof request.body.body === 'string') {
                const body = decodePlainArtifactStoredContent(request.body.body);
                const approval: unknown = body && typeof body === 'object' && 'body' in body && typeof body.body === 'string'
                    ? JSON.parse(body.body) : null;
                if (approval && typeof approval === 'object' && 'status' in approval && approval.status === 'approved') {
                    lostDecisionReceipt = true;
                    reply.code(500);
                    return JSON.stringify({ error: 'Committed receipt lost' });
                }
            }
            if (request.url === '/v1/auth/api-tokens/create') {
                const body: unknown = typeof payload === 'string' ? JSON.parse(payload) : undefined;
                const error = body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
                    && /^(?:not_authenticated|present_user_required|invalid_token|forbidden)$/.test(body.error) ? body.error : undefined;
                nativeMintAttempts.push({ status: reply.statusCode,
                    signed: typeof request.headers[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER] === 'string',
                    bearer: request.headers.authorization !== undefined,
                    human: request.headers.authorization === `Bearer ${humanCredentials.token}`, ...(error ? { error } : {}) });
            }
            return payload;
        });
        const sockets = new Server(home.server, { path: '/v1/updates' });
        sockets.use((socket, next) => {
            void (async () => {
                const token: unknown = socket.handshake.auth.token;
                const verified = typeof token === 'string' ? await auth.verifyTokenForRoute(token) : null;
                if (verified?.userId !== account.id) return next(new Error('Unauthorized'));
                await socket.join(getAccountStoredContentV3SocketRoom(account.id)); next();
            })().catch(next);
        });
        eventRouter.setIo(sockets);
        // Observe the real network fanout boundary without replacing routing.
        const outboundUpdates = vi.spyOn(eventRouter, 'emitUpdate');
        const outboundBroadcasts = vi.spyOn(eventRouter, 'emitSessionBroadcast');
        const outboundEphemerals = vi.spyOn(eventRouter, 'emitEphemeral');
        let invocation: Promise<ActionExecuteResult> | undefined;
        let nativeToolReceipt: Promise<unknown> | undefined;
        let readPublicApproval: ((artifactId: string) => Promise<unknown>) | undefined;
        let closeNativeTransport: (() => Promise<void>) | undefined;
        let executeSession: ReturnType<typeof SessionExecutorFactory> | undefined;
        let humanContext: Awaited<ReturnType<typeof AdmitHuman>> | undefined;
        try {
            accountRoutes(home); artifactsRoutes(home); registerAccountApiTokenManagementRoutes(home);
            const machineId = randomUUID();
            const installationId = randomUUID();
            const installation = nacl.sign.keyPair();
            const homeId = await getOrCreateServerIdentityId();
            const machineMetadata = { host: 'token-host', platform: 'linux', happyCliVersion: 'test' };
            const machineContent = accountMode === 'e2ee' ? (() => {
                const keyed = createMachineDataEncryptionKeyV1({ material, dataKeyPublicKey: contentKey, randomBytes: nacl.randomBytes });
                const nonce = nacl.randomBytes(SESSION_DATA_KEY_NONCE_BYTES);
                const cipher = createCipheriv('aes-256-gcm', keyed.encryptionKey, nonce);
                const ciphertext = Buffer.concat([cipher.update(serializeSessionDataKeyValue(machineMetadata)), cipher.final()]);
                return { metadata: Buffer.from(packSessionDataKeyBundleV0({ nonce, ciphertext, authTag: cipher.getAuthTag() })).toString('base64'),
                    dataEncryptionKey: keyed.dataEncryptionKey };
            })() : { metadata: encodePlainMachineStoredContent(machineMetadata),
                dataEncryptionKey: Buffer.from(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64') };
            await db.machine.create({ data: { id: machineId, accountId: account.id, installationId,
                installationPublicKey: installation.publicKey, active: true, lastActiveAt: new Date(),
                ...machineContent } });
            const callerPermissionMode = origin === 'signed-session-account-change' ? 'read-only' as const : 'default' as const;
            const causalPermissionAuthority = origin === 'signed-session-account-change'
                ? { kind: 'admittedSessionInputV1' as const, admittedPermissionCeiling: callerPermissionMode } : undefined;
            const metadata = { machineId, path: '/workspace', host: 'token-host', homeDir: '/home/token-host', permissionMode: callerPermissionMode };
            const owner = createSessionOwnerMetadataV1({ metadata });
            if (!owner.ok) throw new Error('Session owner metadata refused');
            const ownerMetadata = accountMode === 'plain' ? { t: 'plain' as const, v: owner.ownerMetadata }
                : sealSessionOwnerMetadataEnvelopeV1({ material, ownerMetadata: owner.ownerMetadata, randomBytes: nacl.randomBytes });
            const session = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), encryptionMode: 'plain',
                metadataLayoutVersion: 1, metadata: JSON.stringify(projectSessionSharedMetadataV1({ metadata })),
                ownerMetadata: encodeSessionOwnerMetadataEnvelopeV1(ownerMetadata),
                active: true, lastActiveAt: new Date() } });
            await db.accessKey.create({ data: { accountId: account.id, machineId, sessionId: session.id, data: 'opaque' } });
            // Session process liveness is the OS boundary; Home still verifies
            // real ownership, installation proof, signed root and native effect.
            home.decorate('resolveCurrentSessionMachine', async ({ accountId, sessionId }: { accountId: string; sessionId: string }) =>
                accountId === account.id && sessionId === session.id ? machineId : null);
            registerSessionListingRoutes(home); featuresRoutes(home);
            registerExternalActionRoutes(home);
            const url = await home.listen({ port: 0, host: '127.0.0.1' });
            // The Session-listing lane currently selects a removed Prisma field.
            // Substitute only that unrelated HTTP read; signed root issuance,
            // Artifact CAS, approval continuation and token HTTP remain real.
            const get = axios.get.bind(axios);
            if (signedSession) vi.spyOn(axios, 'get').mockImplementation(async (endpoint, config) => {
                if (String(endpoint) === `${url}/v2/sessions/${session.id}`) return { status: 200, data: {
                    session: createSessionRecordFixture({ id: session.id, encryptionMode: 'plain', metadataLayoutVersion: 1,
                        metadata: session.metadata, ownerMetadata, share: null, effectiveAccess: { v: 1, level: 'owner',
                            sources: [{ kind: 'owner' }], capabilities: projectSessionAccessCapabilitiesV1({ owner: true, grants: [] }) } }),
                } };
                return get(endpoint, config);
            });
            sqlite.resetEnv({ HAPPIER_HOME_DIR: `${sqlite.baseDir}/cli-${origin}`, HAPPIER_SERVER_URL: url, HAPPIER_WEBAPP_URL: url });
            const cliConfiguration = await importCli<{ reloadConfiguration: () => void; configuration: { activeServerId: string; happyHomeDir: string; installationIdentityFile: string } }>('../../../../../../cli/src/configuration');
            cliConfiguration.reloadConfiguration();
            const { configuration } = cliConfiguration;
            const installedCurrentness = origin === 'signed-session-delayed' || origin === 'signed-session-account-change';
            if (installedCurrentness) {
                const fixtureHome = join(sqlite.baseDir, `cli-${origin}`);
                if (await realpath(sqlite.baseDir) !== sqlite.baseDir
                    || !basename(sqlite.baseDir).startsWith('happier-token-act-')
                    || dirname(configuration.installationIdentityFile) !== fixtureHome)
                    throw new Error('Fixture installation identity escaped its disposable Home');
                // The installed Machine identity is an OS boundary. Only this
                // disposable Home may hold its fixture, and it may never replace
                // an existing identity even if fixture setup is accidentally repeated.
                await mkdir(dirname(configuration.installationIdentityFile), { recursive: true });
                if (await realpath(dirname(configuration.installationIdentityFile)) !== fixtureHome)
                    throw new Error('Fixture installation Home is not its canonical disposable directory');
                await writeFile(configuration.installationIdentityFile, JSON.stringify({ version: 1, installationId,
                    createdAt: Date.now(), publicKey: Buffer.from(installation.publicKey).toString('base64url'),
                    privateKey: Buffer.from(installation.secretKey).toString('base64url') }), { mode: 0o600, flag: 'wx' });
            }
            const { bootstrapAccountSettingsContext, resetInMemoryAccountSettingsContextForTests } = await importCli<{
                bootstrapAccountSettingsContext: (input: unknown) => Promise<unknown>;
                resetInMemoryAccountSettingsContextForTests: () => void;
            }>('../../../../../../cli/src/settings/accountSettings/bootstrapAccountSettingsContext');
            resetInMemoryAccountSettingsContextForTests();
            await bootstrapAccountSettingsContext({ credentials, mode: 'blocking', refresh: 'force' });
            const { createCliActionExecutorFromCredentials } = await importCli<{
                createCliActionExecutorFromCredentials: (params: unknown) => ReturnType<typeof createActionExecutor>;
            }>('../../../../../../cli/src/session/actions/createCliActionExecutorFromCredentials');
            const { createCliApprovalsArtifactStore } = await importCli<{
                createCliApprovalsArtifactStore: (params: unknown) => Pick<ActionExecutorDeps, 'approvalsGet' | 'approvalsUpdate' | 'approvalsList'>;
            }>('../../../../../../cli/src/session/actions/approvals/artifactStore');
            let policy = normalizeActionsSettingsV1({ v: 1 });
            const params = { credentials, serverId: configuration.activeServerId, serverApiUrl: url, readCredentials: async () => credentials,
                actionsSettingsProvider: { getActionsSettings: () => policy, getAccountSettings: () => accountSettingsParse({}) } };
            const { createDaemonApprovalExecutionOriginCurrentnessFromCredentials } = await importCli<
                typeof import('../../../../../../cli/src/daemon/externalActions/daemonExternalActionTargetResolver')>(
                '../../../../../../cli/src/daemon/externalActions/daemonExternalActionTargetResolver');
            const isApprovalExecutionOriginCurrent = installedCurrentness
                ? createDaemonApprovalExecutionOriginCurrentnessFromCredentials({ credentials, machineId,
                    serverId: configuration.activeServerId, serverApiUrl: url,
                    resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: homeId, machineId }),
                    isSessionCallerCurrent: async () => !cancellation.signal.aborted })
                : async () => true;
            if (!isApprovalExecutionOriginCurrent) throw new Error('Installed approval currentness unavailable');
            const executor = createCliActionExecutorFromCredentials({ ...params, machineId,
                serverIdentityId: homeId, externalActionMachineInstallationId: installationId,
                externalActionMachineRequestPrivateKey: installation.secretKey,
                // Current host identity is the OS/runtime boundary. HTTP, Artifact
                // CAS, policy, codecs and token authentication remain real.
                isApprovalExecutionOriginCurrent,
            });
            const deps = createCliApprovalsArtifactStore({ credentials, serverId: configuration.activeServerId });
            const tokenId = randomUUID();
            const input = { tokenId, label: `Approved ${surface}`,
                ...(origin === 'signed-session-delayed' ? { expiresAt: '2030-10-17T20:00:00Z' } : {}),
                grant: { ...API_TOKEN_FULL_GRANT_V1,
                actions: { ids: ['workflow.trigger.run_now'], families: [] },
                automationIds: ['16cce218-b735-46cd-a68a-303c84743527'] } };
            const context = { surface, authority: 'account_automation' as const, serverId: configuration.activeServerId, runtimeAccountId: account.id, defaultSessionMachineId: 'token-machine',
                actionRequestId: randomUUID(), actionCaller: { kind: 'host' as const }, signal: cancellation.signal };
            // A caller cannot turn a request into human authority or bypass policy.
            expect(await executor.execute('account.apiTokens.create', input, { ...context, bypassApprovals: true }))
                .toMatchObject({ ok: false, errorCode: 'present_user_required' });
            if (signedSession) {
                const { createDaemonSessionAccountActionExecutor } = await importCli<{
                    createDaemonSessionAccountActionExecutor: typeof SessionExecutorFactory;
                }>('../../../../../../cli/src/daemon/agentRuntime/createDaemonSessionAccountActionExecutor');
                const { prepareExternalActionRequesterAccountAuthorization } = await importCli<{
                    prepareExternalActionRequesterAccountAuthorization: typeof PrepareSessionAuthorization;
                }>('../../../../../../cli/src/api/externalActionExecutionAuthorization');
                executeSession = createDaemonSessionAccountActionExecutor({ serverId: configuration.activeServerId,
                    serverHttpBaseUrl: url, token: credentials.token, credentials, machineId,
                    createExecutor: () => executor,
                    prepareExternalActionAuthorization: async args => {
                        const target = { kind: 'machine' as const, machineId };
                        const authorization = await prepareExternalActionRequesterAccountAuthorization({
                            actionId: args.operation.actionId, input: args.operation.input, requestId: args.operation.requestId,
                            target, machineId, sourceMachineId: machineId, accountId: account.id, accountEncryptionMode: accountMode,
                            ...(accountMode === 'e2ee' ? { material } : {}),
                            tokenEpochHint: account.tokenEpoch, token: credentials.token, serverId: configuration.activeServerId,
                            serverIdentityId: homeId, serverHttpBaseUrl: url, installationId, privateKey: installation.secretKey,
                            sessionActionOrigin: args.sessionActionOrigin, isCurrent: args.isCallerCurrent,
                            signal: args.authority.signal });
                        return authorization ? { authorization, target } : null;
                    } });
                const invokeSession = (actionId: Parameters<typeof executeSession>[0]['actionId'], toolInput: unknown) => executeSession!({ kind: 'action.execute', requestId: context.actionRequestId, actionId,
                    input: toolInput, toolCallId: 'native-token-call', witness: { turnId: 'token-turn', inputId: 'token-input',
                        userMessageSeq: 1, userMessageSeqs: [1], workDepth: 0, callerPermissionMode,
                        ...(causalPermissionAuthority ? { causalPermissionAuthority } : {}),
                        agentStartCaller: { kind: 'session', sessionId: session.id, starterDepth: 0, turnDepth: 0 } } },
                    { sessionId: session.id, isCurrent: async () => true, signal: cancellation.signal });
                if (origin === 'signed-session-runner' || origin === 'signed-session-runner-e2ee' || origin === 'signed-session-account-change'
                    || origin === 'signed-session-miswired') {
                    if (configuration.happyHomeDir !== join(sqlite.baseDir, `cli-${origin}`)
                        || !basename(sqlite.baseDir).startsWith('happier-token-act-'))
                        throw new Error('Runner authority fixture escaped its disposable Home');
                    const { createSessionDaemonAuthorityFixture } = await importCli<
                        typeof import('../../../../../../cli/src/mcp/runtime/sessionDaemonAuthority.testkit')>(
                        '../../../../../../cli/src/mcp/runtime/sessionDaemonAuthority.testkit');
                    const { createHappierMcpServer } = await importCli<
                        typeof import('../../../../../../cli/src/mcp/createHappierMcpServer')>(
                        '../../../../../../cli/src/mcp/createHappierMcpServer');
                    const { RpcHandlerManager } = await importCli<
                        typeof import('../../../../../../cli/src/api/rpc/RpcHandlerManager')>(
                        '../../../../../../cli/src/api/rpc/RpcHandlerManager');
                    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
                    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
                    const { callMcpToolWithResolvedTimeout } = await importCli<
                        typeof import('../../../../../../cli/src/mcp/mcpToolCallRequestOptions')>(
                        '../../../../../../cli/src/mcp/mcpToolCallRequestOptions');
                    const daemonControl = await importCli<typeof import('../../../../../../cli/src/daemon/controlClient')>(
                        '../../../../../../cli/src/daemon/controlClient');
                    const discoveryExecutor = createCliActionExecutorFromCredentials({ ...params,
                        pluginActionExecutionOwner: 'current_process' });
                    // Daemon-control IPC is a separate OS boundary from the
                    // Session-services TCP fixture below. Keep its real catalog
                    // executor, just as the canonical MCP host tests do.
                    vi.spyOn(daemonControl, 'requestDaemonPluginActionExecution').mockImplementation(async request => {
                        if (request.actionId !== 'action.spec.get') throw new Error('Unexpected daemon catalog request');
                        const result = await discoveryExecutor.execute('action.spec.get', request.input, {
                            surface: request.surface, authority: 'account_automation', actionCaller: { kind: 'host' },
                            ...(request.defaultSessionId ? { defaultSessionId: request.defaultSessionId } : {}),
                        });
                        return { matched: true, result: result.ok
                            ? { ok: true, result: StrictJsonValueSchema.parse(result.result) }
                            : { ok: false, errorCode: result.errorCode, error: result.error } };
                    });
                    let requested: Promise<ActionExecuteResult> | undefined;
                    const daemon = await createSessionDaemonAuthorityFixture({ sessionId: session.id, execute: operation => {
                        const executing = executeSession!(operation, { sessionId: session.id, isCurrent: async () => true,
                            signal: cancellation.signal });
                        if (operation.actionId === 'account.apiTokens.create') requested = executing;
                        return executing;
                    } });
                    const witness = { turnId: 'token-turn', inputId: 'token-input', userMessageSeq: 1, userMessageSeqs: [1],
                        agentStartCaller: { kind: 'session' as const, sessionId: session.id, starterDepth: 0, turnDepth: 0 },
                        callerPermissionMode, ...(causalPermissionAuthority ? { causalPermissionAuthority } : {}) };
                    const runtime = createHappierMcpServer({ sessionId: session.id, updateMetadata() {},
                        rpcHandlerManager: new RpcHandlerManager({ scopePrefix: session.id, encryptionMode: 'plain' }),
                        getServerBinding: () => ({ serverId: configuration.activeServerId, serverUrl: url }),
                        getMetadataSnapshot: () => ({ ...metadata, machineId }),
                        getActiveTurnAdmissionWitness: () => witness,
                        getActiveTurnPermissionWitness: () => ({ turnId: witness.turnId }),
                        getWorkDepth: () => 0, getHostTurnWorkDepth: () => 0,
                        getStoredContentEncryptionContext: () => ({ mode: 'plain' }),
                    }, { authorityScope: 'session', credentials: null,
                        sessionCredentials: { token: 'restricted-runner-session-bearer', encryption: null },
                        accountSettings: accountSettingsParse({}) });
                    const nativeClient = new Client({ name: 'runner-token-requester', version: '1' });
                    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
                    closeNativeTransport = async () => {
                        try { await nativeClient.close(); await runtime.mcp.close(); }
                        finally { await daemon.close(); }
                    };
                    await runtime.mcp.connect(serverTransport); await nativeClient.connect(clientTransport);
                    const tools = (await nativeClient.listTools()).tools.map(tool => tool.name);
                    expect(tools).toEqual(expect.arrayContaining(['action_spec_get', 'action_execute']));
                    // Account writes use discovery by default on the Agent surface.
                    // An absent dedicated tool must not be mistaken for a denied Action.
                    expect(tools).not.toContain('account_api_tokens_create');
                    const specReceipt = await callMcpToolWithResolvedTimeout({ client: nativeClient,
                        toolName: 'action_spec_get', args: { id: 'account.apiTokens.create' },
                        signal: cancellation.signal });
                    const specText = specReceipt.content.find(block => block.type === 'text');
                    if (specText?.type !== 'text') throw new Error('Token Action discovery unavailable');
                    const discovered: unknown = JSON.parse(specText.text);
                    const discoveryError = discovered && typeof discovered === 'object' && 'errorCode' in discovered
                        && typeof discovered.errorCode === 'string' ? discovered.errorCode : undefined;
                    expect(specReceipt.isError, discoveryError).not.toBe(true);
                    expect(discovered).toMatchObject({ actionSpec: { id: 'account.apiTokens.create',
                        surfaces: { agent: true, mcp: true }, approval: { flow: 'blocking', result: 'required' } } });
                    const encryptionRefusal = await callMcpToolWithResolvedTimeout({ client: nativeClient,
                        toolName: 'action_execute', args: { actionId: 'account.apiTokens.create', input: {
                            ...input, tokenId: randomUUID(), encryption: { access: { v: 1, serverIdentityId: homeId,
                                contentPublicKey: 'A'.repeat(43) + '=', wrappedContentPrivateKey: 'B'.repeat(96) } },
                        } }, signal: cancellation.signal });
                    expect(encryptionRefusal.isError).toBe(true);
                    const refusalText = encryptionRefusal.content.find(block => block.type === 'text');
                    if (refusalText?.type !== 'text') throw new Error('Token encryption refusal unavailable');
                    expect(JSON.parse(refusalText.text)).toMatchObject({ errorCode: 'api_token_encryption_not_ready' });
                    expect((await deps.approvalsList!({ limit: 20 })).items).toEqual([]);
                    expect(nativeMintAttempts).toEqual([]);
                    expect(await db.accountApiToken.count({ where: { accountId: account.id } })).toBe(0);
                    readPublicApproval = artifactId => callMcpToolWithResolvedTimeout({ client: nativeClient,
                        toolName: 'action_execute', args: { actionId: 'approval.request.get', input: { artifactId } },
                        signal: cancellation.signal });
                    nativeToolReceipt = callMcpToolWithResolvedTimeout({ client: nativeClient,
                        toolName: 'action_execute', args: { actionId: 'account.apiTokens.create', input },
                        signal: cancellation.signal });
                    invocation = nativeToolReceipt.then(async () => {
                        if (!requested) throw new Error('Runner MCP request did not reach daemon execution');
                        return await requested;
                    });
                } else if (origin === 'signed-session' || origin === 'signed-session-e2ee' || origin === 'signed-session-delayed'
                    || origin === 'signed-session-lost-decision-receipt' || origin === 'signed-session-refused-decision-write') {
                    const { createActionToolExecutorBridge } = await importCli<typeof import('../../../../../../cli/src/agent/tools/happierTools/createActionToolExecutorBridge')>(
                        '../../../../../../cli/src/agent/tools/happierTools/createActionToolExecutorBridge');
                    const { registerHappierMcpBuiltInTools, prepareHappierMcpToolInventory } = await importCli<typeof import('../../../../../../cli/src/mcp/server/registerHappierMcpBuiltInTools')>(
                        '../../../../../../cli/src/mcp/server/registerHappierMcpBuiltInTools');
                    const { createHappierToolInventory } = await importCli<typeof import('../../../../../../cli/src/agent/tools/happierTools/listBuiltInHappierTools')>(
                        '../../../../../../cli/src/agent/tools/happierTools/listBuiltInHappierTools');
                    const inventory = createHappierToolInventory({ surface: 'agent', actionsSettings: policy });
                    let requested: Promise<ActionExecuteResult> | undefined;
                    const bridge = createActionToolExecutorBridge({ surface: 'agent', getActionsSettings: () => policy,
                        executor: { execute: (actionId, toolInput) => {
                            requested = invokeSession(actionId, toolInput); return requested;
                        } } });
                    const handlers = new Map<string, (args: unknown, extra?: unknown) => Promise<unknown>>();
                    const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
                    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
                    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
                    const { CallToolResultSchema } = await import('@modelcontextprotocol/sdk/types.js');
                    const nativeServer = origin === 'signed-session-delayed'
                        ? new McpServer({ name: 'delayed-token-approval', version: '1' }) : null;
                    registerHappierMcpBuiltInTools({ registerTool: (name, meta, handler) => {
                        handlers.set(name, handler);
                        nativeServer?.registerTool(name, meta as Parameters<typeof nativeServer.registerTool>[1],
                            async (args, extra) => CallToolResultSchema.parse(await handler(args, extra)));
                    } }, {
                        surface: 'agent', sessionId: session.id, sessionMachineId: machineId, getActionsSettings: () => policy,
                        toolInventory: prepareHappierMcpToolInventory({ sessionId: session.id, inventory: {
                            ...inventory, tools: inventory.tools.filter(tool => tool.name === 'action_execute'),
                        } }),
                        deps: { ...bridge, changeTitle: async () => { throw new Error('Not requested'); } },
                    });
                    const handler = handlers.get('action_execute');
                    if (!handler) throw new Error('Real Action tool registration missing');
                    if (nativeServer) {
                        const nativeClient = new Client({ name: 'native-token-requester', version: '1' });
                        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
                        await nativeServer.connect(serverTransport); await nativeClient.connect(clientTransport);
                        closeNativeTransport = async () => { await nativeClient.close(); await nativeServer.close(); };
                        const { callMcpToolWithResolvedTimeout } = await importCli<
                            typeof import('../../../../../../cli/src/mcp/mcpToolCallRequestOptions')>(
                            '../../../../../../cli/src/mcp/mcpToolCallRequestOptions');
                        nativeToolReceipt = callMcpToolWithResolvedTimeout({ client: nativeClient,
                            toolName: 'action_execute', args: { actionId: 'account.apiTokens.create', input },
                            signal: cancellation.signal });
                    } else nativeToolReceipt = handler({ actionId: 'account.apiTokens.create', input }, {
                            requestId: 'native-token-call', signal: cancellation.signal,
                        });
                    invocation = nativeToolReceipt.then(async () => {
                        if (!requested) throw new Error('Registered tool did not reach signed Session execution');
                        return await requested;
                    });
                } else invocation = invokeSession('account.apiTokens.create', input);
            } else invocation = executor.execute('account.apiTokens.create', input, context);
            let earlyResult: ActionExecuteResult | undefined;
            void invocation.then(result => { earlyResult = result; });
            // Observe the real approval store instead of replacing its create/get owners.
            // Creation crosses HTTP; wait for that asynchronous boundary using the test runner.
            let artifactId = '';
            await vi.waitFor(async () => {
                if (earlyResult && !earlyResult.ok) {
                    const reason = earlyResult.details && typeof earlyResult.details === 'object'
                        && 'reason' in earlyResult.details && typeof earlyResult.details.reason === 'string'
                        && /^[a-z_]+$/.test(earlyResult.details.reason) ? earlyResult.details.reason : 'unavailable';
                    throw new Error(`request_stopped_before_approval:${earlyResult.errorCode}:${reason}`);
                }
                const result = await deps.approvalsList!({ limit: 20 });
                const item = result.items.find(item => item.actionId === 'account.apiTokens.create');
                expect(item).toBeDefined();
                artifactId = item!.artifactId;
            }, { timeout: task.timeout });
            expect(await db.accountApiToken.count({ where: { accountId: account.id } })).toBe(0);
            if (origin === 'signed-session-account-change') {
                // Unrelated Account activity while a person considers the Ask
                // cannot revoke the unchanged invocation or its encryption custody.
                await db.account.update({ where: { id: account.id }, data: { seq: { increment: 1 }, settingsVersion: { increment: 1 } } });
            }
            const pending = await deps.approvalsGet!({ artifactId });
            expect(pending).not.toBeNull();
            if (readPublicApproval && pending?.v === 2) {
                const observed = await readPublicApproval(artifactId);
                expect(observed).toMatchObject({ isError: false });
                const serialized = JSON.stringify(observed);
                expect(serialized.includes('externalActionExecutionAuthorization')).toBe(false);
                expect(serialized.includes('externalActionInputSignature')).toBe(false);
                expect(serialized.includes('originalActionEnvelope')).toBe(false);
                const authorization = pending.executionOriginV1.externalActionExecutionAuthorization;
                if (!authorization) throw new Error('Private approval authorization unavailable');
                expect(serialized.includes(authorization.token)).toBe(false);
                const { handleActionsCommand } = await importCli<{
                    handleActionsCommand: typeof import('../../../../../../cli/src/cli/commands/actions')['handleActionsCommand'];
                }>('../../../../../../cli/src/cli/commands/actions');
                const { captureConsoleJsonOutput } = await importCli<
                    typeof import('../../../../../../cli/src/testkit/logger/captureOutput')>(
                    '../../../../../../cli/src/testkit/logger/captureOutput');
                const output = captureConsoleJsonOutput<unknown>();
                try {
                    await handleActionsCommand(['invoke', 'approval.request.get', '--input-json', JSON.stringify({ artifactId }), '--json'], {
                        readCredentialsFn: async () => credentials, createExecutorFn: () => executor,
                    }, cancellation.signal);
                    const receipt = output.json();
                    expect(Boolean(receipt && typeof receipt === 'object' && 'v' in receipt && receipt.v === 1
                        && 'ok' in receipt && receipt.ok === true)).toBe(true);
                    const cliSerialized = JSON.stringify(receipt);
                    expect(cliSerialized.includes(authorization.token)).toBe(false);
                    expect(cliSerialized.includes('externalActionExecutionAuthorization')).toBe(false);
                    expect(cliSerialized.includes('externalActionInputSignature')).toBe(false);
                    expect(cliSerialized.includes('originalActionEnvelope')).toBe(false);
                } finally { output.restore(); process.exitCode = undefined; }
                // Observation must not destroy the original requester's replay custody.
                expect((await deps.approvalsGet!({ artifactId }))?.status).toBe('open');
            }
            if (origin === 'signed-session-delayed') {
                const { verifyExternalActionApprovalInputV1 } = await import('@happier-dev/protocol/actions/externalActionExecutionAuthorization');
                if (!pending || pending.v !== 2) throw new Error('Native approval origin unavailable');
                const captured = pending.executionOriginV1;
                if (!captured.externalActionExecutionAuthorization || !captured.externalActionInputSignature || !captured.target)
                    throw new Error('Native approval signature unavailable');
                expect(verifyExternalActionApprovalInputV1({
                    authorizationToken: captured.externalActionExecutionAuthorization.token,
                    actionId: pending.actionId, input: pending.actionArgs, target: captured.target,
                    signature: captured.externalActionInputSignature, publicKey: installation.publicKey,
                }), 'Native approval signature matches persisted input').toBe(true);
                // LIVE-9's token approval waited 126.812 seconds. Keep the
                // actual MCP request pending beyond that observation, using the
                // real host timeout configuration rather than a clock-only jump.
                await new Promise<void>(resolve => setTimeout(resolve, 126_813));
                expect(Date.now() - pending.createdAtMs).toBeGreaterThan(126_812);
            }
            expect(resolveApprovalExecutor(pending!)).toEqual({ kind: 'live_invocation' });
            expect(JSON.stringify(describeApprovalRequestFields(pending!))).toContain(input.grant.automationIds[0]);
            let replayExecutor = executor;
            let humanTokenActions: Pick<ActionExecutorDeps, 'accountApiTokensCreateAction' | 'accountApiTokensRevokeAction' | 'accountApiTokensRevokeAllAction'> | undefined;
            if (signedSession) {
                const { prepareExternalActionRequesterAccountAuthorization } = await importCli<{
                    prepareExternalActionRequesterAccountAuthorization: typeof PrepareSessionAuthorization;
                }>('../../../../../../cli/src/api/externalActionExecutionAuthorization');
                const { admitRequesterAccountActionContext } = await importCli<{ admitRequesterAccountActionContext: typeof AdmitHuman }>(
                    '../../../../../../cli/src/daemon/sessionEncryption/requesterAccountActionProjection');
                const { verifyExternalActionExecutionAuthorizationCurrent } = await importCli<{
                    verifyExternalActionExecutionAuthorizationCurrent: typeof VerifyHumanAuthorization;
                }>('../../../../../../cli/src/api/externalActionExecutionAuthorization');
                const { createApprovedApiTokenExecutionPreparer } = await importCli<{ createApprovedApiTokenExecutionPreparer: typeof CreateTokenPreparer }>(
                    '../../../../../../cli/src/daemon/externalActions/prepareApprovedApiTokenExecution');
                const humanRoot = await prepareExternalActionRequesterAccountAuthorization({ actionId: 'approval.request.decide',
                    input: { artifactId, decision: 'approve' }, requestId: randomUUID(), target: { kind: 'machine', machineId },
                    machineId, accountId: account.id, accountEncryptionMode: accountMode, tokenEpochHint: account.tokenEpoch,
                    ...(accountMode === 'e2ee' ? { material } : {}),
                    token: humanCredentials.token, serverId: configuration.activeServerId, serverIdentityId: homeId,
                    serverHttpBaseUrl: url, installationId, privateKey: installation.secretKey });
                if (!humanRoot) throw new Error('Human signed root unavailable');
                humanContext = await admitRequesterAccountActionContext({ authorization: humanRoot, credentials: humanCredentials,
                    serverId: configuration.activeServerId, serverIdentityId: homeId, serverHttpBaseUrl: url,
                    isCurrent: () => verifyExternalActionExecutionAuthorizationCurrent({ authorization: humanRoot,
                        effectActionId: 'approval.request.decide', target: { kind: 'machine', machineId },
                        installationId, privateKey: installation.secretKey, serverHttpBaseUrl: url }) });
                if (!humanContext) throw new Error('Human Account custody unavailable');
                const { createAccountServerActionDeps } = await importCli<{
                    createAccountServerActionDeps: (params: unknown) => Pick<ActionExecutorDeps, 'accountApiTokensCreateAction' | 'accountApiTokensRevokeAction' | 'accountApiTokensRevokeAllAction'>;
                }>('../../../../../../cli/src/api/accountServerActionDeps');
                humanTokenActions = createAccountServerActionDeps({ credentials: humanCredentials, token: humanCredentials.token,
                    serverId: configuration.activeServerId, serverHttpBaseUrl: url, serverIdentityId: homeId });
                const nativeTokenCreate = humanTokenActions.accountApiTokensCreateAction!;
                const prepare = createApprovedApiTokenExecutionPreparer({ requester: humanContext,
                    artifactId: origin === 'signed-session-miswired' ? randomUUID() : artifactId,
                    authority: 'present_user', signal: cancellation.signal,
                    execute: nativeTokenCreate });
                // These are real admitted custody and the real prepared
                // continuation. Altered input and aborted custody must refuse
                // before any native token HTTP request.
                if (origin === 'signed-session') {
                    const approved = { ...pending!, status: 'approved' as const,
                        decision: { kind: 'approve' as const, decidedAtMs: Date.now() } };
                    const changed = await prepare({ artifactId, request: approved });
                    expect(changed).not.toBeNull();
                    expect(await changed!.execute({ ...input, label: 'Unreviewed label' })).toMatchObject({ ok: false, errorCode: 'approval_stale' });
                    await changed!.dispose(); await changed!.settled;
                    const abort = new AbortController();
                    const prepareAborted = createApprovedApiTokenExecutionPreparer({ requester: humanContext, artifactId,
                        authority: 'present_user', signal: abort.signal,
                        execute: nativeTokenCreate });
                    const abandoned = await prepareAborted({ artifactId, request: approved });
                    expect(abandoned).not.toBeNull(); abort.abort();
                    await abandoned!.settled;
                    expect(await abandoned!.execute(input)).toMatchObject({ ok: false, errorCode: 'approval_stale' });
                    expect(await createApprovedApiTokenExecutionPreparer({ requester: humanContext, artifactId,
                        authority: 'account_automation', execute: nativeTokenCreate })(
                        { artifactId, request: approved })).toBeNull();
                    expect(await prepare({ artifactId, request: { ...approved, decision: {
                        kind: 'reject', decidedAtMs: Date.now() } } })).toBeNull();
                    const requesterRoot = pending!.v === 2 ? pending!.executionOriginV1.externalActionExecutionAuthorization : undefined;
                    if (!requesterRoot) throw new Error('Signed Session root missing');
                    const requesterContext = await admitRequesterAccountActionContext({ authorization: requesterRoot, credentials,
                        serverId: configuration.activeServerId, serverIdentityId: homeId, serverHttpBaseUrl: url,
                        isCurrent: () => verifyExternalActionExecutionAuthorizationCurrent({ authorization: requesterRoot,
                            effectActionId: 'account.apiTokens.create', target: { kind: 'machine', machineId },
                            installationId, privateKey: installation.secretKey, serverHttpBaseUrl: url }) });
                    if (!requesterContext) throw new Error('Original Session custody unavailable');
                    try {
                        expect(await createApprovedApiTokenExecutionPreparer({ requester: requesterContext, artifactId,
                            authority: 'present_user', execute: nativeTokenCreate })(
                            { artifactId, request: approved })).toBeNull();
                    } finally { await requesterContext.dispose(); }
                    const staleHuman = await prepare({ artifactId, request: approved });
                    expect(staleHuman).not.toBeNull();
                    await db.account.update({ where: { id: account.id }, data: { tokenEpoch: account.tokenEpoch + 1 } });
                    try {
                        expect(await staleHuman!.execute(input)).toMatchObject({ ok: false, errorCode: 'approval_stale' });
                    } finally {
                        await db.account.update({ where: { id: account.id }, data: { tokenEpoch: account.tokenEpoch } });
                        await staleHuman!.dispose();
                    }
                    // Cancellation can arrive while Home is checking the human
                    // root. Hold only that HTTP boundary, not custody logic.
                    const inFlight = await prepare({ artifactId, request: approved });
                    expect(inFlight).not.toBeNull();
                    let entered!: () => void; let release!: () => void;
                    const checking = new Promise<void>(resolve => { entered = resolve; });
                    const held = new Promise<void>(resolve => { release = resolve; });
                    holdHumanVerification = async () => { entered(); await held; };
                    const requesterAbort = new AbortController();
                    try {
                        const executing = inFlight!.execute(input, requesterAbort.signal);
                        const checkpoint = await Promise.race([checking.then(() => 'checking'), executing.then(() => 'settled')]);
                        expect(checkpoint).toBe('checking'); requesterAbort.abort(); release();
                        expect(await executing).toMatchObject({ ok: false, errorCode: 'approval_stale' });
                        expect(await inFlight!.execute(input)).toMatchObject({ ok: false, errorCode: 'approval_stale' });
                    } finally { release(); holdHumanVerification = undefined; await inFlight!.dispose(); }
                    expect(nativeMintAttempts).toEqual([]);
                }
                replayExecutor = createCliActionExecutorFromCredentials({ ...params, credentials: humanCredentials,
                    readCredentials: async () => humanCredentials,
                    isApprovalExecutionOriginCurrent,
                    bindApprovedApiTokenExecution: (execute: NonNullable<ActionExecutorDeps['accountApiTokensCreateAction']>) =>
                        createApprovedApiTokenExecutionPreparer({ requester: humanContext!,
                            artifactId: origin === 'signed-session-miswired' ? randomUUID() : artifactId,
                            authority: 'present_user', signal: cancellation.signal, execute }) });
            }
            // The approved app dispatches through the incumbent exact-daemon
            // replay transport. Only that authenticated transport boundary is in-process.
            const decider = createActionExecutor({ ...deps, ...humanTokenActions,
                isApprovalExecutionOriginCurrent: async () => true,
                approvalRequestApprovedReplay: async ({ request }) => {
                    const owner = resolveApprovalExecutor(request);
                    return owner.kind === 'daemon' || owner.kind === 'live_invocation'
                        ? replayExecutor.replayApprovedApprovalRequest({ artifactId, callerAuthority: 'present_user' }) : null;
                },
            } as ActionExecutorDeps);
            if (origin === 'signed-session-detached') {
                cancellation.abort(); await invocation;
            }
            if (origin === 'signed-session-disabled') {
                policy = normalizeActionsSettingsV1({ v: 1, actions: { 'account.apiTokens.create': { enabled: false } } });
            }
            const decided = await decider.execute('approval.request.decide', { artifactId, decision: 'approve' }, {
                surface: 'ui', authority: 'present_user', serverId: configuration.activeServerId, runtimeAccountId: account.id,
            });
            if (origin === 'signed-session-lost-decision-receipt') {
                expect(lostDecisionReceipt).toBe(true);
                const persisted = await deps.approvalsGet!({ artifactId });
                expect(decided, JSON.stringify({
                    errorCode: decided.ok ? undefined : decided.errorCode, status: persisted?.status,
                })).toMatchObject({ ok: true });
            }
            if (origin === 'signed-session-refused-decision-write') {
                expect(refusedDecisionWrite).toBe(true);
                expect(decided).toMatchObject({ ok: false, errorCode: 'update_failed' });
                expect(await deps.approvalsGet!({ artifactId })).toMatchObject({ status: 'open' });
                expect(nativeMintAttempts).toEqual([]);
                expect(await db.accountApiToken.count({ where: { accountId: account.id } })).toBe(0);
                return;
            }
            const completed = await invocation;
            if (origin === 'signed-session-disabled') {
                expect(completed).toMatchObject({ ok: false, errorCode: 'action_disabled' });
                expect(nativeMintAttempts).toEqual([]);
                expect(await db.accountApiToken.count({ where: { accountId: account.id } })).toBe(0);
                return;
            }
            if (origin === 'signed-session-miswired' || origin === 'signed-session-detached') {
                expect(completed).toMatchObject({ ok: false });
                if (nativeToolReceipt) expect(await nativeToolReceipt).toMatchObject({ isError: true });
                expect(nativeMintAttempts).toEqual([]);
                expect(await db.accountApiToken.count({ where: { accountId: account.id } })).toBe(0);
                return;
            }
            if (!completed.ok) throw new Error(`token_request_failed:${completed.errorCode}:${JSON.stringify(nativeMintAttempts)}`);
            const created = AccountApiTokensCreateActionOutputV1Schema.parse(completed.result);
            if (nativeToolReceipt) {
                const receipt = await nativeToolReceipt;
                if (!receipt || typeof receipt !== 'object' || !('content' in receipt)) throw new Error('Native tool receipt unavailable');
                expect(JSON.stringify(receipt).includes(created.token)).toBe(true);
                const { projectRuntimeTranscriptEvent } = await importCli<typeof import('../../../../../../cli/src/agent/runtime/session/transcripts/projectRuntimeTranscriptEvent')>(
                    '../../../../../../cli/src/agent/runtime/session/transcripts/projectRuntimeTranscriptEvent');
                const { prepareCommittedAgentMessageViaPort } = await importCli<typeof import('../../../../../../cli/src/api/session/client/transcript/commitMessages')>(
                    '../../../../../../cli/src/api/session/client/transcript/commitMessages');
                const claude = await importCli<typeof import('../../../../../../../packages/plugins/claude/src/agent/runtime/remote/sdk/streamEvents')>(
                    '../../../../../../../packages/plugins/claude/src/agent/runtime/remote/sdk/streamEvents');
                const codex = await importCli<typeof import('../../../../../../../packages/plugins/codex/src/agent/runtime/appServer/projection/toolEvents')>(
                    '../../../../../../../packages/plugins/codex/src/agent/runtime/appServer/projection/toolEvents');
                let sequence = 0;
                for (const provider of [origin === 'signed-session' || origin === 'signed-session-runner' ? 'claude' : 'codex'] as const) {
                    const port: Parameters<typeof prepareCommittedAgentMessageViaPort>[0] = {
                        sessionId: session.id, socket: { connected: true, emit: () => undefined },
                        outboundShapeLogger: { log: () => undefined }, debug: () => undefined, debugLargeJson: () => undefined,
                        getMetadataSnapshot: () => null, buildOutboundSessionMessagePayload: content => ({ t: 'plain', v: content }),
                        toolCallCanonicalNameByProviderAndId: new Map(), permissionToolCallRawInputByProviderAndId: new Map(),
                        toolCallInputByProviderAndId: new Map(),
                    };
                    const callId = 'native-token-call';
                    const toolInput = { actionId: 'account.apiTokens.create', input };
                    const nativeEvents = provider === 'claude' ? [
                        ...claude.extractToolUseBlocksFromSdkMessage({ type: 'assistant', message: { content: [
                            { type: 'tool_use', id: callId, name: 'mcp__happier__action_execute', input: toolInput },
                        ] } }).map(block => ({ type: 'tool-call' as const, callId: block.id, name: block.name, input: block.input })),
                        ...claude.extractToolResultBlocksFromSdkMessage({ type: 'user', message: { content: [
                            { type: 'tool_result', tool_use_id: callId, content: receipt.content },
                        ] }, toolUseResult: receipt }).map(block => ({ type: 'tool-result' as const, callId: block.toolUseId, output: block.output })),
                    ] : codex.projectCodexAppServerToolEventsFromNotification({ method: 'item/completed', notificationParams: {
                        item: { id: callId, type: 'mcpToolCall', server: 'happier', tool: 'action_execute', arguments: toolInput, result: { Ok: receipt } },
                    } });
                    expect(nativeEvents.map(event => event.type)).toEqual(['tool-call', 'tool-result']);
                    for (const event of nativeEvents) {
                        const projected = await projectRuntimeTranscriptEvent({ provider,
                            session: { sessionId: session.id, enqueueAgentMessageCommitted: async (agent, body, opts) => {
                                const prepared = await prepareCommittedAgentMessageViaPort(port, agent, body, opts);
                                const committed = await createSessionMessage({ inputAdmission: 'transcriptOnly', actorUserId: account.id,
                                    sessionId: session.id, localId: opts.localId, messageRole: prepared.messageRole,
                                    content: SessionStoredMessageContentSchema.parse(prepared.payload) });
                                if (!committed.ok) throw new Error(`Native transcript commit refused:${committed.error}`);
                                return { persisted: true, delivered: true };
                            } },
                            event: { kind: event.type, sessionId: session.id, sequence: ++sequence, emittedAtMs: Date.now(),
                                toolCallId: event.callId, ...(event.type === 'tool-call'
                                    ? { toolName: event.name, input: event.input } : { output: event.output }) },
                        });
                        expect(projected.projected).toBe(true);
                    }
                }
                const messages = await db.sessionMessage.findMany({ where: { sessionId: session.id } });
                expect(messages).toHaveLength(2);
                for (const message of messages) {
                    expect(JSON.stringify(message.content).includes(created.token)).toBe(false);
                    if (message.localId?.includes('result')) expect(JSON.stringify(message.content)).toContain('apiToken');
                }
                const observerPayloads = [
                    ...outboundUpdates.mock.calls.map(([params]) => params.payload),
                    ...outboundBroadcasts.mock.calls.map(([params]) => params.payload),
                    ...outboundEphemerals.mock.calls.map(([params]) => params.payload),
                ];
                expect(observerPayloads.length).toBeGreaterThan(0);
                expect(JSON.stringify(observerPayloads).includes(created.token)).toBe(false);
            }
            if (signedSession) expect(nativeMintAttempts).toEqual([{ status: 200, signed: false, bearer: true, human: true }]);
            if (readPublicApproval && pending?.v === 2) {
                const authorization = pending.executionOriginV1.externalActionExecutionAuthorization;
                if (!authorization) throw new Error('Signed Session root missing');
                expect(await deps.approvalsGet!({ artifactId })).toMatchObject({ status: 'executed' });
                // Settlement is single-execution custody, not JWT revocation.
                // Measure the real verifier after settlement without logging the root.
                expect(await auth.verifyExternalActionExecutionAuthorization(authorization.token) !== null).toBe(true);
                const { verifyExternalActionExecutionAuthorizationCurrent } = await importCli<{
                    verifyExternalActionExecutionAuthorizationCurrent: typeof VerifyHumanAuthorization;
                }>('../../../../../../cli/src/api/externalActionExecutionAuthorization');
                expect(await verifyExternalActionExecutionAuthorizationCurrent({ authorization,
                    effectActionId: 'account.apiTokens.create', target: { kind: 'machine', machineId },
                    installationId, privateKey: installation.secretKey, serverHttpBaseUrl: url })).toBe(true);
            }
            expect(created.apiToken.grant).toEqual(input.grant);
            expect(JSON.stringify(decided).includes(created.token)).toBe(false);
            expect(JSON.stringify(await deps.approvalsGet!({ artifactId })).includes(created.token)).toBe(false);
            for (const row of await db.artifact.findMany({ where: { accountId: account.id } })) {
                expect(JSON.stringify({ header: decodePlainArtifactStoredContent(row.header),
                    body: row.body ? decodePlainArtifactStoredContent(row.body) : null }).includes(created.token)).toBe(false);
            }
            expect((await home.inject({ method: 'GET', url: '/v1/auth/api-tokens/self', headers: { authorization: `Bearer ${created.token}` } })).statusCode).toBe(200);
            expect((await home.inject({ method: 'POST', url: '/v1/auth/api-tokens/create', headers: { authorization: `Bearer ${created.token}` }, payload: { ...input, tokenId: randomUUID() } })).statusCode).toBe(403);
            expect(await db.accountApiToken.count({ where: { accountId: account.id } })).toBe(1);
            const repeated = await decider.execute('approval.request.decide', { artifactId, decision: 'approve' }, {
                surface: 'ui', authority: 'present_user', serverId: configuration.activeServerId, runtimeAccountId: account.id,
            });
            expect(JSON.stringify(repeated).includes(created.token)).toBe(false);
            expect(await db.accountApiToken.count({ where: { accountId: account.id } })).toBe(1);
            if (origin === 'signed-session') {
                const sessionAction = (actionId: 'account.apiTokens.list' | 'account.apiTokens.revoke' | 'account.apiTokens.revokeAll', value: unknown) =>
                    executeSession!({ kind: 'action.execute', requestId: randomUUID(), actionId, input: value,
                        toolCallId: 'native-token-lifecycle', witness: { turnId: 'token-turn', inputId: 'token-input',
                            userMessageSeq: 1, userMessageSeqs: [1], workDepth: 0, callerPermissionMode: 'default',
                            agentStartCaller: { kind: 'session', sessionId: session.id, starterDepth: 0, turnDepth: 0 } } },
                    { sessionId: session.id, isCurrent: async () => true, signal: cancellation.signal });
                const { handleActionsCommand } = await importCli<{
                    handleActionsCommand: typeof import('../../../../../../cli/src/cli/commands/actions')['handleActionsCommand'];
                }>('../../../../../../cli/src/cli/commands/actions');
                const genericAction = async (actionId: 'account.apiTokens.list' | 'account.apiTokens.revoke' | 'account.apiTokens.revokeAll', value: unknown): Promise<ActionExecuteResult> => {
                    let envelope: unknown;
                    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk, ...args) => {
                        try {
                            const value: unknown = JSON.parse(String(chunk));
                            if (value && typeof value === 'object' && 'v' in value && value.v === 1 && 'ok' in value) envelope = value;
                        } catch { /* Structured server logs are not the command result. */ }
                        const callback = args.find(argument => typeof argument === 'function');
                        if (typeof callback === 'function') callback();
                        return true;
                    });
                    try {
                        await handleActionsCommand(['invoke', actionId, '--input-json', JSON.stringify(value), '--json'], {
                            readCredentialsFn: async () => credentials,
                            createExecutorFn: () => ({ execute: async (id, input) => {
                                if (id !== 'account.apiTokens.list' && id !== 'account.apiTokens.revoke' && id !== 'account.apiTokens.revokeAll') {
                                    return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
                                }
                                return sessionAction(id, input);
                            }, resolveSessionTarget: async () => { throw new Error('Unexpected Session lookup'); } }),
                        }, cancellation.signal);
                        expect(envelope).toMatchObject({ ok: true });
                        if (!envelope || typeof envelope !== 'object' || !('data' in envelope)) throw new Error('CLI response missing data');
                        return { ok: true, result: envelope.data };
                    } finally { stdout.mockRestore(); process.exitCode = undefined; }
                };
                const approveMutation = async (actionId: 'account.apiTokens.revoke' | 'account.apiTokens.revokeAll', value: unknown) => {
                    const requested = await genericAction(actionId, value);
                    expect(requested).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
                    if (!requested.ok || !requested.result || typeof requested.result !== 'object'
                        || !('artifactId' in requested.result) || typeof requested.result.artifactId !== 'string') throw new Error('Approval was not created');
                    const artifactId = requested.result.artifactId;
                    const decided = await decider.execute('approval.request.decide', { artifactId, decision: 'approve' }, {
                        surface: 'ui', authority: 'present_user', serverId: configuration.activeServerId, runtimeAccountId: account.id,
                    });
                    if (!decided.ok) throw new Error(`signed_token_decision_refused:${decided.errorCode}`);
                    expect(decided).toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true } } });
                    return decided;
                };
                const otherAccount = await db.account.create({ data: { encryptionMode: 'plain' } });
                const other = await auth.createApiToken({ accountId: otherAccount.id, tokenId: randomUUID(), label: 'Other Account', expiresAt: null });
                const listed = await sessionAction('account.apiTokens.list', {});
                if (!listed.ok) throw new Error(`signed_token_list_refused:${listed.errorCode}`);
                expect(listed).toMatchObject({ ok: true, result: { tokens: [expect.objectContaining({ tokenId })] } });
                expect(JSON.stringify(listed)).not.toContain(other.tokenId);
                expect(await genericAction('account.apiTokens.list', {}))
                    .toMatchObject({ ok: true, result: { tokens: [expect.objectContaining({ tokenId })] } });
                expect(tokenListProof).toBeDefined();
                expect((await home.inject({ method: 'POST', url: '/v1/auth/api-tokens/revoke',
                    headers: tokenListProof!, payload: { tokenId } })).statusCode).toBe(401);
                for (const path of ['list', 'revoke', 'revoke-all']) {
                    expect((await home.inject({ method: 'POST', url: `/v1/auth/api-tokens/${path}`,
                        headers: { authorization: `Bearer ${created.token}` }, payload: path === 'revoke' ? { tokenId } : {} })).statusCode).toBe(403);
                }
                expect(await approveMutation('account.apiTokens.revoke', { tokenId: other.tokenId }))
                    .toMatchObject({ result: { execution: { result: { revoked: false } } } });
                expect((await home.inject({ method: 'GET', url: '/v1/auth/api-tokens/self', headers: { authorization: `Bearer ${created.token}` } })).statusCode).toBe(200);
                expect(await approveMutation('account.apiTokens.revoke', { tokenId }))
                    .toMatchObject({ result: { execution: { result: { revoked: true } } } });
                expect((await home.inject({ method: 'GET', url: '/v1/auth/api-tokens/self', headers: { authorization: `Bearer ${created.token}` } })).statusCode).toBe(401);
                expect(await approveMutation('account.apiTokens.revoke', { tokenId }))
                    .toMatchObject({ result: { execution: { result: { revoked: false } } } });
                const remaining = await auth.createApiToken({ accountId: account.id, tokenId: randomUUID(), label: 'Remaining', expiresAt: null });
                expect(await approveMutation('account.apiTokens.revokeAll', {}))
                    .toMatchObject({ result: { execution: { result: { revokedCount: 1 } } } });
                expect((await home.inject({ method: 'GET', url: '/v1/auth/api-tokens/self', headers: { authorization: `Bearer ${remaining.token}` } })).statusCode).toBe(401);
                expect((await home.inject({ method: 'GET', url: '/v1/auth/api-tokens/self', headers: { authorization: `Bearer ${other.token}` } })).statusCode).toBe(200);
                return;
            }
            const revoked = await executor.execute('account.apiTokens.revoke', { tokenId }, {
                surface: 'cli', authority: 'present_user', presentUserConfirmation: { actionId: 'account.apiTokens.revoke' },
            });
            if (!revoked.ok) throw new Error(`token_revoke_failed:${revoked.errorCode}`);
            expect(revoked).toMatchObject({ ok: true });
            expect((await home.inject({ method: 'GET', url: '/v1/auth/api-tokens/self', headers: { authorization: `Bearer ${created.token}` } })).statusCode).toBe(401);
            expect(await db.accountApiToken.count({ where: { accountId: account.id } })).toBe(0);
        } finally { cancellation.abort(); await invocation?.catch(() => undefined); await closeNativeTransport?.(); await humanContext?.dispose();
            vi.restoreAllMocks(); await sockets.close(); await home.close(); }
    }, 180_000);
});
