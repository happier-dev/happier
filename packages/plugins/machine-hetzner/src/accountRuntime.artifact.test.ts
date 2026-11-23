import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { packageNameOfSpecifier, readWorkspacePackages, resolveWorkspaceSource } from '../../../cli-common/sourceRuntimeEntries.mjs';
import { compileUniversalPluginUiCommonJs } from '../../../plugin-sdk/src/ui/build/universalCommonJsCompiler.js';

it('compiles the declared Hetzner Account runtime without Node built-ins', async () => {
  const projectRoot = fileURLToPath(new URL('..', import.meta.url));
  const packages = await readWorkspacePackages(resolve(projectRoot, '../../..'));
  const manifest = JSON.parse(await readFile(resolve(projectRoot, 'package.json'), 'utf8'));
  const entry = manifest.exports['./happier-plugin-ui/account-runtime']['happier-source'];
  const artifact = await compileUniversalPluginUiCommonJs({
    projectRoot, entryPath: resolve(projectRoot, entry), artifactId: 'account-runtime',
    requestedExports: ['activateAccount'], exportConditions: ['happier-source'],
    resolveSourceImport: specifier => packages.has(packageNameOfSpecifier(specifier))
      ? resolveWorkspaceSource(packages, specifier, { conditions: ['react-native', 'browser'] }) : undefined,
  });
  expect(artifact.exports).toContain('activateAccount');
});
