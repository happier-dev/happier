import type { Fastify } from '../../types';
import { createHash } from 'node:crypto';
import { z } from 'zod/mini';
import { PublicProfileReadResultV1Schema } from '@happier-dev/protocol/account/publicProfilePublication';
import { readRequestHomeEnv } from '@/app/home/settings/requestHomeEnv';
import { readPublicProfile, readPublicProfileRepresentation, readPublicProfileDeliveryRepresentation, matchesPublicProfileEtag,
    type PublicProfileDelivery, type PublicProfileRepresentationVariant } from '@/app/account/profile/publicProfileRead';
import type { PublicProfileServerDependencies } from '@/app/account/profile/publicProfileStorage';
import { publicProfileServerDependencies } from '@/app/account/profile/publicProfileDependencies';
import { renderPublicProfileSvg, publicProfileBadgeMessage } from '@/app/account/profile/render/publicProfileSvg';
import { renderPublicProfileCardPng, renderPublicProfileOg } from '@/app/account/profile/render/publicProfileOg';
import { PUBLIC_PROFILE_ASSET_LABELS } from '@/app/account/profile/render/publicProfileLabels';
import { PUBLIC_PROFILE_PALETTES } from '@/app/account/profile/render/publicProfileEnvironment';
import { publicProfileFontFaceForFilename, readPublicProfileFont } from '@/app/account/profile/render/publicProfileFonts';
import { createPublicProfileHero, renderPublicProfileHeroImage } from '@/app/account/profile/render/publicProfileHero';
import { resolvePublicProfileServiceName } from '@/app/account/profile/publicProfileContext';

let publicProfileHtml: Promise<typeof import('@/app/account/profile/render/publicProfileHtml')> | undefined;

/** Concurrent visitor requests share the renderer's first-demand module load. */
export function loadPublicProfileHtml(): Promise<typeof import('@/app/account/profile/render/publicProfileHtml')> {
    return publicProfileHtml ??= import('@/app/account/profile/render/publicProfileHtml');
}

/** Validators describe the currently admitted representation, never a stored snapshot timestamp. */
export function publicProfileRepresentationEtag(bytes: string | Uint8Array): string {
    return `"${createHash('sha256').update(bytes).digest('hex')}"`;
}

export { matchesPublicProfileEtag } from '@/app/account/profile/publicProfileRead';

