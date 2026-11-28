import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

type ManifestNode = { $: Record<string, string>; 'intent-filter'?: IntentFilter[] };
type IntentFilter = { $?: Record<string, string>; action?: { $: Record<string, string> }[]; category?: { $: Record<string, string> }[]; data?: { $: Record<string, string> }[] };
type Manifest = { manifest: { application: (ManifestNode & { activity: ManifestNode[]; 'activity-alias'?: ManifestNode[] })[] } };
type ModConfig = Record<string, unknown> & { android?: { package?: string; intentFilters?: unknown[] }; mods?: { android?: { manifest?: (config: unknown) => Promise<{ modResults: Manifest }> } } };

const withAppIcons = require('../../plugins/withAppIcons.js') as ((config: ModConfig) => ModConfig) & {
    resolveAlternateIcons: () => { name: string; ios: string; android: { foregroundImage: string; backgroundColor: string } }[];
};
const { XML } = require('@expo/config-plugins') as { XML: { parseXMLAsync: (contents: string) => Promise<Manifest> } };

// The https App Link filter `app.config.js` declares; Expo's own mod writes it onto MainActivity.
const APP_LINKS = [{
    action: 'VIEW',
    autoVerify: true,
    data: [{ scheme: 'https', host: 'app.happier.dev', pathPrefix: '/' }],
    category: ['BROWSABLE', 'DEFAULT'],
}];

async function applyManifestMod() {
    const config = withAppIcons({ name: 'Happier', slug: 'happier', android: { package: 'dev.happier.app', intentFilters: APP_LINKS } });
    const manifest = await XML.parseXMLAsync(readFileSync(new URL('./fixtures/expo54/AndroidManifest.xml', import.meta.url), 'utf8'));
    const mod = config.mods?.android?.manifest;
    if (!mod) throw new Error('no manifest mod registered');
    const result = await mod({
        ...config,
        modResults: manifest,
        modRequest: { platform: 'android', modName: 'manifest', projectRoot: '/project', platformProjectRoot: '/project/android', introspect: true },
        modRawConfig: config,
    });
    return { config, application: result.modResults.manifest.application[0] };
}

const names = (filters: IntentFilter[] | undefined, key: 'action' | 'category') =>
    (filters ?? []).map((filter) => (filter[key] ?? []).map((entry) => entry.$['android:name']));

describe('app icon config plugin', () => {
    it('registers the seven alternates from the one icon list', () => {
        const icons = withAppIcons.resolveAlternateIcons();
        expect(icons.map((icon) => icon.name)).toEqual(['Night', 'Paper', 'Gold', 'Aurora', 'Sunrise', 'Blueprint', 'Pixel']);
        for (const icon of icons) {
            expect(icon.ios).toMatch(/app-icons\/[a-z]+\/ios\.png$/);
            expect(icon.android.backgroundColor).toMatch(/^#[0-9A-F]{6}$/);
        }
    });

    it('moves the launcher entry to one alias per icon and keeps every deep link on MainActivity only', async () => {
        const { config, application } = await applyManifestMod();
        // The app's own intent filters are untouched for Expo's intent filter mod.
        expect(config.android?.intentFilters).toBe(APP_LINKS);

        const aliases = application['activity-alias'] ?? [];
        expect(aliases.map((alias) => alias.$['android:name'])).toEqual([
            '.MainActivityDefault', '.MainActivityNight', '.MainActivityPaper', '.MainActivityGold',
            '.MainActivityAurora', '.MainActivitySunrise', '.MainActivityBlueprint', '.MainActivityPixel',
        ]);
        expect(aliases.filter((alias) => alias.$['android:enabled'] === 'true').map((alias) => alias.$['android:name']))
            .toEqual(['.MainActivityDefault']);
        for (const alias of aliases) {
            expect(alias.$['android:targetActivity']).toBe('.MainActivity');
            // Launcher only: an https filter here would be a second App Link handler in the same app.
            expect(names(alias['intent-filter'], 'action')).toEqual([['android.intent.action.MAIN']]);
            expect(names(alias['intent-filter'], 'category')).toEqual([['android.intent.category.LAUNCHER']]);
        }

        const main = application.activity.find((activity) => activity.$['android:name'] === '.MainActivity');
        const mainFilters = main?.['intent-filter'] ?? [];
        expect(names(mainFilters, 'category').flat()).not.toContain('android.intent.category.LAUNCHER');
        const schemes = mainFilters.flatMap((filter) => (filter.data ?? []).map((data) => data.$['android:scheme']));
        expect(schemes).toEqual(['happier', 'https']);
        expect(mainFilters.find((filter) => filter.$?.['android:autoVerify'] === 'true')).toBeDefined();
    });
});
