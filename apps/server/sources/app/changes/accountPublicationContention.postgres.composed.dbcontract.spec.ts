import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { AsyncLocalStorage } from 'node:async_hooks';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ChangesResponseSchema } from '@happier-dev/protocol/changes';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent, UsageEventIngestRequestSchema, ApprovalRequestV2Schema,
    MACHINE_PLAIN_DATA_KEY_MARKER, encodePlainMachineStoredContent } from '@happier-dev/protocol';
import type { ActionExecutorDeps } from '@happier-dev/protocol';
import type { FastifyRequest } from 'fastify';
import * as privacyKit from 'privacy-kit';

import { db, initDbPostgres } from '@/storage/db';
import { getDbProviderFromEnv } from '@/storage/prisma';
import type { Tx } from '@/storage/inTx';
import { enqueuePendingMessageByAuthenticatedMachine, materializeNextPendingMessage } from '@/app/session/pending/pendingMessageService';
import { createAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { changesRoutes } from '@/app/api/routes/changes/changesRoutes';
import { artifactsRoutes } from '@/app/api/routes/artifacts/artifactsRoutes';
import { createSessionPublisherPresence } from '@/app/presence/sessionPublisherPresence';
import { createSessionMessage } from '@/app/session/sessionWriteService';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { setSessionFollowSource } from '@/app/session/follow/sessionFollowEdgeService';
import { recordUsageEvent } from '@/app/usage/usageWriteService';
import { updateArtifact } from '@/app/artifacts/artifactWriteService';
import { mutateQualifiedConnectedServiceCredential } from '@/app/api/routes/connect/qualifiedConnectedAccounts/credentialRepository';
import { writeQualifiedProviderAccountUsageRecord } from '@/app/api/routes/connect/qualifiedConnectedAccounts/usageRepository';
import { createProviderAccountUsageRecordKey, createUsageSnapshot } from '@/app/api/routes/connect/providerAccountUsageTestkit';
import { initEncrypt } from '@/modules/encrypt';
import { observeLazyPrismaQuery } from './accountPublicationContention.testkit';

async function importCliModule<T>(specifier: string): Promise<T> {
    // Real cross-owner consumer, without widening the server compiler root.
    return await import(specifier) as T;
}
const { createCliApprovalsArtifactStore } = await importCliModule<{
    createCliApprovalsArtifactStore: (options: unknown) => {
        approvalsCreate: NonNullable<ActionExecutorDeps['approvalsCreate']>;
        approvalsGet: NonNullable<ActionExecutorDeps['approvalsGet']>;
        approvalsUpdate: NonNullable<ActionExecutorDeps['approvalsUpdate']>;
    };
}>('../../../../cli/src/session/actions/approvals/artifactStore');
const { runWithServerHttpBaseUrl } = await importCliModule<{
    runWithServerHttpBaseUrl: <T>(url: string, run: () => Promise<T>) => Promise<T>;
}>('../../../../cli/src/api/client/serverHttpBaseUrl');

interface TransactionMeasurement {
    owner: string;
    pid: number;
    enteredAt: number;
    lockRequestedAt?: number;
    lockAcquiredAt?: number;
    firstPendingInsertAt?: number;
    publicationStartedAt?: number;
    callbackEndedAt?: number;
    settledAt?: number;
    queries: { operation: string; startedAt: number; endedAt: number }[];
}

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('Account publication contention with real Machine admissions', () => {
    beforeAll(async () => {
        if (!process.env.DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Account publication load requires the disposable PostgreSQL contract database');
        }
        initDbPostgres();
        await db.$connect();
    });
    afterAll(async () => { await db.$disconnect(); });

    it('keeps concurrent distinct-Session admissions durable and exposes Account lock acquisition and hold times', async () => {
        const account = await db.account.create({ data: { publicKey: `publication-load-${randomUUID()}`, encryptionMode: 'plain' } });
        const originalTransaction = db.$transaction;
        const measurements: TransactionMeasurement[] = [];
        const waiterSamples: { sampledAt: number; waiters: number; blockedByMeasuredTransactions: number }[] = [];
        let signalSample!: () => void;
        const nextSampleSignal = () => new Promise<void>(resolve => { signalSample = resolve; });
        let sampleSignal = nextSampleSignal();
        const app = createAuthenticatedTestApp();
        const operationOwner = new AsyncLocalStorage<string>();
        const measured = <T>(owner: string, operation: () => Promise<T>) => operationOwner.run(owner, async () => {
            try { return await operation(); }
            catch (error) { console.error('INT_ACCTLOCK_OWNER_FAILED', owner, error); throw error; }
        });
        vi.stubEnv('HAPPIER_SERVER_IDENTITY_ID', `srv_${'a'.repeat(32)}`);
        vi.stubEnv('HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY', 'optional');
        vi.stubEnv('HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_ARTIFACTS_AT_REST', 'none');
        vi.stubEnv('HAPPIER_FEATURE_SESSIONS__ENABLED', '1');
        vi.stubEnv('HAPPIER_FEATURE_SESSIONS_FOLLOWING__ENABLED', '1');
        vi.stubEnv('HANDY_MASTER_SECRET', 'account-lock-disposable-test-secret');
        try {
            await initEncrypt();
            const machine = await db.machine.create({ data: {
                id: randomUUID(), accountId: account.id, metadata: encodePlainMachineStoredContent({}),
                dataEncryptionKey: privacyKit.decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER), installationId: randomUUID(),
                operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1] } },
                operationProtocolCapabilitiesRevision: 1,
            } });
            const sessions = await Promise.all(Array.from({ length: 12 }, () => db.session.create({ data: {
                accountId: account.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain',
            } })));
            for (const session of sessions) await db.accessKey.create({ data: {
                accountId: account.id, machineId: machine.id, sessionId: session.id, data: 'encrypted',
            } });
            const bytes = (value: unknown) => privacyKit.decodeBase64(encodePlainArtifactStoredContent(value));
            const artifacts = await Promise.all(sessions.map(() => db.artifact.create({ data: {
                id: randomUUID(), accountId: account.id, header: bytes({ title: 'Contention fixture' }), body: bytes({ body: 'before' }),
                dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER), headerVersion: 1, bodyVersion: 1,
            } })));
            const authentication = createPresentUserSessionAccessAuthentication({ env: process.env });
            const presence = createSessionPublisherPresence();
            const publishers = await Promise.all(sessions.map(async session => {
                const socket = {};
                const registration = await presence.registerPublisher({ socket,
                    binding: { accountId: account.id, machineId: machine.id, sessionId: session.id },
                    completeActivitySnapshot: { state: 'idle', activeCount: 0 } });
                if (registration.status !== 'registered') throw new Error(`Publisher setup failed: ${registration.reason}`);
                return { socket, binding: { accountId: account.id, machineId: machine.id, sessionId: session.id }, registration };
            }));
            app.addHook('onRequest', async (request: FastifyRequest) => { request.headers['x-test-user-id'] = account.id; });
            artifactsRoutes(app);
            changesRoutes(app);
            const origin = await app.listen({ host: '127.0.0.1', port: 0 });
            const approvalStore = createCliApprovalsArtifactStore({ credentials: { token: 'fixture', encryption: null },
                serverId: 'home', serverHttpBaseUrl: origin, getAccountEncryptionMode: async () => 'plain' });
            const approvals = await runWithServerHttpBaseUrl(origin, async () => Promise.all(sessions.map(async session => {
                const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'approved', createdAtMs: 1, updatedAtMs: 2,
                    createdBy: { surface: 'cli' }, requestedSurface: 'cli', actionId: 'session.delete',
                    actionArgs: { sessionId: session.id }, summary: 'Delete fixture Session',
                    decision: { kind: 'approve', decidedAtMs: 2 },
                    executionOriginV1: { v: 1, authority: 'present_user', surface: 'cli', caller: { kind: 'host' },
                        serverId: 'home', sessionId: session.id, actionId: 'session.delete', requestId: randomUUID() } });
                return { request, ...(await approvalStore.approvalsCreate({ request, serverId: null })) };
            })));
            const usageCredentials = await Promise.all(sessions.map(async (_session, index) => {
                const providerAccountId = `provider-${index}`;
                const ref = { service: { pluginId: 'example.connected-accounts', localId: 'contention' }, accountId: `qualified-${index}` };
                const credential = await mutateQualifiedConnectedServiceCredential({ accountId: account.id, ref,
                    expectedCredentialRevision: null, authenticationModeId: 'api-key', content: { t: 'plain', v: { token: 'fixture' } },
                    metadata: { scopes: [], providerIdentity: { accountId: providerAccountId } } });
                if (credential.status !== 'written') throw new Error('Expected qualified usage credential');
                return { ref, credentialRevision: credential.credentialRevision, providerAccountId };
            }));

            // Prisma is the only interposition boundary. Every query, lock,
            // admission decision, queue allocation and commit below is real.
            // The PID query adds one round trip before the measured critical
            // section; there are no barriers, sleeps or injected remote work.
            db.$transaction = new Proxy(originalTransaction, {
                apply(target, thisArg, args) {
                    const operation: unknown = args[0];
                    if (typeof operation !== 'function') return Reflect.apply(target, thisArg, args);
                    let measurement: TransactionMeasurement | undefined;
                    const result: unknown = Reflect.apply(target, thisArg, [async (tx: Tx) => {
                        const rows = await tx.$queryRawUnsafe<{ pid: number }[]>('SELECT pg_backend_pid() AS pid');
                        const current: TransactionMeasurement = { owner: operationOwner.getStore() ?? 'approval-claim',
                            pid: rows[0].pid, enteredAt: performance.now(), queries: [] };
                        measurement = current;
                        measurements.push(current);
                        const delegates = new Map<PropertyKey, object>();
                        const instrumented = new Proxy(tx, {
                            get(owner, property, receiver) {
                                const member: unknown = Reflect.get(owner, property, receiver);
                                if (['$queryRawUnsafe', '$executeRawUnsafe', '$queryRaw', '$executeRaw'].includes(String(property)) && typeof member === 'function') {
                                    return (...queryArgs: unknown[]) => {
                                        const candidate = queryArgs[0];
                                        const fragments: unknown = candidate && typeof candidate === 'object' ? Reflect.get(candidate, 'strings') : undefined;
                                        const query = typeof candidate === 'string' ? candidate
                                            : Array.isArray(candidate) ? candidate.join('?')
                                                : Array.isArray(fragments) ? fragments.join('?') : 'raw SQL';
                                        const accountLock = /(?:FROM|UPDATE)\s+"Account"/.test(query)
                                            && (/FOR (?:NO KEY )?UPDATE/.test(query) || /UPDATE\s+"Account"/.test(query));
                                        return observeLazyPrismaQuery(Reflect.apply(member, owner, queryArgs), () => {
                                            let startedAt = 0;
                                            let firstAccountLock = false;
                                            return {
                                                started() {
                                                    startedAt = performance.now();
                                                    if (query.includes('INSERT INTO "AccountChange"')) current.publicationStartedAt ??= startedAt;
                                                    firstAccountLock = accountLock && current.lockRequestedAt === undefined;
                                                    if (firstAccountLock) {
                                                        current.lockRequestedAt = startedAt;
                                                        signalSample();
                                                    }
                                                },
                                                settled(succeeded) {
                                                    const endedAt = performance.now();
                                                    current.queries.push({ operation: query.replace(/\s+/g, ' ').trim(), startedAt, endedAt });
                                                    if (succeeded && firstAccountLock) {
                                                        current.lockAcquiredAt = endedAt;
                                                        signalSample();
                                                    }
                                                },
                                            };
                                        });
                                    };
                                }
                                if (typeof member !== 'object' || member === null || typeof property !== 'string'
                                    || property.startsWith('$') || property.startsWith('_')
                                    || typeof Reflect.get(member, 'findMany') !== 'function') {
                                    return member;
                                }
                                const existing = delegates.get(property);
                                if (existing) return existing;
                                const delegate = new Proxy(member, {
                                    get(delegateOwner, method, delegateReceiver) {
                                        const execute: unknown = Reflect.get(delegateOwner, method, delegateReceiver);
                                        if (typeof execute !== 'function') return execute;
                                        return (...queryArgs: unknown[]) => {
                                            return observeLazyPrismaQuery(Reflect.apply(execute, delegateOwner, queryArgs), () => {
                                                let startedAt = 0;
                                                let firstAccountUpdate = false;
                                                return {
                                                    started() {
                                                        startedAt = performance.now();
                                                        firstAccountUpdate = property === 'account' && ['update', 'updateMany'].includes(String(method))
                                                            && current.lockRequestedAt === undefined;
                                                        if (firstAccountUpdate) current.lockRequestedAt = startedAt;
                                                    },
                                                    settled(succeeded) {
                                                        const endedAt = performance.now();
                                                        if (succeeded && firstAccountUpdate) current.lockAcquiredAt = endedAt;
                                                        current.queries.push({ operation: `${property}.${String(method)}`, startedAt, endedAt });
                                                        if (succeeded && property === 'sessionPendingMessage' && method === 'create') current.firstPendingInsertAt ??= endedAt;
                                                    },
                                                };
                                            });
                                        };
                                    },
                                });
                                delegates.set(property, delegate);
                                return delegate;
                            },
                        });
                        try {
                            return await Reflect.apply(operation, undefined, [instrumented]);
                        } finally {
                            current.callbackEndedAt = performance.now();
                        }
                    }, ...args.slice(1)]);
                    return Promise.resolve(result).finally(() => {
                        if (measurement) measurement.settledAt = performance.now();
                        signalSample();
                    });
                },
            });

            const loadStartedAt = performance.now();
            for (let wave = 0; wave < 2; wave++) {
                let finished = false;
                const admissions = Promise.allSettled(sessions.map(session => {
                    const localId = `publication-${wave}-${randomUUID()}`;
                    return measured('pending-enqueue', () => enqueuePendingMessageByAuthenticatedMachine({
                        accountId: account.id, sourceMachineId: machine.id, targetMachineId: machine.id,
                        sessionId: session.id, localId, content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'test-input' } } },
                        requestedAction: { v: 1, kind: 'enqueue' },
                    })).then(result => ({ result, localId }));
                })).finally(() => { finished = true; signalSample(); });
                // Observe actual backend waits, including transactionid and
                // tuple waits, instead of assuming elapsed time means a lock.
                while (!finished) {
                    const pids = [...new Set(measurements.map(row => row.pid))];
                    const rows = await db.$queryRawUnsafe<{ waiters: number; blocked: number }[]>(
                        `SELECT count(*)::int AS waiters,
                            count(*) FILTER (WHERE pg_blocking_pids(pid) && $1::int[])::int AS blocked
                         FROM pg_stat_activity
                         WHERE pid = ANY($1::int[]) AND wait_event_type = 'Lock'
                            AND query LIKE '%"Account"%'`, pids,
                    );
                    waiterSamples.push({ sampledAt: performance.now(), waiters: rows[0].waiters,
                        blockedByMeasuredTransactions: rows[0].blocked });
                    // Lock entry/acquisition and transaction settlement drive
                    // the observer; continuous census traffic would perturb load.
                    if (!finished) {
                        await sampleSignal;
                        sampleSignal = nextSampleSignal();
                    }
                }
                for (const admission of await admissions) {
                    if (admission.status === 'rejected') throw admission.reason;
                    expect(admission.value.result).toEqual({ status: 'accepted', localId: admission.value.localId });
                }
            }
            const lockMeasurements = measurements.filter(row => row.lockAcquiredAt !== undefined);
            const duration = (end: number | undefined, start: number | undefined) =>
                end !== undefined && start !== undefined ? Number((end - start).toFixed(3)) : null;
            console.info('FIX107_ACCOUNT_PUBLICATION_CONTENTION', JSON.stringify({
                sessions: sessions.length, acceptedInputs: sessions.length * 2,
                elapsedMs: duration(performance.now(), loadStartedAt), transactionAttempts: measurements.length,
                maxAccountLockWaiters: Math.max(0, ...waiterSamples.map(row => row.waiters)),
                maxWaitersBlockedByMeasuredTransactions: Math.max(0, ...waiterSamples.map(row => row.blockedByMeasuredTransactions)),
                samples: waiterSamples.length,
                transactions: lockMeasurements.map(row => ({ pid: row.pid,
                    acquisitionMs: duration(row.lockAcquiredAt, row.lockRequestedAt),
                    holdToCallbackEndMs: duration(row.callbackEndedAt, row.lockAcquiredAt),
                    holdToCommitSettlementMs: duration(row.settledAt, row.lockAcquiredAt),
                    lockToPendingInsertMs: duration(row.firstPendingInsertAt, row.lockAcquiredAt),
                    lockToPublicationMs: duration(row.publicationStartedAt, row.lockAcquiredAt),
                    transactionMs: duration(row.settledAt, row.enteredAt),
                })),
            }));

            const pending = await db.sessionPendingMessage.findMany({ where: { sessionId: { in: sessions.map(row => row.id) } },
                select: { sessionId: true, localId: true, position: true, status: true } });
            expect(pending).toHaveLength(24);
            expect(new Set(pending.map(row => row.localId)).size).toBe(24);
            for (const session of sessions) {
                expect(pending.filter(row => row.sessionId === session.id).map(row => row.position).sort()).toEqual([1, 2]);
                expect(pending.filter(row => row.sessionId === session.id).every(row => row.status === 'queued')).toBe(true);
                expect(await db.session.findUniqueOrThrow({ where: { id: session.id }, select: {
                    pendingCount: true, pendingQueueSeq: true,
                } })).toEqual({ pendingCount: 2, pendingQueueSeq: 2 });
            }
            // Same one-Account/twelve-Session workload, now through the real
            // materializer, publisher, transcript, Follow, usage and Artifact owners.
            // Twelve concurrent agent flows, each submitting its operations in
            // order. Concurrency models agents rather than multiplying every
            // operation into an independent requester on the same Session.
            const claimedLocalIds = new Map<string, string>();
            for (let wave = 0; wave < 2; wave++) {
                await runWithServerHttpBaseUrl(origin, async () => {
                    const outcomes = await Promise.allSettled(sessions.map(async (session, index) => {
                        await measured('pending-materialize', async () => {
                            const publisher = publishers[index];
                            const result = await materializeNextPendingMessage({ actorUserId: account.id, sessionId: session.id,
                                deliveryState: 'provider', deliveryTiming: 'after_foreground_ready', foregroundState: 'ready',
                                publisherAuthority: { ...publisher.binding, committedFence: publisher.registration.committedFence } });
                            // Materialization claims provider delivery; transcript
                            // publication waits for the separate acceptance owner.
                            expect(result).toMatchObject({ ok: true, didMaterialize: true, didWriteMessage: false });
                            if (result.ok && result.didMaterialize) {
                                if (wave === 0) claimedLocalIds.set(session.id, result.message.localId);
                                else expect(result.message.localId).toBe(claimedLocalIds.get(session.id));
                            }
                        });
                        await measured('transcript-write', async () => {
                            expect(await createSessionMessage({ actorUserId: account.id, sessionId: session.id,
                                inputAdmission: 'authenticatedAccount', authentication, localId: `ordinary-${wave}-${randomUUID()}`,
                                messageRole: 'user', content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'ordinary' } } } }))
                                .toMatchObject({ ok: true, didWrite: true });
                        });
                        await measured('publisher-presence', async () => {
                            const result = await presence.touchPublisher({ socket: publishers[index].socket });
                            expect(result.status).toBe('touched');
                            if (result.status === 'touched') publishers[index].registration.committedFence = result.committedFence;
                        });
                        await measured('follow-publication', async () => {
                            expect(await setSessionFollowSource({ accountId: account.id, sourceSessionId: session.id,
                                destinationSessionId: sessions[(index + 1) % sessions.length].id, authentication,
                                policy: { preset: wave === 0 ? 'quiet' : 'important' } })).toMatchObject({ ok: true });
                        });
                        await measured('usage-event', async () => {
                            expect(await recordUsageEvent(account.id, UsageEventIngestRequestSchema.parse({
                                sessionId: session.id, externalKey: randomUUID(), observedAt: Date.now(), agentId: 'codex',
                                source: 'runtime', scope: 'turn_delta', isCumulative: false,
                                tokens: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 2 },
                                cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' },
                            }))).toMatchObject({ ok: true });
                        });
                        await measured('qualified-provider-usage', async () => {
                            const credential = usageCredentials[index];
                            const snapshot = createUsageSnapshot({ fetchedAt: Date.now() + wave,
                                recordKey: createProviderAccountUsageRecordKey({ accountSubjectId: credential.providerAccountId }),
                                planLabel: `wave-${wave}` });
                            const result = await writeQualifiedProviderAccountUsageRecord({ accountId: account.id,
                                source: { ref: credential.ref, bindingKind: 'account' },
                                expectedCredentialRevision: credential.credentialRevision, expectedConfigurationRevision: null,
                                recordId: snapshot.recordId, recordKey: snapshot.recordKey, payloadMode: 'plain_json_v1', status: 'ok',
                                snapshot, fetchedAt: snapshot.fetchedAtMs, staleAfterMs: snapshot.staleAfterMs });
                            expect(result.record).toMatchObject({ recordId: snapshot.recordId });
                        });
                        await measured('artifact-update', async () => {
                            expect(await updateArtifact({ actorUserId: account.id, artifactId: artifacts[index].id,
                                body: { bytes: bytes({ body: `wave-${wave}` }), expectedVersion: wave + 1 } })).toMatchObject({ ok: true });
                        });
                        if (wave === 0) await measured('approval-claim', async () => {
                            const approval = approvals[index];
                            expect(await approvalStore.approvalsUpdate({ artifactId: approval.artifactId, serverId: null,
                                request: ApprovalRequestV2Schema.parse({ ...approval.request, status: 'executing', updatedAtMs: 3 }) }))
                                .toEqual({ ok: true });
                        });
                    }));
                    for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason;
                });
            }
            db.$transaction = originalTransaction;
            expect(await db.usageEvent.count({ where: { accountId: account.id } })).toBe(24);
            expect(await db.sessionFollowEdge.count({ where: { sourceSessionId: { in: sessions.map(row => row.id) } } })).toBe(12);
            for (const artifact of artifacts) expect((await db.artifact.findUniqueOrThrow({ where: { id: artifact.id } })).bodyVersion).toBe(3);
            await runWithServerHttpBaseUrl(origin, async () => {
                for (const approval of approvals) expect(await approvalStore.approvalsGet({ artifactId: approval.artifactId, serverId: null }))
                    .toMatchObject({ status: 'executing' });
            });
            const rounded = (value: number) => Number(value.toFixed(3));
            const distribution = (values: number[]) => {
                const sorted = [...values].sort((a, b) => a - b);
                return { median: sorted.length ? rounded((sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.ceil((sorted.length - 1) / 2)]) / 2) : null,
                    p95: sorted.length ? rounded(sorted[Math.ceil(sorted.length * 0.95) - 1]) : null,
                    total: rounded(sorted.reduce((sum, value) => sum + value, 0)) };
            };
            const owners = [...new Set(measurements.map(row => row.owner))].map(owner => {
                const all = measurements.filter(row => row.owner === owner);
                const locked = all.filter((row): row is TransactionMeasurement & { lockAcquiredAt: number; lockRequestedAt: number; settledAt: number; callbackEndedAt: number } =>
                    row.lockAcquiredAt !== undefined && row.lockRequestedAt !== undefined && row.settledAt !== undefined && row.callbackEndedAt !== undefined);
                const queryTotals = new Map<string, { calls: number; totalMs: number }>();
                const gaps: { ms: number; after: string; before: string }[] = [];
                const queryUnderHoldMs: number[] = [];
                for (const row of locked) {
                    const queries = row.queries.filter(query => query.startedAt >= row.lockAcquiredAt).sort((a, b) => a.startedAt - b.startedAt);
                    let previousEnd = row.lockAcquiredAt;
                    let coveredMs = 0;
                    let previousOperation = 'Account lock acquired';
                    for (const query of queries) {
                        gaps.push({ ms: rounded(Math.max(0, query.startedAt - previousEnd)), after: previousOperation, before: query.operation });
                        coveredMs += Math.max(0, query.endedAt - Math.max(previousEnd, query.startedAt));
                        previousEnd = Math.max(previousEnd, query.endedAt);
                        previousOperation = query.operation;
                        const total = queryTotals.get(query.operation) ?? { calls: 0, totalMs: 0 };
                        total.calls++;
                        total.totalMs += query.endedAt - query.startedAt;
                        queryTotals.set(query.operation, total);
                    }
                    gaps.push({ ms: rounded(Math.max(0, row.callbackEndedAt - previousEnd)), after: previousOperation, before: 'callback end' });
                    queryUnderHoldMs.push(coveredMs);
                }
                return { owner, transactionAttempts: all.length, accountLockTransactions: locked.length,
                    acquisitionMs: distribution(locked.map(row => row.lockAcquiredAt - row.lockRequestedAt)),
                    holdMs: distribution(locked.map(row => row.settledAt - row.lockAcquiredAt)),
                    callbackHoldMs: distribution(locked.map(row => row.callbackEndedAt - row.lockAcquiredAt)),
                    queryUnderHoldMs: distribution(queryUnderHoldMs),
                    queries: [...queryTotals].map(([operation, value]) => ({ operation, ...value, totalMs: rounded(value.totalMs) }))
                        .sort((a, b) => b.totalMs - a.totalMs),
                    largestNonQueryGaps: gaps.sort((a, b) => b.ms - a.ms).slice(0, 3) };
            }).sort((a, b) => b.holdMs.total - a.holdMs.total);
            console.info('INT_ACCTLOCK_MIXED_CONTENTION', JSON.stringify({ sessions: sessions.length,
                elapsedMs: duration(performance.now(), loadStartedAt),
                accountLockTransactions: measurements.filter(row => row.lockAcquiredAt !== undefined).length,
                acquisitionMs: distribution(measurements.flatMap(row => row.lockAcquiredAt !== undefined && row.lockRequestedAt !== undefined
                    ? [row.lockAcquiredAt - row.lockRequestedAt] : [])),
                holdMs: distribution(measurements.flatMap(row => row.lockAcquiredAt !== undefined && row.settledAt !== undefined
                    ? [row.settledAt - row.lockAcquiredAt] : [])),
                owners }));
            let cursor = 0;
            const observedSessionIds: string[] = [];
            while (true) {
                const response = await app.inject({ method: 'GET', url: `/v2/changes?after=${cursor}&limit=3`,
                    headers: { 'x-test-user-id': account.id } });
                expect(response.statusCode).toBe(200);
                const body = ChangesResponseSchema.parse(response.json());
                for (const change of body.changes) {
                    expect(change.cursor).toBeGreaterThan(cursor);
                    cursor = change.cursor;
                    if (change.kind === 'session') observedSessionIds.push(change.entityId);
                }
                expect(body.nextCursor).toBeGreaterThanOrEqual(cursor);
                cursor = body.nextCursor;
                if (body.changes.length === 0) break;
            }
            expect(observedSessionIds.sort()).toEqual(sessions.map(row => row.id).sort());
            expect(cursor).toBe((await db.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } })).seq);
        } finally {
            db.$transaction = originalTransaction;
            vi.unstubAllEnvs();
            await app.close();
            await db.usageEvent.deleteMany({ where: { accountId: account.id } });
            await db.serviceAccountToken.deleteMany({ where: { accountId: account.id } });
            await db.artifact.deleteMany({ where: { accountId: account.id } });
            await db.sessionFollowEdge.deleteMany({ where: { sourceSession: { accountId: account.id } } });
            await db.accessKey.deleteMany({ where: { accountId: account.id } });
            await db.sessionMessage.deleteMany({ where: { session: { accountId: account.id } } });
            await db.session.deleteMany({ where: { accountId: account.id } });
            await db.machine.deleteMany({ where: { accountId: account.id } });
            await db.account.delete({ where: { id: account.id } });
        }
    });
});
