import Fastify from 'fastify';
import { performance } from 'node:perf_hooks';
import { Server, type Socket } from 'socket.io';
import { io as connect } from 'socket.io-client';
import tweetnacl from 'tweetnacl';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createExternalActionDaemonDispatchResponse, EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1,
    parseExternalActionResponseEnvelopeV1, getActionSpec,
    type ExternalActionDaemonDispatchRequest } from '@happier-dev/protocol/actions';
import { sealExternalActionRequestV2, openExternalActionResponseV2 } from '@happier-dev/protocol/actions/externalActionEncryption';
import { createMachineDataEncryptionKeyV1 } from '@happier-dev/protocol/machines/machineStoredContent';
import { SOCKET_RPC_EVENTS, type SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol';
import { decodeBase64 } from 'privacy-kit';

import { createServerBackedSessionTranscriptStore } from '../../../../cli/src/api/session/createServerBackedSessionTranscriptStore';
import { createSessionTranscriptFollowLeaseRegistry } from '../../../../cli/src/api/session/followSessionTranscript';
import { executeCliTranscriptAction } from '../../../../cli/src/session/actions/executeCliTranscriptAction';
import { createCliActionDeps } from '../../../../cli/src/session/actions/createCliActionDeps';
import { executeExternalAction } from '../../../../cli/src/daemon/externalActions/executeExternalAction';
import { createDaemonExternalActionTargetResolver } from '../../../../cli/src/daemon/externalActions/daemonExternalActionTargetResolver';
import { runWithServerHttpBaseUrl } from '../../../../cli/src/api/client/serverHttpBaseUrl';
import { sealSessionStoredContent, type SessionStoredContentCryptoContext } from '../../../../cli/src/session/transport/encryption/sessionStoredContentCodec';
import type { Fastify as AppFastify } from '@/app/api/types';
import { enableAuthentication } from '@/app/api/utils/enableAuthentication';
import { registerExternalActionRoutes } from '@/app/api/routes/actions/registerExternalActionRoutes';
import { registerSessionMessageRoutes } from '@/app/api/routes/session/registerSessionMessageRoutes';
import { createExternalActionDaemonDispatcher } from '@/app/api/socket/externalActionDispatcher';
import { buildRpcMethodRoom } from '@/app/api/socket/rpc/rpcMethodRoom';
import { qualifyCurrentAccountStoredContentSocket, currentAccountStoredContentCompatibilityHeaders } from '@/app/api/testkit/accountStoredContentCompatibility';
import { auth } from '@/app/auth/auth';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { verifyCurrentExternalActionPrincipal } from '@/app/auth/externalActionExecutionAuthorization';
import { createSessionMessage } from '@/app/session/sessionWriteService';
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

export function registerTranscriptFollowTimingTests(provider: 'sqlite' | 'postgres'): void {
describe(`Home Action transcript follow through real HTTP, RPC, Socket.IO and ${provider}`, () => {
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

    it.each([1, 2] as const)('returns committed rows promptly through V%s, with a held writer and retained subscription', async version => {
        const material = version === 2 ? { type: 'dataKey' as const, machineKey: tweetnacl.randomBytes(32) } : null;
        const contentPublicKey = material ? tweetnacl.box.keyPair.fromSecretKey(material.machineKey).publicKey : null;
        const owner = await db.account.create({ data: contentPublicKey
            ? { ...createSignedAccountContentBinding(contentPublicKey), encryptionMode: 'e2ee' }
            : { publicKey: crypto.randomUUID(), encryptionMode: 'plain' } });
        const sessionKey = material ? createMachineDataEncryptionKeyV1({ material, randomBytes: tweetnacl.randomBytes }) : null;
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
            operationProtocolCapabilities: { externalActionExecutionAuthorization: { protocolVersions: [1] } } } });
        const session = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(),
            encryptionMode: contentContext.mode, dataEncryptionKey: sessionKey?.dataEncryptionKey,
            metadata: sealedMetadata.t === 'encrypted' ? sealedMetadata.c : JSON.stringify({ t: 'plain', v: {} }) } });
        await db.accessKey.create({ data: { accountId: owner.id, sessionId: session.id, machineId: machine.id, data: 'test' } });
        const token = await auth.createToken(owner.id, undefined, { kind: 'account', authority: 'present_user' });
        const pat = await auth.createApiToken({ accountId: owner.id, tokenId: crypto.randomUUID(), label: 'follow harness' });
        const serverIdentityId = await getOrCreateServerIdentityId();
        const raw = Fastify();
        raw.setValidatorCompiler(validatorCompiler);
        raw.setSerializerCompiler(serializerCompiler);
        const app = raw.withTypeProvider<ZodTypeProvider>() as unknown as AppFastify;
        const io = new Server(raw.server, { path: '/v1/updates/' });
        eventRouter.setIo(io);
        let observerConnections = 0;
        const stamps: Record<string, number> = {};
        const pages: { start: number; end?: number }[] = [];
        let receivedRunner!: (socket: Socket) => void;
        const runnerSocket = new Promise<Socket>(resolve => { receivedRunner = resolve; });
        app.addHook('onRequest', async request => {
            if (request.url.startsWith(`/v1/sessions/${session.id}/messages`)) pages.push({ start: performance.now() });
        });
        app.addHook('onResponse', async request => {
            if (request.url.startsWith(`/v1/sessions/${session.id}/messages`)) pages.at(-1)!.end = performance.now();
        });
        enableAuthentication(app);
        registerSessionMessageRoutes(app);
        registerExternalActionRoutes(app, { dispatch: createExternalActionDaemonDispatcher({ io }) });
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
                void socket.join(`session:${session.id}:${owner.id}`);
                if (socket.handshake.auth.runner === true) receivedRunner(socket);
            }
        });
        const endpoint = await app.listen({ host: '127.0.0.1', port: 0 });
        const registry = createSessionTranscriptFollowLeaseRegistry({ idleTtlMs: 600_000 });
        const store = createServerBackedSessionTranscriptStore({ token, sessionId: session.id, ...contentContext });
        const observedStore = { ...store,
            readAfter: async (input?: unknown) => {
                stamps.pageStart = performance.now();
                const page = await store.readAfter(input);
                stamps.pageEnd = performance.now();
                return page;
            },
            observeChanges: (listener: Parameters<NonNullable<typeof store.observeChanges>>[0],
                onError: Parameters<NonNullable<typeof store.observeChanges>>[1]) => store.observeChanges!(change => {
                    stamps.consumer = performance.now();
                    listener(change);
                    stamps.waiterSignalled = performance.now();
                }, onError),
        };
        const executor = createActionExecutor({ ...createCliActionDeps({ token, sessionId: session.id, ...contentContext }),
            sessionTranscriptAction: args => executeCliTranscriptAction({ ...args,
            defaultSessionId: session.id, options: { transcriptSessionId: session.id, transcriptStore: observedStore,
                transcriptFollowLeaseRegistry: registry } }) });
        const daemon = connect(endpoint, { path: '/v1/updates/', transports: ['websocket'],
            reconnection: false, auth: { clientType: 'machine-scoped' } });
        const runner = connect(endpoint, { path: '/v1/updates/', transports: ['websocket'],
            reconnection: false, auth: { clientType: 'session-scoped', runner: true } });
        const abort = new AbortController();
        daemon.on(SOCKET_RPC_EVENTS.REQUEST, async (rpc: SocketRpcRequestPayload, acknowledge: (value: unknown) => void) => {
            const request = rpc.params as ExternalActionDaemonDispatchRequest;
            stamps.dispatch = performance.now();
            const result = await runWithServerHttpBaseUrl(endpoint, () => executeExternalAction({
                ...request, currentMachineId: machine.id, currentServerId: 'follow-test',
                currentInstallationId: machine.installationId!, externalActionMachineRequestPrivateKey: keyPair.secretKey,
                verifyExecutionAuthorization: async ({ authorization }) => Boolean(await verifyCurrentExternalActionPrincipal(authorization.binding)),
                ...(material ? { resolveEncryption: async () => ({ serverIdentityId, material }) } : {}),
                resolveTarget: createDaemonExternalActionTargetResolver({ credentials: { token, encryption: null },
                    serverApiUrl: endpoint }), executor, signal: abort.signal,
            }));
            stamps.daemonReturn = performance.now();
            acknowledge(result.kind === 'response' ? createExternalActionDaemonDispatchResponse(result.prepared) : result);
        });
        daemon.on(SOCKET_RPC_EVENTS.CANCEL, () => abort.abort());
        let releaseWriter: (() => void) | undefined;
        let writer: Promise<void> | undefined;
        const headers = { authorization: `Bearer ${material ? token : pat.token}`, 'content-type': 'application/json',
            ...currentAccountStoredContentCompatibilityHeaders };
        const follow = (cursor: string) => {
            const binding = { serverIdentityId, accountId: owner.id, actionId: 'transcript.follow' as const,
                requestId: crypto.randomUUID(), target: { kind: 'machine' as const, machineId: machine.id },
                authentication: { kind: 'account' as const, tokenEpoch: owner.tokenEpoch } };
            const input = { sessionId: session.id, cursor, leaseId: 'home-follow', waitForChanges: true };
            const envelope = material ? sealExternalActionRequestV2({ binding, input, material, randomBytes: tweetnacl.randomBytes })
                : { v: 1 as const, requestId: binding.requestId, target: binding.target, input };
            stamps.httpStart = performance.now();
            return fetch(`${endpoint}/v1/actions/transcript.follow`, { method: 'POST', headers, body: JSON.stringify(envelope) })
                .then(async http => {
                    stamps.httpReturn = performance.now();
                    const body: unknown = await http.json();
                    const execution = material && envelope.v === 2
                        ? openExternalActionResponseV2({ binding, material, request: envelope, envelope: body })
                        : parseExternalActionResponseEnvelopeV1(body)?.execution;
                    if (!execution?.ok) throw new Error(`Home Action failed: ${JSON.stringify(body)}`);
                    const result = getActionSpec('transcript.follow').outputSchema.parse(execution.result);
                    return { status: http.status, body: { execution: { ok: true, result } } };
                });
        };
        try {
            await new Promise<void>((resolve, reject) => { daemon.once('connect', resolve); daemon.once('connect_error', reject); });
            const binding = { accountId: owner.id, machineId: machine.id, sessionId: session.id };
            const presence = createSessionPublisherPresence();
            const registration = await presence.registerPublisher({ socket: await runnerSocket, binding,
                completeActivitySnapshot: { state: 'idle', activeCount: 0 } });
            if (registration.status !== 'registered') throw new Error('Runner publisher claim failed');
            const publisherAuthority = { ...binding, committedFence: registration.committedFence };
            let cursor = 'tail';
            for (let index = 1; index <= 2; index++) {
                if (index === 1) {
                    expect(await enqueuePendingMessage({ actorUserId: owner.id,
                        authentication: createPresentUserSessionAccessAuthentication(), sessionId: session.id,
                        localId: 'follow-1', targetMachineId: machine.id, requestedAction: { v: 1, kind: 'send_now' },
                        content: sealSessionStoredContent({ ...contentContext,
                            payload: { role: 'user', content: { type: 'text', text: 'row-1' } } }) })).toMatchObject({ ok: true });
                    expect(await materializeNextPendingMessage({ actorUserId: owner.id, sessionId: session.id,
                        deliveryState: 'provider', deliveryTiming: 'after_foreground_ready', foregroundState: 'ready', publisherAuthority }))
                        .toMatchObject({ ok: true, didMaterialize: true });
                }
                const priorPages = pages.length;
                for (const key of Object.keys(stamps)) delete stamps[key];
                const response = follow(cursor);
                void response.catch(() => undefined);
                // Wait for a real baseline response. This is test readiness, not product polling.
                await expect.poll(() => pages.length > priorPages && pages.at(-1)?.end !== undefined).toBe(true);
                stamps.appendStart = performance.now();
                const written = index === 1
                    ? await resolveAcceptedPendingDelivery({ actorUserId: owner.id, sessionId: session.id, localId: 'follow-1', publisherAuthority })
                    : await createSessionMessage({ inputAdmission: 'transcriptOnly', actorUserId: owner.id, publisherAuthority,
                        sessionId: session.id, localId: `follow-${index}`, messageRole: 'agent',
                        content: sealSessionStoredContent({ ...contentContext,
                            payload: { role: 'agent', content: { type: 'text', text: `row-${index}` } } }) });
                stamps.commit = performance.now();
                if (!written.ok) throw new Error(`Append failed: ${written.error}`);
                const message = written.message;
                if (!message) throw new Error('Runner append returned no row');
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
                const publication = (async () => {
                    const accountActor = await resolveSessionMessageAccountActor(message);
                    stamps.emit = performance.now();
                    await eventRouter.emitUpdate({ userId: owner.id,
                        payload: buildNewMessageUpdate({ ...message, accountActor }, session.id, recipients![0]!.cursor, `follow-${index}`),
                        recipientFilter: { type: 'all-interested-in-session', sessionId: session.id } });
                })();
                let timer: ReturnType<typeof setTimeout> | undefined;
                try {
                    const observed = await Promise.race([response,
                        new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 1000); })]);
                    console.info('WAKE2_HOME_TIMING', JSON.stringify({ provider, version, index, stamps: { ...stamps },
                        commitToResponseMs: observed ? stamps.httpReturn! - stamps.commit! : null, writerHeld: true,
                        observerConnections, pages: [...pages] }));
                    expect(observed, 'Home follow must return before the next writer releases').not.toBeNull();
                    expect(observed).toMatchObject({ status: 200, body: { execution: { ok: true,
                        result: { items: [{ seq: message.seq }], nextCursor: String(message.seq) } } } });
                    const items = observed!.body.execution.result.items;
                    expect(items).toHaveLength(1);
                    const nextCursor = observed!.body.execution.result.nextCursor;
                    if (typeof nextCursor !== 'string') throw new Error('Committed row must advance the follow cursor');
                    cursor = nextCursor;
                    expect(observerConnections).toBe(1);
                } finally {
                    clearTimeout(timer);
                    releaseWriter?.();
                    await writer;
                    await publication;
                    await response;
                }
            }
        } finally {
            releaseWriter?.();
            abort.abort();
            await registry.dispose();
            daemon.disconnect();
            runner.disconnect();
            eventRouter.clearIo();
            await new Promise<void>(resolve => io.close(() => resolve()));
            await app.close();
            if (provider === 'postgres') {
                await db.session.delete({ where: { id: session.id } });
                await db.account.delete({ where: { id: owner.id } });
            }
        }
    });
});
}
