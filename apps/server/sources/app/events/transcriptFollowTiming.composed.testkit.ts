import { projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import Fastify from 'fastify';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Server, type Socket } from 'socket.io';
import { io as connect } from 'socket.io-client';
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
import { eventRouter } from './connectionEventRouter';
import { buildNewMessageUpdate } from './eventPayloadBuilders';

export function registerTranscriptFollowTimingTests(provider: 'sqlite' | 'postgres',
    httpRoundTripDelayMs = 0, scenario: 'timing' | 'heavy-history-transfer' = 'timing'): void {
const measureTransfer = scenario === 'heavy-history-transfer';
describe(`Home Action transcript follow through real HTTP, RPC, Socket.IO and ${provider}, HTTP delay ${httpRoundTripDelayMs}ms${measureTransfer ? ', heavy-history-transfer' : ''}`, () => {
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

    it.each([1, 2] as const)(measureTransfer ? 'reports V%s transfer after heavy history without changing retained content' : provider === 'postgres'
        ? 'queues committed rows through V%s behind a held writer, then returns with a retained subscription'
        : 'returns committed rows promptly through V%s, with a held writer and retained subscription', async version => {
        const material = version === 2 ? { type: 'dataKey' as const, machineKey: tweetnacl.randomBytes(32) } : null;
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
        const pat = await auth.createApiToken({ accountId: owner.id, tokenId: crypto.randomUUID(), label: 'follow harness' });
        const serverIdentityId = await getOrCreateServerIdentityId();
        const raw = Fastify();
        enableSchemaValidation(raw);
        const app = raw.withTypeProvider<ZodTypeProvider>() as unknown as AppFastify;
        const io = new Server(raw.server, { path: '/v1/updates/' });
        eventRouter.setIo(io);
        let observerConnections = 0;
        const stamps: Record<string, number> = {};
        const pages: { url: string; start: number; end?: number }[] = [];
        let baselineRead: (() => void) | undefined;
        let receivedRunner!: (socket: Socket) => void;
        const runnerSocket = new Promise<Socket>(resolve => { receivedRunner = resolve; });
        app.addHook('onRequest', async request => {
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
                    if (socket.handshake.auth.runner !== true && event === 'update'
                        && payload && typeof payload === 'object' && 'body' in payload
                        && payload.body && typeof payload.body === 'object' && 't' in payload.body
                        && payload.body.t === 'new-message') stamps.socketEmit = performance.now();
                });
                void socket.join(`session:${session.id}:${owner.id}`);
                if (socket.handshake.auth.runner === true) receivedRunner(socket);
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
        const meter = measureTransfer ? connect(endpoint, { path: '/v1/updates/', transports: ['websocket'],
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
        const abort = new AbortController();
        daemon.on(SOCKET_RPC_EVENTS.REQUEST, async (rpc: SocketRpcRequestPayload, acknowledge: (value: unknown) => void) => {
            const request = rpc.params as ExternalActionDaemonDispatchRequest;
            stamps.dispatch = performance.now();
            const result = await runWithServerHttpBaseUrl(endpoint, () => executeExternalAction({
                ...request, currentMachineId: machine.id, currentServerId: 'follow-test',
                currentInstallationId: machine.installationId!, externalActionMachineRequestPrivateKey: keyPair.secretKey,
                verifyExecutionAuthorization: async ({ authorization }) => Boolean(await verifyCurrentExternalActionPrincipal(authorization.binding)),
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
                if (index === 1) {
                    const enqueued = await enqueuePendingMessage({ actorUserId: owner.id,
                        authentication: createPresentUserSessionAccessAuthentication(), sessionId: session.id,
                        localId: 'follow-1', targetMachineId: machine.id, requestedAction: { v: 1, kind: 'send_now' },
                        content: sealSessionStoredContent({ ...contentContext,
                            payload: { role: 'user', content: { type: 'text', text: 'row-1' } } }) });
                    if (!enqueued.ok) throw new Error(`Canonical pending admission failed: ${JSON.stringify(enqueued)}`);
                    expect(await materializeNextPendingMessage({ actorUserId: owner.id, sessionId: session.id,
                        deliveryState: 'provider', deliveryTiming: 'after_foreground_ready', foregroundState: 'ready', publisherAuthority }))
                        .toMatchObject({ ok: true, didMaterialize: true });
                }
                const baseline = new Promise<void>(resolve => { baselineRead = resolve; });
                for (const key of Object.keys(stamps)) delete stamps[key];
                const response = follow(cursor);
                // Observe completion or admission failure directly; never poll readiness.
                await Promise.race([baseline, response.then(() => {
                    throw new Error('Home follow returned before a transcript baseline was read');
                })]);
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
                    const nextCursor = observed!.body.execution.result.nextCursor;
                    if (typeof nextCursor !== 'string') throw new Error('Committed row must advance the follow cursor');
                    cursor = nextCursor;
                    expect(observerConnections).toBe(measureTransfer ? 2 : 1);
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
        } catch (error) {
            testFailed = true;
            throw error;
        } finally {
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
    });
});
}
