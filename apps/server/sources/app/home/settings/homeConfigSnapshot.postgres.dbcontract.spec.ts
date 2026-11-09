import { randomUUID } from 'node:crypto';
import type { FastifyRequest, LightMyRequestResponse } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { createAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { auth } from '@/app/auth/auth';
import { HOME_ANONYMOUS_SIGNUP_KEY } from '@/app/home/governance/homeAuthenticationPolicyEnv';
import { db, getDbProviderFromEnv, initDbPostgres } from '@/storage/db';
import { inReadSnapshot } from '@/storage/inTx';
import * as logging from '@/utils/logging/log';
import { withWebLatencyTrace } from '@/utils/webLatencyTrace';
import { SERVER_CONFIG } from '@happier-dev/protocol/serverConfig/registry';

import { readHomeConfigEnvInTx, readHomeConfigSnapshot } from './homeSettings';
import { readRequestHomeEnv, readRequestHomeFlag } from './requestHomeEnv';

type Span = { phase: string; spanId?: number; parentSpanId?: number };

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('Home configuration PostgreSQL request cost', () => {
    let connected = false;
    const accounts: string[] = [];
    const apps: ReturnType<typeof createAuthenticatedTestApp>[] = [];

    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Use the disposable PostgreSQL DB-contract harness');
        }
        vi.stubEnv('HANDY_MASTER_SECRET', 'home-snapshot-disposable-fixture');
        vi.stubEnv('HAPPIER_SERVER_IDENTITY_ID', 'srv_home_snapshot_fixture');
        vi.stubEnv('HAPPIER_WEB_LATENCY_TRACE', '1');
        initDbPostgres();
        await db.$connect();
        connected = true;
        await auth.init();
    });
    afterEach(async () => {
        await Promise.all(apps.splice(0).map(app => app.close()));
        if (connected) {
            await db.homeSettings.deleteMany({});
            await db.homeGovernancePolicy.deleteMany({});
            await db.account.deleteMany({ where: { id: { in: accounts.splice(0) } } });
        }
        vi.restoreAllMocks();
    });
    afterAll(async () => { if (connected) await db.$disconnect(); vi.unstubAllEnvs(); });

    async function measure<T>(operation: () => Promise<T>) {
        const spans: Span[] = [];
        const sink = vi.spyOn(logging, 'log').mockImplementation((metadata) => {
            if (typeof metadata === 'object' && metadata !== null && 'module' in metadata
                && metadata.module === 'web-latency' && 'phase' in metadata && typeof metadata.phase === 'string') {
                spans.push(metadata as Span);
            }
        });
        try {
            const value = await withWebLatencyTrace(randomUUID(), operation);
            const orm = spans.filter(span => span.phase.startsWith('db.') && !span.phase.startsWith('db.transaction.'));
            return { value, spans, orm };
        } finally { sink.mockRestore(); }
    }

    it('uses one Home data read per real authenticated request, retaining fresh capture and epoch revocation', async () => {
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        accounts.push(account.id);
        const token = await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' });
        const app = createAuthenticatedTestApp({ authentication: 'real' });
        apps.push(app);
        // Inject uses Fastify's own async resources, just like a real HTTP request.
        app.addHook('onRequest', (_request: FastifyRequest, _reply: unknown, done: () => void) => withWebLatencyTrace(randomUUID(), done));
        app.get('/snapshot', { preHandler: app.authenticate }, async (request: FastifyRequest) => {
            await readRequestHomeFlag(request, SERVER_CONFIG.HAPPIER_AUTH_DECORATOR_DIAGNOSTIC_LOGS);
            const env = await readRequestHomeEnv(request);
            return { name: env.HAPPIER_HOME_DISPLAY_NAME ?? null };
        });
        const request = async (): Promise<LightMyRequestResponse> => app.inject({ method: 'GET', url: '/snapshot', headers: { authorization: `Bearer ${token}` } });
        const measured = await measure(request);
        expect(measured.value.statusCode, measured.value.body).toBe(200);
        const home = measured.spans.find(span => span.phase === 'auth.home_env');
        expect(home?.spanId).toBeDefined();
        const belongsToHome = (span: Span): boolean => {
            if (span.parentSpanId === home!.spanId) return true;
            const parent = measured.spans.find(candidate => candidate.spanId === span.parentSpanId);
            return parent !== undefined && belongsToHome(parent);
        };
        const homeOps = measured.orm.filter(belongsToHome);
        const homeData = homeOps.filter(span => !['db.raw.$executeRaw', 'db.raw.$executeRawUnsafe', 'db.raw.$queryRaw'].includes(span.phase));
        console.info('HOME_REQUEST_COST', JSON.stringify({ homeOps: homeOps.map(span => span.phase), totalOrm: measured.orm.length }));
        // This distinguishes a single joined read from the previous two model reads.
        expect(homeData.map(span => span.phase)).toHaveLength(1);
        expect(homeOps.length).toBeLessThanOrEqual(4);
        expect(measured.orm.length).toBeLessThanOrEqual(8);

        await db.homeSettings.create({ data: { id: 'home', values: { HAPPIER_HOME_DISPLAY_NAME: 'next request' } } });
        expect((await request()).json()).toEqual({ name: 'next request' });
        await db.account.update({ where: { id: account.id }, data: { tokenEpoch: { increment: 1 } } });
        expect((await request()).statusCode).toBe(401);
    });

    it('preserves optional-row defaults, policy precedence, sealed bytes and per-request capture', async () => {
        expect((await readHomeConfigSnapshot({})).record).toEqual({ revision: 0, values: {}, sealedSecrets: {} });
        await db.homeGovernancePolicy.create({ data: { id: 'home', authenticationPolicy: { v: 1, anonymousSignup: false } } });
        expect((await readHomeConfigSnapshot({})).policyValues).toMatchObject({ [HOME_ANONYMOUS_SIGNUP_KEY]: false });
        await db.homeSettings.create({ data: { id: 'home', revision: 7,
            values: { HAPPIER_HOME_DISPLAY_NAME: 'before', [HOME_ANONYMOUS_SIGNUP_KEY]: true },
            encryptedSecrets: new TextEncoder().encode(JSON.stringify({ fixture: 'sealed', malformed: 42 })) } });
        const capture = {};
        await readRequestHomeFlag(capture, SERVER_CONFIG.HAPPIER_AUTH_DECORATOR_DIAGNOSTIC_LOGS);
        await db.homeSettings.update({ where: { id: 'home' }, data: { values: { HAPPIER_HOME_DISPLAY_NAME: 'after' } } });
        await db.homeGovernancePolicy.update({ where: { id: 'home' }, data: { authenticationPolicy: { v: 1, anonymousSignup: true } } });
        expect((await readRequestHomeEnv(capture)).HAPPIER_HOME_DISPLAY_NAME).toBe('before');
        expect((await readRequestHomeEnv(capture))[HOME_ANONYMOUS_SIGNUP_KEY]).toBe('false');
        expect((await readRequestHomeEnv({})).HAPPIER_HOME_DISPLAY_NAME).toBe('after');
        expect((await readRequestHomeEnv({}))[HOME_ANONYMOUS_SIGNUP_KEY]).toBe('true');
        expect((await readHomeConfigSnapshot({})).record.sealedSecrets).toEqual({ fixture: 'sealed' });
        await db.homeGovernancePolicy.deleteMany({});
        expect((await readHomeConfigSnapshot({})).policyValues).toEqual({});
    });

    it('reads the same overlay inside an existing transaction without opening another one', async () => {
        const measured = await measure(() => inReadSnapshot(tx => readHomeConfigEnvInTx(tx, {})));
        expect(measured.spans.filter(span => span.phase === 'db.transaction.attempt')).toHaveLength(1);
        console.info('HOME_EXISTING_TX_COST', JSON.stringify(measured.orm.map(span => span.phase)));
        expect(measured.orm.length).toBeLessThanOrEqual(4);
    });

    it('keeps credential revocation fresher than the earlier Home capture', async () => {
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        accounts.push(account.id);
        const token = await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' });
        await inReadSnapshot(async tx => {
            await readHomeConfigEnvInTx(tx, {});
            await db.account.update({ where: { id: account.id }, data: { tokenEpoch: { increment: 1 } } });
            // Reusing the earlier RepeatableRead transaction for authentication
            // would still admit epoch 0; the real verifier must see the commit.
            expect((await tx.account.findUniqueOrThrow({ where: { id: account.id } })).tokenEpoch).toBe(account.tokenEpoch);
            expect(await auth.verifyToken(token)).toBeNull();
        });
    });
});
