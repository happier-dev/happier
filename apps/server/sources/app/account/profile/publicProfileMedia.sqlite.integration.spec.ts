import sharp from 'sharp';
import { transform } from 'esbuild';
import * as privacyKit from 'privacy-kit';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PUBLIC_PROFILE_POLICY_V1 } from '@happier-dev/protocol/account/publicProfile';
import { DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1, PublicProfilePublishBodyV1Schema } from '@happier-dev/protocol/account/publicProfilePublication';
import { PublicProfilePreparedAtmosphereV1Schema, type PublicProfilePictureDescriptorV1 } from '@happier-dev/protocol/account/publicProfileAtmosphere';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import * as files from '@/storage/blob/files';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { changeUsernameInTx } from '@/app/social/usernameUpdate';
import { publicProfileServerDependencies as deps } from './publicProfileDependencies';
import { readPublicProfilePicture, retirePublicProfilePictureInTx, cleanupPublicProfilePictures } from './publicProfilePicture';
import { publishPublicProfile } from './publicProfilePublish';
import { updatePublicProfile } from './publicProfileUpdate';
import { refreshPublicProfile } from './publicProfileRefresh';
import { pausePublicProfile } from './publicProfilePause';
import { unpublishPublicProfile } from './publicProfileUnpublish';
import { readAdmittedPublicProfileDelivery, readPublicProfileDelivery } from './publicProfileRead';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { registerAccountPublicProfileRoutes } from '@/app/api/routes/account/registerAccountPublicProfileRoutes';
import { registerPublicProfileReadRoutes } from '@/app/api/routes/account/registerPublicProfileReadRoutes';
import { HAPPIER_PUBLIC_PROFILE_HERO_METRICS } from '@happier-dev/plugin-ui/presentation/pageMetrics';

// Real font IO is the asynchronous system boundary after publication admission.
const fontIo = vi.hoisted(() => ({ afterRead: undefined as (() => Promise<void>) | undefined }));
vi.mock('node:fs/promises', async original => {
    const actual = await original<typeof import('node:fs/promises')>();
    return { ...actual, readFile: async (...args: Parameters<typeof actual.readFile>) => {
        const bytes = await actual.readFile(...args);
        if (String(args[0]).endsWith('Inter-Regular.ttf') && fontIo.afterRead) {
            const afterRead = fontIo.afterRead;
            fontIo.afterRead = undefined;
            await afterRead();
        }
        return bytes;
    } };
});

const env = { HAPPIER_PUBLIC_SERVER_URL: 'https://profiles.example.test/prefix',
    HAPPIER_PUBLIC_PROFILE_REPORT_URL: 'mailto:operator@example.test', HAPPIER_ACCOUNT_SERVICE_DISPLAY_NAME: 'Test Home' };

async function pictureFixture(red: number, credit: PublicProfilePictureDescriptorV1['credit'] = null) {
    const pixels = await sharp({ create: { width: 96, height: 48, channels: 3, background: { r: red, g: 83, b: 137 } } }).png().toBuffer();
    const atmosphere = PublicProfilePreparedAtmosphereV1Schema.parse({ source: 'picture', picture: {
        layout: 'horizon', descriptor: { kind: 'photo', title: 'Reviewed copy', credit, horizon: {}, focus: {},
            hour: 12, grades: { light: 1, dusk: 1, night: 1 }, dark: 'night', adaptiveHaze: false,
            look: { effect: 'original', params: {}, strength: 1, dissolve: { style: 'gradient', from: 0.58, to: 1 } } },
        content: { mimeType: 'image/png', base64: privacyKit.encodeBase64(pixels) },
    } });
    return { pixels, appearance: { atmosphere, theme: 'auto' as const } };
}

