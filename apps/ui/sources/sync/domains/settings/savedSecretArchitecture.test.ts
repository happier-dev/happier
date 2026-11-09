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

    it('routes production whole-array SavedSecret writers through the reference-aware owner', () => {
        const violations = walkSourceFiles(UI_SOURCES_ROOT)
            .map((fullPath) => ({
                relativePath: relative(UI_SOURCES_ROOT, fullPath).replaceAll('\\', '/'),
                contents: readFileSync(fullPath, 'utf8'),
            }))
            .filter(({ contents }) => /useSettingMutable\(\s*['"]secrets['"]\s*\)/u.test(contents))
            .map(({ relativePath }) => relativePath)
            .sort();

        expect(violations).toEqual([]);
    });

    it('has no Account Settings whole-array Saved Secret writer beside the catalog owner', () => {
        // Personal keys are created, renamed, rotated and deleted through the catalog's personal Actions only.
        const violations = walkSourceFiles(UI_SOURCES_ROOT)
            .map((fullPath) => ({
                relativePath: relative(UI_SOURCES_ROOT, fullPath).replaceAll('\\', '/'),
                contents: readFileSync(fullPath, 'utf8'),
            }))
            .filter(({ contents }) => contents.includes('useSavedSecretsMutable') || contents.includes('applySavedSecretReplacementIntent'))
            .map(({ relativePath }) => relativePath)
            .filter((relativePath) => relativePath !== 'sync/domains/settings/savedSecretArchitecture.test.ts');

        expect(violations).toEqual([]);
    });

    it('keeps SecretsList mutation behavior callback-driven', () => {
        const contents = readFileSync(join(UI_SOURCES_ROOT, 'components/secrets/SecretsList.tsx'), 'utf8');

        expect(contents).not.toContain('onChangeSecrets');
        expect(contents).not.toContain('function newId');
        expect(contents).not.toContain('Modal.prompt');
        expect(contents).not.toContain('Modal.confirm');
    });
});
