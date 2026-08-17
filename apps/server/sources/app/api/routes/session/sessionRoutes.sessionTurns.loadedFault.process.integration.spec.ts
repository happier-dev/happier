import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { applySessionTurnMutation } from '@/app/session/sessionWriteService';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createAuthenticatedTestApp } from '../../testkit/sqliteFastify';
import { sessionRoutes } from './sessionRoutes';

type Deferred<T> = Readonly<{
    promise: Promise<T>;
    resolve: (value: T) => void;
}>;

function deferred<T = void>(): Deferred<T> {
    let resolvePromise!: (value: T) => void;
    const promise = new Promise<T>((resolve) => { resolvePromise = resolve; });
    return { promise, resolve: resolvePromise };
}

type ChildMessage = Readonly<{
    type: string;
    queue?: Array<Readonly<{
        mutationId: string;
        attempts: number;
        nextAttemptAt: number;
        lastAttempt?: unknown;
    }>>;
    error?: string;
}>;

type RunningChild = Readonly<{
    child: ChildProcess;
    waitForMessage: (type: string) => Promise<ChildMessage>;
    completion: Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null }>>;
}>;

const currentDir = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(currentDir, '../../../../../../..');
const cliRoot = join(repositoryRoot, 'apps', 'cli');
const childFixturePath = join(
    cliRoot,
    'src/api/session/client/transport/mutations/sessionClientDurableMutationLoadedFault.child.ts',
);

function startOutboxChild(params: Readonly<{
    homeDir: string;
    serverUrl: string;
    token: string;
    sessionId: string;
    primary: Readonly<Record<string, unknown>>;
    secondary?: Readonly<Record<string, unknown>>;
}>): RunningChild {
    const child = fork(childFixturePath, [JSON.stringify({
        token: params.token,
        sessionId: params.sessionId,
        primary: params.primary,
        ...(params.secondary ? { secondary: params.secondary } : {}),
    })], {
        cwd: cliRoot,
        execArgv: ['--import', 'tsx'],
        env: {
            ...process.env,
            HAPPIER_HOME_DIR: params.homeDir,
            HAPPIER_ACTIVE_SERVER_ID: 'loaded-fault-process',
            HAPPIER_SERVER_URL: params.serverUrl,
            HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS: '60000',
            HAPPIER_SESSION_MUTATION_OUTBOX_MAX_RETRY_MS: '60000',
            HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS: '0',
        },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const buffered: ChildMessage[] = [];
    const waiters = new Map<string, Array<(message: ChildMessage) => void>>();
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
    child.on('message', (value: unknown) => {
        const message = value as ChildMessage;
        const waiter = waiters.get(message.type)?.shift();
        if (waiter) waiter(message);
        else buffered.push(message);
    });
    const completion = new Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null }>>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) => {
            if (code !== 0 && signal === null) {
                reject(new Error(`Outbox child exited with code ${String(code)}\n${stdout}\n${stderr}`));
                return;
            }
            resolve({ code, signal });
        });
    });
    return {
        child,
        completion,
        waitForMessage: async (type) => {
            const bufferedIndex = buffered.findIndex((message) => message.type === type || message.type === 'fixture-error');
            if (bufferedIndex >= 0) {
                const [message] = buffered.splice(bufferedIndex, 1);
                if (message?.type === 'fixture-error') throw new Error(message.error);
                return message!;
            }
            return await new Promise<ChildMessage>((resolveMessage, rejectMessage) => {
                const timeout = setTimeout(() => {
                    rejectMessage(new Error(`Timed out waiting for child message ${type}\n${stdout}\n${stderr}`));
                }, 45_000);
                const settle = (message: ChildMessage) => {
                    clearTimeout(timeout);
                    if (message.type === 'fixture-error') rejectMessage(new Error(message.error));
                    else resolveMessage(message);
                };
                const typedWaiters = waiters.get(type) ?? [];
                typedWaiters.push(settle);
                waiters.set(type, typedWaiters);
                const errorWaiters = waiters.get('fixture-error') ?? [];
                errorWaiters.push(settle);
                waiters.set('fixture-error', errorWaiters);
            });
        },
    };
}

async function createSessionWithRunningTurn(label: string) {
    const account = await db.account.create({
        data: {
            publicKey: `pk-${label}-${randomUUID()}`,
            encryptionMode: 'plain',
        },
        select: { id: true },
    });
    const session = await db.session.create({
        data: {
            tag: `${label}-${randomUUID()}`,
            accountId: account.id,
            encryptionMode: 'plain',
            metadata: JSON.stringify({ t: 'plain', v: {} }),
            agentState: null,
        },
        select: { id: true },
    });
    const turnId = `turn-${label}-${randomUUID()}`;
    const observedAt = Date.now();
    await expect(applySessionTurnMutation({
        actorUserId: account.id,
        mutation: {
            v: 1,
            sessionId: session.id,
            mutationId: `begin-${label}-${randomUUID()}`,
            turnId,
            action: 'begin',
            provider: 'codex',
            observedAt,
        },
    })).resolves.toMatchObject({ ok: true, didApply: true });
    return { accountId: account.id, sessionId: session.id, turnId, observedAt };
}

