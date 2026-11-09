import { describe, expect, it } from 'vitest';
import { DEFAULT_HOME_ATMOSPHERE, HomeAtmosphereSchema, ProjectAtmosphereSchema } from './homeAtmosphere.js';
import { accountSettingsParse } from './accountSettings.js';

describe('Home atmosphere Fade contract', () => {
    it('round-trips a deliberate selection time while accepting pictures saved before it existed', () => {
        const selected = { ...DEFAULT_HOME_ATMOSPHERE, picture: { ...DEFAULT_HOME_ATMOSPHERE.picture, selectedAtMs: 1_800_000_000_000 } };
        expect(HomeAtmosphereSchema.safeParse(selected).success).toBe(true);
        expect(accountSettingsParse({ homeAtmosphere: selected }).homeAtmosphere).toEqual(selected);
        expect(accountSettingsParse({ homeAtmosphere: DEFAULT_HOME_ATMOSPHERE }).homeAtmosphere).toEqual(DEFAULT_HOME_ATMOSPHERE);
        expect(HomeAtmosphereSchema.safeParse({ ...selected, picture: { ...selected.picture, selectedAtMs: -1 } }).success).toBe(false);
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