/** Anonymous output is independent of optional UI mounting and caller credentials. */
export function registerPublicProfileReadRoutes(app: Fastify, deps: PublicProfileServerDependencies = publicProfileServerDependencies): void {
    app.get('/v1/public/profiles/assets/fonts/:filename', { schema: { params: z.strictObject({ filename: z.string() }) } }, async (request, reply) => {
        reply.header('X-Content-Type-Options', 'nosniff').header('X-Robots-Tag', 'noindex');
        const face = publicProfileFontFaceForFilename(request.params.filename);
        if (!face) return reply.code(404).send({ kind: 'unavailable' });
        try {
            const font = await readPublicProfileFont(face);
            const etag = publicProfileRepresentationEtag(font.bytes);
            reply.header('Cache-Control', 'public, no-cache, must-revalidate').header('ETag', etag)
                .type(request.params.filename.endsWith('.otf') ? 'font/otf' : 'font/ttf');
            if (matchesPublicProfileEtag(request.headers['if-none-match'], etag)) return reply.code(304).send();
            return reply.send(font.bytes);
        } catch { return reply.header('Cache-Control', 'no-store').code(503).send({ kind: 'unavailable' }); }
    });
    const assetOptions = { labels: PUBLIC_PROFILE_ASSET_LABELS, palette: PUBLIC_PROFILE_PALETTES };
    const assetQuery = z.object({ theme: z.optional(z.enum(['auto', 'light', 'dark'])) });
    for (const kind of ['badge', 'card'] as const) {
        const path = kind === 'badge' ? '/@:handle/badge/:kind.svg' : '/@:handle/card.svg';
        app.get(path, { schema: { params: z.object({ handle: z.string(), kind: z.optional(z.string()) }), querystring: assetQuery } }, async (request, reply) => {
            reply.header('X-Content-Type-Options', 'nosniff').header('X-Robots-Tag', 'noindex').header('Referrer-Policy', 'no-referrer')
                .header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:");
            try {
                const env = await readRequestHomeEnv(request);
                // A metric badge has no picture layer, just like its Shields JSON counterpart.
                const materialize = (delivery: PublicProfileDelivery) => renderPublicProfileSvg(delivery.result, { ...assetOptions, kind, theme: request.query.theme ?? 'auto',
                    metric: request.params.kind, ...(delivery.picture ? { picture: delivery.picture.bytes } : {}) });
                const condition = { ifNoneMatch: request.headers['if-none-match'], variant: { kind: 'svg', surface: kind,
                    theme: request.query.theme ?? 'auto', ...(request.params.kind ? { metric: request.params.kind } : {}) } satisfies PublicProfileRepresentationVariant };
                const rendered = kind === 'badge'
                    ? await readPublicProfileRepresentation(request.params.handle, env, deps, result => materialize({ result }), condition)
                    : await readPublicProfileDeliveryRepresentation(request.params.handle, env, deps, materialize, condition);
                reply.header('Cache-Control', 'public, no-cache, must-revalidate').type('image/svg+xml');
                if (rendered.etag) reply.header('ETag', rendered.etag);
                if (rendered.kind === 'not_modified') return reply.code(304).send();
                return reply.send(rendered.representation);
            } catch { return reply.header('Cache-Control', 'no-store').code(503).send({ kind: 'unavailable' }); }
        });
    }
    app.get('/@:handle/badge/:kind.json', { schema: { params: z.strictObject({ handle: z.string(), kind: z.string() }) } }, async (request, reply) => {
        reply.header('X-Content-Type-Options', 'nosniff').header('X-Robots-Tag', 'noindex').header('Referrer-Policy', 'no-referrer');
        try {
            const result = await readPublicProfile(request.params.handle, await readRequestHomeEnv(request), deps);
            const message = publicProfileBadgeMessage(result, request.params.kind, PUBLIC_PROFILE_ASSET_LABELS);
            const body = { schemaVersion: 1, label: PUBLIC_PROFILE_ASSET_LABELS.brand, message: message.message,
                color: PUBLIC_PROFILE_PALETTES.light.secondary.replace('#', ''), ...(message.isError ? { isError: true } : {}) };
            reply.header('Cache-Control', 'public, no-cache, must-revalidate');
            if (result.kind === 'unavailable') return reply.send(body);
            const etag = publicProfileRepresentationEtag(JSON.stringify(body));
            reply.header('ETag', etag);
            if (matchesPublicProfileEtag(request.headers['if-none-match'], etag)) return reply.code(304).send();
            return reply.send(body);
        } catch { return reply.header('Cache-Control', 'no-store').code(503).send({ kind: 'unavailable' }); }
    });
    for (const kind of ['card', 'og'] as const) {
    app.get(`/@:handle/${kind}.png`, { schema: { params: z.strictObject({ handle: z.string() }),
        querystring: z.object({ v: z.optional(z.string()), theme: z.optional(z.enum(['auto', 'light', 'dark'])) }) } }, async (request, reply) => {
        reply.header('X-Content-Type-Options', 'nosniff').header('X-Robots-Tag', 'noindex').header('Referrer-Policy', 'no-referrer');
        try {
            const rendered = await readPublicProfileDeliveryRepresentation(request.params.handle, await readRequestHomeEnv(request), deps, async delivery => {
                const options = { ...assetOptions, ...(delivery.picture ? { picture: delivery.picture.bytes } : {}) };
                return kind === 'og' ? renderPublicProfileOg(delivery.result, options)
                    : renderPublicProfileCardPng(delivery.result, { ...options, theme: request.query.theme ?? 'auto' });
            }, { ifNoneMatch: request.headers['if-none-match'], variant: { kind: 'png', surface: kind,
                ...(kind === 'card' ? { theme: request.query.theme ?? 'auto' } : {}) } });
            reply.header('Cache-Control', 'public, no-cache, must-revalidate').type('image/png');
            if (rendered.etag) reply.header('ETag', rendered.etag);
            if (rendered.kind === 'not_modified') return reply.code(304).send();
            return reply.send(rendered.representation);
        } catch { return reply.header('Cache-Control', 'no-store').code(503).send({ kind: 'unavailable' }); }
    });
    }
    app.get('/@:handle/background', { schema: { params: z.strictObject({ handle: z.string() }), querystring: z.union([
        z.strictObject({}), z.strictObject({ theme: z.enum(['light', 'dark']), viewport: z.enum(['wide', 'phone']), density: z.enum(['1', '2']) }),
    ]) } }, async (request, reply) => {
        reply.header('X-Content-Type-Options', 'nosniff').header('X-Robots-Tag', 'noindex').header('Referrer-Policy', 'no-referrer');
        try {
            const rendered = await readPublicProfileDeliveryRepresentation(request.params.handle,
                await readRequestHomeEnv(request), deps, async (delivery): Promise<PublicProfileDelivery['picture']> => {
                    if (delivery.result.kind !== 'published') return undefined;
                    if ('theme' in request.query) return renderPublicProfileHeroImage(delivery.result.view,
                        { palette: PUBLIC_PROFILE_PALETTES, ...(delivery.picture ? { picture: delivery.picture.bytes } : {}) },
                        { theme: request.query.theme, viewport: request.query.viewport, density: request.query.density === '2' ? 2 : 1 });
                    return delivery.picture;
                }, { ifNoneMatch: request.headers['if-none-match'], variant: { kind: 'background',
                    ...('theme' in request.query ? { selection: { theme: request.query.theme, viewport: request.query.viewport, density: request.query.density } } : {}) } });
            if (rendered.kind === 'not_modified') return reply.header('Cache-Control', 'public, no-cache, must-revalidate')
                .header('ETag', rendered.etag).type('image/png').code(304).send();
            const { result, representation: image } = rendered;
            if (result.kind !== 'published' || !image) {
                return reply.header('Cache-Control', 'public, no-cache, must-revalidate').code(404).send({ kind: 'unavailable' });
            }
            reply.header('Cache-Control', 'public, no-cache, must-revalidate').type(image.mimeType);
            if (rendered.etag) reply.header('ETag', rendered.etag);
            return reply.send(image.bytes);
        } catch { return reply.header('Cache-Control', 'no-store').code(503).send({ kind: 'unavailable' }); }
    });
    app.get('/@:handle', { schema: { params: z.strictObject({ handle: z.string() }) } }, async (request, reply) => {
        reply.header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'no-referrer')
            .header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; font-src 'self'; base-uri 'none'; frame-ancestors 'none'");
        let service: string | undefined;
        try {
            const env = await readRequestHomeEnv(request);
            service = resolvePublicProfileServiceName(env);
            const nowMs = Date.now();
            const rendered = await readPublicProfileRepresentation(request.params.handle, env, deps, async result => {
                const hero = result.kind === 'published' ? createPublicProfileHero(result.view) : undefined;
                const { renderPublicProfileHtml } = await loadPublicProfileHtml();
                return renderPublicProfileHtml(result, hero, { service, nowMs });
            }, { ifNoneMatch: request.headers['if-none-match'], variant: { kind: 'html', service, nowMs } });
            const { result } = rendered;
            reply.header('X-Robots-Tag', result.kind === 'published' && result.view.indexable ? 'index, follow' : 'noindex, nofollow');
            reply.header('Cache-Control', 'public, no-cache, must-revalidate').type('text/html; charset=utf-8');
            if (rendered.etag) reply.header('ETag', rendered.etag);
            if (rendered.kind === 'not_modified') return reply.code(304).send();
            return reply.code(result.kind === 'unavailable' ? 404 : 200).send(rendered.representation);
        } catch {
            const { renderPublicProfileHtml } = await loadPublicProfileHtml();
            return reply.header('Cache-Control', 'no-store').header('X-Robots-Tag', 'noindex, nofollow')
                .type('text/html; charset=utf-8').code(503).send(renderPublicProfileHtml({ kind: 'unavailable' }, undefined, { service }));
        }
    });
    app.get('/v1/public/profiles/:handle', { schema: { params: z.strictObject({ handle: z.string() }),
        response: { 200: PublicProfileReadResultV1Schema, 304: z.optional(z.null()), 404: PublicProfileReadResultV1Schema, 503: PublicProfileReadResultV1Schema } } }, async (request, reply) => {
        reply.header('X-Content-Type-Options', 'nosniff').header('X-Robots-Tag', 'noindex').header('Referrer-Policy', 'no-referrer');
        try {
            const result = await readPublicProfile(request.params.handle, await readRequestHomeEnv(request), deps);
            reply.header('Cache-Control', 'public, no-cache, must-revalidate');
            if (result.kind === 'unavailable') return reply.code(404).send(result);
            const etag = publicProfileRepresentationEtag(JSON.stringify(result));
            reply.header('ETag', etag);
            if (matchesPublicProfileEtag(request.headers['if-none-match'], etag)) return reply.code(304).send(undefined);
            return reply.send(result);
        } catch {
            return reply.header('Cache-Control', 'no-store').code(503).send({ kind: 'unavailable' });
        }
    });
}