async function createListeningSessionApp(params: Readonly<{
    beforeApply?: (mutationId: string, reply: any) => Promise<void>;
    afterApply?: (mutationId: string, reply: any, payload: unknown) => Promise<unknown>;
}>) {
    const app = createAuthenticatedTestApp();
    app.addHook('onRequest', async (request: any) => {
        const authorization = request.headers.authorization;
        if (typeof authorization === 'string' && authorization.startsWith('Bearer ')) {
            request.headers['x-test-user-id'] = authorization.slice('Bearer '.length);
        }
    });
    app.addHook('preHandler', async (request: any, reply: any) => {
        const mutationId = request.body?.mutationId;
        if (typeof mutationId === 'string') await params.beforeApply?.(mutationId, reply);
    });
    app.addHook('onSend', async (request: any, reply: any, payload: unknown) => {
        const mutationId = request.body?.mutationId;
        return typeof mutationId === 'string'
            ? await params.afterApply?.(mutationId, reply, payload) ?? payload
            : payload;
    });
    sessionRoutes(app as any);
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    return { app, address };
}

describe('session-turn durable outbox loaded fault process integration', () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: 'happier-session-turn-loaded-fault-',
            initAuth: false,
        });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    afterEach(async () => {
        await harness.resetDbTables([
            () => db.sessionTurnMutationReceipt.deleteMany(),
            () => db.sessionTurn.deleteMany(),
            () => db.accountChange.deleteMany(),
            () => db.session.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    it('persists before transport, survives process death after commit-before-receipt, and replays once', async () => {
        const homeDir = await mkdtemp(join(tmpdir(), 'happier-loaded-fault-home-'));
        const fixture = await createSessionWithRunningTurn('lost-ack');
        const mutationId = `end-${randomUUID()}`;
        const mutation = {
            v: 1,
            sessionId: fixture.sessionId,
            mutationId,
            action: 'end_session',
            turnId: fixture.turnId,
            observedAt: fixture.observedAt + 1,
        } as const;
        const requestArrived = deferred();
        const allowApply = deferred();
        const committedBeforeReceipt = deferred();
        const allowLostReceipt = deferred();
        const responseHookFinished = deferred();
        let gatedRequest = true;
        let gatedResponse = true;
        let requestCount = 0;
        const { app, address } = await createListeningSessionApp({
            beforeApply: async (incomingMutationId) => {
                if (incomingMutationId !== mutationId) return;
                requestCount += 1;
                if (!gatedRequest) return;
                gatedRequest = false;
                requestArrived.resolve();
                await allowApply.promise;
            },
            afterApply: async (incomingMutationId, reply, payload) => {
                if (incomingMutationId !== mutationId || !gatedResponse) return payload;
                gatedResponse = false;
                committedBeforeReceipt.resolve();
                await allowLostReceipt.promise;
                reply.raw.destroy();
                responseHookFinished.resolve();
                return payload;
            },
        });
        let firstChild: RunningChild | null = null;
        let replayChild: RunningChild | null = null;
        try {
            firstChild = startOutboxChild({
                homeDir,
                serverUrl: address,
                token: fixture.accountId,
                sessionId: fixture.sessionId,
                primary: mutation,
            });
            await firstChild.waitForMessage('ready');
            firstChild.child.send({ type: 'enqueue-primary-and-await' });
            await requestArrived.promise;

            const queuePath = join(
                homeDir,
                'servers',
                'loaded-fault-process',
                'session-mutations',
                `session-${fixture.sessionId}.daemon.json`,
            );
            const admitted = JSON.parse(await readFile(queuePath, 'utf8')) as {
                mutations: Array<{ mutationId: string; attempts: number }>;
            };
            expect(admitted.mutations).toEqual([
                expect.objectContaining({ mutationId, attempts: 0 }),
            ]);

            allowApply.resolve();
            await committedBeforeReceipt.promise;
            const committedReceipts = await db.sessionTurnMutationReceipt.findMany({
                where: { sessionId: fixture.sessionId, mutationId },
                select: {
                    decision: true,
                    action: true,
                    turnId: true,
                    observedAt: true,
                    appliedAt: true,
                },
            });
            expect(committedReceipts).toEqual([{
                decision: 'applied',
                action: 'end_session',
                turnId: fixture.turnId,
                observedAt: BigInt(mutation.observedAt),
                appliedAt: expect.any(BigInt),
            }]);
            const committedTurn = await db.sessionTurn.findUniqueOrThrow({
                where: { sessionId_turnId: { sessionId: fixture.sessionId, turnId: fixture.turnId } },
                select: {
                    status: true,
                    lastMutationId: true,
                    updatedAt: true,
                    terminalAt: true,
                },
            });
            expect(committedTurn).toEqual({
                status: 'cancelled',
                lastMutationId: mutationId,
                updatedAt: BigInt(mutation.observedAt),
                terminalAt: BigInt(mutation.observedAt),
            });

            firstChild.child.kill('SIGKILL');
            await expect(firstChild.completion).resolves.toMatchObject({ signal: 'SIGKILL' });
            allowLostReceipt.resolve();
            await responseHookFinished.promise;

            replayChild = startOutboxChild({
                homeDir,
                serverUrl: address,
                token: fixture.accountId,
                sessionId: fixture.sessionId,
                primary: mutation,
            });
            await replayChild.waitForMessage('ready');
            replayChild.child.send({ type: 'flush-startup' });
            await expect(replayChild.waitForMessage('startup-flushed')).resolves.toMatchObject({ queue: [] });
            await expect(replayChild.completion).resolves.toEqual({ code: 0, signal: null });

            expect(requestCount).toBe(2);
            await expect(db.sessionTurnMutationReceipt.count({
                where: { sessionId: fixture.sessionId, mutationId },
            })).resolves.toBe(1);
            await expect(db.sessionTurn.count({
                where: { sessionId: fixture.sessionId, turnId: fixture.turnId },
            })).resolves.toBe(1);
            await expect(db.sessionTurnMutationReceipt.findMany({
                where: { sessionId: fixture.sessionId, mutationId },
                select: {
                    decision: true,
                    action: true,
                    turnId: true,
                    observedAt: true,
                    appliedAt: true,
                },
            })).resolves.toEqual(committedReceipts);
            await expect(db.sessionTurn.findUniqueOrThrow({
                where: { sessionId_turnId: { sessionId: fixture.sessionId, turnId: fixture.turnId } },
                select: {
                    status: true,
                    lastMutationId: true,
                    updatedAt: true,
                    terminalAt: true,
                },
            })).resolves.toEqual(committedTurn);
            await expect(access(queuePath)).rejects.toMatchObject({ code: 'ENOENT' });
        } finally {
            allowApply.resolve();
            allowLostReceipt.resolve();
            if (firstChild?.child.exitCode === null && firstChild.child.signalCode === null) firstChild.child.kill('SIGKILL');
            if (replayChild?.child.exitCode === null && replayChild.child.signalCode === null) replayChild.child.kill('SIGKILL');
            await app.close();
            await rm(homeDir, { recursive: true, force: true });
        }
    }, 180_000);

    it('does not reset a failed head mutation backoff when later queue activity arrives', async () => {
        const homeDir = await mkdtemp(join(tmpdir(), 'happier-backoff-activity-home-'));
        const fixture = await createSessionWithRunningTurn('backoff');
        const primary = {
            v: 1,
            sessionId: fixture.sessionId,
            mutationId: `backoff-head-${randomUUID()}`,
            action: 'end_session',
            turnId: fixture.turnId,
            observedAt: fixture.observedAt + 1,
        } as const;
        const secondary = {
            ...primary,
            mutationId: `backoff-later-${randomUUID()}`,
            observedAt: fixture.observedAt + 2,
        } as const;
        let requestCount = 0;
        const { app, address } = await createListeningSessionApp({
            beforeApply: async (mutationId, reply) => {
                if (mutationId !== primary.mutationId) return;
                requestCount += 1;
                await reply.code(503).send({ error: 'injected-retryable-failure' });
            },
        });
        const child = startOutboxChild({
            homeDir,
            serverUrl: address,
            token: fixture.accountId,
            sessionId: fixture.sessionId,
            primary,
            secondary,
        });
        try {
            await child.waitForMessage('ready');
            child.child.send({ type: 'enqueue-primary-and-await' });
            const first = await child.waitForMessage('primary-settled');
            expect(requestCount).toBe(1);
            await expect(db.sessionTurnMutationReceipt.count({
                where: { sessionId: fixture.sessionId, mutationId: primary.mutationId },
            })).resolves.toBe(0);
            expect(first.queue).toEqual([
                expect.objectContaining({
                    mutationId: primary.mutationId,
                    attempts: 1,
                    nextAttemptAt: expect.any(Number),
                    lastAttempt: expect.objectContaining({ reason: 'delivery_not_confirmed' }),
                }),
            ]);
            const firstNextAttemptAt = first.queue?.[0]?.nextAttemptAt ?? 0;
            expect(firstNextAttemptAt).toBeGreaterThan(Date.now());

            child.child.send({ type: 'enqueue-secondary-and-await' });
            const second = await child.waitForMessage('secondary-settled');
            expect(requestCount).toBe(1);
            expect(second.queue).toEqual([
                expect.objectContaining({
                    mutationId: primary.mutationId,
                    attempts: 1,
                    nextAttemptAt: firstNextAttemptAt,
                }),
                expect.objectContaining({
                    mutationId: secondary.mutationId,
                    attempts: 0,
                }),
            ]);
        } finally {
            if (child.child.exitCode === null && child.child.signalCode === null) child.child.kill('SIGKILL');
            await child.completion.catch(() => undefined);
            await app.close();
            await rm(homeDir, { recursive: true, force: true });
        }
    }, 180_000);
});
