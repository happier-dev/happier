import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compileUniversalPluginUiCommonJs } from '../../../plugin-sdk/src/ui/build/universalCommonJsCompiler.js';
import { packageNameOfSpecifier, readWorkspacePackages, resolveWorkspaceSource } from '../../../cli-common/sourceRuntimeEntries.mjs';

describe('Channels portable Account runtime', () => {
  it('compiles its actual entry through the canonical browser-safe artifact policy', async () => {
    const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const packages = await readWorkspacePackages(resolve(projectRoot, '../../..'));
    const artifact = await compileUniversalPluginUiCommonJs({
      projectRoot, entryPath: resolve(projectRoot, 'src/accountRuntime.ts'),
      artifactId: 'channels-account-runtime', requestedExports: ['activate'],
      exportConditions: ['happier-source'],
      resolveSourceImport: specifier => packages.has(packageNameOfSpecifier(specifier))
        ? resolveWorkspaceSource(packages, specifier, { conditions: ['react-native', 'browser'] }) : undefined,
    });
    expect(artifact.exports).toContain('activate');
  });
});
