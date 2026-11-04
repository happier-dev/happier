import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { auth } from '@/app/auth/auth';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { createSessionMessage as createSessionMessageWithAuthentication } from '@/app/session/sessionWriteService';
import { deleteSessionTree } from '@/app/session/delete/deleteSessionTree';
import { runSessionSidechainMessageRetentionRule } from '@/app/retention/rules/sessionSidechainMessageRetentionRule';
import { SESSION_TRANSCRIPT_PUBLICATION_SELECT } from '@/app/session/sessionTranscriptPublicationPolicy';
import { perfFixtureId } from '../../../../../packages/tests/src/testkit/stress/scenarios/perfProfile';

const shutdownHandlers = vi.hoisted(() => new Map<string, Array<() => Promise<void>>>());
const authentication = createPresentUserSessionAccessAuthentication();

type AuthenticatedSessionMessageInput = Omit<
    Extract<Parameters<typeof createSessionMessageWithAuthentication>[0], { content: unknown }>,
    'authentication' | 'inputAdmission'
>;

function createSessionMessage(params: AuthenticatedSessionMessageInput) {
    return createSessionMessageWithAuthentication({
        ...params,
        inputAdmission: 'authenticatedAccount',
        authentication,
    });
}

/**
 * Bounded real-clock polling over the live derived projection. The projection is
 * asynchronous by contract (a freshly committed message may be briefly absent),
 * so assertions poll until the canonical commit is observed or the budget ends.
 */
