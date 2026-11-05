import { describe, expect, it } from 'vitest';
import { PublicProfileAtmosphereV1Schema, PublicProfilePreparedAtmosphereV1Schema } from './publicProfileAtmosphere.js';
import { DEFAULT_HOME_ATMOSPHERE } from './settings/homeAtmosphere.js';

const picture = {
    layout: 'horizon', descriptor: {
        kind: 'photo', title: 'Owner selection', credit: null, adaptiveHaze: false,
        horizon: {}, focus: { x: 0.5, y: 0.5 }, hour: 12,
        grades: { light: 12, dusk: 12, night: 12 }, dark: 'night',
        look: { effect: 'fine', params: { cell: 3 }, strength: 0.4, dissolve: { style: 'rows', from: 0.58, to: 1 } },
    },
};

describe('reviewed atmosphere copy admission', () => {
    it('accepts only the active shared presentation, with no private context or live picture resolution', () => {
        expect(PublicProfileAtmosphereV1Schema.parse({ source: 'none' })).toEqual({ source: 'none' });
        expect(PublicProfileAtmosphereV1Schema.parse({ source: 'planet', planet: DEFAULT_HOME_ATMOSPHERE.planet }))
            .toEqual({ source: 'planet', planet: DEFAULT_HOME_ATMOSPHERE.planet });
        const applied = { source: 'picture', picture: { ...picture, ref: { kind: 'publication', id: 'asset-a' } } };
        expect(PublicProfileAtmosphereV1Schema.safeParse(applied).success).toBe(true);
        for (const ref of [{ kind: 'user', localId: '/private/file' }, { kind: 'builtin', id: 'plugin/photo' },
            { kind: 'publication', id: 'asset-a', path: '/private/file' }]) {
            expect(PublicProfileAtmosphereV1Schema.safeParse({ ...applied, picture: { ...applied.picture, ref } }).success).toBe(false);
        }
        expect(PublicProfileAtmosphereV1Schema.safeParse({ ...applied, moments: {}, showOn: ['home', 'new-session', 'projects', 'sessions'] }).success).toBe(false);
        expect(PublicProfileAtmosphereV1Schema.safeParse({ ...applied, picture: { ...applied.picture,
            descriptor: { ...picture.descriptor, src: { full: 'https://source/picture', thumb: 'https://source/thumb' } } } }).success).toBe(false);
        for (const url of ['not-a-url', 'javascript:alert(1)', 'http://credit.example/']) {
            expect(PublicProfileAtmosphereV1Schema.safeParse({ ...applied, picture: { ...applied.picture,
                descriptor: { ...picture.descriptor, credit: { author: 'Author', source: 'Source', licence: 'CC0', url } } } }).success).toBe(false);
        }
    });

    it('requires frozen look defaults and canonical bytes, rejecting sparse or unreviewed content', () => {
        const candidate = { source: 'picture', picture: { ...picture, content: { mimeType: 'image/png', base64: 'AA==' } } };
        expect(PublicProfilePreparedAtmosphereV1Schema.safeParse(candidate).success).toBe(true);
        expect(PublicProfilePreparedAtmosphereV1Schema.safeParse({ ...candidate, picture: { ...candidate.picture,
            descriptor: { ...picture.descriptor, look: { ...picture.descriptor.look, strength: 2.4 } } } }).success).toBe(true);
        expect(PublicProfilePreparedAtmosphereV1Schema.safeParse({ ...candidate,
            picture: { ...candidate.picture, content: { mimeType: 'image/webp', base64: 'AA==' } } }).success).toBe(true);
        for (const content of [{ mimeType: 'image/png', base64: 'A===' }, { mimeType: 'image/jpeg', base64: 'AA==' },
            { mimeType: 'image/png', base64: 'AA==', url: 'https://source/picture' }]) {
            expect(PublicProfilePreparedAtmosphereV1Schema.safeParse({ ...candidate, picture: { ...candidate.picture, content } }).success).toBe(false);
        }
        expect(PublicProfilePreparedAtmosphereV1Schema.safeParse({ ...candidate, picture: { ...candidate.picture,
            descriptor: { ...picture.descriptor, look: { effect: 'fine' } } } }).success).toBe(false);
        expect(PublicProfilePreparedAtmosphereV1Schema.safeParse({ ...candidate, picture: { ...candidate.picture,
            descriptor: { ...picture.descriptor, adaptiveHaze: undefined } } }).success).toBe(false);
    });
});
