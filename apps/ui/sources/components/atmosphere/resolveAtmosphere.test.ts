import { describe, expect, it } from 'vitest';
import { DEFAULT_HOME_ATMOSPHERE, type HomeAtmosphere } from '@happier-dev/protocol/account/settings/accountSettings';
import { glassPresetMaterials, resolveGlassSurfaceMaterial } from '@/components/ui/glass/glassMaterial';
import { resolveAtmosphere } from './resolveAtmosphere';
import type { PictureRecord } from './pictureStore.types';

const picture = { id: 'p501', src: { full: 'https://pictures/full', thumb: 'https://pictures/thumb' } };
const home: HomeAtmosphere = { ...DEFAULT_HOME_ATMOSPHERE, source: 'picture',
    picture: { ref: { kind: 'builtin', id: picture.id }, layout: 'wallpaper' }, moments: { send: false } };
const pictureRecord: PictureRecord = { localId: 'builtin:p501', kind: 'builtin', createdAtMs: 1, size: 1, data: new Blob(['x']), source: picture.src };
const clearGlass = { glassSurfaceMaterials: glassPresetMaterials('clear'), glassBlurIntensity: 'strong' as const };
const input = { surface: 'home' as const, home, pictures: [picture], pictureRecord,
    glassEnvironment: {}, isPhone: false, reduceTransparency: false, reducedMotion: false };