async function eventually(assertion: () => Promise<void>): Promise<void> {
    let lastError: unknown = new Error('eventual assertion did not run');
    for (let attempt = 0; attempt < 40; attempt += 1) {
        try {
            await assertion();
            return;
        } catch (error) {
            lastError = error;
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
    }
    throw lastError;
}

function getNativePrismaRequestBoundary() {
    const nativeClient: unknown = Reflect.get(db, '_originalClient');
    if (!nativeClient || typeof nativeClient !== 'object') throw new Error('Native Prisma boundary unavailable');
    const boundary: unknown = Object.getPrototypeOf(nativeClient);
    if (!boundary || typeof boundary !== 'object') throw new Error('Native Prisma prototype unavailable');
    const nativeRequest: unknown = Reflect.get(boundary, '_request');
    if (typeof nativeRequest !== 'function') throw new Error('Native Prisma request boundary unavailable');
    return { boundary, nativeRequest };
}

vi.mock('@/app/api/socket', () => ({ startSocket: vi.fn() }));
vi.mock('@/utils/process/shutdown', () => ({
    onShutdown: vi.fn((name: string, callback: () => Promise<void>) => {
        const handlers = shutdownHandlers.get(name) ?? [];
        handlers.push(callback);
        shutdownHandlers.set(name, handlers);
        return () => {
            const current = shutdownHandlers.get(name);
            if (!current) return;
            const index = current.indexOf(callback);
            if (index >= 0) current.splice(index, 1);
            if (current.length === 0) shutdownHandlers.delete(name);
        };
    }),
}));
vi.mock('@/app/automations/automationReplyHandoffWorker', () => ({
    startAutomationReplyHandoffWorker: vi.fn(() => ({ stop: async () => {} })),
}));
vi.mock('@/app/automations/automationScheduleWorker', () => ({
    startAutomationScheduleWorker: vi.fn(() => ({ stop: async () => {} })),
}));

describe('startApi Home search production composition', () => {
    let harness: LightSqliteHarness;

    const stopHomeSearch = async () => {
        const handlers = shutdownHandlers.get('home-search') ?? [];
        shutdownHandlers.delete('home-search');
        for (const handler of handlers) await handler();
    };

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: 'happier-home-search-api-',
            initAuth: true,
            env: {
                HAPPIER_SERVER_FLAVOR: 'light',
                HAPPY_SERVER_FLAVOR: 'light',
                HAPPIER_FILES_BACKEND: 'local',
                HAPPY_FILES_BACKEND: 'local',
                HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'plaintext_only',
                AUTH_REQUIRED_LOGIN_PROVIDERS: '',
                PORT: '0',
            },
        });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
        vi.restoreAllMocks();
        shutdownHandlers.clear();
    });

    it('projects canonical plain SessionMessage insert, edit, edit-to-empty, and delete through the authenticated /v1/home/search route', async () => {
        const { startApi } = await import('@/app/api/api');
        const canonicalReads: unknown[] = [];
        const { boundary, nativeRequest } = getNativePrismaRequestBoundary();
        // Observe the genuine DB request without replacing Prisma's generated delegate.
        Reflect.set(boundary, '_request', new Proxy(nativeRequest, { apply(target, receiver, args) {
            const request: unknown = args[0];
            if (request && typeof request === 'object' && Reflect.get(request, 'model') === 'SessionMessage'
                && Reflect.get(request, 'action') === 'findMany') {
                canonicalReads.push(Reflect.get(request, 'args'));
            }
            return Reflect.apply(target, receiver, args);
        } }));
        const app = await startApi().catch(error => {
            Reflect.set(boundary, '_request', nativeRequest);
            throw error;
        });
        try {
            await vi.waitFor(async () => {
                const ready = await app.inject({ method: 'GET', url: '/v1/features' });
                expect(ready.json()).toMatchObject({
                    capabilities: { homeSearch: { enabled: true } },
                });
            });
            expect(canonicalReads).toHaveLength(0);

            const account = await db.account.create({
                data: { publicKey: `home-search-api-${randomUUID()}`, encryptionMode: 'plain' },
                select: { id: true },
            });
            const token = await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' });
            const session = await db.session.create({
                data: {
                    tag: `home-search-api-${randomUUID()}`,
                    accountId: account.id,
                    metadata: 'metadata',
                    encryptionMode: 'plain',
                    currentStorageState: 'hosted',
                },
                select: { id: true },
            });
            const homeServerIdentityId = await getOrCreateServerIdentityId(process.env);
            const search = async (query: string) => app.inject({
                method: 'POST',
                url: '/v1/home/search',
                headers: { authorization: `Bearer ${token}` },
                payload: { v: 1, query, scope: { type: 'global' }, mode: 'auto' },
            });

            // Unauthorized credentials are rejected by the real verifier before any index access.
            const forged = await app.inject({
                method: 'POST',
                url: '/v1/home/search',
                headers: { authorization: 'Bearer forged-home-search-credential' },
                payload: { v: 1, query: 'quokka', scope: { type: 'global' }, mode: 'auto' },
            });
            expect(forged.statusCode).toBe(401);
            expect(forged.json()).toMatchObject({ error: 'invalid_token' });

            // Canonical insert with a nested plain object envelope becomes searchable.
            const inserted = await createSessionMessage({
                actorUserId: account.id,
                sessionId: session.id,
                localId: 'home-search-api-primary',
                content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'quokka burrow chronicle' } } },
            });
            expect(inserted).toMatchObject({ ok: true, didWrite: true });
            await eventually(async () => {
                const response = await search('quokka');
                expect(response.statusCode).toBe(200);
                expect(response.json()).toMatchObject({
                    ok: true,
                    hits: [expect.objectContaining({
                        sessionId: session.id,
                        homeServerIdentityId,
                        summary: expect.stringContaining('quokka'),
                    })],
                });
            });
            expect(canonicalReads).toHaveLength(1);
            expect(canonicalReads.at(-1)).toEqual(expect.objectContaining({
                where: expect.objectContaining({ sessionId: { in: [session.id] } }),
            }));

            // Canonical agent content stored beneath content.data also becomes searchable.
            const blocks = await createSessionMessage({
                actorUserId: account.id,
                sessionId: session.id,
                localId: 'home-search-api-blocks',
                content: {
                    t: 'plain',
                    v: {
                        role: 'agent',
                        content: {
                            type: 'acp',
                            agentId: 'home-search-api-agent',
                            data: { type: 'text', text: 'echidna trench blueprint' },
                        },
                    },
                },
            });
            expect(blocks).toMatchObject({ ok: true, didWrite: true });
            await eventually(async () => {
                expect((await search('echidna')).json()).toMatchObject({
                    ok: true,
                    hits: [expect.objectContaining({ sessionId: session.id })],
                });
            });

            // Canonical edit (same localId) changes the indexed result.
            const edited = await createSessionMessage({
                actorUserId: account.id,
                sessionId: session.id,
                localId: 'home-search-api-primary',
                content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'platypus gorge revision' } } },
            });
            expect(edited).toMatchObject({ ok: true, didUpdate: true });
            await eventually(async () => {
                expect((await search('quokka')).json()).toMatchObject({ ok: true, hits: [] });
                expect((await search('platypus')).json()).toMatchObject({
                    ok: true,
                    hits: [expect.objectContaining({ sessionId: session.id })],
                });
                // The untouched sibling row keeps its own indexed entry.
                expect((await search('echidna')).json()).toMatchObject({ ok: true, hits: [expect.anything()] });
            });

            // Edit-to-empty removes the stale derived row instead of keeping old text searchable.
            const emptied = await createSessionMessage({
                actorUserId: account.id,
                sessionId: session.id,
                localId: 'home-search-api-primary',
                content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: '' } } },
            });
            expect(emptied).toMatchObject({ ok: true, didUpdate: true });
            await eventually(async () => {
                expect((await search('platypus')).json()).toMatchObject({ ok: true, hits: [] });
            });

            // Canonical message deletion (sidechain retention owner) removes the derived row.
            const retained = await createSessionMessage({
                actorUserId: account.id,
                sessionId: session.id,
                localId: 'home-search-api-sidechain',
                sidechainId: 'home-search-api-expired-sidechain',
                content: { t: 'plain', v: { role: 'assistant', content: { type: 'text', text: 'wombat retention clause' } } },
            });
            expect(retained).toMatchObject({ ok: true, didWrite: true });
            if (!retained.ok) throw new Error('expected canonical sidechain write');
            await eventually(async () => {
                expect((await search('wombat')).json()).toMatchObject({ ok: true, hits: [expect.anything()] });
            });
            await db.sessionMessage.update({
                where: { id: retained.message.id },
                data: { createdAt: new Date('2025-01-01T00:00:00.000Z') },
            });
            await expect(runSessionSidechainMessageRetentionRule({
                cutoff: new Date('2026-01-01T00:00:00.000Z'),
                batchSize: 10,
                dryRun: false,
                maxDeletesPerRulePerRun: 10,
            })).resolves.toMatchObject({ deleted: 1 });
            await eventually(async () => {
                expect((await search('wombat')).json()).toMatchObject({ ok: true, hits: [] });
            });

            // Canonical whole-session deletion removes every remaining derived row for it.
            const last = await createSessionMessage({
                actorUserId: account.id,
                sessionId: session.id,
                localId: 'home-search-api-last',
                content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'zephyr canyon ledger' } } },
            });
            expect(last).toMatchObject({ ok: true, didWrite: true });
            await eventually(async () => {
                expect((await search('zephyr')).json()).toMatchObject({ ok: true, hits: [expect.anything()] });
            });
            const current = await db.session.findUniqueOrThrow({ where: { id: session.id }, select: { updatedAt: true } });
            await inTx(async (tx) => {
                await deleteSessionTree(tx, { sessionId: session.id, sessionUpdatedAt: current.updatedAt, actorAccountId: account.id, reason: 'user_request' });
            });
            await eventually(async () => {
                expect((await search('zephyr')).json()).toMatchObject({ ok: true, hits: [] });
                expect((await search('echidna')).json()).toMatchObject({ ok: true, hits: [] });
            });
        } finally {
            Reflect.set(boundary, '_request', nativeRequest);
            await stopHomeSearch();
            await app.close();
        }
    }, 120_000);

    it('uses the canonical session-list visibility rule without reading unrelated Sessions for a scoped search', async () => {
        const { startApi } = await import('@/app/api/api');
        const app = await startApi();
        try {
            await vi.waitFor(async () => {
                const ready = await app.inject({ method: 'GET', url: '/v1/features' });
                expect(ready.json()).toMatchObject({
                    capabilities: { homeSearch: { enabled: true } },
                });
            });

            const [owner, viewer, outsider] = await Promise.all([
                db.account.create({
                    data: { publicKey: `home-search-owner-${randomUUID()}`, encryptionMode: 'plain' },
                    select: { id: true },
                }),
                db.account.create({
                    data: { publicKey: `home-search-viewer-${randomUUID()}`, encryptionMode: 'plain' },
                    select: { id: true },
                }),
                db.account.create({
                    data: { publicKey: `home-search-outsider-${randomUUID()}`, encryptionMode: 'plain' },
                    select: { id: true },
                }),
            ]);
            const session = await db.session.create({
                data: {
                    tag: `home-search-shared-${randomUUID()}`,
                    accountId: owner.id,
                    metadata: 'metadata',
                    encryptionMode: 'plain',
                    currentStorageState: 'hosted',
                },
                select: { id: true },
            });
            const team = await db.team.create({ data: { name: `home-search-team-${randomUUID()}` } });
            await db.teamMembership.create({ data: { teamId: team.id, accountId: viewer.id, role: 'member' } });
            await db.sessionTeamGrant.create({ data: { sessionId: session.id, teamId: team.id, accessLevel: 'view', effectiveAt: new Date() } });
            const published = await createSessionMessage({
                actorUserId: owner.id,
                sessionId: session.id,
                localId: 'home-search-shared-published',
                content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'shared marmot field notes' } } },
            });
            expect(published).toMatchObject({ ok: true, didWrite: true });
            if (!published.ok) throw new Error('expected published shared message');
            const privateRow = await createSessionMessage({
                actorUserId: owner.id,
                sessionId: session.id,
                localId: 'home-search-shared-private',
                content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'marmot marmot marmot private draft' } } },
            });
            expect(privateRow).toMatchObject({ ok: true, didWrite: true });
            if (!privateRow.ok) throw new Error('expected private shared message');
            await db.session.update({
                where: { id: session.id },
                data: {
                    currentStorageState: 'snapshot_complete',
                    acceptedThroughServerSeq: null,
                    materializationPublicationId: `publication-${randomUUID()}`,
                    materializedThroughSourceAt: BigInt(Date.now()),
                    publishedThroughServerSeq: published.message.seq,
                },
            });

            const [viewerToken, outsiderToken] = await Promise.all([
                auth.createToken(viewer.id, undefined, { kind: 'account', authority: 'present_user' }),
                auth.createToken(outsider.id, undefined, { kind: 'account', authority: 'present_user' }),
            ]);
            const searchAs = async (token: string) => app.inject({
                method: 'POST',
                url: '/v1/home/search',
                headers: { authorization: `Bearer ${token}` },
                payload: { v: 1, query: 'marmot', scope: { type: 'global' }, mode: 'auto', maxResults: 1 },
            });

            await eventually(async () => {
                expect((await searchAs(viewerToken)).json()).toMatchObject({
                    ok: true,
                    hits: [expect.objectContaining({
                        sessionId: session.id,
                        seqFrom: published.message.seq,
                        seqTo: published.message.seq,
                    })],
                });
            });
            expect((await searchAs(outsiderToken)).json()).toMatchObject({ ok: true, hits: [] });

            await db.session.createMany({ data: Array.from({ length: 999 }, (_, index) => ({
                id: perfFixtureId(20261023, 'home-search-unrelated-session', index),
                tag: `home-search-unrelated-${index}`,
                accountId: viewer.id,
                metadata: 'unrelated Session',
                encryptionMode: 'plain',
                currentStorageState: 'hosted',
            })) });
            const { boundary, nativeRequest } = getNativePrismaRequestBoundary();
            let returnedSessionRows = 0;
            // Pass through the genuine database adapter: the production resolver,
            // Session access rules and publication-ceiling projection remain real.
            Reflect.set(boundary, '_request', new Proxy(nativeRequest, { async apply(target, receiver, args) {
                const result: unknown = await Reflect.apply(target, receiver, args);
                const request: unknown = args[0];
                const queryArgs: unknown = request && typeof request === 'object' ? Reflect.get(request, 'args') : null;
                const select: unknown = queryArgs && typeof queryArgs === 'object' ? Reflect.get(queryArgs, 'select') : null;
                if (request && typeof request === 'object' && Reflect.get(request, 'model') === 'Session'
                    && Reflect.get(request, 'action') === 'findMany' && Array.isArray(result)
                    && select && typeof select === 'object' && Reflect.get(select, 'id') === true
                    && Object.entries(SESSION_TRANSCRIPT_PUBLICATION_SELECT).every(([key, value]) => Reflect.get(select, key) === value)) {
                    returnedSessionRows += result.length;
                }
                return result;
            } }));
            try {
                const scopedSearch = () => app.inject({
                    method: 'POST', url: '/v1/home/search',
                    headers: { authorization: `Bearer ${viewerToken}` },
                    payload: { v: 1, query: 'marmot', scope: { type: 'session', sessionId: session.id },
                        mode: 'auto', maxResults: 1 },
                });
                const selected = await scopedSearch();
                expect(selected.statusCode).toBe(200);
                expect(selected.json()).toMatchObject({ ok: true, hits: [expect.objectContaining({
                    sessionId: session.id, seqFrom: published.message.seq, seqTo: published.message.seq,
                })] });
                const selectedRows = returnedSessionRows;
                await db.teamMembership.deleteMany({ where: { teamId: team.id, accountId: viewer.id } });
                returnedSessionRows = 0;
                const revoked = await scopedSearch();
                expect(revoked.statusCode).toBe(200);
                expect(revoked.json()).toMatchObject({ ok: true, hits: [] });
                const revokedRows = returnedSessionRows;
                expect({ selectedRows, revokedRows }).toEqual({ selectedRows: 1, revokedRows: 0 });
            } finally { Reflect.set(boundary, '_request', nativeRequest); }
        } finally {
            await stopHomeSearch();
            await app.close();
        }
    }, 120_000);

    it('builds no Home search lifecycle, route, or capability when the search feature is disabled', async () => {
        const previous = process.env.HAPPIER_FEATURE_SEARCH__ENABLED;
        process.env.HAPPIER_FEATURE_SEARCH__ENABLED = '0';
        const findManySpy = vi.spyOn(db.sessionMessage, 'findMany');
        const { startApi } = await import('@/app/api/api');
        const app = await startApi();
        try {
            const account = await db.account.create({
                data: { publicKey: `home-search-api-disabled-${randomUUID()}`, encryptionMode: 'plain' },
                select: { id: true },
            });
            const token = await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' });

            const features = await app.inject({ method: 'GET', url: '/v1/features' });
            expect(features.json()).toMatchObject({ features: { search: { enabled: false } } });
            expect(features.json().capabilities).not.toHaveProperty('homeSearch');

            const response = await app.inject({
                method: 'POST',
                url: '/v1/home/search',
                headers: { authorization: `Bearer ${token}` },
                payload: { v: 1, query: 'quokka', scope: { type: 'global' }, mode: 'auto' },
            });
            expect(response.statusCode).toBe(404);
            // No derived projection is constructed at all: the disabled feature is not a
            // route-only gate over a running index.
            expect(findManySpy).not.toHaveBeenCalled();
            expect(shutdownHandlers.has('home-search')).toBe(false);
        } finally {
            findManySpy.mockRestore();
            if (previous === undefined) delete process.env.HAPPIER_FEATURE_SEARCH__ENABLED;
            else process.env.HAPPIER_FEATURE_SEARCH__ENABLED = previous;
            await stopHomeSearch();
            await app.close();
        }
    }, 120_000);

    it('listens before demanded reconciliation and keeps canonical writes available when initial indexing fails', async () => {
        let releaseCanonicalRead!: () => void;
        let canonicalReadStarted!: () => void;
        const canonicalReadEntered = new Promise<void>((resolve) => { canonicalReadStarted = resolve; });
        const canonicalReadDeferred = new Promise<void>((resolve) => { releaseCanonicalRead = resolve; });
        vi.spyOn(db.sessionMessage, 'findMany').mockImplementationOnce((async () => {
            canonicalReadStarted();
            await canonicalReadDeferred;
            throw new Error('injected derived-index read failure');
        // Prisma advertises PrismaPromise, while this boundary fixture deliberately
        // interposes an ordinary deferred promise to prove API listen is independent.
        }) as any);
        const { startApi } = await import('@/app/api/api');
        const app = await startApi();
        try {
            const account = await db.account.create({
                data: { publicKey: `home-search-api-failure-${randomUUID()}`, encryptionMode: 'plain' },
                select: { id: true },
            });
            const token = await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' });
            const session = await db.session.create({
                data: {
                    tag: `home-search-api-failure-${randomUUID()}`,
                    accountId: account.id,
                    metadata: 'metadata',
                    encryptionMode: 'plain',
                    currentStorageState: 'hosted',
                },
                select: { id: true },
            });

            // Demand starts reconciliation only after the API is already listening.
            const preparing = app.inject({
                method: 'POST',
                url: '/v1/home/search',
                headers: { authorization: `Bearer ${token}` },
                payload: { v: 1, query: 'canonical', scope: { type: 'global' }, mode: 'auto' },
            }).then(response => response);
            await canonicalReadEntered;
            const indexing = await app.inject({ method: 'GET', url: '/v1/features' });
            expect(indexing.json()).toMatchObject({
                capabilities: { homeSearch: { enabled: false, reason: 'indexing' } },
            });
            const unauthorized = await app.inject({
                method: 'POST',
                url: '/v1/home/search',
                payload: { v: 1, query: 'probe', scope: { type: 'global' }, mode: 'auto' },
            });
            expect(unauthorized.statusCode).toBe(401);

            await expect(createSessionMessage({
                actorUserId: account.id,
                sessionId: session.id,
                localId: 'home-search-api-index-failure',
                content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'canonical truth survives projection failure' } } },
            })).resolves.toMatchObject({ ok: true, didWrite: true });
            await expect(db.sessionMessage.count({ where: { sessionId: session.id } })).resolves.toBe(1);

            releaseCanonicalRead();
            await vi.waitFor(async () => {
                const features = await app.inject({ method: 'GET', url: '/v1/features' });
                expect(features.json()).toMatchObject({
                    capabilities: { homeSearch: { enabled: false, reason: 'index_unavailable' } },
                });
            });

            const response = await preparing;
            expect(response.statusCode).toBe(200);
            expect(response.json()).toMatchObject({
                v: 1,
                ok: false,
                errorCode: 'memory_index_missing',
            });
        } finally {
            releaseCanonicalRead();
            await stopHomeSearch();
            await app.close();
        }
    }, 120_000);
});
