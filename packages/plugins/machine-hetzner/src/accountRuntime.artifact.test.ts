import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import type { PluginAccountApi } from '@happier-dev/plugin-sdk';
import { packageNameOfSpecifier, readWorkspacePackages, resolveWorkspaceSource } from '../../../cli-common/sourceRuntimeEntries.mjs';
import { evaluatePortableCommonJs } from '../../../plugin-sdk/src/test-support/evaluatePortableCommonJs.js';
import { compileUniversalPluginUiCommonJs } from '../../../plugin-sdk/src/ui/build/universalCommonJsCompiler.js';

it('activates the compiled Hetzner Account runtime with host artifact metadata', async () => {
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
  const module = { exports: {} as Record<string, unknown> };
  evaluatePortableCommonJs(new TextDecoder().decode(artifact.bytes), module);
  const actions = new Set<string>();
  // Only the host registration boundary is replaced.
  const api = { actions: { register(id: string) { actions.add(id); } },
    connectedAccounts: { register() {} } } as unknown as PluginAccountApi;
  await Reflect.apply(module.exports.activateAccount as CallableFunction, undefined,
    [api, { artifactId: 'account-runtime', exportName: 'activateAccount' }]);
  expect(actions).toContain('check');
});
