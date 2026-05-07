import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

const UI_SOURCES_ROOT = join(__dirname, '..', '..', '..');
const APP_ROUTES_ROOT = join(UI_SOURCES_ROOT, 'app', '(app)');
const SETTINGS_ROUTES_ROOT = join(APP_ROUTES_ROOT, 'settings');
const SETTINGS_LAYOUT_PATH = join(SETTINGS_ROUTES_ROOT, '_layout.tsx');
const SETTINGS_NAVIGATION_REGISTRY_PATH = join(
    UI_SOURCES_ROOT,
    'components',
    'settings',
    'navigation',
    'settingsRouteRegistry.ts',
);
const MAIN_VIEW_PATH = join(UI_SOURCES_ROOT, 'components', 'navigation', 'shell', 'MainView.tsx');
const MOBILE_BOTTOM_CHROME_HOST_PATH = join(
    UI_SOURCES_ROOT,
    'components',
    'navigation',
    'mobile',
    'chrome',
    'MobileBottomChromeHost.tsx',
);

function walkFiles(root: string): string[] {
    return readdirSync(root)
        .flatMap((entry) => {
            const fullPath = join(root, entry);
            const stats = statSync(fullPath);
            if (stats.isDirectory()) return walkFiles(fullPath);
            return stats.isFile() ? [fullPath] : [];
        });
}

function toRelativeUiPath(fullPath: string): string {
    return relative(UI_SOURCES_ROOT, fullPath).replaceAll('\\', '/');
}

describe('settings navigation architecture', () => {
    it('centralizes settings route chrome in the settings layout registry', () => {
        expect(existsSync(SETTINGS_LAYOUT_PATH)).toBe(true);
        expect(existsSync(SETTINGS_NAVIGATION_REGISTRY_PATH)).toBe(true);

        const appLayout = readFileSync(join(APP_ROUTES_ROOT, '_layout.tsx'), 'utf8');
        expect(appLayout).not.toMatch(/name=["']settings\/[^"']+["']/);

        const settingsLayout = readFileSync(SETTINGS_LAYOUT_PATH, 'utf8');
        expect(settingsLayout).toContain('getSettingsStackScreenDefinitions');

        const registry = readFileSync(SETTINGS_NAVIGATION_REGISTRY_PATH, 'utf8');
        const routeNames = walkFiles(SETTINGS_ROUTES_ROOT)
            .filter((fullPath) => fullPath.endsWith('.tsx'))
            .filter((fullPath) => !fullPath.endsWith('/_layout.tsx'))
            .map((fullPath) => {
                const relativePath = relative(SETTINGS_ROUTES_ROOT, fullPath).replaceAll('\\', '/');
                return relativePath.replace(/\.tsx$/, '');
            })
            .sort();

        const missingRoutes = routeNames.filter((routeName) => !registry.includes(`name: '${routeName}'`));
        expect(missingRoutes).toEqual([]);
    });

    it('keeps settings screens from declaring their own static Stack.Screen chrome', () => {
        const violations = [
            ...walkFiles(SETTINGS_ROUTES_ROOT),
            ...walkFiles(join(UI_SOURCES_ROOT, 'components', 'settings')),
        ]
            .filter((fullPath) => fullPath.endsWith('.tsx'))
            .filter((fullPath) => !fullPath.endsWith('/_layout.tsx'))
            .map((fullPath) => ({
                relativePath: toRelativeUiPath(fullPath),
                contents: readFileSync(fullPath, 'utf8'),
            }))
            .filter(({ contents }) => /<Stack\.Screen\b/.test(contents))
            .map(({ relativePath }) => relativePath)
            .sort();

        expect(violations).toEqual([]);
    });

    it('keeps settings home owned by the settings stack instead of the root phone tab view', () => {
        const mainView = readFileSync(MAIN_VIEW_PATH, 'utf8');
        const mobileBottomChromeHost = readFileSync(MOBILE_BOTTOM_CHROME_HOST_PATH, 'utf8');

        expect(mainView).not.toContain('SettingsViewWrapper');
        expect(mainView).not.toContain('<TabBar');
        expect(mobileBottomChromeHost).toContain("settings: '/settings'");
    });
});
