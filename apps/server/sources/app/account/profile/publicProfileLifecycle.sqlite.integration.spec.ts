import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { UpdateContainerSchema } from '@happier-dev/protocol/updates';
import { eventRouter } from '@/app/events/connectionEventRouter';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { DEFAULT_PUBLIC_PROFILE_POLICY_V1, type PublicProfileSnapshotV1 } from '@happier-dev/protocol/account/publicProfile';
import { DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1, PublicProfilePublishBodyV1Schema } from '@happier-dev/protocol/account/publicProfilePublication';
import { db } from '@/storage/db';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { registerAccountPublicProfileRoutes } from '@/app/api/routes/account/registerAccountPublicProfileRoutes';
import { registerPublicProfileReadRoutes } from '@/app/api/routes/account/registerPublicProfileReadRoutes';
import { replaceAccountForProviderResetInTx } from '@/app/home/governance/accountReplacement';
import { setAccountStatusInTx } from '@/app/home/governance/accountLifecycle';
import { changeUsernameInTx, usernameUpdate, usernameRelease } from '@/app/social/usernameUpdate';
import { Context } from '@/context';
import { inTx } from '@/storage/inTx';
import { resolveApiRateLimitPluginOptions } from '@/app/api/utils/apiRateLimitPolicy';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { publishPublicProfile, resumePublicProfile } from './publicProfilePublish';
import { updatePublicProfile } from './publicProfileUpdate';
import { refreshPublicProfile } from './publicProfileRefresh';
import { readPublicProfile } from './publicProfileRead';
import { pausePublicProfile } from './publicProfilePause';
import { unpublishPublicProfile } from './publicProfileUnpublish';
import { moderatePublicProfile } from './publicProfileModeration';
import { withdrawPublicProfileInTx } from './publicProfileWithdrawal';
import { publicProfileServerDependencies as deps } from './publicProfileDependencies';

const snapshot: PublicProfileSnapshotV1 = { v: 1, computedAtMs: 2000, period: { startMs: 1000, endMs: 2000, timeZoneOffsetMinutes: 0 },
    coverage: { status: 'partial', method: 'runtime' }, fieldCoverage: { tokens: { status: 'partial', method: 'runtime' } },
    facts: { tokens: 987654321, activeDays: 2, agentMix: [{ agentId: 'codex', share: 1, tokens: 987654321, coverage: { status: 'partial', method: 'runtime' } }] } };
const query = PublicProfilePublishBodyV1Schema.shape.query.parse(normalizeUsageQuery({
    population: 'public_eligible_personal', period: { startMs: 1000, endMs: 2000 }, timeZoneOffsetMinutes: 0,
}));
const body = () => PublicProfilePublishBodyV1Schema.parse({ policy: structuredClone(DEFAULT_PUBLIC_PROFILE_POLICY_V1), metadata: {}, projectSelections: [], query, snapshot,
    layout: { v: 1, items: [] }, appearance: DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1 });
const publicationEnv = { HAPPIER_PUBLIC_SERVER_URL: 'https://profiles.example/prefix',
    HAPPIER_PUBLIC_PROFILE_REPORT_URL: 'mailto:operator@example.test', HAPPIER_ACCOUNT_SERVICE_DISPLAY_NAME: 'Test Home' };

