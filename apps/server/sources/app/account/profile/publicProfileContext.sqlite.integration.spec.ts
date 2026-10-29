import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PublicProfileContextV1Schema } from '@happier-dev/protocol/account/publicProfilePublication';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { buildHomeConfigEnv } from '@/app/home/settings/homeConfigOverlay';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { readPublicProfileContextInTx, resolvePublicProfilePrerequisite } from './publicProfileContext';

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
            handle: 'owner_/legacy', identity: { name: 'Chosen name', sinceMs: account.createdAt.getTime() },
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
});