function publishBody(appearance: unknown = DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1) {
    return PublicProfilePublishBodyV1Schema.parse({ policy: structuredClone(DEFAULT_PUBLIC_PROFILE_POLICY_V1), metadata: {}, projectSelections: [],
        query: normalizeUsageQuery({ population: 'public_eligible_personal', period: { startMs: 1000, endMs: 2000 }, timeZoneOffsetMinutes: 0 }),
        snapshot: { v: 1, computedAtMs: 2000, period: { startMs: 1000, endMs: 2000, timeZoneOffsetMinutes: 0 },
            coverage: { status: 'partial', method: 'runtime' }, fieldCoverage: {}, facts: {} },
        layout: { v: 1, items: [] }, appearance });
}

async function publishedAccount() {
    const owner = await db.account.create({ data: { encryptionMode: 'plain', username: 'delivery_owner', name: 'Reviewed owner' } });
    expect((await publishPublicProfile(owner.id, publishBody(), env, deps)).kind).toBe('updated');
    return owner;
}

async function applyPicture(accountId: string, red: number, credit: PublicProfilePictureDescriptorV1['credit'] = null) {
    const fixture = await pictureFixture(red, credit);
    const result = await updatePublicProfile(accountId, { appearance: fixture.appearance });
    expect(result.kind).toBe('updated');
    if (result.kind !== 'updated' || result.record?.appearance?.atmosphere.source !== 'picture') throw new Error('Expected applied picture');
    return { pixels: fixture.pixels, id: result.record.appearance.atmosphere.picture.ref.id };
}

