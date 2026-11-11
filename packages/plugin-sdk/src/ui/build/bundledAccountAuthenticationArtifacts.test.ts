import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { packageNameOfSpecifier, readWorkspacePackages, resolveWorkspaceSource } from '../../../../cli-common/sourceRuntimeEntries.mjs';
import { compileUniversalPluginUiCommonJs } from './universalCommonJsCompiler.js';

const repositoryRoot = resolve(import.meta.dirname, '../../../../..');
const packages = await readWorkspacePackages(repositoryRoot);
const entries: { name: string; root: string; entry: string }[] = [];
for (const [name, { root }] of packages) {
    if (!root.startsWith(join(repositoryRoot, 'packages/plugins/'))) continue;
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    const entry = manifest.exports?.['./happier-plugin-ui/connected-account-authentication']?.['happier-source'];
    if (typeof entry === 'string') entries.push({ name, root, entry });
}

describe('bundled account authentication UI portability', () => {
    it.each(entries)('$name compiles its real app entry without Node built-ins', async ({ root, entry }) => {
        const compiled = await compileUniversalPluginUiCommonJs({
            projectRoot: root,
            entryPath: join(root, entry),
            artifactId: 'connected-account-authentication',
            requestedExports: ['activate'],
            exportConditions: ['happier-source'],
            resolveSourceImport: specifier => packages.has(packageNameOfSpecifier(specifier))
                ? resolveWorkspaceSource(packages, specifier, { conditions: ['react-native', 'browser'] })
                : undefined,
        });
        expect(compiled.exports).toContain('activate');
    });
});
