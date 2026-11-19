import { describe, expect, it } from 'vitest';
import { DEFAULT_HOME_ATMOSPHERE, HomeAtmosphereSchema, ProjectAtmosphereSchema } from './homeAtmosphere.js';
import { accountSettingsParse } from './accountSettings.js';

describe('Home atmosphere Fade contract', () => {
    it('drops the legacy selection time on stored reads while retaining the chosen picture and layout', () => {
        const value = { ...DEFAULT_HOME_ATMOSPHERE, source: 'picture', picture: { ref: { kind: 'builtin', id: 'calm-sea' }, layout: 'wallpaper' } };
        const legacy = { ...value, picture: { ...value.picture, selectedAtMs: 1_800_000_000_000 } };
        expect(accountSettingsParse({ homeAtmosphere: legacy }).homeAtmosphere).toEqual(value);
        expect(HomeAtmosphereSchema.safeParse(legacy).success).toBe(false);
    });
    it('admits the dissolve style and rejects numeric fade on Home and Project writes', () => {
        const value = { ...DEFAULT_HOME_ATMOSPHERE, looks: { sky: { dissolve: 'rows' } } };
        expect(HomeAtmosphereSchema.safeParse(value).success).toBe(true);
        const { moments: _moments, ...project } = value;
        expect(ProjectAtmosphereSchema.safeParse(project).success).toBe(true);
        const numeric = { sky: { fade: 0.55 } };
        expect(HomeAtmosphereSchema.safeParse({ ...value, looks: numeric }).success).toBe(false);
        expect(ProjectAtmosphereSchema.safeParse({ ...project, looks: numeric }).success).toBe(false);
    });
    it('drops the undeployed numeric field on stored reads while keeping authored dissolve and other choices', () => {
        const value = { ...DEFAULT_HOME_ATMOSPHERE, looks: { sky: { dissolve: 'rows', strength: 0.7 } } };
        expect(accountSettingsParse({ homeAtmosphere: { ...value, looks: { sky: { ...value.looks.sky, fade: 0.55 } } } }).homeAtmosphere).toEqual(value);
    });
});

describe('stored Home moments', () => {
    it('drops the retired Welcome moment from stored accounts while retaining the other moment switches', () => {
        const homeAtmosphere = { ...DEFAULT_HOME_ATMOSPHERE, moments: { welcome: false, loading: false, qr: true } };
        expect(accountSettingsParse({ homeAtmosphere }).homeAtmosphere.moments).toEqual({ loading: false, qr: true });
        expect(HomeAtmosphereSchema.safeParse(homeAtmosphere).success).toBe(false);
    });
});

describe('stored planet preferences', () => {
    it('reads the legacy planet at Quiet and retains the authored picture, looks, places and moments', () => {
        const legacy = {
            source: 'picture',
            planet: { placement: 'side', style: 'rich', digits: false },
            picture: { ref: { kind: 'user', localId: 'favourite-picture' }, layout: 'wallpaper' },
            looks: { 'favourite-picture': { look: 'haze' }, 'white-rocks-open-sea': { strength: 0.4 } },
            showOn: ['home', 'sessions'],
            moments: { sessionFinished: false },
        };
        expect(accountSettingsParse({ homeAtmosphere: legacy }).homeAtmosphere).toEqual({
            ...legacy,
            planet: { intensity: 'quiet', digits: false },
        });
        expect(HomeAtmosphereSchema.safeParse(legacy).success).toBe(false);
    });
});
