import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

const UI_SOURCES_ROOT = join(__dirname, '..', '..', '..');

const ALLOWED_COMPATIBILITY_ONLY_FILES = new Set([
    'sync/domains/settings/parse/accountSettingsCompatibilityMigrations.ts',
    'sync/domains/settings/registry/account/accountLegacySettingDefinitions.ts',
]);

const COMPATIBILITY_ONLY_SETTING_KEY_PATTERN =
    /['"`](compactSessionView|compactSessionViewMinimal|usePickerSearch|lastUsedPermissionMode|lastUsedModelMode|reviewPromptAnswered|reviewPromptLikedApp|inferenceOpenAIKey|viewInline|expandTodos)['"`]/;

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

describe('settings legacy architecture', () => {
    it('keeps compatibility-only legacy setting keys out of modern production modules', () => {
        const violations = walkSourceFiles(UI_SOURCES_ROOT)
            .map((fullPath) => ({
                relativePath: relative(UI_SOURCES_ROOT, fullPath).replaceAll('\\', '/'),
                contents: readFileSync(fullPath, 'utf8'),
            }))
            .filter(({ relativePath, contents }) => {
                if (ALLOWED_COMPATIBILITY_ONLY_FILES.has(relativePath)) return false;
                return COMPATIBILITY_ONLY_SETTING_KEY_PATTERN.test(contents);
            })
            .map(({ relativePath }) => relativePath)
            .sort();

        expect(violations).toEqual([]);
    });
});
