import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

const UI_SOURCES_ROOT = join(__dirname, '..', '..');

const ALLOWED_DIRECT_ACCOUNT_WRITE_FILES = new Set([
    'app/(app)/_layout.tsx',
    'sync/store/settingsWriters.ts',
]);

const ALLOWED_DIRECT_LOCAL_WRITE_FILES = new Set([
    'sync/store/settingsWriters.ts',
    'sync/store/domains/settings.ts',
    'sync/domains/settings/localSettings.ts',
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

function collectViolations(pattern: RegExp, allowlist: Set<string>): string[] {
    return walkSourceFiles(UI_SOURCES_ROOT)
        .map((fullPath) => ({
            relativePath: relative(UI_SOURCES_ROOT, fullPath).replaceAll('\\', '/'),
            contents: readFileSync(fullPath, 'utf8'),
        }))
        .filter(({ relativePath, contents }) => pattern.test(contents) && !allowlist.has(relativePath))
        .map(({ relativePath }) => relativePath)
        .sort();
}

describe('settings writer architecture', () => {
    it('keeps direct sync.applySettings usage inside approved writer and system files only', () => {
        const violations = collectViolations(/sync\.applySettings\s*\(/g, ALLOWED_DIRECT_ACCOUNT_WRITE_FILES);
        expect(violations).toEqual([]);
    });

    it('keeps direct local settings store writes inside approved writer files only', () => {
        const violations = collectViolations(/applyLocalSettings\s*\([^)]*,\s*\{\s*source:/g, ALLOWED_DIRECT_LOCAL_WRITE_FILES);
        expect(violations).toEqual([]);
    });
});
