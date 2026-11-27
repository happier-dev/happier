import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PublicProfileContextV1Schema, PublicProfilePublishBodyV1Schema, PublicProfileReadResultV1Schema,
    DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1 } from '@happier-dev/protocol/account/publicProfilePublication';
import { DEFAULT_PUBLIC_PROFILE_POLICY_V1 } from '@happier-dev/protocol/account/publicProfile';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { db, getActivePrismaRuntime } from '@/storage/db';
import { createDbMaintenanceClient, onDbClientQuery } from '@/storage/prismaClientConstruction';
import { inTx } from '@/storage/inTx';
import { buildHomeConfigEnv } from '@/app/home/settings/homeConfigOverlay';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { readPublicProfileContextInTx, resolvePublicProfilePrerequisite } from './publicProfileContext';
import { publicProfileServerDependencies } from './publicProfileDependencies';
import { publishPublicProfile } from './publicProfilePublish';
import { readPublicProfile } from './publicProfileRead';
import { pausePublicProfile } from './publicProfilePause';
import { updatePublicProfile } from './publicProfileUpdate';

describe('public-profile canonical context', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-profile-context-' }); }, 120_000);
    afterAll(async () => { await harness?.close(); });
    afterEach(async () => { await db.account.deleteMany(); });

    it('uses current Account presentation and Home-effective prefix ingress even before a publication exists', async () => {
        const account = await db.account.create({ data: { publicKey: 'profile-context', username: 'owner_/legacy', name: ' Chosen name ',
            firstName: 'Legacy', lastName: 'Provider', avatar: { path: 'private/avatar.png', width: 1, height: 1, thumbhash: 'private-thumbhash' }, createdAt: new Date('2024-01-02T00:00:00Z') } });
        const env = buildHomeConfigEnv({ HAPPIER_CANONICAL_SERVER_URL: 'http://identity.local:3000', HAPPIER_WEBAPP_URL: 'https://app.example.test' }, {
            HAPPIER_PUBLIC_SERVER_URL: 'https://profiles.example.test/prefix/', HAPPIER_ACCOUNT_SERVICE_DISPLAY_NAME: 'My service',
            HAPPIER_PUBLIC_PROFILE_REPORT_URL: 'mailto:operator@example.test?subject=Profile&body=Please%20review',
        });
        const context = await inTx(tx => readPublicProfileContextInTx(tx, account.id, env));
        const page = 'https://profiles.example.test/prefix/@owner_%2Flegacy';
        expect(PublicProfileContextV1Schema.parse(context)).toEqual({
            handle: 'owner_/legacy', identity: { name: 'Chosen name', sinceMs: account.createdAt.getTime(),
                avatar: { kind: 'planet', reason: 'account_image_unavailable' } },
            service: { displayName: 'My service', publicBaseUrl: 'https://profiles.example.test/prefix' },
            urls: { page, json: 'https://profiles.example.test/prefix/v1/public/profiles/owner_%2Flegacy',
                badgeBase: `${page}/badge`, card: `${page}/card.svg`, og: `${page}/og.png`,
                report: expect.any(String) },
        });
        const report = new URL(context.urls!.report);
        expect(report.pathname).toBe('operator@example.test');
        expect(report.searchParams.get('subject')).toBe('Profile');
        expect(report.searchParams.get('body')).toContain('Please review');
        expect(report.searchParams.get('body')).toContain(page);
        expect(JSON.stringify(context)).not.toContain(account.id);
        expect(JSON.stringify(context)).not.toContain('private/avatar.png');
    });

    it('settles missing, unsafe and withdrawn Account images to the explained public planet without disclosing source URLs', async () => {
        const account = await db.account.create({ data: { publicKey: 'profile-context-avatar', username: 'avatar_owner' } });
        const env = { HAPPIER_PUBLIC_SERVER_URL: 'https://profiles.example.test',
            HAPPIER_PUBLIC_PROFILE_REPORT_URL: 'mailto:operator@example.test' };
        const readIdentity = async () => (await inTx(tx => readPublicProfileContextInTx(tx, account.id, env))).identity;
        const fallback = { kind: 'planet', reason: 'account_image_unavailable' };
        expect(await readIdentity()).toEqual({ sinceMs: account.createdAt.getTime(), name: 'avatar_owner', avatar: fallback });
        for (const avatar of [
            { path: 'javascript:private-provider-secret', width: 1, height: 1, thumbhash: 'private-thumbhash' },
            { path: 'https://provider.example.test/private-photo?token=private-provider-secret', width: 1, height: 1, thumbhash: 'private-thumbhash' },
            { path: 'private/account-avatar.png', width: 1, height: 1, thumbhash: 'private-thumbhash' },
        ]) {
            await db.account.update({ where: { id: account.id }, data: { avatar } });
            const identity = await readIdentity();
            expect(identity).toEqual({ sinceMs: account.createdAt.getTime(), name: 'avatar_owner', avatar: fallback });
        }
        await db.account.update({ where: { id: account.id }, data: { avatar: getActivePrismaRuntime().DbNull } });
        expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).avatar).toBeNull();
        expect(await readIdentity()).toEqual({ sinceMs: account.createdAt.getTime(), name: 'avatar_owner', avatar: fallback });
    });

    it('reads current supporter identity in the same SQLite statement as the Account', async () => {
        const account = await db.account.create({ data: { publicKey: 'profile-context-supporter', username: 'supporter_context', supporterRing: true } });
        await db.supporterRecord.create({ data: { accountId: account.id, code: 'context-supporter-code', number: 723,
            grantedAt: new Date('2024-06-02T00:00:00Z') } });
        const reader = await createDbMaintenanceClient('sqlite', undefined, { log: [{ emit: 'event', level: 'query' }] });
        const selects: string[] = [];
        onDbClientQuery(reader, ({ query }) => { if (/^\s*SELECT\b/i.test(query)) selects.push(query); });
        try {
            const context = await reader.$transaction(tx => readPublicProfileContextInTx(tx, account.id, {}));
            expect(context.identity.supporter).toEqual({ sinceYear: 2024 });
            expect(selects).toHaveLength(1);
            selects.length = 0;
            const disabled = await reader.$transaction(tx => readPublicProfileContextInTx(tx, account.id, {
                HAPPIER_FEATURE_SUPPORTER__ENABLED: '0',
            }));
            expect(disabled.identity).not.toHaveProperty('supporter');
            expect(selects).toHaveLength(1);
        } finally {
            await reader.$disconnect();
        }
    });

    it('keeps absent handle and missing ingress/contact recoverable without inventing a Cloud URL', async () => {
        const account = await db.account.create({ data: { publicKey: 'profile-context-absent', name: 'Unpublished' } });
        const env = { HAPPIER_PUBLIC_SERVER_URL: 'http://localhost:3000/base', HAPPIER_PUBLIC_PROFILE_REPORT_URL: 'https://reports.example.test/contact' };
        const absent = await inTx(tx => readPublicProfileContextInTx(tx, account.id, env));
        expect(absent).toMatchObject({ handle: null, urls: null,
            service: { displayName: 'localhost', publicBaseUrl: 'http://localhost:3000/base' } });
        expect(resolvePublicProfilePrerequisite(env)).toBeNull();
        await db.account.update({ where: { id: account.id }, data: { username: 'local_owner' } });
        const local = await inTx(tx => readPublicProfileContextInTx(tx, account.id, env));
        expect(PublicProfileContextV1Schema.parse(local).urls).toMatchObject({
            page: 'http://localhost:3000/base/@local_owner', report: 'https://reports.example.test/contact',
        });
        expect(resolvePublicProfilePrerequisite({ HAPPIER_PUBLIC_PROFILE_REPORT_URL: env.HAPPIER_PUBLIC_PROFILE_REPORT_URL })).toBe('public_ingress_unconfigured');
        expect(resolvePublicProfilePrerequisite({ HAPPIER_PUBLIC_SERVER_URL: env.HAPPIER_PUBLIC_SERVER_URL })).toBe('report_contact_unconfigured');
        expect(resolvePublicProfilePrerequisite({ ...env, HAPPIER_PUBLIC_PROFILE_REPORT_URL: 'http://reports.example.test' })).toBe('report_contact_unconfigured');
        const noIngress = await inTx(tx => readPublicProfileContextInTx(tx, account.id, { HAPPIER_WEBAPP_URL: 'https://cloud.happier.dev' }));
        expect(noIngress).toMatchObject({ handle: 'local_owner', urls: null, service: null });
        expect(JSON.stringify(noIngress)).not.toContain('cloud.happier.dev');
    });

    it('delivers the real producer fallback in published and paused reads and withdraws it with avatar consent', async () => {
        const account = await db.account.create({ data: { publicKey: 'profile-context-avatar-lifecycle', username: 'avatar_lifecycle' } });
        const env = { HAPPIER_PUBLIC_SERVER_URL: 'https://profiles.example.test',
            HAPPIER_PUBLIC_PROFILE_REPORT_URL: 'mailto:operator@example.test' };
        const policy = structuredClone(DEFAULT_PUBLIC_PROFILE_POLICY_V1);
        const candidate = PublicProfilePublishBodyV1Schema.parse({ policy, metadata: { avatar: { kind: 'account' } }, projectSelections: [],
            query: normalizeUsageQuery({ population: 'public_eligible_personal', period: { startMs: 1000, endMs: 2000 }, timeZoneOffsetMinutes: 0 }),
            snapshot: { v: 1, computedAtMs: 2000, period: { startMs: 1000, endMs: 2000, timeZoneOffsetMinutes: 0 },
                coverage: { status: 'unknown', method: 'unknown' }, fieldCoverage: {}, facts: {} },
            layout: { v: 1, items: [] }, appearance: DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1 });
        expect((await publishPublicProfile(account.id, candidate, env, publicProfileServerDependencies)).kind).toBe('updated');
        const read = async () => PublicProfileReadResultV1Schema.parse(await readPublicProfile(account.username!, env, publicProfileServerDependencies));
        const published = await read();
        expect(published).toMatchObject({ kind: 'published', view: { identity: { avatar: { kind: 'planet', reason: 'account_image_unavailable' } } } });
        expect((await pausePublicProfile(account.id)).kind).toBe('updated');
        expect(await read()).toMatchObject({ kind: 'paused', identity: { avatar: { kind: 'planet', reason: 'account_image_unavailable' } } });
        policy.fields.avatar = false;
        expect((await updatePublicProfile(account.id, { policy })).kind).toBe('updated');
        const hidden = await read();
        expect(hidden.kind).toBe('paused');
        if (hidden.kind !== 'paused') throw new Error('expected paused publication');
        expect(hidden.identity).not.toHaveProperty('avatar');
        expect(hidden.identity).not.toHaveProperty('avatarUrl');
    });
});