describe('public-profile media admission', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-profile-delivery-', initFiles: true,
        env: { NODE_OPTIONS: [process.env.NODE_OPTIONS, '--conditions=happier-source'].filter(Boolean).join(' ') } }); }, 120_000);
    afterAll(async () => { await harness?.close(); });
    afterEach(async () => { fontIo.afterRead = undefined; vi.restoreAllMocks(); await db.uploadedFile.deleteMany(); await db.account.deleteMany(); });

    it.each(['hide', 'withdraw'] as const)('finishes captured painting when %s occurs during font IO and revokes on the next request', async change => {
        harness.resetEnv(env);
        const owner = await publishedAccount();
        await withAuthenticatedTestApp(app => { registerAccountPublicProfileRoutes(app); registerPublicProfileReadRoutes(app); }, async app => {
            for (const suffix of ['/badge/tokens.svg', '/card.svg', '/card.png?theme=light', '/og.png',
                '/background?theme=light&viewport=phone&density=1']) {
                const body = publishBody({ ...DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1,
                    atmosphere: { source: 'planet', planet: { placement: 'side', style: 'airy', digits: true } } });
                expect((await publishPublicProfile(owner.id, body, env, deps)).kind).toBe('updated');
                const admitted = await app.inject({ method: 'GET', url: `/@delivery_owner${suffix}` });
                expect(admitted.statusCode, suffix).toBe(200);
                let changed = false;
                fontIo.afterRead = async () => {
                    changed = true;
                    if (change === 'withdraw') await unpublishPublicProfile(owner.id);
                    else {
                        const policy = structuredClone(DEFAULT_PUBLIC_PROFILE_POLICY_V1);
                        policy.fields.name = false;
                        await updatePublicProfile(owner.id, { policy });
                    }
                };
                // A miss starts a finite render under the captured admission.
                const response = await app.inject({ method: 'GET', url: `/@delivery_owner${suffix}`, headers: { 'if-none-match': '"stale-render"' } });
                expect(changed, `font IO reached for ${suffix || 'HTML'}`).toBe(true);
                expect(response.statusCode, suffix).toBe(200);
                expect(response.headers.etag, suffix).toBe(admitted.headers.etag);
                expect(response.rawPayload, suffix).toEqual(admitted.rawPayload);
                const next = await app.inject({ method: 'GET', url: `/@delivery_owner${suffix}`,
                    headers: { 'if-none-match': response.headers.etag } });
                expect(next.statusCode, suffix).toBe(change === 'withdraw' && suffix.startsWith('/background?') ? 404 : 200);
                expect(next.headers.etag, suffix).not.toBe(admitted.headers.etag);
                if (change === 'withdraw') expect(next.headers.etag, suffix).toBeUndefined();
                const current = await app.inject({ method: 'GET', url: `/@delivery_owner${suffix}` });
                expect(next.rawPayload, suffix).toEqual(current.rawPayload);
            }
        });
        harness.restoreEnv();
    });

    it('reports a real paint failure even when the captured publication is withdrawn during font IO', async () => {
        harness.resetEnv(env);
        const owner = await publishedAccount();
        await withAuthenticatedTestApp(app => registerPublicProfileReadRoutes(app), async app => {
            fontIo.afterRead = async () => { throw new Error('physical font read failed'); };
            const unchanged = await app.inject({ method: 'GET', url: '/@delivery_owner/card.svg' });
            expect(unchanged.statusCode).toBe(503);
            expect(unchanged.headers.etag).toBeUndefined();
            fontIo.afterRead = async () => {
                await unpublishPublicProfile(owner.id);
                throw new Error('retired paint failed');
            };
            const retired = await app.inject({ method: 'GET', url: '/@delivery_owner/card.svg', headers: { 'if-none-match': '"stale-render"' } });
            expect(retired.statusCode).toBe(503);
            expect(retired.headers.etag).toBeUndefined();
            expect(retired.headers['cache-control']).toBe('no-store');
            const unavailable = await app.inject({ method: 'GET', url: '/@missing_profile/card.svg' });
            const next = await app.inject({ method: 'GET', url: '/@delivery_owner/card.svg' });
            expect(next.statusCode).toBe(200);
            expect(next.headers.etag).toBeUndefined();
            expect(next.rawPayload).toEqual(unavailable.rawPayload);
        });
        harness.restoreEnv();
    });

    it('cold-renders selected picture URLs without reading pixels and revalidates current policy on the next HTML request', async () => {
        harness.resetEnv(env);
        const owner = await publishedAccount();
        await applyPicture(owner.id, 17, { author: 'Ada <Painter>', source: 'Local collection', url: 'https://example.test/credit', licence: 'CC0' });
        await withAuthenticatedTestApp(app => { registerAccountPublicProfileRoutes(app); registerPublicProfileReadRoutes(app); }, async app => {
            const physicalReads = vi.spyOn(files, 'readPrivateFile');
            const url = '/@delivery_owner';
            const startedAt = performance.now();
            const first = await app.inject({ method: 'GET', url });
            console.info('public-profile-cold-hero-http-cost', { elapsedMs: Math.round(performance.now() - startedAt),
                htmlBytes: first.rawPayload.length });
            expect(first.statusCode).toBe(200);
            expect(physicalReads.mock.calls.length).toBe(0);
            expect(first.body).toContain('public-profile-hero-band');
            const stylesheet = first.body.match(/<style>([\s\S]*?)<\/style>/)?.[1];
            if (!stylesheet) throw new Error('Expected the actual cold HTTP stylesheet');
            // Parse and lower equivalent range/not-min forms; an escaped '<'
            // becomes an unknown feature instead of this strict width condition.
            const normalized = await transform(stylesheet, { loader: 'css', supported: { 'media-range': false }, minify: true });
            expect(normalized.code.match(/@media not\s*\(min-width:640px\)\{\.public-profile-wide\{display:none\}\.public-profile-phone\{display:block\}\}/)?.[0]).toBeDefined();
            expect(first.body).toContain('Ada &lt;Painter&gt; · Local collection');
            expect(first.body).not.toContain('data:image/png;base64,');
            const images = new Set([...first.body.matchAll(/https:[^"\s,]+\/background\?[^"\s,]+/g)].map(match => match[0].replaceAll('&amp;', '&')));
            expect(images.size).toBe(8);
            const dimensions = await Promise.all([...images].map(async source => {
                const image = new URL(source);
                expect(image.origin).toBe('https://profiles.example.test');
                expect(image.pathname).toBe('/prefix/@delivery_owner/background');
                const response = await app.inject({ method: 'GET', url: `/@delivery_owner/background${image.search}` });
                expect(response.statusCode).toBe(200);
                expect(response.headers['cache-control']).toBe('public, no-cache, must-revalidate');
                expect((await app.inject({ method: 'GET', url: `/@delivery_owner/background${image.search}`,
                    headers: { 'if-none-match': response.headers.etag } })).statusCode).toBe(304);
                const metadata = await sharp(response.rawPayload).metadata();
                return `${metadata.width}x${metadata.height}`;
            }));
            expect(physicalReads.mock.calls.length).toBe(images.size);
            for (const kind of ['wide', 'phone'] as const) {
                for (const density of [1, 2]) expect(dimensions).toContain(`${HAPPIER_PUBLIC_PROFILE_HERO_METRICS.rasterWidthPx[kind] * density}x${HAPPIER_PUBLIC_PROFILE_HERO_METRICS.bandHeightPx[kind] * density}`);
            }
            expect(first.body).toContain(' 2x');
            expect(first.body).not.toContain('<script');
            const validator = String(first.headers.etag);
            expect((await app.inject({ method: 'GET', url, headers: { 'if-none-match': validator } })).statusCode).toBe(304);

            const policy = structuredClone(DEFAULT_PUBLIC_PROFILE_POLICY_V1);
            policy.fields.name = false;
            await updatePublicProfile(owner.id, { policy });
            physicalReads.mockClear();
            const hidden = await app.inject({ method: 'GET', url, headers: { 'if-none-match': '"stale-render"' } });
            expect(hidden.statusCode).toBe(200);
            expect(physicalReads.mock.calls.length).toBe(0);
            expect(hidden.body).not.toContain('Reviewed owner');
            expect(hidden.headers.etag).not.toBe(validator);
            await applyPicture(owner.id, 233);
            const replacement = await app.inject({ method: 'GET', url, headers: { 'if-none-match': hidden.headers.etag } });
            expect(replacement.statusCode).toBe(200);
            expect(replacement.headers.etag).not.toBe(hidden.headers.etag);
            expect(replacement.body).not.toBe(hidden.body);
            expect(replacement.body).not.toContain('Ada &lt;Painter&gt;');
            await unpublishPublicProfile(owner.id);
            const withdrawn = await app.inject({ method: 'GET', url, headers: { 'if-none-match': replacement.headers.etag } });
            expect(withdrawn.statusCode).toBe(404);
            expect(withdrawn.headers.etag).toBeUndefined();
            expect(withdrawn.body).toMatch(/data-testid="public-profile-hero-band"[^>]*>\s*<svg[\s\S]*?<circle/);
            expect(withdrawn.body).not.toContain('/@delivery_owner/background?');
            expect(withdrawn.body).not.toContain('public-profile-identity');
        });
        harness.restoreEnv();
    });

    it.each(['replace', 'hide', 'pause', 'unpublish'] as const)('rechecks referenced hero pixels before old validators after %s', async change => {
        harness.resetEnv(env);
        const owner = await publishedAccount();
        await applyPicture(owner.id, 17);
        await withAuthenticatedTestApp(app => registerPublicProfileReadRoutes(app), async app => {
            const url = '/@delivery_owner/background?theme=dark&viewport=phone&density=2';
            const first = await app.inject({ method: 'GET', url });
            expect(first.statusCode).toBe(200);
            if (change === 'replace') await applyPicture(owner.id, 233);
            if (change === 'hide') await updatePublicProfile(owner.id, { appearance: { theme: 'auto', atmosphere: { source: 'none' } } });
            if (change === 'pause') await pausePublicProfile(owner.id);
            if (change === 'unpublish') await unpublishPublicProfile(owner.id);
            const current = await app.inject({ method: 'GET', url, headers: { 'if-none-match': first.headers.etag } });
            expect(current.statusCode).toBe(change === 'replace' ? 200 : 404);
            expect(current.headers.etag).not.toBe(first.headers.etag);
            expect(current.rawPayload).not.toEqual(first.rawPayload);
            if (change !== 'replace') expect(current.headers.etag).toBeUndefined();
        });
        harness.restoreEnv();
    });

    it.each(['plain', 'e2ee'] as const)('publishes reviewed picture bytes atomically without changing %s Account keys', async encryptionMode => {
        const owner = await db.account.create({ data: { encryptionMode, username: 'delivery_owner',
            ...(encryptionMode === 'e2ee' ? createSignedAccountContentBinding() : {}) } });
        const fixture = await pictureFixture(17);
        const result = await publishPublicProfile(owner.id, publishBody(fixture.appearance), env, deps);
        expect(result.kind).toBe('updated');
        if (result.kind !== 'updated' || result.record?.appearance?.atmosphere.source !== 'picture') throw new Error('Expected applied picture');
        const pictureId = result.record.appearance.atmosphere.picture.ref.id;
        const physical = await readPublicProfilePicture({ accountId: owner.id, pictureId });
        expect(physical.ok).toBe(true);
        if (!physical.ok) throw new Error('Expected readable committed pixels');
        expect((await sharp(physical.bytes).raw().toBuffer()).equals(await sharp(fixture.pixels).raw().toBuffer())).toBe(true);
        expect(JSON.stringify(result)).not.toContain('base64');
        const facts = publishBody();
        expect((await refreshPublicProfile(owner.id, { query: facts.query, snapshot: facts.snapshot }, env, deps)).kind).toBe('updated');
        const refreshed = await db.accountPublicProfile.findUniqueOrThrow({ where: { accountId: owner.id } });
        expect(JSON.parse(refreshed.appearanceJson!).atmosphere.picture.ref.id).toBe(pictureId);
        const after = await db.account.findUniqueOrThrow({ where: { id: owner.id } });
        expect(after).toMatchObject({ encryptionMode: owner.encryptionMode, publicKey: owner.publicKey,
            contentPublicKey: owner.contentPublicKey, contentPublicKeySig: owner.contentPublicKeySig });
    });

    it('retires displaced custody after Apply and unpublish and preserves a committed result when deletion fails', async () => {
        const owner = await publishedAccount();
        const first = await applyPicture(owner.id, 17);
        const oldRow = await db.uploadedFile.findUniqueOrThrow({ where: { id: first.id } });
        const deletion = vi.spyOn(files, 'deletePrivateFile').mockRejectedValue(new Error('physical deletion unavailable'));
        const second = await applyPicture(owner.id, 199);
        expect(await readPublicProfilePicture({ accountId: owner.id, pictureId: first.id })).toEqual({ ok: false, reason: 'not_found' });
        expect((await files.readPrivateFile(oldRow.path)).length).toBeGreaterThan(0);
        expect((await readPublicProfilePicture({ accountId: owner.id, pictureId: second.id })).ok).toBe(true);
        deletion.mockRestore();
        await cleanupPublicProfilePictures(owner.id);
        await expect(files.readPrivateFile(oldRow.path)).rejects.toThrow();
        await unpublishPublicProfile(owner.id);
        expect(await readPublicProfilePicture({ accountId: owner.id, pictureId: second.id })).toEqual({ ok: false, reason: 'not_found' });
    });

    it('rejects an Apply that loses admission during physical IO without replacing the prior image', async () => {
        const owner = await publishedAccount();
        const first = await applyPicture(owner.id, 17);
        const fixture = await pictureFixture(199);
        const realWrite = files.writePrivateFile;
        vi.spyOn(files, 'writePrivateFile').mockImplementationOnce(async (path, bytes) => {
            await realWrite(path, bytes);
            await db.accountPublicProfile.update({ where: { accountId: owner.id }, data: { removedAt: new Date(), removalReason: 'operator restriction won' } });
        });
        expect(await updatePublicProfile(owner.id, { appearance: fixture.appearance })).toEqual({ kind: 'unavailable', reason: 'restricted' });
        const current = await db.accountPublicProfile.findUniqueOrThrow({ where: { accountId: owner.id } });
        expect(JSON.parse(current.appearanceJson!).atmosphere.picture.ref.id).toBe(first.id);
        expect(await db.uploadedFile.findMany({ where: { accountId: owner.id }, select: { id: true } })).toEqual([{ id: first.id }]);
        expect((await readPublicProfilePicture({ accountId: owner.id, pictureId: first.id })).ok).toBe(true);
    });

    it('retains the applied edition when preparing replacement pixels fails', async () => {
        const owner = await publishedAccount();
        const first = await applyPicture(owner.id, 17);
        const fixture = await pictureFixture(199);
        vi.spyOn(files, 'writePrivateFile').mockRejectedValueOnce(new Error('physical write unavailable'));
        expect(await updatePublicProfile(owner.id, { appearance: fixture.appearance })).toEqual({ kind: 'unavailable', reason: 'asset_unavailable' });
        const current = await db.accountPublicProfile.findUniqueOrThrow({ where: { accountId: owner.id } });
        expect(JSON.parse(current.appearanceJson!).atmosphere.picture.ref.id).toBe(first.id);
        expect(await db.uploadedFile.findMany({ where: { accountId: owner.id }, select: { id: true } })).toEqual([{ id: first.id }]);
    });

    it('retains applied picture custody through rename and retires it on canonical username release', async () => {
        const owner = await publishedAccount();
        const applied = await applyPicture(owner.id, 17);
        await inTx(tx => changeUsernameInTx(tx, owner.id, { kind: 'manual_set', username: 'renamed_owner' }, env), { isolationLevel: 'Serializable' });
        expect(await readAdmittedPublicProfileDelivery('delivery_owner', env, deps)).toEqual({ result: { kind: 'unavailable' } });
        expect((await readAdmittedPublicProfileDelivery('renamed_owner', env, deps)).result).toMatchObject({ kind: 'published' });
        expect((await readPublicProfilePicture({ accountId: owner.id, pictureId: applied.id })).ok).toBe(true);
        await inTx(tx => changeUsernameInTx(tx, owner.id, { kind: 'release' }, env), { isolationLevel: 'ReadCommitted' });
        expect(await db.accountPublicProfile.findUnique({ where: { accountId: owner.id } })).toBeNull();
        expect(await readPublicProfilePicture({ accountId: owner.id, pictureId: applied.id })).toEqual({ ok: false, reason: 'not_found' });
    });

    it('returns only the current admitted picture and revokes media on replacement, pause and unpublish', async () => {
        const owner = await publishedAccount();
        const first = await applyPicture(owner.id, 17);
        const delivery = await readAdmittedPublicProfileDelivery('delivery_owner', env, deps);
        expect(delivery.result.kind).toBe('published');
        expect(delivery.picture).toMatchObject({ mimeType: 'image/png', width: 96, height: 48 });
        expect((await sharp(delivery.picture!.bytes).raw().toBuffer()).equals(await sharp(first.pixels).raw().toBuffer())).toBe(true);
        expect(JSON.stringify(delivery.result)).not.toContain(owner.id);
        expect(JSON.stringify(delivery.result)).not.toContain('public-profile/');

        const second = await applyPicture(owner.id, 199);
        const replaced = await readAdmittedPublicProfileDelivery('delivery_owner', env, deps);
        expect(replaced.result).toMatchObject({ kind: 'published', view: { appearance: { atmosphere: {
            source: 'picture', picture: { ref: { kind: 'publication', id: second.id } },
        } } } });
        expect((await sharp(replaced.picture!.bytes).raw().toBuffer()).equals(await sharp(second.pixels).raw().toBuffer())).toBe(true);
        await pausePublicProfile(owner.id);
        expect(await readAdmittedPublicProfileDelivery('delivery_owner', env, deps)).toMatchObject({ result: { kind: 'paused' } });
        expect((await readAdmittedPublicProfileDelivery('delivery_owner', env, deps)).picture).toBeUndefined();
        await unpublishPublicProfile(owner.id);
        expect(await readAdmittedPublicProfileDelivery('delivery_owner', env, deps)).toEqual({ result: { kind: 'unavailable' } });
    });

    it('distinguishes missing custody from a physical storage failure', async () => {
        const owner = await publishedAccount();
        const applied = await applyPicture(owner.id, 17);
        const boundary = vi.spyOn(files, 'readPrivateFile').mockRejectedValue(new Error('physical storage unavailable'));
        await expect(readAdmittedPublicProfileDelivery('delivery_owner', env, deps)).rejects.toThrow();
        boundary.mockRestore();
        await inTx(tx => retirePublicProfilePictureInTx(tx, owner.id, applied.id));
        expect(await readAdmittedPublicProfileDelivery('delivery_owner', env, deps)).toEqual({ result: { kind: 'unavailable' } });
    });

    it('reports a genuine captured-picture read failure and withdraws the next read normally', async () => {
        const owner = await publishedAccount();
        await applyPicture(owner.id, 17);
        vi.spyOn(files, 'readPrivateFile').mockImplementationOnce(async () => {
            await unpublishPublicProfile(owner.id);
            throw new Error('retired file is no longer available');
        });
        await expect(readAdmittedPublicProfileDelivery('delivery_owner', env, deps)).rejects.toThrow('public_profile_picture_unavailable');
        expect(await readAdmittedPublicProfileDelivery('delivery_owner', env, deps)).toEqual({ result: { kind: 'unavailable' } });
    });

    it.each(['pause', 'hide', 'replace', 'rename', 'recycle'] as const)('finishes captured picture delivery across %s and admits only current state on the next read', async change => {
        const owner = await publishedAccount();
        const captured = await applyPicture(owner.id, 17);
        const realRead = files.readPrivateFile;
        vi.spyOn(files, 'readPrivateFile').mockImplementationOnce(async path => {
            const bytes = await realRead(path);
            if (change === 'pause') await pausePublicProfile(owner.id);
            if (change === 'hide') {
                const policy = structuredClone(DEFAULT_PUBLIC_PROFILE_POLICY_V1);
                policy.fields.name = false;
                await updatePublicProfile(owner.id, { policy });
            }
            if (change === 'replace') await applyPicture(owner.id, 199);
            if (change === 'rename' || change === 'recycle') {
                await inTx(tx => changeUsernameInTx(tx, owner.id, { kind: 'manual_set', username: 'renamed_owner' }, env), { isolationLevel: 'Serializable' });
                if (change === 'recycle') {
                    const replacement = await publishedAccount();
                    await applyPicture(replacement.id, 199);
                }
            }
            return bytes;
        });
        const delivered = await readAdmittedPublicProfileDelivery('delivery_owner', env, deps);
        expect(delivered.result).toMatchObject({ kind: 'published', view: { identity: { name: 'Reviewed owner' },
            appearance: { atmosphere: { source: 'picture', picture: { ref: { id: captured.id } } } } } });
        expect(delivered.picture).toBeDefined();
        expect((await sharp(delivered.picture!.bytes).raw().toBuffer()).equals(await sharp(captured.pixels).raw().toBuffer())).toBe(true);
        const next = await readAdmittedPublicProfileDelivery('delivery_owner', env, deps);
        if (change === 'hide') {
            expect(next.result).toMatchObject({ kind: 'published', view: { identity: {} } });
            expect(JSON.stringify(next.result)).not.toContain('Reviewed owner');
            expect(next.picture).toBeDefined();
        } else if (change === 'replace' || change === 'recycle') {
            expect(next.result.kind).toBe('published');
            expect(JSON.stringify(next.result)).not.toContain(captured.id);
            expect(next.picture).toBeDefined();
            expect((await sharp(next.picture!.bytes).raw().toBuffer()).equals(await sharp(captured.pixels).raw().toBuffer())).toBe(false);
        } else {
            expect(next.result.kind).toBe(change === 'pause' ? 'paused' : 'unavailable');
            expect(next.picture).toBeUndefined();
        }
    });

    it('returns no media when the real capability decision disables publication', async () => {
        const owner = await publishedAccount();
        await applyPicture(owner.id, 17);
        expect(await readPublicProfileDelivery('delivery_owner', { ...env, HAPPIER_BUILD_FEATURES_DENY: 'account.publicProfiles' }, deps))
            .toEqual({ result: { kind: 'unavailable' } });
    });
});
