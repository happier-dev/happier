import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

const UI_SOURCES_ROOT = join(__dirname, '..', '..', '..');

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

describe('saved secret architecture', () => {
    it('keeps SavedSecret imports out of the settings facade in production modules', () => {
        const violations = walkSourceFiles(UI_SOURCES_ROOT)
            .map((fullPath) => ({
                relativePath: relative(UI_SOURCES_ROOT, fullPath).replaceAll('\\', '/'),
                contents: readFileSync(fullPath, 'utf8'),
            }))
            .filter(({ relativePath, contents }) => {
                if (relativePath === 'sync/domains/settings/settings.ts') return false;
                return /import\s*(type\s*)?\{[^}]*\b(SavedSecret|SavedSecretSchema)\b[^}]*\}\s*from ['"]@\/sync\/domains\/settings\/settings['"]/.test(contents);
            })
            .map(({ relativePath }) => relativePath)
            .sort();

        expect(violations).toEqual([]);
    });
});
