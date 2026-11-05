import { describe, expect, it } from 'vitest';
import { ATMOSPHERE_PICTURES } from '@happier-dev/brand/atmosphere';
import { DEFAULT_HOME_ATMOSPHERE } from '@happier-dev/protocol/account/settings/accountSettings';
import { PublicProfilePreparedAtmosphereV1Schema } from '@happier-dev/protocol/account/publicProfileAtmosphere';
import type { PictureStore } from './pictureStore.types';
import { preparePublicProfileAtmosphere } from './preparePublicProfileAtmosphere';

// Device persistence and platform decoding are boundaries. All selection, metadata and Look logic remains real.
function pictureBoundary() {
    const picture = structuredClone(ATMOSPHERE_PICTURES[0]!);
    let bytes: Blob = new Blob(['source WebP'], { type: 'image/webp' });
    let preparedCount = 0;
    const store = {
        get: async (localId: string) => localId === `builtin:${picture.id}` ? { localId, kind: 'builtin' as const,
            createdAtMs: 1, size: bytes.size, data: bytes, source: picture.src } : undefined,
        prepare: async () => { preparedCount++; return new Blob(['retained reviewed pixels'], { type: 'image/png' }); },
    } satisfies Pick<PictureStore, 'get' | 'prepare'>;
    return { picture, store, replace: () => { bytes = new Blob(['changed source'], { type: 'image/webp' }); }, preparedCount: () => preparedCount };
}

