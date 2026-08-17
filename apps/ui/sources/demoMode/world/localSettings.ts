import type { LocalSettings } from '@/sync/domains/settings/localSettings';
import { createThemeProfileDraft } from '@/theme/profiles/createThemeProfileDraft';
import { getBuiltInThemeProfileDefinition } from '@/theme/profiles/builtInThemeProfiles';
import type { BuiltInThemeProfilePresetId, ThemeProfileV1 } from '@/theme/profiles/themeProfileTypes';

import { DEMO_NOW_MS } from './constants';

export type DemoWorldLocalSettings = Pick<LocalSettings, 'themeProfiles'>;

type DemoThemeProfileSeed = Readonly<{
    id: string;
    name: string;
    presetId: BuiltInThemeProfilePresetId;
    createdAgoMs: number;
}>;

/**
 * A13 "Configure (almost) everything."
 *
 * The built-in presets live behind a collapsed dropdown, so an unseeded world
 * renders the customization stage as a single trigger row over empty space. The
 * demo user has saved a few themes of their own; each one is a real clone of a
 * built-in preset, so the rows carry genuine token overrides rather than names
 * with nothing behind them.
 */
const DEMO_THEME_PROFILE_SEEDS: readonly DemoThemeProfileSeed[] = [
    { id: 'theme_demo_late_night', name: 'Late night', presetId: 'tokyoNight', createdAgoMs: 32 * 86_400_000 },
    { id: 'theme_demo_review_desk', name: 'Review desk', presetId: 'sunsetDark', createdAgoMs: 12 * 86_400_000 },
    { id: 'theme_demo_daylight', name: 'Daylight', presetId: 'premiumLight', createdAgoMs: 5 * 86_400_000 },
    { id: 'theme_demo_deep_focus', name: 'Deep focus', presetId: 'pitchDark', createdAgoMs: 86_400_000 },
];

function buildDemoThemeProfiles(): ThemeProfileV1[] {
    return DEMO_THEME_PROFILE_SEEDS.flatMap((seed) => {
        const sourceProfile = getBuiltInThemeProfileDefinition(seed.presetId)?.profile;
        if (!sourceProfile) return [];
        return [createThemeProfileDraft({
            id: seed.id,
            name: seed.name,
            now: new Date(DEMO_NOW_MS - seed.createdAgoMs).toISOString(),
            sourceProfile,
        })];
    });
}

export function buildDemoLocalSettings(): DemoWorldLocalSettings {
    return {
        themeProfiles: {
            // The demo never activates one of its own themes: the real runtime theme
            // is resolved from durable device state at boot, so a seeded selection
            // would claim an active profile the running app is not actually using.
            activeProfileIds: { light: null, dark: null },
            profiles: buildDemoThemeProfiles(),
        },
    };
}
