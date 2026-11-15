import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { DEFAULT_PUBLIC_PROFILE_POLICY_V1 } from '@happier-dev/protocol/account/publicProfile';
import { DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1, PublicProfilePublishBodyV1Schema } from '@happier-dev/protocol/account/publicProfilePublication';
import { bindHomeDomainActionHttpRequestV1 } from '@happier-dev/protocol/actions/homeDomainActionFamily';
import { HomeAdministrationEventV1Schema, HomePublicProfileHandleReclaimResultV1Schema } from '@happier-dev/protocol/home/governance';
import { db } from '@/storage/db';
import { Context } from '@/context';
import { inTx } from '@/storage/inTx';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { registerAccountPublicProfileRoutes } from '@/app/api/routes/account/registerAccountPublicProfileRoutes';
import { feedRoutes } from '@/app/api/routes/feed/feedRoutes';
import { changeUsernameInTx, usernameUpdate } from '@/app/social/usernameUpdate';
import { listHomeAdministrationEventsInTx } from '@/app/home/audit/homeAdministrationEvents';
import { publishPublicProfile } from './publicProfilePublish';
import { publicProfileServerDependencies } from './publicProfileDependencies';

const publicationEnv = { HAPPIER_PUBLIC_SERVER_URL: 'https://profiles.example/prefix', HAPPIER_PUBLIC_PROFILE_REPORT_URL: 'mailto:operator@example.test' };
function body() {
    return PublicProfilePublishBodyV1Schema.parse({
        policy: DEFAULT_PUBLIC_PROFILE_POLICY_V1, metadata: {}, projectSelections: [],
        query: normalizeUsageQuery({ population: 'public_eligible_personal', period: { startMs: 1000, endMs: 2000 }, timeZoneOffsetMinutes: 0 }),
        snapshot: { v: 1, computedAtMs: 2000, period: { startMs: 1000, endMs: 2000, timeZoneOffsetMinutes: 0 },
            coverage: { status: 'partial', method: 'runtime' }, fieldCoverage: {}, facts: { tokens: 987654321 } },
        layout: { v: 1, items: [] }, appearance: DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1,
    });
}