describe('Account public profile durable lifecycle', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-public-profile-',
        env: { ...publicationEnv, NODE_OPTIONS: [process.env.NODE_OPTIONS, '--conditions=happier-source'].filter(Boolean).join(' ') } }); }, 120_000);
    afterAll(async () => { await harness?.close(); });
    afterEach(async () => { harness.restoreEnv(); await db.homeAdministrationEvent.deleteMany(); await db.account.deleteMany(); });

    it('publishes one addressed Account change after committed disclosure changes and none for no-ops or rollback', async () => {
        const account = await db.account.create({ data: { publicKey: 'profile-push-owner', username: 'push_owner' } });
        const operator = await db.account.create({ data: { publicKey: 'profile-push-operator', homeRole: 'owner' } });
        const emit = vi.fn();
        eventRouter.setIo({ to: () => ({ emit, disconnectSockets: vi.fn() }) });
        const wakes = () => emit.mock.calls.map(([, payload]) => UpdateContainerSchema.parse(payload))
            .filter(update => update.body.t === 'account-change' && update.body.entityIds?.includes('public-profile'));
        let cursor = account.seq;
        const changed = async (operation: () => Promise<unknown>) => {
            emit.mockClear();
            await operation();
            const marker = await db.accountChange.findUnique({ where: {
                accountId_kind_entityId: { accountId: account.id, kind: 'account', entityId: 'public-profile' },
            } });
            expect(marker?.cursor).toBeGreaterThan(cursor);
            cursor = marker!.cursor;
            expect(wakes()).toHaveLength(1);
            expect(wakes()[0]?.body).toEqual({ t: 'account-change', changeKinds: ['account'],
                entityIds: ['public-profile'], sessionSystemRecords: [] });
        };
        const unchanged = async (operation: () => Promise<unknown>) => {
            emit.mockClear();
            await operation();
            expect(wakes()).toEqual([]);
            expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).seq).toBe(cursor);
        };
        try {
            await unchanged(() => unpublishPublicProfile(account.id));
            await changed(() => publishPublicProfile(account.id, body(), publicationEnv, deps));
            await unchanged(() => publishPublicProfile(account.id, body(), publicationEnv, deps));
            await changed(() => updatePublicProfile(account.id, { policy: { ...body().policy, indexable: true } }));
            await changed(() => refreshPublicProfile(account.id, { query, snapshot: { ...snapshot, computedAtMs: 3000 } }, publicationEnv, deps));
            await changed(() => pausePublicProfile(account.id));
            await unchanged(() => pausePublicProfile(account.id));
            await changed(() => resumePublicProfile(account.id, { query, snapshot }, publicationEnv, deps));
            emit.mockClear();
            await expect(inTx(async tx => {
                await withdrawPublicProfileInTx(tx, account.id);
                expect(wakes()).toEqual([]);
                throw new Error('rollback-publication');
            })).rejects.toThrow('rollback-publication');
            expect(wakes()).toEqual([]);
            expect(await readPublicProfile('push_owner', publicationEnv, deps)).toMatchObject({ kind: 'published' });
            await changed(() => unpublishPublicProfile(account.id));
            await unchanged(() => unpublishPublicProfile(account.id));
            await changed(() => moderatePublicProfile(operator.id, account.id, 'restrict', 'operator restriction'));
            await unchanged(() => unpublishPublicProfile(account.id));
            await changed(() => moderatePublicProfile(operator.id, account.id, 'restore', 'operator restored'));
        } finally { eventRouter.clearIo(); }
    });

    it.each([{ relative: '30days' }, { relative: '90days' }, { relative: 'year' }, { startMs: 1000, endMs: 2000 }, {}])('round-trips publication query period %j through HTTP read, refresh and resume', async period => {
        const account = await db.account.create({ data: { publicKey: 'public-profile-period', username: 'period_owner' } });
        const candidate = PublicProfilePublishBodyV1Schema.parse({ ...body(), query: { ...query, period } });
        await withAuthenticatedTestApp(app => registerAccountPublicProfileRoutes(app), async app => {
            const headers = { 'x-test-user-id': account.id };
            const published = await app.inject({ method: 'POST', url: '/v1/account/public-profile/publish', headers, payload: candidate });
            expect(published.statusCode).toBe(200);
            const stored = await db.accountPublicProfile.findUniqueOrThrow({ where: { accountId: account.id } });
            expect(JSON.parse(stored.queryJson!).period).toEqual(period);
            expect(published.json()).toMatchObject({ kind: 'updated', record: { state: 'published' } });
            expect(published.json().record.query.period).toEqual(period);
            const owner = await app.inject({ method: 'GET', url: '/v1/account/public-profile', headers });
            expect(owner.statusCode).toBe(200);
            expect(owner.json().record.query.period).toEqual(period);
            const publicRead = await readPublicProfile(account.username!, publicationEnv, deps);
            expect(publicRead.kind).toBe('published');
            if (publicRead.kind !== 'published') throw new Error('Expected published period');
            if ('relative' in period) expect(publicRead.view).toHaveProperty('relativePeriod', period.relative);
            else expect(publicRead.view).not.toHaveProperty('relativePeriod');
            const payload = { query: owner.json().record.query, snapshot };
            const refreshed = await app.inject({ method: 'PUT', url: '/v1/account/public-profile/snapshot', headers, payload });
            expect(refreshed.json()).toMatchObject({ kind: 'updated', record: { state: 'published' } });
            expect(refreshed.json().record.query.period).toEqual(period);
            const paused = await app.inject({ method: 'POST', url: '/v1/account/public-profile/pause', headers, payload: {} });
            expect(paused.json()).toMatchObject({ kind: 'updated', record: { state: 'paused' } });
            const resumed = await app.inject({ method: 'POST', url: '/v1/account/public-profile/resume', headers, payload });
            expect(resumed.json()).toMatchObject({ kind: 'updated', record: { state: 'published' } });
            expect(resumed.json().record.query.period).toEqual(period);
            expect(await readPublicProfile(account.username!, publicationEnv, deps)).toMatchObject({ kind: 'published',
                view: { ...('relative' in period ? { relativePeriod: period.relative } : {}), snapshot: { period: snapshot.period } } });
        });
    });

    it.each(['plain', 'e2ee'])('stores explicit disclosure without changing %s Account encryption authority or keys', async encryptionMode => {
        const account = await db.account.create({ data: { publicKey: `public-profile-${encryptionMode}`, username: `owner_${encryptionMode}`, encryptionMode,
            ...(encryptionMode === 'e2ee' ? { contentPublicKey: new Uint8Array([1, 2, 3]), contentPublicKeySig: new Uint8Array([4, 5, 6]) } : {}) } });
        const result = await publishPublicProfile(account.id, body(), publicationEnv, deps);
        expect(result.kind).toBe('updated');
        const row = await db.accountPublicProfile.findUniqueOrThrow({ where: { accountId: account.id } });
        expect(row.state).toBe('published');
        expect(JSON.parse(row.snapshotJson!).facts.tokens).toBe(987654321);
        const after = await db.account.findUniqueOrThrow({ where: { id: account.id } });
        expect(after.encryptionMode).toBe(encryptionMode);
        expect(after.contentPublicKey).toEqual(account.contentPublicKey);
        expect(after.contentPublicKeySig).toEqual(account.contentPublicKeySig);
    });

    it('remasks a stale refresh after hide, keeps layout-only Apply independent of consent, and rejects refresh after pause/unpublish', async () => {
        const account = await db.account.create({ data: { publicKey: 'public-profile-stale', username: 'stale_owner' } });
        await publishPublicProfile(account.id, body(), publicationEnv, deps);
        const hidden = body().policy;
        hidden.fields.tokens = false;
        expect((await updatePublicProfile(account.id, { policy: hidden })).kind).toBe('updated');
        const offlineLayout = { v: 1, items: [{ kind: 'widget', id: 'offline-applied', size: 'medium', frameStyle: 'plain',
            presentation: { kind: 'declarative', document: { version: 1, root: { kind: 'text', text: 'Applied while sources are offline' } } } }] } as const;
        expect((await updatePublicProfile(account.id, { layout: PublicProfilePublishBodyV1Schema.shape.layout.parse(offlineLayout) })).kind).toBe('updated');
        expect((await refreshPublicProfile(account.id, { query, snapshot }, publicationEnv, deps)).kind).toBe('updated');
        const row = await db.accountPublicProfile.findUniqueOrThrow({ where: { accountId: account.id } });
        expect(row.snapshotJson).not.toContain('987654321');
        expect(JSON.parse(row.policyJson!).fields.tokens).toBe(false);
        expect(JSON.parse(row.layoutJson!).items[0].id).toBe('offline-applied');
        const read = await readPublicProfile('stale_owner', publicationEnv, deps);
        expect(read.kind).toBe('published');
        expect(JSON.stringify(read)).not.toContain('987654321');
        expect((await pausePublicProfile(account.id)).kind).toBe('updated');
        expect(await refreshPublicProfile(account.id, { query, snapshot }, publicationEnv, deps)).toEqual({ kind: 'unavailable', reason: 'not_published' });
        expect((await db.accountPublicProfile.findUniqueOrThrow({ where: { accountId: account.id } })).state).toBe('paused');
        expect((await unpublishPublicProfile(account.id)).kind).toBe('updated');
        expect(await refreshPublicProfile(account.id, { query, snapshot }, publicationEnv, deps)).toEqual({ kind: 'unavailable', reason: 'not_published' });
        expect(await readPublicProfile('stale_owner', publicationEnv, deps)).toEqual({ kind: 'unavailable' });
    });

    it.each(['widen', 'query'] as const)('commits %s and fresh snapshot atomically through the owner HTTP update', async change => {
        const account = await db.account.create({ data: { publicKey: `public-profile-update-${change}`, username: `update_${change}` } });
        const initial = body();
        initial.policy.fields.tokens = false;
        await publishPublicProfile(account.id, initial, publicationEnv, deps);
        const updatedQuery = change === 'query' ? { ...query, period: { startMs: 2000, endMs: 3000 } } : query;
        const freshSnapshot = { ...snapshot, computedAtMs: 3000, facts: { tokens: 12345 },
            period: change === 'query' ? { ...snapshot.period, startMs: 2000, endMs: 3000 } : snapshot.period };
        await withAuthenticatedTestApp(app => registerAccountPublicProfileRoutes(app), async app => {
            const response = await app.inject({ method: 'PUT', url: '/v1/account/public-profile/policy',
                headers: { 'x-test-user-id': account.id }, payload: { policy: body().policy, query: updatedQuery, snapshot: freshSnapshot } });
            expect(response.statusCode).toBe(200);
            expect(response.json()).toMatchObject({ kind: 'updated', record: { snapshot: { computedAtMs: 3000, facts: { tokens: 12345 } } } });
        });
        const row = await db.accountPublicProfile.findUniqueOrThrow({ where: { accountId: account.id } });
        expect(JSON.parse(row.queryJson!)).toEqual(updatedQuery);
        expect(JSON.parse(row.snapshotJson!)).toMatchObject({ computedAtMs: 3000, facts: { tokens: 12345 } });
        expect((await refreshPublicProfile(account.id, { query: updatedQuery, snapshot: freshSnapshot }, publicationEnv, deps)).kind).toBe('updated');
    });

    it('keeps restriction after owner Unpublish and operator Restore cannot republish deleted disclosure', async () => {
        const account = await db.account.create({ data: { publicKey: 'public-profile-restricted', username: 'restricted_owner' } });
        const operator = await db.account.create({ data: { publicKey: 'public-profile-operator', homeRole: 'owner' } });
        const selected = body();
        selected.query = PublicProfilePublishBodyV1Schema.shape.query.parse(normalizeUsageQuery({ ...selected.query, machines: ['owner-private-machine-scope'] }));
        await publishPublicProfile(account.id, selected, publicationEnv, deps);
        expect((await db.accountPublicProfile.findUniqueOrThrow({ where: { accountId: account.id } })).queryJson).toContain('owner-private-machine-scope');
        await withAuthenticatedTestApp(app => { registerAccountPublicProfileRoutes(app); registerPublicProfileReadRoutes(app); }, async app => {
            const moderate = (actorAccountId: string, operation: 'restrict' | 'restore', reason: string) => app.inject({
                method: 'POST', url: `/v1/home/public-profiles/${account.id}/${operation}`,
                headers: { 'x-test-user-id': actorAccountId }, payload: { reason },
            });
            const before = await app.inject({ method: 'GET', url: '/v1/public/profiles/restricted_owner' });
            expect(before.statusCode).toBe(200);
            expect(before.json()).toMatchObject({ kind: 'published', view: { snapshot: { facts: { tokens: 987654321 } } } });
            expect(before.headers.etag).toBeTypeOf('string');
            const deniedRestriction = await moderate(account.id, 'restrict', 'owner cannot self-moderate');
            expect(deniedRestriction.statusCode).toBe(403);
            expect(deniedRestriction.json()).toEqual({ error: 'home_governance_forbidden' });
            const restricted = await moderate(operator.id, 'restrict', 'reported content');
            expect(restricted.statusCode).toBe(200);
            expect(restricted.json()).toEqual({ kind: 'updated', record: null });
            expect(await readPublicProfile('restricted_owner', publicationEnv, deps)).toEqual({ kind: 'unavailable' });
            const unpublished = await app.inject({ method: 'DELETE', url: '/v1/account/public-profile', headers: { 'x-test-user-id': account.id } });
            expect(unpublished.statusCode).toBe(200);
            expect(unpublished.json()).toMatchObject({ kind: 'updated', record: { state: 'draft', restriction: { reason: 'reported content' } } });
            const row = await db.accountPublicProfile.findUniqueOrThrow({ where: { accountId: account.id } });
            expect(row.removalReason).toBe('reported content');
            expect(row.snapshotJson).toBeNull();
            expect(row.policyJson).toBeNull();
            expect(await publishPublicProfile(account.id, body(), publicationEnv, deps)).toEqual({ kind: 'unavailable', reason: 'restricted' });
            const deniedRestore = await moderate(account.id, 'restore', 'self restore');
            expect(deniedRestore.statusCode).toBe(403);
            expect(deniedRestore.json()).toEqual({ error: 'home_governance_forbidden' });
            const restored = await moderate(operator.id, 'restore', 'operator restored');
            expect(restored.statusCode).toBe(200);
            expect(restored.json()).toEqual({ kind: 'updated', record: null });
            expect(await readPublicProfile('restricted_owner', publicationEnv, deps)).toEqual({ kind: 'unavailable' });
            expect(await db.accountPublicProfile.findUniqueOrThrow({ where: { accountId: account.id } })).toMatchObject({
                state: 'draft', policyJson: null, metadataJson: null, queryJson: null, snapshotJson: null,
                layoutJson: null, appearanceJson: null, publishedAt: null, removedAt: null,
                removedByAccountId: null, removalReason: null,
            });
            const readback = await app.inject({ method: 'GET', url: '/v1/account/public-profile', headers: { 'x-test-user-id': account.id } });
            expect(readback.statusCode).toBe(200);
            expect(readback.json()).toMatchObject({ kind: 'ready', record: { state: 'draft', snapshot: null,
                policy: null, query: null, metadata: null, layout: null, appearance: null, restriction: null } });
            const anonymous = await app.inject({ method: 'GET', url: '/v1/public/profiles/restricted_owner',
                headers: { 'if-none-match': before.headers.etag! } });
            expect(anonymous.statusCode).toBe(404);
            expect(anonymous.json()).toEqual({ kind: 'unavailable' });
            expect(anonymous.headers.etag).toBeUndefined();
            const fresh = body();
            fresh.snapshot.facts = { tokens: 12345 };
            const published = await app.inject({ method: 'POST', url: '/v1/account/public-profile/publish',
                headers: { 'x-test-user-id': account.id }, payload: fresh });
            expect(published.statusCode).toBe(200);
            expect(published.json()).toMatchObject({ kind: 'updated', record: { snapshot: { facts: { tokens: 12345 } } } });
            const after = await app.inject({ method: 'GET', url: '/v1/public/profiles/restricted_owner' });
            expect(after.statusCode).toBe(200);
            expect(after.json()).toMatchObject({ kind: 'published', view: { snapshot: { facts: { tokens: 12345 } } } });
            expect(after.body).not.toContain('987654321');
            expect(await db.homeAdministrationEvent.findMany({
                select: { action: true, actorAccountId: true, targetId: true, summary: true }, orderBy: { at: 'asc' },
            })).toEqual([
                { action: 'public_profile.restricted', actorAccountId: operator.id, targetId: account.id, summary: { reason: 'reported content' } },
                { action: 'public_profile.restored', actorAccountId: operator.id, targetId: account.id, summary: { reason: 'operator restored' } },
            ]);
        });
    });

    it('keeps a renamed publication at the new handle, then withdraws it on explicit release', async () => {
        const account = await db.account.create({ data: { publicKey: 'public-profile-rename', username: 'rename_owner' } });
        await publishPublicProfile(account.id, body(), publicationEnv, deps);
        const before = await db.accountPublicProfile.findUniqueOrThrow({ where: { accountId: account.id } });
        await usernameUpdate(Context.create(account.id), 'renamed_owner');
        expect(await db.accountPublicProfile.findUniqueOrThrow({ where: { accountId: account.id } })).toEqual(before);
        expect(await readPublicProfile('rename_owner', publicationEnv, deps)).toEqual({ kind: 'unavailable' });
        expect(await readPublicProfile('renamed_owner', publicationEnv, deps)).toMatchObject({ kind: 'published' });
        expect(await usernameRelease(Context.create(account.id))).toEqual({ username: null, released: true, reservedUntilMs: null });
        expect(await db.accountPublicProfile.findUnique({ where: { accountId: account.id } })).toBeNull();
        expect(await readPublicProfile('renamed_owner', publicationEnv, deps)).toEqual({ kind: 'unavailable' });
    });

    it.each(['paused', 'restricted'] as const)('preserves a %s publication and restriction through rename', async state => {
        const account = await db.account.create({ data: { publicKey: `public-profile-rename-${state}`, username: `rename_${state}` } });
        await publishPublicProfile(account.id, body(), publicationEnv, deps);
        if (state === 'paused') await pausePublicProfile(account.id);
        else await db.accountPublicProfile.update({ where: { accountId: account.id }, data: { removedAt: new Date(), removalReason: 'Operator restriction' } });
        const before = await db.accountPublicProfile.findUniqueOrThrow({ where: { accountId: account.id } });
        await usernameUpdate(Context.create(account.id), `renamed_${state}`);
        expect(await db.accountPublicProfile.findUniqueOrThrow({ where: { accountId: account.id } })).toEqual(before);
        expect(await readPublicProfile(`renamed_${state}`, publicationEnv, deps)).toMatchObject({ kind: state === 'paused' ? 'paused' : 'unavailable' });
    });

    it('withdraws disclosure on identity clear and transfers only restriction during provider reset', async () => {
        const account = await db.account.create({ data: { publicKey: 'public-profile-reset', username: 'reset_owner', homeRole: 'owner' } });
        await publishPublicProfile(account.id, body(), publicationEnv, deps);
        await db.accountPublicProfile.update({ where: { accountId: account.id }, data: { removedAt: new Date(), removalReason: 'restriction survives recovery', removedByAccountId: account.id } });
        const replacementAccountId = 'public-profile-replacement';
        const replaced = await inTx(tx => replaceAccountForProviderResetInTx(tx, {
            oldAccountId: account.id, replacement: { accountId: replacementAccountId, publicKey: 'public-profile-reset-new-key' }, desiredUsername: 'reset_owner',
            retireReplacedAccountInTx: async tx => {
                const result = await setAccountStatusInTx(tx, { actorAccountId: replacementAccountId, targetAccountId: account.id, status: 'disabled', authority: 'provider_account_replacement' });
                if (result.status === 'rejected') throw new Error(result.code);
            },
        }), { isolationLevel: 'Serializable' });
        expect(replaced.status).toBe('replaced');
        const replacementProfile = await db.accountPublicProfile.findUniqueOrThrow({ where: { accountId: replacementAccountId } });
        expect(replacementProfile.removalReason).toBe('restriction survives recovery');
        expect(replacementProfile.state).toBe('draft');
        expect(replacementProfile.snapshotJson).toBeNull();
        expect(replacementProfile.policyJson).toBeNull();
        expect((await db.accountPublicProfile.findUniqueOrThrow({ where: { accountId: account.id } })).snapshotJson).toBeNull();
        expect(await publishPublicProfile(replacementAccountId, body(), publicationEnv, deps)).toEqual({ kind: 'unavailable', reason: 'restricted' });

        const automatic = await db.account.create({ data: { publicKey: 'public-profile-identity-clear', username: 'auto_owner' } });
        await publishPublicProfile(automatic.id, body(), publicationEnv, deps);
        await inTx(tx => changeUsernameInTx(tx, automatic.id, { kind: 'identity_unlink', matchingUsername: 'auto_owner' }), { isolationLevel: 'Serializable' });
        expect(await db.accountPublicProfile.findUnique({ where: { accountId: automatic.id } })).toBeNull();
        expect(await readPublicProfile('auto_owner', publicationEnv, deps)).toEqual({ kind: 'unavailable' });
    });


    it('keeps owner recovery and revocation reachable through the production API when publication is disabled', async () => {
        harness.resetEnv({ ...publicationEnv, HAPPIER_FEATURE_ACCOUNT_PUBLIC_PROFILES__ENABLED: '0' });
        const { registerApiRoutes } = await import('@/app/api/api');
        const account = await db.account.create({ data: { publicKey: 'public-profile-api-composition', username: 'root_owner' } });
        await publishPublicProfile(account.id, body(), publicationEnv, deps);
        await withAuthenticatedTestApp(app => {
            app.register(import('@fastify/rate-limit'), resolveApiRateLimitPluginOptions(process.env));
            registerApiRoutes(app, { homeConnectionDescriptorContinuityStore: null });
        }, async app => {
            const headers = { 'x-test-user-id': account.id };
            const unavailable = await app.inject({ method: 'GET', url: '/v1/public/profiles/root_owner', headers: { 'if-none-match': '*' } });
            expect(unavailable.statusCode).toBe(404);
            expect(unavailable.json()).toEqual({ kind: 'unavailable' });
            expect(unavailable.headers.etag).toBeUndefined();
            const owned = await app.inject({ method: 'GET', url: '/v1/account/public-profile', headers });
            expect(owned.statusCode).toBe(200);
            expect(owned.json()).toMatchObject({ kind: 'ready', record: { state: 'published' } });
            const publish = await app.inject({ method: 'POST', url: '/v1/account/public-profile/publish', headers, payload: body() });
            expect(publish.json()).toEqual({ kind: 'unavailable', reason: 'feature_disabled' });
            const paused = await app.inject({ method: 'POST', url: '/v1/account/public-profile/pause', headers, payload: {} });
            expect(paused.statusCode).toBe(200);
            expect(paused.json()).toMatchObject({ kind: 'updated', record: { state: 'paused' } });
            const removed = await app.inject({ method: 'DELETE', url: '/v1/account/public-profile', headers });
            expect(removed.json()).toEqual({ kind: 'updated', record: null });
        });
    });

    it('returns only the normalized configured report contact without disclosing profile existence', async () => {
        const account = await db.account.create({ data: { publicKey: 'public-profile-report-contact' } });
        harness.resetEnv({ HAPPIER_PUBLIC_PROFILE_REPORT_URL: 'mailto:operator@example.test' });
        await withAuthenticatedTestApp(app => registerAccountPublicProfileRoutes(app), async app => {
            const result = await app.inject({ method: 'GET', url: '/v1/account/public-profile/report?handle=missing_owner', headers: { 'x-test-user-id': account.id } });
            expect(result.statusCode).toBe(200);
            expect(result.json().kind).toBe('ready');
            const contact = new URL(result.json().url);
            expect(contact.protocol).toBe('mailto:');
            expect(contact.pathname).toBe('operator@example.test');
            expect(contact.searchParams.get('body')).toContain('https://profiles.example/prefix/@missing_owner');
            harness.resetEnv({ HAPPIER_PUBLIC_PROFILE_REPORT_URL: 'http://unsafe.example.test' });
            const invalid = await app.inject({ method: 'GET', url: '/v1/account/public-profile/report?handle=missing_owner', headers: { 'x-test-user-id': account.id } });
            expect(invalid.json()).toEqual({ kind: 'unavailable', reason: 'report_contact_unconfigured' });
        });
    });

    it('rejects unknown symbolic field paths at the real HTTP boundary before accepting a disclosure', async () => {
        const account = await db.account.create({ data: { publicKey: 'public-profile-invalid-binding', username: 'binding_owner' } });
        await withAuthenticatedTestApp(app => registerAccountPublicProfileRoutes(app), async app => {
            const invalid = { ...body(), layout: { v: 1, items: [{ kind: 'widget', id: 'invalid', size: 'medium', frameStyle: 'plain',
                presentation: { kind: 'declarative', document: { version: 1, root: { kind: 'metric', label: 'Private cost',
                    data: { kind: 'value', value: { kind: 'public_profile' } }, value: { path: ['snapshot', 'facts', 'cost'], type: 'number' } } } } }] } };
            const result = await app.inject({ method: 'POST', url: '/v1/account/public-profile/publish', headers: { 'x-test-user-id': account.id }, payload: invalid });
            expect(result.statusCode).toBe(400);
            expect(await db.accountPublicProfile.findUnique({ where: { accountId: account.id } })).toBeNull();
        });
    });

    it('requires configured delivery when resuming and retains the previously applied consent and layout', async () => {
        const account = await db.account.create({ data: { publicKey: 'public-profile-resume', username: 'resume_owner' } });
        await publishPublicProfile(account.id, body(), publicationEnv, deps);
        await pausePublicProfile(account.id);
        expect(await resumePublicProfile(account.id, { query, snapshot }, {}, deps)).toEqual({ kind: 'unavailable', reason: 'public_ingress_unconfigured' });
        expect((await db.accountPublicProfile.findUniqueOrThrow({ where: { accountId: account.id } })).state).toBe('paused');
        expect((await resumePublicProfile(account.id, { query, snapshot }, publicationEnv, deps)).kind).toBe('updated');
        const resumed = await db.accountPublicProfile.findUniqueOrThrow({ where: { accountId: account.id } });
        expect(JSON.parse(resumed.policyJson!)).toEqual(body().policy);
        expect(JSON.parse(resumed.layoutJson!)).toEqual(body().layout);
        expect(JSON.parse(resumed.appearanceJson!)).toEqual(body().appearance);
    });
});
