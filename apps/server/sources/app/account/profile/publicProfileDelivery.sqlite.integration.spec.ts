import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { registerPublicProfileReadRoutes, publicProfileRepresentationEtag } from '@/app/api/routes/account/registerPublicProfileReadRoutes';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { loadSharp } from '@/storage/blob/sharpRuntime';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { changeUsernameInTx } from '@/app/social/usernameUpdate';
import { DEFAULT_PUBLIC_PROFILE_POLICY_V1 } from '@happier-dev/protocol/account/publicProfile';
import { DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1, PublicProfilePublishBodyV1Schema, PublicProfileReadResultV1Schema } from '@happier-dev/protocol/account/publicProfilePublication';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { registerAccountPublicProfileRoutes } from '@/app/api/routes/account/registerAccountPublicProfileRoutes';
import * as svgRenderer from './render/publicProfileSvg';
import * as htmlRenderer from './render/publicProfileHtml';
import * as pngRenderer from './render/publicProfileOg';
import * as heroRenderer from './render/publicProfileHero';
import { publicProfileServerDependencies } from './publicProfileDependencies';

describe('anonymous public-profile delivery', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-profile-delivery-', env: {
        HAPPIER_PUBLIC_SERVER_URL: 'https://profiles.example/prefix', HAPPIER_PUBLIC_PROFILE_REPORT_URL: 'mailto:operator@example.test',
    } }); }, 120_000);
    afterAll(async () => { await harness?.close(); });
    afterEach(async () => { vi.restoreAllMocks(); harness.restoreEnv(); await db.account.deleteMany(); });

    it('renders current supporter consent and withdraws the badge and tenure without republishing', async () => {
        const account = await db.account.create({ data: { publicKey: 'public-profile-supporter-owner', username: 'supporter_owner', supporterRing: true } });
        const grant = await db.supporterRecord.create({ data: { accountId: account.id, code: 'profile-supporter-code', number: 123,
            grantedAt: new Date('2024-01-02T00:00:00Z') } });
        vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 10, 27));
        const candidate = PublicProfilePublishBodyV1Schema.parse({ policy: DEFAULT_PUBLIC_PROFILE_POLICY_V1, metadata: {}, projectSelections: [],
            query: normalizeUsageQuery({ population: 'public_eligible_personal', period: { startMs: 1000, endMs: 2000 }, timeZoneOffsetMinutes: 0 }),
            snapshot: { v: 1, computedAtMs: 2000, period: { startMs: 1000, endMs: 2000, timeZoneOffsetMinutes: 0 },
                coverage: { status: 'unknown', method: 'unknown' }, fieldCoverage: {}, facts: {} },
            appearance: DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1, layout: { v: 1, items: [] } });
        await withAuthenticatedTestApp(app => {
            registerAccountPublicProfileRoutes(app);
            registerPublicProfileReadRoutes(app);
        }, async app => {
            const headers = { 'x-test-user-id': account.id };
            const publication = await app.inject({ method: 'POST', url: '/v1/account/public-profile/publish', headers, payload: candidate });
            expect(publication.json().kind).toBe('updated');
            const page = await app.inject('/@supporter_owner');
            expect(page.body.includes('Supporter since 2024'), 'the cold page includes one-time tenure').toBe(true);
            expect(page.body.includes('public-profile-supporter-ring'), 'the cold page renders an avatar ring').toBe(true);
            expect((await app.inject('/@supporter_owner/card.svg')).body).toContain('Supporter');
            const json = () => app.inject('/v1/public/profiles/supporter_owner');
            const visible = await json();
            expect(visible.json().view.identity.supporter).toEqual({ sinceYear: 2024 });

            const hidden = structuredClone(candidate.policy);
            hidden.fields.supporter = false;
            const optedOut = await app.inject({ method: 'PUT', url: '/v1/account/public-profile/policy', headers, payload: { policy: hidden } });
            expect(optedOut.json().kind).toBe('updated');
            expect((await json()).json().view.identity).not.toHaveProperty('supporter');
            expect((await app.inject('/@supporter_owner')).body).not.toContain('public-profile-supporter-ring');

            const { supporter: _supporter, ...legacyFields } = candidate.policy.fields;
            await db.accountPublicProfile.update({ where: { accountId: account.id }, data: {
                policyJson: JSON.stringify({ ...candidate.policy, fields: legacyFields }),
            } });
            expect((await json()).json().view.identity).not.toHaveProperty('supporter');

            const restored = await app.inject({ method: 'PUT', url: '/v1/account/public-profile/policy', headers, payload: { policy: candidate.policy } });
            expect(restored.json().kind).toBe('updated');
            await db.account.update({ where: { id: account.id }, data: { supporterRing: false } });
            expect((await json()).json().view.identity).not.toHaveProperty('supporter');
            await db.account.update({ where: { id: account.id }, data: { supporterRing: true } });
            expect((await json()).json().view.identity).toHaveProperty('supporter');

            await db.supporterRecord.update({ where: { id: grant.id }, data: {
                recurringActive: true, recurringSince: new Date('2026-04-12T13:45:00Z'),
            } });
            const recurring = await json();
            expect(recurring.json().view.identity.supporter).toEqual({ sinceYear: 2024,
                recurring: { sinceMonthMs: Date.UTC(2026, 3, 1), months: 7 } });
            expect((await app.inject('/@supporter_owner')).body.includes('Supporting for 7 months · since April 2026'),
                'the cold page includes recurring tenure').toBe(true);
            vi.mocked(Date.now).mockReturnValue(Date.UTC(2026, 11, 27));
            const aged = await app.inject({ url: '/v1/public/profiles/supporter_owner', headers: { 'if-none-match': String(recurring.headers.etag) } });
            expect(aged.statusCode).toBe(200);
            expect(aged.json().view.identity.supporter.recurring.months).toBe(8);

            await db.supporterRecord.update({ where: { id: grant.id }, data: { revokedAt: new Date() } });
            const refunded = await app.inject({ url: '/v1/public/profiles/supporter_owner', headers: { 'if-none-match': String(aged.headers.etag) } });
            expect(refunded.statusCode).toBe(200);
            expect(refunded.headers.etag).not.toBe(aged.headers.etag);
            expect(refunded.json().view.identity).not.toHaveProperty('supporter');
            expect((await app.inject('/@supporter_owner')).body).not.toContain('public-profile-supporter-ring');

            await db.supporterRecord.update({ where: { id: grant.id }, data: { revokedAt: null } });
            const paused = await app.inject({ method: 'POST', url: '/v1/account/public-profile/pause', headers, payload: {} });
            expect(paused.json()).toMatchObject({ kind: 'updated', record: { state: 'paused' } });
            expect((await json()).json()).toMatchObject({ kind: 'paused' });
            expect((await json()).json().identity).not.toHaveProperty('supporter');
        });
    });

    it('publishes through the actual feature-admitted HTTP owner and revalidates every output after hide and withdrawal', async () => {
        const account = await db.account.create({ data: { publicKey: 'public-profile-delivery-owner', username: 'delivery_owner', name: 'Delivery Owner' } });
        const candidate = PublicProfilePublishBodyV1Schema.parse({ policy: DEFAULT_PUBLIC_PROFILE_POLICY_V1, metadata: {}, projectSelections: [],
            query: normalizeUsageQuery({ population: 'public_eligible_personal', period: { startMs: 1000, endMs: 2000 }, timeZoneOffsetMinutes: 0 }),
            snapshot: { v: 1, computedAtMs: 2000, period: { startMs: 1000, endMs: 2000, timeZoneOffsetMinutes: 0 },
                coverage: { status: 'partial', method: 'runtime' }, fieldCoverage: {}, facts: { tokens: 987654321, activeDays: 2 } },
            appearance: DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1,
            layout: { v: 1, items: [{ kind: 'widget', id: 'token-figure', size: 'medium', frameStyle: 'plain',
                presentation: { kind: 'declarative', document: { version: 1, root: { kind: 'metric', label: 'Tokens',
                    data: { kind: 'value', value: { kind: 'public_profile' } }, value: { path: ['snapshot', 'facts', 'tokens'], type: 'number' } } } } }] } });
        await withAuthenticatedTestApp(app => { registerAccountPublicProfileRoutes(app); registerPublicProfileReadRoutes(app); }, async app => {
            const headers = { 'x-test-user-id': account.id };
            const published = await app.inject({ method: 'POST', url: '/v1/account/public-profile/publish', headers, payload: candidate });
            expect(published.statusCode).toBe(200);
            expect(published.json()).toMatchObject({ kind: 'updated', record: { state: 'published' } });
            const paths = ['/v1/public/profiles/delivery_owner', '/@delivery_owner', '/@delivery_owner/badge/tokens.svg',
                '/@delivery_owner/card.svg', '/@delivery_owner/card.png?theme=dark', '/@delivery_owner/og.png?v=old',
                '/@delivery_owner/background?theme=light&viewport=phone&density=1'];
            // Count actual paint and database boundary work; all implementations remain real.
            const paints = [vi.spyOn(svgRenderer, 'renderPublicProfileSvg'), vi.spyOn(htmlRenderer, 'renderPublicProfileHtml'),
                vi.spyOn(pngRenderer, 'renderPublicProfileCardPng'), vi.spyOn(pngRenderer, 'renderPublicProfileOg'),
                vi.spyOn(heroRenderer, 'renderPublicProfileHeroImage')];
            const snapshots = vi.spyOn(publicProfileServerDependencies, 'readPublicationContext');
            const validators = new Map<string, string>();
            for (const url of paths) {
                snapshots.mockClear();
                const response = await app.inject({ method: 'GET', url });
                expect(response.statusCode, url).toBe(200);
                expect(snapshots.mock.calls.length, `admission reads for ${url}`).toBe(1);
                expect(typeof response.headers.etag, url).toBe('string');
                const etag = String(response.headers.etag);
                validators.set(url, etag);
                if (!url.startsWith('/v1/')) {
                    expect(paints.reduce((count, paint) => count + paint.mock.calls.length, 0), `initial paints for ${url}`).toBeGreaterThan(0);
                }
                paints.forEach(paint => paint.mockClear());
                snapshots.mockClear();
                const unchanged = await app.inject({ method: 'GET', url, headers: { 'if-none-match': etag } });
                expect(unchanged.statusCode, url).toBe(304);
                expect(unchanged.body).toBe('');
                expect(paints.reduce((count, paint) => count + paint.mock.calls.length, 0), `paints for ${url}`).toBe(0);
                expect(snapshots.mock.calls.length, `publication snapshots for ${url}`).toBe(1);
                if (!url.startsWith('/v1/')) {
                    // GET comparison is weak even when an intermediary sends the strong form in a list.
                    expect((await app.inject({ method: 'GET', url, headers: { 'if-none-match': `"other", ${etag.replace(/^W\//, '')}` } })).statusCode).toBe(304);
                    // Previously issued byte validators safely miss after the rendering-validator transition.
                    const oldBytes = publicProfileRepresentationEtag(response.rawPayload);
                    expect((await app.inject({ method: 'GET', url, headers: { 'if-none-match': oldBytes } })).statusCode).toBe(200);
                }
                paints.forEach(paint => paint.mockClear());
            }
            // The page says how long ago it synced, so its validator follows that age; the JSON does not.
            const later = Date.now() + 2 * 86_400_000;
            vi.spyOn(Date, 'now').mockReturnValue(later);
            const agedPage = await app.inject({ method: 'GET', url: '/@delivery_owner', headers: { 'if-none-match': validators.get('/@delivery_owner')! } });
            expect(agedPage.statusCode).toBe(200);
            expect(agedPage.headers.etag).not.toBe(validators.get('/@delivery_owner'));
            expect((await app.inject({ method: 'GET', url: '/@delivery_owner', headers: { 'if-none-match': String(agedPage.headers.etag) } })).statusCode).toBe(304);
            expect((await app.inject({ method: 'GET', url: '/v1/public/profiles/delivery_owner',
                headers: { 'if-none-match': validators.get('/v1/public/profiles/delivery_owner')! } })).statusCode).toBe(304);
            vi.mocked(Date.now).mockRestore();
            const otherTheme = await app.inject({ method: 'GET', url: '/@delivery_owner/card.svg?theme=dark',
                headers: { 'if-none-match': validators.get('/@delivery_owner/card.svg')! } });
            expect(otherTheme.statusCode).toBe(200);
            expect(otherTheme.headers.etag).not.toBe(validators.get('/@delivery_owner/card.svg'));
            const otherDensity = await app.inject({ method: 'GET', url: '/@delivery_owner/background?theme=light&viewport=phone&density=2',
                headers: { 'if-none-match': validators.get('/@delivery_owner/background?theme=light&viewport=phone&density=1')! } });
            expect(otherDensity.statusCode).toBe(200);
            expect(otherDensity.headers.etag).not.toBe(validators.get('/@delivery_owner/background?theme=light&viewport=phone&density=1'));
            const hidden = structuredClone(candidate.policy);
            hidden.fields.tokens = false;
            const applied = await app.inject({ method: 'PUT', url: '/v1/account/public-profile/policy', headers, payload: { policy: hidden } });
            expect(applied.json().kind).toBe('updated');
            for (const url of paths) {
                const response = await app.inject({ method: 'GET', url, headers: { 'if-none-match': validators.get(url)! } });
                expect(response.statusCode, url).toBe(200);
                expect(response.headers.etag, url).not.toBe(validators.get(url));
                if (url.startsWith('/v1/')) {
                    const current = PublicProfileReadResultV1Schema.parse(response.json());
                    expect(current.kind).toBe('published');
                    if (current.kind === 'published') expect(current.view.snapshot.facts.tokens).toBeUndefined();
                }
                expect(response.body, url).not.toContain('987654321');
            }
            const withdrawn = await app.inject({ method: 'DELETE', url: '/v1/account/public-profile', headers });
            expect(withdrawn.json()).toEqual({ kind: 'updated', record: null });
            for (const url of paths) {
                const response = await app.inject({ method: 'GET', url, headers: { 'if-none-match': validators.get(url)! } });
                expect(response.statusCode, url).toBe(url === '/@delivery_owner' || url.startsWith('/v1/') || url.includes('/background?') ? 404 : 200);
                expect(response.headers.etag, url).toBeUndefined();
            }
            await inTx(tx => changeUsernameInTx(tx, account.id, { kind: 'manual_set', username: 'previous_owner' }, process.env),
                { isolationLevel: 'Serializable' });
            const replacement = await db.account.create({ data: { publicKey: 'public-profile-replacement-owner',
                username: 'delivery_owner', name: 'Replacement Owner' } });
            const replacementCandidate = structuredClone(candidate);
            replacementCandidate.snapshot.facts.tokens = 123;
            expect((await app.inject({ method: 'POST', url: '/v1/account/public-profile/publish',
                headers: { 'x-test-user-id': replacement.id }, payload: replacementCandidate })).json().kind).toBe('updated');
            for (const url of paths) {
                const response = await app.inject({ method: 'GET', url, headers: { 'if-none-match': validators.get(url)! } });
                expect(response.statusCode, url).toBe(200);
                expect(response.headers.etag, url).not.toBe(validators.get(url));
                expect(response.body, url).not.toContain('987654321');
                const current = await app.inject({ method: 'GET', url });
                expect(response.rawPayload, url).toEqual(current.rawPayload);
                if (url.startsWith('/v1/')) expect(response.json()).toMatchObject({ kind: 'published', view: {
                    identity: { name: 'Replacement Owner' }, snapshot: { facts: { tokens: 123 } },
                } });
            }
        });
    });

    it('serves a cold anonymous HTML unavailable state without an optional UI mount', async () => {
        await withAuthenticatedTestApp(app => registerPublicProfileReadRoutes(app), async app => {
            const response = await app.inject({ method: 'GET', url: '/@missing_profile', headers: { 'if-none-match': '*' } });
            expect(response.statusCode).toBe(404);
            expect(response.headers['content-type']).toContain('text/html');
            expect(response.body).toContain('Profile unavailable');
            expect(response.body).toContain('profiles.example');
            expect(response.body).not.toContain('https://profiles.example/prefix');
            expect(response.headers.etag).toBeUndefined();
        });
    });

    it('serves indistinguishable unavailable embed canvases and a strict Shields envelope for unknown or hidden metrics', async () => {
        await withAuthenticatedTestApp(app => registerPublicProfileReadRoutes(app), async app => {
            for (const path of ['/badge/tokens.svg', '/badge/unknown.svg', '/card.svg']) {
                const response = await app.inject({ method: 'GET', url: `/@missing_profile${path}`, headers: { 'if-none-match': '*' } });
                expect(response.statusCode).toBe(200);
                expect(response.headers['content-type']).toContain('image/svg+xml');
                expect(response.body).toContain('Profile unavailable');
                expect(response.headers.etag).toBeUndefined();
                expect(response.headers['x-robots-tag']).toContain('noindex');
            }
            const shield = await app.inject({ method: 'GET', url: '/@missing_profile/badge/tokens.json' });
            expect(shield.statusCode).toBe(200);
            expect(shield.json()).toEqual({ schemaVersion: 1, label: 'Happier', message: 'Profile unavailable', color: '6c6c70', isError: true });
            for (const [path, width, height] of [['/card.png?theme=dark', 495, 195], ['/og.png?v=old', 1200, 630]] as const) {
                const image = await app.inject({ method: 'GET', url: `/@missing_profile${path}`, headers: { 'if-none-match': '*' } });
                expect(image.statusCode, path).toBe(200);
                expect(image.headers['content-type']).toContain('image/png');
                expect(image.rawPayload.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
                expect(await (await loadSharp())(image.rawPayload).metadata()).toMatchObject({ width, height });
                expect(image.headers.etag).toBeUndefined();
            }
        });
    });

    it('keeps a missing publication background unavailable before considering an old image validator', async () => {
        await withAuthenticatedTestApp(app => registerPublicProfileReadRoutes(app), async app => {
            const response = await app.inject({ method: 'GET', url: '/@missing_profile/background', headers: { 'if-none-match': '*' } });
            expect(response.statusCode).toBe(404);
            expect(response.json()).toEqual({ kind: 'unavailable' });
            expect(response.headers.etag).toBeUndefined();
        });
    });
});