describe('Home public-profile handle reclaim', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-handle-reclaim-', env: {
        ...publicationEnv, HAPPIER_FEATURE_SOCIAL_FRIENDS__ENABLED: '0',
        NODE_OPTIONS: [process.env.NODE_OPTIONS, '--conditions=happier-source'].filter(Boolean).join(' '),
    } }); }, 120_000);
    afterAll(async () => { await harness?.close(); });
    afterEach(async () => {
        await db.homeAdministrationEvent.deleteMany();
        await db.account.deleteMany();
    });

    it('reclaims only the reviewed handle through Home authority, retaining restriction and delivering one owner notice', async () => {
        const account = await db.account.create({ data: { publicKey: 'public-profile-reclaim', username: 'Reviewed_Handle' } });
        const owner = await db.account.create({ data: { publicKey: 'public-profile-reclaim-owner', homeRole: 'owner', username: 'operator_handle' } });
        const admin = await db.account.create({ data: { publicKey: 'public-profile-reclaim-admin', homeRole: 'admin' } });
        await publishPublicProfile(account.id, body(), publicationEnv, publicProfileServerDependencies);
        const removedAt = new Date();
        await db.accountPublicProfile.update({ where: { accountId: account.id }, data: {
            removedAt, removedByAccountId: owner.id, removalReason: 'Independent content restriction',
        } });

        await withAuthenticatedTestApp(app => { registerAccountPublicProfileRoutes(app); feedRoutes(app); }, async app => {
            const reclaim = (actor: string, targetAccountId = account.id, username = 'Reviewed_Handle') => {
                const request = bindHomeDomainActionHttpRequestV1('home.public_profiles.handle_reclaim', { accountId: targetAccountId,
                    username, reason: 'Abusive identity', notice: 'Your username was reclaimed. Contact this Home operator to appeal.' });
                return app.inject({ method: request.method, url: request.path, headers: { 'x-test-user-id': actor }, payload: request.body });
            };
            expect((await reclaim(account.id)).statusCode).toBe(403);
            expect((await reclaim(admin.id, owner.id, 'operator_handle')).statusCode).toBe(403);
            expect(await db.userFeedItem.count({ where: { userId: account.id } })).toBe(0);

            const wrongSpelling = await reclaim(admin.id, account.id, 'reviewed_handle');
            expect(wrongSpelling.statusCode).toBe(409);
            expect(wrongSpelling.json()).toEqual({ error: 'username-changed' });
            expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).username).toBe('Reviewed_Handle');
            await usernameUpdate(Context.create(account.id), 'reviewed_new');
            const stale = await reclaim(admin.id);
            expect(stale.statusCode).toBe(409);
            expect(stale.json()).toEqual({ error: 'username-changed' });
            expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).username).toBe('reviewed_new');
            expect(await db.userFeedItem.count({ where: { userId: account.id } })).toBe(0);
            expect(await db.homeAdministrationEvent.count({ where: { targetId: account.id } })).toBe(0);
            const result = await reclaim(admin.id, account.id, 'reviewed_new');
            expect(result.statusCode).toBe(200);
            expect(HomePublicProfileHandleReclaimResultV1Schema.parse(result.json())).toEqual({ username: null, reclaimed: true });
            expect((await reclaim(admin.id, account.id, 'reviewed_new')).json()).toEqual({ username: null, reclaimed: false });
            const readback = await app.inject({ method: 'GET', url: '/v1/account/public-profile', headers: { 'x-test-user-id': account.id } });
            expect(readback.statusCode).toBe(200);
            expect(readback.json()).toMatchObject({ kind: 'ready', context: { handle: null }, record: {
                state: 'draft', snapshot: null, policy: null, query: null, layout: null, appearance: null,
                restriction: { reason: 'Independent content restriction' },
            } });
            const notice = await app.inject({ method: 'GET', url: '/v1/feed', headers: { 'x-test-user-id': account.id } });
            expect(notice.statusCode).toBe(200);
            expect(notice.json().items).toEqual([expect.objectContaining({ repeatKey: 'public_profile_handle_reclaim',
                body: { kind: 'text', text: 'Your username was reclaimed. Contact this Home operator to appeal.' } })]);
        });

        expect(await db.account.findUniqueOrThrow({ where: { id: account.id } })).toMatchObject({ username: null, usernameAutoFillEnabled: false });
        const retained = await db.accountPublicProfile.findUniqueOrThrow({ where: { accountId: account.id } });
        expect(retained).toMatchObject({ state: 'draft', removedAt, removedByAccountId: owner.id,
            removalReason: 'Independent content restriction', policyJson: null, snapshotJson: null, layoutJson: null, appearanceJson: null });
        expect((await db.userFeedItem.findMany({ where: { userId: account.id } })).map(item => item.body)).toEqual([
            { kind: 'text', text: 'Your username was reclaimed. Contact this Home operator to appeal.' },
        ]);
        const audit = await inTx(tx => listHomeAdministrationEventsInTx(tx, { targetId: account.id }));
        expect(audit.status).toBe('ok');
        if (audit.status !== 'ok') throw new Error('Reclaim audit could not be read');
        expect(audit.result.items).toHaveLength(1);
        expect(HomeAdministrationEventV1Schema.parse(audit.result.items[0])).toMatchObject({
            action: 'public_profile.handle_reclaimed', actor: { accountId: admin.id }, target: { id: account.id },
            summary: { username: 'reviewed_new', reason: 'Abusive identity', notice: 'Your username was reclaimed. Contact this Home operator to appeal.' },
        });
        await inTx(tx => changeUsernameInTx(tx, account.id, { kind: 'identity_fill', suggestion: 'reviewed_new' }), { isolationLevel: 'Serializable' });
        expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).username).toBeNull();
    });
});
