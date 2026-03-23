import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

const UI_SOURCES_ROOT = join(__dirname, '..', '..', '..');
const SETTINGS_FACADE_IMPORT_RE = /import\s+(type\s+)?\{([^}]+)\}\s+from\s+['"]@\/sync\/domains\/settings\/settings['"]/g;
const ALLOWED_SETTINGS_FACADE_IMPORTS = new Set([
    'ACCOUNT_SETTING_ARTIFACTS',
    'KnownSettings',
    'Settings',
    'SettingsSchema',
    'SUPPORTED_SCHEMA_VERSION',
    'applySettings',
    'settingsDefaults',
    'settingsParse',
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

function extractImportedBindings(contents: string): string[] {
    const bindings: string[] = [];
    for (const match of contents.matchAll(SETTINGS_FACADE_IMPORT_RE)) {
        const namedImportBlock = match[2] ?? '';
        for (const rawPart of namedImportBlock.split(',')) {
            const trimmed = rawPart.trim().replace(/^type\s+/, '');
            if (!trimmed) continue;
            const [importedName] = trimmed.split(/\s+as\s+/i);
            if (importedName) bindings.push(importedName.trim());
        }
    }
    return bindings;
}

describe('settings facade architecture', () => {
    it('keeps settings facade imports limited to the canonical facade API surface', () => {
        const violations = walkSourceFiles(UI_SOURCES_ROOT)
            .map((fullPath) => ({
                relativePath: relative(UI_SOURCES_ROOT, fullPath).replaceAll('\\', '/'),
                importedBindings: extractImportedBindings(readFileSync(fullPath, 'utf8')),
            }))
            .flatMap(({ relativePath, importedBindings }) => importedBindings
                .filter((binding) => !ALLOWED_SETTINGS_FACADE_IMPORTS.has(binding))
                .map((binding) => `${relativePath}:${binding}`))
            .sort();

        expect(violations).toEqual([]);
    });
});
