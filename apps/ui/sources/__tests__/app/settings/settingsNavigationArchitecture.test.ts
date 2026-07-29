import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

const UI_SOURCES_ROOT = join(__dirname, '..', '..', '..');
const APP_ROUTES_ROOT = join(UI_SOURCES_ROOT, 'app', '(app)');
const SETTINGS_ROUTES_ROOT = join(APP_ROUTES_ROOT, 'settings');
const SETTINGS_LAYOUT_PATH = join(SETTINGS_ROUTES_ROOT, '_layout.tsx');
const EXTERNAL_SESSIONS_SETTINGS_ROUTE_PATH = join(SETTINGS_ROUTES_ROOT, 'external-sessions.tsx');
const SETTINGS_THEME_PROFILES_ROUTE_ROOT = join(SETTINGS_ROUTES_ROOT, 'appearance', 'themes');
const CONNECTED_SERVICES_LEGACY_FILE_ROUTE_PATH = join(SETTINGS_ROUTES_ROOT, 'connected-services.tsx');
const CONNECTED_SERVICES_INDEX_ROUTE_PATH = join(SETTINGS_ROUTES_ROOT, 'connected-services', 'index.tsx');
const SETTINGS_NAVIGATION_REGISTRY_PATH = join(
    UI_SOURCES_ROOT,
    'components',
    'settings',
    'navigation',
    'settingsRouteRegistry.ts',
);
const MAIN_VIEW_PATH = join(
    UI_SOURCES_ROOT,
    'components',
    'navigation',
    'shell',
    'MainView.tsx',
);

const ALLOWED_SETTINGS_STACK_SCREEN_FILES = new Set([
    'app/(app)/settings/_layout.tsx',
    'components/settings/actions/ActionSettingsDetailView.tsx',
]);

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

function toSettingsRouteName(fullPath: string): string {
    const relativePath = relative(SETTINGS_ROUTES_ROOT, fullPath).replaceAll('\\', '/');
    const routePath = relativePath.replace(/\.tsx$/, '');
    return routePath;
}

describe('settings navigation architecture', () => {
    it('centralizes settings route chrome in the settings layout registry', () => {
        expect(existsSync(SETTINGS_LAYOUT_PATH)).toBe(true);
        expect(existsSync(SETTINGS_NAVIGATION_REGISTRY_PATH)).toBe(true);
        expect(existsSync(join(SETTINGS_ROUTES_ROOT, 'appearance.tsx'))).toBe(true);
        expect(existsSync(join(SETTINGS_ROUTES_ROOT, 'keyboard.tsx'))).toBe(true);
        expect(existsSync(EXTERNAL_SESSIONS_SETTINGS_ROUTE_PATH)).toBe(true);
        expect(existsSync(join(SETTINGS_ROUTES_ROOT, 'appearance', 'themes.tsx'))).toBe(true);
        expect(existsSync(join(SETTINGS_THEME_PROFILES_ROUTE_ROOT, '[profileId].tsx'))).toBe(true);
        expect(existsSync(join(SETTINGS_THEME_PROFILES_ROUTE_ROOT, 'import.tsx'))).toBe(true);
        expect(existsSync(join(SETTINGS_THEME_PROFILES_ROUTE_ROOT, 'export.tsx'))).toBe(true);

        const appLayout = readFileSync(join(APP_ROUTES_ROOT, '_layout.tsx'), 'utf8');
        expect(appLayout).not.toMatch(/name=["']settings\/[^"']+["']/);

        const settingsLayout = readFileSync(SETTINGS_LAYOUT_PATH, 'utf8');
        expect(settingsLayout).toContain('getSettingsStackScreenDefinitions');

        const registry = readFileSync(SETTINGS_NAVIGATION_REGISTRY_PATH, 'utf8');
        const routeNames = walkFiles(SETTINGS_ROUTES_ROOT)
            .filter((fullPath) => fullPath.endsWith('.tsx'))
            .filter((fullPath) => !fullPath.endsWith('.test.tsx'))
            .filter((fullPath) => !fullPath.endsWith('/_layout.tsx'))
            .map(toSettingsRouteName)
            .sort();

        expect(routeNames).toContain('appearance');
        expect(routeNames).toContain('keyboard');
        expect(routeNames).toContain('external-sessions');
        expect(routeNames).toContain('appearance/themes');
        expect(routeNames).toContain('appearance/themes/[profileId]');
        expect(routeNames).toContain('appearance/themes/import');
        expect(routeNames).toContain('appearance/themes/export');

        const missingRoutes = routeNames.filter((routeName) => !registry.includes(`name: '${routeName}'`));
        expect(missingRoutes).toEqual([]);

        expect(registry).toContain("name: 'appearance/themes'");
        expect(registry).toContain("name: 'appearance/themes/[profileId]'");
        expect(registry).toContain("name: 'appearance/themes/import'");
        expect(registry).toContain("name: 'appearance/themes/export'");
        expect(registry).toContain("name: 'keyboard'");
        expect(registry).toContain("name: 'external-sessions'");
    });

    it('keeps settings screens from declaring their own static Stack.Screen chrome', () => {
        const violations = [
            ...walkFiles(SETTINGS_ROUTES_ROOT),
            ...walkFiles(join(UI_SOURCES_ROOT, 'components', 'settings')),
        ]
            .filter((fullPath) => fullPath.endsWith('.tsx'))
            .map((fullPath) => ({
                relativePath: toRelativeUiPath(fullPath),
                contents: readFileSync(fullPath, 'utf8'),
            }))
            .filter(({ relativePath }) => !ALLOWED_SETTINGS_STACK_SCREEN_FILES.has(relativePath))
            .filter(({ contents }) => /<Stack\.Screen\b/.test(contents))
            .map(({ relativePath }) => relativePath)
            .sort();

        expect(violations).toEqual([]);
    });

    it('keeps settings home owned by the settings stack instead of the main tab view', () => {
        const mainView = readFileSync(MAIN_VIEW_PATH, 'utf8');

        expect(mainView).not.toContain('SettingsViewWrapper');
    });

    it('keeps connected-services settings index in the route folder index', () => {
        const registry = readFileSync(SETTINGS_NAVIGATION_REGISTRY_PATH, 'utf8');

        expect(existsSync(CONNECTED_SERVICES_LEGACY_FILE_ROUTE_PATH)).toBe(false);
        expect(existsSync(CONNECTED_SERVICES_INDEX_ROUTE_PATH)).toBe(true);
        expect(registry).toContain("name: 'connected-services/index'");
    });
});
