import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { packageNameOfSpecifier, readWorkspacePackages, resolveWorkspaceSource } from '../../../../cli-common/sourceRuntimeEntries.mjs';
import { compileUniversalPluginUiCommonJs } from './universalCommonJsCompiler.js';

describe.each(['react-native', 'browser'])('%s Account artifact resolution', (condition) => {
    it.each(['github', 'gitlab', 'bitbucket'])('compiles the %s Account runtime through the portable artifact policy', async (provider) => {
        const repositoryRoot = resolve(import.meta.dirname, '../../../../..');
        const projectRoot = resolve(repositoryRoot, `packages/plugins/scm-${provider}`);
        const packages = await readWorkspacePackages(repositoryRoot);
        const artifact = await compileUniversalPluginUiCommonJs({
            projectRoot, artifactId: `${provider}-account-runtime`, entryPath: 'src/accountRuntime.ts',
            requestedExports: ['activate'], exportConditions: ['happier-source'],
            resolveSourceImport: specifier => packages.has(packageNameOfSpecifier(specifier))
                ? resolveWorkspaceSource(packages, specifier, { conditions: [condition] }) : undefined,
        });
        expect(artifact.exports).toContain('activate');
    // Use the existing bundledUiArtifactGraph compiler-suite budget.
    }, 120_000);
});