describe('profile atmosphere preparation at the local store boundary', () => {
    it('retains only exact selected pixels and effective settings without uploading, persisting or inheriting later edits', async () => {
        const boundary = pictureBoundary();
        const candidate = { ...DEFAULT_HOME_ATMOSPHERE, source: 'picture' as const,
            picture: { ref: { kind: 'builtin' as const, id: boundary.picture.id }, layout: 'horizon' as const },
            looks: { [boundary.picture.id]: { look: 'mosaic' as const, strength: 0.37, dissolve: 'rows' as const },
                privateOtherPicture: { look: 'engraving' as const } },
        };
        const result = await preparePublicProfileAtmosphere({ presentation: candidate, pictures: [boundary.picture],
            store: boundary.store, isCurrent: () => true });
        expect(result.status).toBe('ready');
        if (result.status !== 'ready' || result.value.source !== 'picture') throw new Error('Expected retained picture copy');
        expect(PublicProfilePreparedAtmosphereV1Schema.safeParse(result.value).success).toBe(true);
        expect(result.value.picture.content).toEqual({ mimeType: 'image/png', base64: 'cmV0YWluZWQgcmV2aWV3ZWQgcGl4ZWxz' });
        expect(result.value.picture.descriptor.look).toMatchObject({ effect: 'mosaic', strength: 0.37, dissolve: { style: 'rows' } });
        expect(result.value.picture.descriptor.adaptiveHaze).toBe(false);
        expect(result.value.picture.descriptor.look.params).not.toEqual({});
        const retained = JSON.stringify(result.value);
        expect(retained).not.toContain('privateOtherPicture');
        expect(retained).not.toContain('https://images');
        expect(retained).not.toContain('moments');
        expect(retained).not.toContain('showOn');
        boundary.replace();
        boundary.picture.look = { effect: 'original' };
        boundary.picture.src.full = 'https://changed/source';
        boundary.picture.horizon.src = 0.93;
        boundary.picture.focus.x = 0.01;
        boundary.picture.credit.author = 'Changed author';
        expect(JSON.stringify(result.value)).toBe(retained);
        expect(boundary.preparedCount()).toBe(1);
        expect(candidate.looks.privateOtherPicture.look).toBe('engraving');
    });

    it('retains release-versus-custom haze treatment after removing the private look-memory key', async () => {
        const boundary = pictureBoundary();
        const presentation = { ...DEFAULT_HOME_ATMOSPHERE, source: 'picture' as const,
            picture: { ref: { kind: 'builtin' as const, id: boundary.picture.id }, layout: 'wallpaper' as const }, looks: {} };
        const release = await preparePublicProfileAtmosphere({ presentation, pictures: [boundary.picture],
            store: boundary.store, isCurrent: () => true });
        const customized = await preparePublicProfileAtmosphere({ presentation: { ...presentation,
            looks: { [boundary.picture.id]: { strength: 0.37 } } }, pictures: [boundary.picture],
            store: boundary.store, isCurrent: () => true });
        if (release.status !== 'ready' || release.value.source !== 'picture'
            || customized.status !== 'ready' || customized.value.source !== 'picture') throw new Error('Expected retained pictures');
        expect(release.value.picture.descriptor.adaptiveHaze).toBe(true);
        expect(customized.value.picture.descriptor.adaptiveHaze).toBe(false);
    });

    it('copies an admitted plugin release strength without imposing a separate public-copy range', async () => {
        const boundary = pictureBoundary();
        boundary.picture.look = { ...boundary.picture.look, strength: 2.4 };
        const presentation = { ...DEFAULT_HOME_ATMOSPHERE, source: 'picture' as const,
            picture: { ref: { kind: 'builtin' as const, id: boundary.picture.id }, layout: 'wallpaper' as const }, looks: {} };
        const result = await preparePublicProfileAtmosphere({ presentation, pictures: [boundary.picture],
            store: boundary.store, isCurrent: () => true });
        expect(result.status).toBe('ready');
        if (result.status !== 'ready' || result.value.source !== 'picture') throw new Error('Expected admitted release copy');
        expect(result.value.picture.descriptor.look.strength).toBe(2.4);
    });

    it('reports missing bytes and retired capture without silently choosing a different backdrop', async () => {
        const boundary = pictureBoundary();
        const presentation = { ...DEFAULT_HOME_ATMOSPHERE, source: 'picture' as const,
            picture: { ref: { kind: 'user' as const, localId: 'missing-device-only' }, layout: 'wallpaper' as const } };
        expect(await preparePublicProfileAtmosphere({ presentation, pictures: [boundary.picture], store: boundary.store,
            isCurrent: () => true })).toEqual({ status: 'unavailable', reason: 'picture_unavailable' });
        expect(await preparePublicProfileAtmosphere({ presentation, pictures: [boundary.picture], store: boundary.store,
            isCurrent: () => false })).toEqual({ status: 'unavailable', reason: 'account_retired' });
        expect(boundary.preparedCount()).toBe(0);
    });

    it('refuses a retired Account even if its platform encoder completes successfully', async () => {
        const boundary = pictureBoundary();
        let current = true;
        const presentation = { ...DEFAULT_HOME_ATMOSPHERE, source: 'picture' as const,
            picture: { ref: { kind: 'builtin' as const, id: boundary.picture.id }, layout: 'wallpaper' as const } };
        const store = { ...boundary.store, prepare: async () => {
            current = false;
            return new Blob(['valid prepared pixels'], { type: 'image/png' });
        } };
        expect(await preparePublicProfileAtmosphere({ presentation, pictures: [boundary.picture], store,
            isCurrent: () => current })).toEqual({ status: 'unavailable', reason: 'account_retired' });
    });

    it('retains an own-picture native PNG without exposing its device address or adding a release grade', async () => {
        const presentation = { ...DEFAULT_HOME_ATMOSPHERE, source: 'picture' as const,
            picture: { ref: { kind: 'user' as const, localId: 'private-file' }, layout: 'wallpaper' as const } };
        const store = { get: async () => ({ localId: 'private-file', kind: 'user' as const,
            createdAtMs: 1, size: 3, data: 'data:image/webp;base64,YWJj' }),
            prepare: async () => 'data:image/png;base64,YWJj' };
        const result = await preparePublicProfileAtmosphere({ presentation, pictures: [], store, isCurrent: () => true });
        expect(result.status).toBe('ready');
        if (result.status !== 'ready' || result.value.source !== 'picture') throw new Error('Expected own-picture copy');
        expect(result.value.picture).toMatchObject({ layout: 'wallpaper', content: { mimeType: 'image/png', base64: 'YWJj' },
            descriptor: { credit: null, adaptiveHaze: false, hour: 0, grades: { light: 0, dusk: 0, night: 0 }, focus: {}, horizon: {} } });
        expect(JSON.stringify(result.value)).not.toContain('private-file');
    });
});