describe('effective atmosphere owner', () => {
    it('decides each place from the effective Project selection, keeping planets off reading pages', () => {
        const everywhere = ['home', 'new-session', 'projects', 'sessions', 'pages'] as const;
        for (const layout of ['horizon', 'wallpaper'] as const) {
            for (const place of everywhere) {
                const surface = { place, project: { serverId: 'home', projectKey: 'project' } };
                const project = { ...home, picture: { ...home.picture, layout }, showOn: [...everywhere] };
                expect(resolveAtmosphere({ ...input, surface, projectOverride: project })).toMatchObject({ shown: true, source: 'picture',
                    atmosphereBehind: layout === 'wallpaper' ? 'wallpaper' : 'band' });
                expect(resolveAtmosphere({ ...input, surface, projectOverride: { ...project, showOn: [] } }))
                    .toMatchObject({ shown: false, source: 'none', pictureRecord: null, builtinPicture: null, atmosphereBehind: 'none' });
                const planet = resolveAtmosphere({ ...input, surface, projectOverride: { ...project, source: 'planet' } });
                expect(planet.shown).toBe(place !== 'sessions' && place !== 'pages');
                const inherited = resolveAtmosphere({ ...input, surface, home: { ...project, showOn: ['home'] }, projectOverride: 'home' });
                expect(inherited.shown).toBe(place === 'home');
            }
        }
    });
    it('resolves a profile candidate independently of Home and never substitutes missing reviewed pixels', () => {
        const { moments: _moments, showOn: _showOn, ...presentation } = home;
        const candidate = { ...presentation, planet: { ...presentation.planet, placement: 'rise' as const, style: 'rich' as const } };
        const surface = { publicProfile: candidate };
        const resolved = resolveAtmosphere({ ...input, home: { ...home, source: 'none' }, surface, isPhone: true });
        expect(resolved).toMatchObject({ source: 'picture', showOn: [], planet: { placement: 'corner', style: 'rich' }, pictureRecord });
        expect(resolved.moments).toEqual({});
        const missing = resolveAtmosphere({ ...input, surface,
            pictureRecord: undefined, shownPicture: resolved, readingPicture: true });
        expect(missing).toMatchObject({ source: 'none', fallbackReason: 'picture-unavailable', pictureRecord: null });
        expect(home).toMatchObject({ source: 'picture', moments: { send: false } });
    });
    it('inherits Home on new session and absent/home project overrides, with explicit project precedence', () => {
        expect(resolveAtmosphere({ ...input, surface: 'new-session' }).source).toBe('picture');
        const surface = { project: { serverId: 'home', projectKey: 'project' } };
        expect(resolveAtmosphere({ ...input, surface }).source).toBe('picture');
        expect(resolveAtmosphere({ ...input, surface, projectOverride: 'home' }).source).toBe('picture');
        const { moments: _moments, ...override } = { ...home, source: 'none' as const };
        expect(resolveAtmosphere({ ...input, surface, projectOverride: override })).toMatchObject({ source: 'none', moments: { send: false } });
        expect(resolveAtmosphere({ ...input, projectOverride: override }).source).toBe('picture');
    });
    it('falls back for unknown built-ins, uncached built-ins, missing user bytes and stale bytes from another selection', () => {
        expect(resolveAtmosphere({ ...input, pictures: [] })).toMatchObject({ source: 'planet', fallbackReason: 'unknown-picture' });
        expect(resolveAtmosphere({ ...input, pictureRecord: undefined })).toMatchObject({ source: 'planet', fallbackReason: 'picture-unavailable' });
        const own: HomeAtmosphere = { ...home, picture: { ...home.picture, ref: { kind: 'user', localId: 'my-picture' } } };
        expect(resolveAtmosphere({ ...input, home: own })).toMatchObject({ source: 'planet', planet: DEFAULT_HOME_ATMOSPHERE.planet });
        const ownRecord = { ...pictureRecord, localId: 'my-picture', kind: 'user' as const };
        expect(resolveAtmosphere({ ...input, home: own, pictureRecord: ownRecord }).source).toBe('picture');
    });
    it('maps Rise to Corner only on phone and carries motion preferences without changing authored strength', () => {
        const planet: HomeAtmosphere = { ...home, source: 'planet', planet: { ...home.planet, placement: 'rise' } };
        expect(resolveAtmosphere({ ...input, home: planet, isPhone: true }).planet.placement).toBe('corner');
        expect(resolveAtmosphere({ ...input, home: planet }).planet.placement).toBe('rise');
        expect(resolveAtmosphere({ ...input, home: { ...home, looks: { p501: { strength: 0.24 } } }, reducedMotion: true })).toMatchObject({
            reducedMotion: true, looks: { p501: { strength: 0.24 } },
        });
    });
    it.each([
        { name: 'Solid', glassSettings: { glassBlurEnabled: false }, glassEnvironment: {} },
        { name: 'Auto web', glassSettings: {}, glassEnvironment: {} },
        { name: 'inactive window', glassSettings: clearGlass, glassEnvironment: { windowActive: false } },
        { name: 'custom solid', glassSettings: { glassSurfaceMaterials: { ...glassPresetMaterials('clear'), content: { blur: 'strong' as const, opacity: 1 } } }, glassEnvironment: {} },
        { name: 'unavailable desktop glass', glassSettings: clearGlass, glassEnvironment: { desktopWindow: true, nativeWindowMaterialLive: false } },
        { name: 'Reduce Transparency', glassSettings: clearGlass, glassEnvironment: { reduceTransparency: true } },
    ])('preserves Wallpaper independently of resolved solid surfaces: $name', ({ glassSettings, glassEnvironment }) => {
        expect(resolveGlassSurfaceMaterial(glassSettings, 'content', glassEnvironment).material.opacity).toBe(1);
        expect(resolveAtmosphere({ ...input, glassEnvironment })).toMatchObject({ source: 'picture', picture: { layout: 'wallpaper' } });
        const horizon = { ...home, picture: { ...home.picture, layout: 'horizon' as const } };
        expect(resolveAtmosphere({ ...input, home: horizon, glassEnvironment }).picture.layout).toBe('horizon');
    });
    it('keeps Wallpaper on live desktop glass and honors the drawing transparency preference', () => {
        expect(resolveAtmosphere({ ...input, glassEnvironment: { desktopWindow: true, nativeWindowMaterialLive: true } }).picture.layout).toBe('wallpaper');
        expect(resolveAtmosphere({ ...input, reduceTransparency: true })).toMatchObject({ source: 'picture', picture: { layout: 'wallpaper' } });
    });
    it('carries the live environment transparency preference to drawing consumers', () => {
        expect(resolveAtmosphere({ ...input, glassEnvironment: { reduceTransparency: true } })).toMatchObject({
            reduceTransparency: true, picture: { layout: 'wallpaper' },
        });
    });
    it('keeps the picture on screen while the next picture is read, and only then falls back', () => {
        const shown = resolveAtmosphere(input);
        const other: HomeAtmosphere = { ...home, picture: { ...home.picture, ref: { kind: 'builtin', id: 'p347' } } };
        const reading = resolveAtmosphere({ ...input, home: other, pictures: [picture, { ...picture, id: 'p347' }], pictureRecord: undefined });
        expect(reading.source).toBe('planet');
        const pending = { ...input, home: other, pictures: [picture, { ...picture, id: 'p347' }], pictureRecord: undefined };
        expect(resolveAtmosphere({ ...pending, shownPicture: shown, readingPicture: true })).toMatchObject({ source: 'picture', pictureRecord: shown.pictureRecord });
        expect(resolveAtmosphere({ ...pending, shownPicture: shown, readingPicture: false })).toEqual(reading);
        expect(resolveAtmosphere({ ...pending, shownPicture: null, readingPicture: true })).toEqual(reading);
        const planet = resolveAtmosphere({ ...input, home: { ...home, source: 'planet' } });
        expect(resolveAtmosphere({ ...pending, shownPicture: planet, readingPicture: true })).toEqual(reading);
    });
    it('holds available pixels while applying current layout, accessibility, planet and moment decisions', () => {
        const shown = resolveAtmosphere(input);
        const other: HomeAtmosphere = { ...home, planet: { ...home.planet, placement: 'rise' },
            picture: { ...home.picture, ref: { kind: 'builtin', id: 'p347' } }, moments: { send: true }, showOn: ['home', 'new-session', 'projects', 'sessions'] };
        const fresh = { ...input, home: other, pictures: [picture, { ...picture, id: 'p347' }], pictureRecord: undefined,
            isPhone: true, reducedMotion: true, reduceTransparency: true };
        // The owner must resolve the current environment even while the displayed image is retained.
        const held = resolveAtmosphere({ ...fresh, shownPicture: shown, readingPicture: true });
        expect(held).toMatchObject({ source: 'picture', pictureRecord: shown.pictureRecord,
            picture: { layout: 'wallpaper' }, reducedMotion: true, reduceTransparency: true,
            moments: { send: true }, planet: { placement: 'corner' }, showOn: ['home', 'new-session', 'projects', 'sessions'] });
        const disabled = resolveAtmosphere({ ...fresh, home: { ...other, source: 'none' }, shownPicture: shown, readingPicture: true });
        expect(disabled).toMatchObject({ source: 'none', pictureRecord: null });
    });
    it('does not paint old cached pixels under updated picture metadata', () => {
        expect(resolveAtmosphere({ ...input, pictures: [{ ...picture, src: { ...picture.src, full: 'https://pictures/new' } }] }))
            .toMatchObject({ source: 'planet', fallbackReason: 'picture-unavailable', pictureRecord: null });
    });
});
