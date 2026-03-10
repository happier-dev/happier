import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

const UI_SOURCES_ROOT = join(__dirname, '..', '..');

const ALLOWED_ANALYTICS_PREFIX_FILES = new Set([
    'track/settingsAnalytics/buildAccountSettingsSnapshot.ts',
    'track/settingsAnalytics/buildFeatureAnalyticsSnapshot.ts',
    'track/settingsAnalytics/buildLocalSettingsSnapshot.ts',
    'track/settingsAnalytics/emitSettingChangedEvent.ts',
]);

function walkSourceFiles(root: string): string[] {
    const results: string[] = [];
    for (const entry of readdirSync(root)) {
        const fullPath = join(root, entry);
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
            if (entry === 'node_modules') continue;
            results.push(...walkSourceFiles(fullPath));
            continue;
        }
        if (!/\.(ts|tsx)$/.test(entry)) continue;
        if (/\.(test|spec)\.(ts|tsx)$/.test(entry)) continue;
        results.push(fullPath);
    }
    return results;
}

describe('settings analytics architecture', () => {
    it('keeps analytics property prefix ownership inside the approved analytics builders', () => {
        const violations = walkSourceFiles(UI_SOURCES_ROOT)
            .map((fullPath) => ({
                relativePath: relative(UI_SOURCES_ROOT, fullPath).replaceAll('\\', '/'),
                contents: readFileSync(fullPath, 'utf8'),
            }))
            .filter(({ relativePath, contents }) => {
                if (ALLOWED_ANALYTICS_PREFIX_FILES.has(relativePath)) return false;
                return /acct_setting__|local_setting__|derived__|local_derived__|feature_pref__|feature_effective__/.test(contents);
            })
            .map(({ relativePath }) => relativePath)
            .sort();

        expect(violations).toEqual([]);
    });
});
