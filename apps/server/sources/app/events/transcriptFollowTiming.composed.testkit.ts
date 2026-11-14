import { projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import Fastify from 'fastify';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Server, type Socket } from 'socket.io';
import { io as connect } from 'socket.io-client';
import type { Prisma } from '@prisma/client';
import tweetnacl from 'tweetnacl';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createExternalActionDaemonDispatchResponse, EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1, parseExternalActionResponseEnvelopeV1, type ExternalActionDaemonDispatchRequest } from '@happier-dev/protocol/actions/externalActionApi';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/actionExecutor';
import { sealExternalActionRequestV2, openExternalActionResponseV2 } from '@happier-dev/protocol/actions/externalActionEncryption';
import { createMachineDataEncryptionKeyV1 } from '@happier-dev/protocol/machines/machineStoredContent';
import { SOCKET_RPC_EVENTS, type SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { decodeBase64 } from 'privacy-kit';
import { startHttpRequestRecordingProxy } from '../../../../../packages/tests/src/testkit/httpRequestRecordingProxy';

import { createServerBackedSessionTranscriptStore } from '../../../../cli/src/api/session/createServerBackedSessionTranscriptStore';
import { createSessionTranscriptFollowLeaseRegistry } from '../../../../cli/src/api/session/followSessionTranscript';
import { executeCliTranscriptAction } from '../../../../cli/src/session/actions/executeCliTranscriptAction';
import { executeExternalAction } from '../../../../cli/src/daemon/externalActions/executeExternalAction';
import { createDaemonExternalActionTargetResolver } from '../../../../cli/src/daemon/externalActions/daemonExternalActionTargetResolver';
import { runWithServerHttpBaseUrl } from '../../../../cli/src/api/client/serverHttpBaseUrl';
import { sealSessionStoredContent, type SessionStoredContentCryptoContext } from '../../../../cli/src/session/transport/encryption/sessionStoredContentCodec';
import type { Fastify as AppFastify } from '@/app/api/types';
import { enableAuthentication } from '@/app/api/utils/enableAuthentication';
import { enableSchemaValidation } from '@/app/api/utils/enableSchemaValidation';
import { registerExternalActionRoutes } from '@/app/api/routes/actions/registerExternalActionRoutes';
import { registerSessionMessageRoutes } from '@/app/api/routes/session/registerSessionMessageRoutes';
import { registerSessionListingRoutes } from '@/app/api/routes/session/registerSessionListingRoutes';
import { registerAccountEncryptionRoutes } from '@/app/api/routes/account/registerAccountEncryptionRoutes';
import { createExternalActionDaemonDispatcher } from '@/app/api/socket/externalActionDispatcher';
import { buildRpcMethodRoom } from '@/app/api/socket/rpc/rpcMethodRoom';
import { qualifyCurrentAccountStoredContentSocket, currentAccountStoredContentCompatibilityHeaders } from '@/app/api/testkit/accountStoredContentCompatibility';
import { auth } from '@/app/auth/auth';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { verifyCurrentExternalActionPrincipal } from '@/app/auth/externalActionExecutionAuthorization';
import { createSessionMessage } from '@/app/session/sessionWriteService';
import { deleteOwnedSession } from '@/app/session/delete/deleteOwnedSession';
import { enqueuePendingMessage, materializeNextPendingMessage, resolveAcceptedPendingDelivery } from '@/app/session/pending/pendingMessageService';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { createSessionPublisherPresence } from '@/app/presence/sessionPublisherPresence';
import { resolveSessionMessageAccountActor } from '@/app/session/messages/projectSessionMessageAccountActors';
import { db, initDbPostgres, shutdownDbClient } from '@/storage/db';
import { applyEnvValues, restoreEnv, snapshotEnv } from '@/testkit/env';
import { applyLightDefaultEnv, ensureHandyMasterSecret } from '@/flavors/light/env';
import { inTx } from '@/storage/inTx';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { prepareE2eeAccountApiTokenLabel, preparePlainAccountApiTokenLabel } from '@/testkit/privateLabelFixture';
import { eventRouter } from './connectionEventRouter';
import { buildNewMessageUpdate } from './eventPayloadBuilders';
import * as sessionAccessOwner from '@/app/session/access/sessionAccess';
import * as sessionInputOwner from '@/app/session/messages/sessionInputAdmission';
import { sessionUpdateHandler } from '@/app/api/socket/sessionUpdateHandler';
import * as publicationAdmissionOwner from '@/app/api/socket/currentSessionPublicationAdmission';
import * as sessionBindingOwner from '@/app/api/socket/sessionScopedBinding';
import * as sessionAudienceOwner from '@/app/session/access/sessionRecipients';

const flowSql = vi.hoisted(() => ({ statements: 0, accessKeyReads: 0, sessionReads: 0 }));
// Observe real SQLite statements through the existing generated Prisma adapter.
// Generated provider clients share Prisma's constructor/event boundary shape.
vi.mock('../../../generated/sqlite-client/index.js', async importOriginal => {
    const original = await importOriginal<typeof import('@prisma/client')>();
    return { ...original, PrismaClient: class extends original.PrismaClient<Prisma.PrismaClientOptions, 'query'> {
        constructor(options: Prisma.PrismaClientOptions) {
            super({ ...options, log: [{ emit: 'event', level: 'query' }] });
            this.$on('query', event => {
                flowSql.statements++;
                const query = event.query.replace(/["`]/gu, '');
                if (/^SELECT\b/iu.test(query)) {
                    if (/\b(?:FROM|JOIN)\s+(?:main\.)?AccessKey\b/iu.test(query)) flowSql.accessKeyReads++;
                    if (/\b(?:FROM|JOIN)\s+(?:main\.)?Session\b/iu.test(query)) flowSql.sessionReads++;
                }
            });
        }
    } };
});

export function registerTranscriptFollowTimingTests(provider: 'sqlite' | 'postgres',
    httpRoundTripDelayMs = 0, scenario: 'timing' | 'heavy-history-transfer' | 'socket-flow-budget' = 'timing'): void {
const measureTransfer = scenario === 'heavy-history-transfer';
const measureSocketFlow = scenario === 'socket-flow-budget';
const enforcePolicyShape = scenario === 'timing' && httpRoundTripDelayMs === 0;
describe(`Home Action transcript follow through real HTTP, RPC, Socket.IO and ${provider}, HTTP delay ${httpRoundTripDelayMs}ms${measureTransfer ? ', heavy-history-transfer' : measureSocketFlow ? ', FLOWBUDGET socket publication' : ''}`, () => {
    let harness: LightSqliteHarness;
    const originalEnv = snapshotEnv();
    beforeAll(async () => {
        if (provider === 'postgres') {
            // Only the canonical disposable Docker-contract owner supplies this URL.
            const url = process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL;
            if (!url || url !== process.env.DATABASE_URL) throw new Error('Disposable PostgreSQL contract URL required');
            applyEnvValues({ HAPPIER_DB_PROVIDER: 'postgres', HAPPY_DB_PROVIDER: 'postgres',
                HAPPIER_DB_CONNECTION_LIMIT: '2', HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
                AUTH_REQUIRED_LOGIN_PROVIDERS: '', AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS: '0' });
            applyLightDefaultEnv(process.env);
            await ensureHandyMasterSecret(process.env);
            initDbPostgres();
            await db.$connect();
            await auth.init();
            return;
        }
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-home-follow-', sqliteConnectionLimit: 1,
            initAuth: true, env: { HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
                AUTH_REQUIRED_LOGIN_PROVIDERS: '', AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS: '0' } });
    }, 120_000);
    afterAll(async () => {
        if (provider === 'postgres') { await shutdownDbClient(); restoreEnv(originalEnv); }
        else await harness?.close();
    });

    const runJourney = async (version: 1 | 2, enforceStreamShape = false) => {
        const material = version === 2 ? { type: 'dataKey' as const, machineKey: tweetnacl.randomBytes(32) } : null;
        const accessChecks = vi.spyOn(sessionAccessOwner, 'resolveSessionAccessForOperation');
        // Same-module lexical calls do not cross the exported resolver spy.
        // Observe their public composition entries too, forwarding real logic.
        const lexicalPolicyEntries = [
            vi.spyOn(sessionAccessOwner, 'assertSessionCapabilityInTx'),
            vi.spyOn(sessionAccessOwner, 'readCurrentSessionAccessForOperation'),
            vi.spyOn(sessionAccessOwner, 'resolveEffectiveSessionAccess'),
            vi.spyOn(sessionAccessOwner, 'resolveSessionAccessForRowsInTx'),
            vi.spyOn(sessionAccessOwner, 'resolveEffectiveSessionAccessForSessionsInTx'),
            vi.spyOn(sessionAccessOwner, 'resolveSessionAccessForAccountsInTx'),
            vi.spyOn(sessionAccessOwner, 'resolveSessionAccessForSessionsInTx'),
            vi.spyOn(sessionAccessOwner, 'canManageSharing'),
            vi.spyOn(sessionAccessOwner, 'canApprovePermissions'),
            vi.spyOn(sessionAccessOwner, 'canManagePermissionDelegation'),
        ];
        const policyEvaluationCount = () => accessChecks.mock.calls.length
            + lexicalPolicyEntries.reduce((total, entry) => total + entry.mock.calls.length, 0);
        const inputAdmissions = vi.spyOn(sessionInputOwner, 'buildSessionInputAdmissionReceipt');
        const publicationAdmissions = vi.spyOn(publicationAdmissionOwner, 'admitCurrentSessionPublication');
        const structuralAccessChecks = vi.spyOn(sessionAccessOwner, 'resolveStructuralSessionAccess');
        const audienceReads = vi.spyOn(sessionAudienceOwner, 'readCurrentSessionPublicationAudienceInTx');
        const contentPublicKey = material ? tweetnacl.box.keyPair.fromSecretKey(material.machineKey).publicKey : null;
        const owner = await db.account.create({ data: contentPublicKey
            ? { ...createSignedAccountContentBinding(contentPublicKey), encryptionMode: 'e2ee' }
            : { publicKey: crypto.randomUUID(), encryptionMode: 'plain' } });
        const sessionKey = material && contentPublicKey ? createMachineDataEncryptionKeyV1({ material,
            dataKeyPublicKey: contentPublicKey, randomBytes: tweetnacl.randomBytes }) : null;
        const contentContext: SessionStoredContentCryptoContext = sessionKey
            ? { mode: 'e2ee', ctx: sessionKey } : { mode: 'plain', ctx: null };
        const machineMetadata = { host: 'test', platform: 'linux', happyCliVersion: 'test',
            homeDir: '/tmp', happyHomeDir: '/tmp/test' };
        const sealedMetadata = sealSessionStoredContent({ ...contentContext, payload: machineMetadata });
        const keyPair = tweetnacl.sign.keyPair();
        const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: owner.id,
            metadata: sealedMetadata.t === 'encrypted' ? sealedMetadata.c : encodePlainMachineStoredContent(machineMetadata), metadataVersion: 1,
            dataEncryptionKey: sessionKey?.dataEncryptionKey ?? decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64'),
            installationId: crypto.randomUUID(), installationPublicKey: keyPair.publicKey,
            active: true, lastActiveAt: new Date(),
            operationProtocolCapabilitiesRevision: 1,
            operationProtocolCapabilities: { externalActionExecutionAuthorization: { protocolVersions: [1] },
                sessionInputAdmission: { protocolVersions: [1, 2] } } } });
        const sessionMetadata = sealSessionStoredContent({ ...contentContext,
            payload: { ...machineMetadata, machineId: machine.id, path: '/tmp' } });
        const session = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(),
            encryptionMode: contentContext.mode,
            ...(sessionKey ? { dataKeyEnvelopes: { create: { recipientAccountId: owner.id,
                encryptedDataKey: sessionKey.dataEncryptionKey } } } : {}),
            metadata: sessionMetadata.t === 'encrypted' ? sessionMetadata.c : JSON.stringify(sessionMetadata.v) } });
        // Synthetic history is deliberately varied, so future negotiated compression
        // cannot hide replaying it behind a repeated-character fixture.
        const history = measureTransfer ? Array.from({ length: 10 }, (_, index) => ({
            sessionId: session.id, seq: index + 1, localId: `retained-history-${index}`, messageRole: 'agent',
            content: sealSessionStoredContent({ ...contentContext, payload: {
                role: 'agent', content: { type: 'text', text: Array.from({ length: 1024 }, (_, line) =>
                    createHash('sha256').update(`history-${index}-${line}`).digest('hex')).join('\n') },
            } }),
        })) : [];
        if (history.length > 0) {
            await db.sessionMessage.createMany({ data: history });
            await db.session.update({ where: { id: session.id }, data: { seq: history.length } });
        }
        await db.accessKey.create({ data: { accountId: owner.id, sessionId: session.id, machineId: machine.id, data: 'test' } });
        const token = await auth.createToken(owner.id, undefined, { kind: 'account', authority: 'present_user' });
        const patId = crypto.randomUUID();
        const pat = await auth.createApiToken({
            accountId: owner.id,
            tokenId: patId,
            label: sessionKey
                ? await prepareE2eeAccountApiTokenLabel(owner.id, patId, 'follow harness')
                : await preparePlainAccountApiTokenLabel(owner.id, 'follow harness'),
        });
        const serverIdentityId = await getOrCreateServerIdentityId();
        const raw = Fastify();
        enableSchemaValidation(raw);
        const app = raw.withTypeProvider<ZodTypeProvider>() as unknown as AppFastify;
        const io = new Server(raw.server, { path: '/v1/updates/' });
        eventRouter.setIo(io);
        let observerConnections = 0;
        const stamps: Record<string, number> = {};
        const pages: { url: string; start: number; end?: number }[] = [];
        const flowHttp: string[] = [];
        let flowRpc = 0;
        let flowAuthorizations = 0;
        let flowMessagePushes = 0;
        const flowOutgoingKinds: Record<string, number> = {};
        const streamFrames: Array<{ type: string; tick: number; content: unknown }> = [];
        let streamDelivered: (() => void) | undefined;
        let expectedStreamTick = 0;
        let streamCounts: { publicationAdmissions: number; structuralAccessChecks: number; permissionChecks: number;
            audienceReads: number; sqlStatements: number; accessKeyReads: number;
            sessionReads: number; inputAdmissions: number; http: number } | undefined;
        let baselineRead: (() => void) | undefined;
        let receivedRunner!: (socket: Socket) => void;
        const runnerSocket = new Promise<Socket>(resolve => { receivedRunner = resolve; });
        app.addHook('onRequest', async request => {
            flowHttp.push(`${request.method} ${request.url.split('?')[0]}`);
            if (request.url.startsWith(`/v1/sessions/${session.id}/messages`)) pages.push({ url: request.url, start: performance.now() });
        });
        app.addHook('onResponse', async request => {
            if (request.url.startsWith(`/v1/sessions/${session.id}/messages`)) pages.at(-1)!.end = performance.now();
        });
        enableAuthentication(app);
        registerSessionMessageRoutes(app);
        registerSessionListingRoutes(app);
        registerAccountEncryptionRoutes(app);
        const presence = createSessionPublisherPresence();
        registerExternalActionRoutes(app, { dispatch: createExternalActionDaemonDispatcher({ io,
            sessionPublisherPresence: presence }) });
        io.use(async (socket, next) => {
            if (socket.handshake.auth.clientType === 'machine-scoped') { next(); return; }
            const binding = await sessionBindingOwner.resolveSessionScopedSocketBinding({
                userId: owner.id, sessionId: session.id,
                ...(measureSocketFlow && socket.handshake.auth.runner === true ? { machineId: machine.id } : {}),
            });
            if (!binding.ok) { next(new Error('Session fixture binding refused')); return; }
            // Match production: the canonical binding settles before protected
            // rooms and publication handlers become reachable on connect.
            socket.data.sessionScopedBinding = binding.binding;
            next();
        });
        io.on('connection', socket => {
            // Socket authentication/installation stamping is the only substituted boundary.
            // HTTP auth, grant admission, placement, RPC and event qualification remain real.
            if (socket.handshake.auth.clientType === 'machine-scoped') {
                Object.assign(socket.data, { userId: owner.id, clientType: 'machine-scoped', machineId: machine.id,
                    verifiedMachineInstallationId: machine.installationId });
                qualifyCurrentAccountStoredContentSocket(socket);
                void socket.join(buildRpcMethodRoom({ userId: owner.id,
                    method: `${machine.id}:${EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1}` }));
            } else {
                if (socket.handshake.auth.runner !== true) observerConnections++;
                Object.assign(socket.data, { userId: owner.id, clientType: 'session-scoped', sessionId: session.id,
                    authAuthority: 'present_user', authTokenAuthenticationEvidence: [] });
                socket.onAnyOutgoing((event, payload: unknown) => {
                    const kind = payload && typeof payload === 'object' && 'body' in payload
                        && payload.body && typeof payload.body === 'object' && 't' in payload.body
                        ? String(payload.body.t) : payload && typeof payload === 'object' && 'type' in payload
                            ? String(payload.type) : event;
                    const outgoingKind = `${event}:${kind}`;
                    flowOutgoingKinds[outgoingKind] = (flowOutgoingKinds[outgoingKind] ?? 0) + 1;
                    if (socket.handshake.auth.runner !== true && event === 'update'
                        && payload && typeof payload === 'object' && 'body' in payload
                        && payload.body && typeof payload.body === 'object' && 't' in payload.body
                        && payload.body.t === 'new-message') {
                        stamps.socketEmit = performance.now();
                        flowMessagePushes++;
                    }
                });
                void socket.join(`session:${session.id}:${owner.id}`);
                if (socket.handshake.auth.runner === true) {
                    if (measureSocketFlow) {
                        socket.data.machineId = machine.id;
                        sessionUpdateHandler(owner.id, socket, { connectionType: 'session-scoped', socket,
                            userId: owner.id, sessionId: session.id }, { presence,
                            binding: { accountId: owner.id, machineId: machine.id, sessionId: session.id } });
                    }
                    receivedRunner(socket);
                }
            }
        });
        const upstream = await app.listen({ host: '127.0.0.1', port: 0 });
        // Existing network-boundary proxy models finite HTTP RTT only. Socket
        // frames remain real loopback delivery, with no simulated frame delay.
        const network = httpRoundTripDelayMs > 0 || measureTransfer ? await startHttpRequestRecordingProxy({
            targetBaseUrl: upstream, delayRequestMs: () => httpRoundTripDelayMs,
        }) : null;
        const endpoint = network?.baseUrl ?? upstream;
        const registry = createSessionTranscriptFollowLeaseRegistry({ idleTtlMs: 600_000 });
        const store = createServerBackedSessionTranscriptStore({ token, sessionId: session.id, ...contentContext });
        const observedStore = { ...store,
            readAfter: async (input?: unknown) => {
                if (stamps.waiterSignalled !== undefined) stamps.waiterResumed = performance.now();
                stamps.pageStart = performance.now();
                const page = await store.readAfter(input);
                stamps.pageEnd = performance.now();
                baselineRead?.();
                baselineRead = undefined;
                return page;
            },
            observeChanges: (listener: Parameters<NonNullable<typeof store.observeChanges>>[0],
                onError: Parameters<NonNullable<typeof store.observeChanges>>[1]) => store.observeChanges!(change => {
                    stamps.consumer = performance.now();
                    listener(change);
                    stamps.waiterSignalled = performance.now();
                }, onError),
        };
        // Run the real CLI factory through this composition's testkit boundary;
        // the server compiler must not own the CLI factory's source graph.
        const cliActionDepsSource = '../../../../cli/src/session/actions/createCliActionDeps';
        const { createCliActionDeps } = await vi.importActual<{
            createCliActionDeps(params: Readonly<{ token: string; sessionId: string }> & SessionStoredContentCryptoContext): ActionExecutorDeps;
        }>(cliActionDepsSource);
        const executor = createActionExecutor({ ...createCliActionDeps({ token, sessionId: session.id, ...contentContext }),
            sessionTranscriptAction: args => executeCliTranscriptAction({ ...args,
            defaultSessionId: session.id, options: { transcriptSessionId: session.id, transcriptStore: observedStore,
                transcriptFollowLeaseRegistry: registry } }) });
        const daemon = connect(endpoint, { path: '/v1/updates/', transports: ['websocket'],
            reconnection: false, auth: { clientType: 'machine-scoped' } });
        const runner = connect(endpoint, { path: '/v1/updates/', transports: ['websocket'],
            reconnection: false, auth: { clientType: 'session-scoped', runner: true } });
        const meter = measureTransfer || measureSocketFlow ? connect(endpoint, { path: '/v1/updates/', transports: ['websocket'],
            reconnection: false, query: { transferObserver: 'measured' }, auth: { clientType: 'session-scoped' } }) : null;
        let receivedPackets = 0;
        let decodedPacketBytes = 0;
        let expectedMeterSeq: number | undefined;
        let meterDelivered: (() => void) | undefined;
        meter?.io.on('open', () => {
            meter.io.engine.on('packet', packet => {
                if (packet.type === 'message' && typeof packet.data === 'string' && packet.data.startsWith('2["update",')) {
                    receivedPackets++;
                    decodedPacketBytes += Buffer.byteLength(packet.data);
                }
            });
        });
        meter?.on('update', (payload: ReturnType<typeof buildNewMessageUpdate>) => {
            if (payload.body.t === 'new-message' && payload.body.message.seq === expectedMeterSeq) meterDelivered?.();
        });
        meter?.on('ephemeral', (payload: unknown) => {
            if (!measureSocketFlow || !payload || typeof payload !== 'object' || !('type' in payload)
                || (payload.type !== 'transcript-stream-segment' && payload.type !== 'transcript-stream-segment-delta')
                || !('message' in payload) || !payload.message || typeof payload.message !== 'object'
                || !('tick' in payload.message) || typeof payload.message.tick !== 'number'
                || !('content' in payload.message)) return;
            streamFrames.push({ type: payload.type, tick: payload.message.tick, content: payload.message.content });
            if (payload.message.tick === expectedStreamTick) streamDelivered?.();
        });
        const abort = new AbortController();
        daemon.on(SOCKET_RPC_EVENTS.REQUEST, async (rpc: SocketRpcRequestPayload, acknowledge: (value: unknown) => void) => {
            flowRpc++;
            const request = rpc.params as ExternalActionDaemonDispatchRequest;
            stamps.dispatch = performance.now();
            const result = await runWithServerHttpBaseUrl(endpoint, () => executeExternalAction({
                ...request, currentMachineId: machine.id, currentServerId: 'follow-test',
                currentInstallationId: machine.installationId!, externalActionMachineRequestPrivateKey: keyPair.secretKey,
                verifyExecutionAuthorization: async ({ authorization }) => {
                    flowAuthorizations++;
                    return Boolean(await verifyCurrentExternalActionPrincipal(authorization.binding));
                },
                ...(material ? { resolveEncryption: async () => ({ serverIdentityId, material }) } : {}),
                resolveTarget: createDaemonExternalActionTargetResolver({ credentials: { token,
                    encryption: material && contentPublicKey ? { ...material, publicKey: contentPublicKey } : null },
                    serverApiUrl: endpoint }), executor, signal: abort.signal,
            }));
            stamps.daemonReturn = performance.now();
            acknowledge(result.kind === 'response' ? createExternalActionDaemonDispatchResponse(result.prepared) : result);
        });
        daemon.on(SOCKET_RPC_EVENTS.CANCEL, () => abort.abort());
        let releaseWriter: (() => void) | undefined;
        let writer: Promise<void> | undefined;
        const headers = { authorization: `Bearer ${pat.token}`, 'content-type': 'application/json',
            ...currentAccountStoredContentCompatibilityHeaders };
        const follow = (cursor: string) => {
            const binding = { serverIdentityId, accountId: owner.id, actionId: 'transcript.follow' as const,
                requestId: crypto.randomUUID(), target: { kind: 'machine' as const, machineId: machine.id },
                credentialId: pat.tokenId };
            const input = { sessionId: session.id, cursor, leaseId: 'home-follow', waitForChanges: true };
            const envelope = material ? sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding, input, material, randomBytes: tweetnacl.randomBytes })
                : { v: 1 as const, requestId: binding.requestId, target: binding.target, input };
            stamps.httpStart = performance.now();
            return fetch(`${endpoint}/v1/actions/transcript.follow`, { method: 'POST', headers, body: JSON.stringify(envelope) })
                .then(async http => {
                    stamps.httpReturn = performance.now();
                    const body: unknown = await http.json();
                    const execution = material && envelope.v === 2
                        ? openExternalActionResponseV2({ binding, material, request: envelope, envelope: body })
                        : parseExternalActionResponseEnvelopeV1(body)?.execution;
                    if (!execution?.ok) throw new Error(`Home Action failed: ${JSON.stringify(execution ?? { status: http.status })}`);
                    const result = getActionSpec('transcript.follow').outputSchema.parse(execution.result);
                    stamps.responseOpened = performance.now();
                    return { status: http.status, body: { execution: { ok: true, result } } };
                });
        };
        let testFailed = false;
        try {
            await new Promise<void>((resolve, reject) => { daemon.once('connect', resolve); daemon.once('connect_error', reject); });
            if (meter) await new Promise<void>((resolve, reject) => {
                if (meter.connected) { resolve(); return; }
                meter.once('connect', resolve); meter.once('connect_error', reject);
            });
            const binding = { accountId: owner.id, machineId: machine.id, sessionId: session.id };
            const registration = await presence.registerPublisher({ socket: await runnerSocket, binding,
                completeActivitySnapshot: { state: 'idle', activeCount: 0 } });
            if (registration.status !== 'registered') throw new Error('Runner publisher claim failed');
            const publisherAuthority = { ...binding, committedFence: registration.committedFence };
            let cursor = 'tail';
            for (let index = 1; index <= 2; index++) {
                flowHttp.length = 0;
                flowRpc = 0;
                flowAuthorizations = 0;
                flowMessagePushes = 0;
                for (const key of Object.keys(flowOutgoingKinds)) delete flowOutgoingKinds[key];
                flowSql.statements = 0;
                accessChecks.mockClear();
                for (const entry of lexicalPolicyEntries) entry.mockClear();
                inputAdmissions.mockClear();
                const pagesBefore = pages.length;
                let inputPolicyEvaluations = 0;
                let admittedStepPolicyEvaluations = 0;
                if (index === 1) {
                    const beforeInput = policyEvaluationCount();
                    const enqueued = await enqueuePendingMessage({ actorUserId: owner.id,
                        authentication: createPresentUserSessionAccessAuthentication(), sessionId: session.id,
                        localId: 'follow-1', targetMachineId: machine.id, requestedAction: { v: 1, kind: 'send_now' },
                        content: sealSessionStoredContent({ ...contentContext,
                            payload: { role: 'user', content: { type: 'text', text: 'row-1' } } }) });
                    if (!enqueued.ok) throw new Error(`Canonical pending admission failed: ${JSON.stringify(enqueued)}`);
                    inputPolicyEvaluations = policyEvaluationCount() - beforeInput;
                    const beforeMaterialize = policyEvaluationCount();
                    expect(await materializeNextPendingMessage({ actorUserId: owner.id, sessionId: session.id,
                        deliveryState: 'provider', deliveryTiming: 'after_foreground_ready', foregroundState: 'ready', publisherAuthority }))
                        .toMatchObject({ ok: true, didMaterialize: true });
                    admittedStepPolicyEvaluations += policyEvaluationCount() - beforeMaterialize;
                }
                const baseline = new Promise<void>(resolve => { baselineRead = resolve; });
                for (const key of Object.keys(stamps)) delete stamps[key];
                const response = follow(cursor);
                // Observe completion or admission failure directly; never poll readiness.
                await Promise.race([baseline, response.then(() => {
                    throw new Error('Home follow returned before a transcript baseline was read');
                })]);
                const baselinePages = pages.length;
                if (measureSocketFlow && index === 2) {
                    // The same admitted publisher and live Follow consumer used
                    // below exchange real Socket.IO packets. Only handshake
                    // authentication is substituted by this existing composition.
                    const before = { publicationAdmissions: publicationAdmissions.mock.calls.length,
                        structuralAccessChecks: structuralAccessChecks.mock.calls.length,
                        permissionChecks: accessChecks.mock.calls.length,
                        audienceReads: audienceReads.mock.calls.length, sqlStatements: flowSql.statements,
                        accessKeyReads: flowSql.accessKeyReads, sessionReads: flowSql.sessionReads,
                        inputAdmissions: inputAdmissions.mock.calls.length, http: flowHttp.length };
                    const chunks = ['row', '-', '2'];
                    const contents = chunks.map(text => sealSessionStoredContent({ ...contentContext,
                        payload: { role: 'agent', content: { type: 'text', text } } }));
                    for (const [chunkIndex, content] of contents.entries()) {
                        expectedStreamTick = chunkIndex + 1;
                        const delivered = new Promise<void>(resolve => { streamDelivered = resolve; });
                        const event = chunkIndex === 0 ? 'transcript-stream-segment' : 'transcript-stream-segment-delta';
                        runner.emit(event, { sid: session.id, message: { localId: 'follow-2', messageRole: 'agent',
                            tick: expectedStreamTick, ...(chunkIndex === 0 ? {} : { baseLength: chunks.slice(0, chunkIndex).join('').length }),
                            content, createdAt: 1_000, updatedAt: 1_000 + chunkIndex } });
                        await delivered;
                    }
                    streamCounts = { publicationAdmissions: publicationAdmissions.mock.calls.length - before.publicationAdmissions,
                        structuralAccessChecks: structuralAccessChecks.mock.calls.length - before.structuralAccessChecks,
                        permissionChecks: accessChecks.mock.calls.length - before.permissionChecks,
                        audienceReads: audienceReads.mock.calls.length - before.audienceReads,
                        sqlStatements: flowSql.statements - before.sqlStatements,
                        accessKeyReads: flowSql.accessKeyReads - before.accessKeyReads,
                        sessionReads: flowSql.sessionReads - before.sessionReads,
                        inputAdmissions: inputAdmissions.mock.calls.length - before.inputAdmissions,
                        http: flowHttp.length - before.http };
                    console.info('FLOWBUDGET_SESSION_SOCKET_STREAM', JSON.stringify({ provider, version,
                        chunks: chunks.length, frames: streamFrames.length, ...streamCounts }));
                    expect(streamFrames).toEqual(contents.map((content, chunkIndex) => ({
                        type: chunkIndex === 0 ? 'transcript-stream-segment' : 'transcript-stream-segment-delta',
                        tick: chunkIndex + 1, content,
                    })));
                    expect(streamCounts.inputAdmissions).toBe(0);
                    expect(streamCounts.http).toBe(0);
                }
                const transferBefore = network?.entries() ?? [];
                const packetsBefore = receivedPackets;
                const decodedBefore = decodedPacketBytes;
                const receivedByMeter = meter ? new Promise<void>(resolve => { meterDelivered = resolve; }) : Promise.resolve();
                stamps.appendStart = performance.now();
                const transaction = db.$transaction;
                // Instrument the database adapter without substituting its
                // callback or result. Observe the real transaction promise's
                // fulfillment before inTx runs production post-commit callbacks;
                // this is COMMIT acknowledgement, not the disk instant.
                db.$transaction = new Proxy(transaction, { apply(target, thisArg, args: unknown[]) {
                    const committed: unknown = Reflect.apply(target, thisArg, args);
                    if (!(committed instanceof Promise)) throw new Error('Database transaction must return a promise');
                    return committed.then((result: unknown) => {
                        stamps.commitAcknowledged = performance.now();
                        return result;
                    });
                } });
                const beforeWrite = policyEvaluationCount();
                const written = await (async () => {
                    try {
                        return index === 1
                            ? await resolveAcceptedPendingDelivery({ actorUserId: owner.id, sessionId: session.id, localId: 'follow-1', publisherAuthority })
                            : await createSessionMessage({ inputAdmission: 'transcriptOnly', actorUserId: owner.id, publisherAuthority,
                                sessionId: session.id, localId: `follow-${index}`, messageRole: 'agent',
                                content: sealSessionStoredContent({ ...contentContext,
                                    payload: { role: 'agent', content: { type: 'text', text: `row-${index}` } } }) });
                    } finally { db.$transaction = transaction; }
                })();
                admittedStepPolicyEvaluations += policyEvaluationCount() - beforeWrite;
                stamps.writeServiceReturn = performance.now();
                if (!written.ok) throw new Error(`Append failed: ${written.error}`);
                const message = written.message;
                if (!message) throw new Error('Runner append returned no row');
                expectedMeterSeq = message.seq;
                const recipients = 'recipientCursorsMessage' in written ? written.recipientCursorsMessage : written.recipientCursors;
                let enteredWriter!: () => void;
                const entered = new Promise<void>(resolve => { enteredWriter = resolve; });
                const release = new Promise<void>(resolve => { releaseWriter = resolve; });
                writer = inTx(async tx => {
                    await tx.account.update({ where: { id: owner.id }, data: { seq: { increment: 1 } } });
                    enteredWriter();
                    await release;
                });
                await entered;
                if (measureTransfer) {
                    // The transfer scenario exercises ordinary delivery. The timing
                    // scenario below separately owns the held-writer stress case.
                    releaseWriter?.();
                    await writer;
                }
                let deliveryTransactions = 0;
                const deliveryTransaction = db.$transaction;
                // Observe the real database boundary: a queued inTx read has
                // not reached Prisma, whereas a PostgreSQL lock wait has.
                db.$transaction = new Proxy(deliveryTransaction, { apply(target, thisArg, args: unknown[]) {
                    deliveryTransactions++;
                    stamps.deliveryTransactionEntered ??= performance.now();
                    return Reflect.apply(target, thisArg, args);
                } });
                const spareRead = provider === 'postgres'
                    ? db.account.findUniqueOrThrow({ where: { id: owner.id }, select: { id: true } })
                        .then(() => { stamps.spareConnectionReadReturned = performance.now(); })
                    : Promise.resolve();
                const publication = (async () => {
                    stamps.actorReadStarted = performance.now();
                    const accountActor = await resolveSessionMessageAccountActor(message);
                    stamps.actorReadReturned = performance.now();
                    stamps.emit = performance.now();
                    await eventRouter.emitUpdate({ userId: owner.id,
                        payload: buildNewMessageUpdate({ ...message, accountActor }, session.id, recipients![0]!.cursor, `follow-${index}`),
                        recipientFilter: { type: 'all-interested-in-session', sessionId: session.id } });
                })();
                let timer: ReturnType<typeof setTimeout> | undefined;
                let deliveryFailed = false;
                let deliveryTransactionsBeforeWriterRelease: number | undefined;
                try {
                    await spareRead;
                    if (provider === 'postgres') {
                        // C43 reserves the other native connection for discovery;
                        // delivery snapshots share the writer's sole inTx permit.
                        // The independent writer must finish without awaiting delivery.
                        deliveryTransactionsBeforeWriterRelease = deliveryTransactions;
                        expect(deliveryTransactionsBeforeWriterRelease).toBe(0);
                        expect(stamps.responseOpened).toBeUndefined();
                        stamps.writerReleased = performance.now();
                        releaseWriter?.();
                        await writer;
                    }
                    const observed = measureTransfer ? await response : await Promise.race([response,
                        new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 1000); })]);
                    const hopMs = (from: string, to: string) => stamps[from] === undefined || stamps[to] === undefined
                        ? null : stamps[to]! - stamps[from]!;
                    if (!measureTransfer) console.info('WAKE3_HOME_TIMING', JSON.stringify({ provider, version, index, httpRoundTripDelayMs,
                        stamps: { ...stamps }, hops: {
                            appendToCommitAcknowledged: hopMs('appendStart', 'commitAcknowledged'),
                            commitToChangeEmit: hopMs('commitAcknowledged', 'emit'),
                            changeEmitToSocketEmit: hopMs('emit', 'socketEmit'),
                            socketEmitToConsumer: hopMs('socketEmit', 'consumer'),
                            consumerToWaiterSignal: hopMs('consumer', 'waiterSignalled'),
                            waiterSignalToResume: hopMs('waiterSignalled', 'waiterResumed'),
                            pageRead: hopMs('pageStart', 'pageEnd'),
                            pageToDaemonReturn: hopMs('pageEnd', 'daemonReturn'),
                            daemonToHttpHeaders: hopMs('daemonReturn', 'httpReturn'),
                            responseOpen: hopMs('httpReturn', 'responseOpened'),
                        }, commitToResponseMs: observed ? hopMs('commitAcknowledged', 'responseOpened') : null,
                        writerReleaseToResponseMs: observed ? hopMs('writerReleased', 'responseOpened') : null,
                        writerHeld: provider !== 'postgres', deliveryTransactionsBeforeWriterRelease,
                        observerConnections, deliveryTransactions, pages: [...pages] }));
                    expect(observed, provider === 'postgres'
                        ? 'Home follow must return after the queued delivery can acquire the released permit'
                        : 'Home follow must return before the next writer releases').not.toBeNull();
                    const deliveryReadyAt = provider === 'postgres' ? stamps.writerReleased! : stamps.commitAcknowledged!;
                    if (!measureTransfer) expect(stamps.responseOpened! - deliveryReadyAt).toBeLessThan(1000);
                    expect(observed).toMatchObject({ status: 200, body: { execution: { ok: true,
                        result: { items: [{ seq: message.seq }], nextCursor: String(message.seq) } } } });
                    const items = observed!.body.execution.result.items;
                    expect(items).toHaveLength(1);
                    // This scalar policy owner admits each transcript page and
                    // each socket recipient disclosure. Action authorization and
                    // document-set admission keep their separate owners.
                    const naturalTranscriptRequests = pages.length - pagesBefore;
                    const naturalDocumentRequests = flowHttp.filter(route => route === `GET /v2/sessions/${session.id}`).length;
                    const recipientDisclosures = ['update:new-message', 'update:message-updated',
                        'update:update-session', 'ephemeral:session-personal-event']
                        .reduce((total, kind) => total + (flowOutgoingKinds[kind] ?? 0), 0);
                    console.info('FLOWBUDGET_TRANSCRIPT_DELIVERY', JSON.stringify({ provider, version, index, httpRoundTripDelayMs,
                        http: Object.fromEntries([...new Set(flowHttp)].map(route => [route, flowHttp.filter(value => value === route).length])),
                        rpc: flowRpc, daemonAuthorizations: flowAuthorizations, messagePushes: flowMessagePushes,
                        permissionChecks: accessChecks.mock.calls.length, inputAdmissions: inputAdmissions.mock.calls.length,
                        policyEvaluations: policyEvaluationCount(), lexicalPolicyEvaluations: lexicalPolicyEntries.map(entry => entry.mock.calls.length),
                        naturalTranscriptRequests, naturalDocumentRequests, recipientDisclosures,
                        outgoingKinds: flowOutgoingKinds,
                        inputPolicyEvaluations, admittedStepPolicyEvaluations,
                        sqlStatements: provider === 'sqlite' ? flowSql.statements : null,
                        messagePages: pages.length - pagesBefore, bodiesReturned: items.length, deliveryTransactions }));
                    // Measured HTTP/SQL totals are informational. Admission follows
                    // the dispatched request; each new input gets one receipt,
                    // while transcript-only Agent output does not re-admit input.
                    if (provider === 'sqlite' && httpRoundTripDelayMs === 0 && !measureTransfer) {
                        expect(flowAuthorizations).toBe(flowRpc);
                        expect(inputAdmissions.mock.calls).toHaveLength(index === 1 ? 1 : 0);
                        expect(pages.slice(pagesBefore, baselinePages)).toHaveLength(1);
                        expect(pages.slice(baselinePages)).toHaveLength(items.length);
                        expect(flowMessagePushes).toBe(items.length * observerConnections);
                        expect(flowSql.statements,
                            'The real SQL observer must see the exercised database boundary').toBeGreaterThan(0);
                        if (enforcePolicyShape) {
                            expect(inputPolicyEvaluations).toBe(index === 1 ? 1 : 0);
                            expect(admittedStepPolicyEvaluations,
                                'Retained input settlement and publisher replies reuse admission').toBe(0);
                            expect(policyEvaluationCount()).toBe(naturalTranscriptRequests
                                + naturalDocumentRequests + recipientDisclosures + (index === 1 ? 1 : 0));
                        }
                    }
                    const nextCursor = observed!.body.execution.result.nextCursor;
                    if (typeof nextCursor !== 'string') throw new Error('Committed row must advance the follow cursor');
                    cursor = nextCursor;
                    expect(observerConnections).toBe(measureTransfer || measureSocketFlow ? 2 : 1);
                    if (measureTransfer && network && meter) {
                        await receivedByMeter;
                        const after = network.entries();
                        const before = new Map(transferBefore.map(entry => [entry.id, entry]));
                        const http = after.filter(entry => !entry.upgraded).map(entry => ({
                            ...entry, delta: entry.responseBodyWireBytes - (before.get(entry.id)?.responseBodyWireBytes ?? 0),
                        })).filter(entry => entry.delta > 0);
                        const ws = after.filter(entry => entry.upgraded && entry.path.includes('transferObserver=measured'));
                        expect(ws).toHaveLength(1);
                        const transport: unknown = meter.io.engine.transport;
                        const websocket: unknown = typeof transport === 'object' && transport !== null ? Reflect.get(transport, 'ws') : null;
                        const extensions: unknown = typeof websocket === 'object' && websocket !== null ? Reflect.get(websocket, 'extensions') : null;
                        console.info('PERFCI_TRANSFER', JSON.stringify({ scenario: 'transcript-follow-heavy-history-v1',
                            provider, encryptionVersion: version, phase: index,
                            history: { rows: history.length, storedContentBytes: history.reduce((total, row) => total + Buffer.byteLength(JSON.stringify(row.content)), 0) },
                            http: { responses: http.length, wireBodyBytes: http.reduce((total, entry) => total + entry.delta, 0),
                                decodedBodyBytes: http.every(entry => entry.responseContentEncoding === null || entry.responseContentEncoding === 'identity')
                                    ? http.reduce((total, entry) => total + entry.delta, 0) : null,
                                contentEncodings: [...new Set(http.map(entry => entry.responseContentEncoding ?? 'none'))] },
                            websocket: { messages: receivedPackets - packetsBefore, decodedPacketBytes: decodedPacketBytes - decodedBefore,
                                wireBytes: ws[0]!.upgradedResponseWireBytes - (before.get(ws[0]!.id)?.upgradedResponseWireBytes ?? 0),
                                extensions: typeof extensions === 'string' ? extensions || 'none' : 'unknown' },
                        }));
                    }
                } catch (error) {
                    deliveryFailed = true;
                    throw error;
                } finally {
                    clearTimeout(timer);
                    releaseWriter?.();
                    try {
                        const outcomes = await Promise.allSettled([writer, publication, response, spareRead]);
                        const errors = outcomes.flatMap(outcome => outcome.status === 'rejected' ? [outcome.reason] : []);
                        if (errors.length > 0) {
                            const error = new AggregateError(errors, 'Transcript-follow delivery cleanup failed');
                            if (!deliveryFailed) throw error;
                            console.error(error);
                        }
                    } finally { db.$transaction = deliveryTransaction; }
                }
            }
            if (measureTransfer) {
                const retained = await db.sessionMessage.findMany({ where: { sessionId: session.id, seq: { lte: history.length } },
                    orderBy: { seq: 'asc' }, select: { seq: true, content: true } });
                expect(retained).toEqual(history.map(row => ({ seq: row.seq, content: row.content })));
            }
            if (enforceStreamShape) {
                expect(streamCounts).toBeDefined();
                // Connect admitted the publisher; each chunk only asks the audience owner who receives it.
                expect(streamCounts?.structuralAccessChecks, 'Reply chunks must not reopen publisher authority').toBe(0);
                expect(streamCounts?.accessKeyReads).toBe(0);
                expect(streamCounts?.audienceReads).toBe(streamCounts?.publicationAdmissions);
            }
        } catch (error) {
            testFailed = true;
            throw error;
        } finally {
            accessChecks.mockRestore();
            for (const entry of lexicalPolicyEntries) entry.mockRestore();
            inputAdmissions.mockRestore();
            publicationAdmissions.mockRestore();
            structuralAccessChecks.mockRestore();
            audienceReads.mockRestore();
            releaseWriter?.();
            abort.abort();
            const cleanupErrors: unknown[] = [];
            for (const cleanup of [
                async () => { await registry.dispose(); },
                async () => {
                    daemon.disconnect();
                    runner.disconnect();
                    meter?.disconnect();
                    eventRouter.clearIo();
                    await new Promise<void>(resolve => io.close(() => resolve()));
                },
                async () => { await network?.stop(); },
                async () => { await app.close(); },
                async () => {
                    if (provider !== 'postgres') return;
                    // The deletion owner removes transcript children before their parent.
                    expect(await deleteOwnedSession({ sessionId: session.id, reason: 'retention_policy' }))
                        .toEqual({ ok: true });
                    await db.machine.delete({ where: { id: machine.id } });
                    await db.account.delete({ where: { id: owner.id } });
                },
            ]) {
                try { await cleanup(); } catch (error) { cleanupErrors.push(error); }
            }
            if (cleanupErrors.length > 0) {
                const cleanupError = new AggregateError(cleanupErrors, 'Transcript-follow fixture cleanup failed');
                if (!testFailed) throw cleanupError;
                // Keep the deciding response assertion as the test failure.
                console.error(cleanupError);
            }
        }
    };
    it.each([1, 2] as const)(enforcePolicyShape ? 'FLOWBUDGET V%s input and reply admit policy once per natural request'
        : measureTransfer ? 'reports V%s transfer after heavy history without changing retained content' : provider === 'postgres'
        ? 'queues committed rows through V%s behind a held writer, then returns with a retained subscription'
        : 'returns committed rows promptly through V%s, with a held writer and retained subscription', version => runJourney(version));
    if (measureSocketFlow) {
        // Measured 2026-10-31 in both modes (sqlite): 3 chunks -> 3 received frames,
        // SQL 60 -> 42 once the publisher decisions left the chunk path. Audience
        // reads stay one per chunk: recipients are the current census (CR-12).
        // Totals are information, never limits.
        it.each([1, 2] as const)('FLOWBUDGET V%s reply chunks reuse admitted publication authority', version => runJourney(version, true));
    }
});
}
