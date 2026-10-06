import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

import { createPackageLayoutSandbox, writeCliBundledHostPackage, writeWorkspacePackageFixture } from '../../__tests__/testkit/packageLayoutSandbox';
import { readGeneratorAuthoringSourceFingerprint } from './authoringInputs.mjs';

describe('generator authoring dependency preparation', () => {
  it('stages consumed authoring bytes without requiring an unrelated native addon, while refusing a missing consumed asset', () => {
    const { repoRoot, happyCliDir, cleanup } = createPackageLayoutSandbox('generator-authoring-closure-');
    const bundledWorkspaceNames = ['protocol', 'plugin-sdk', 'consumed', 'dynamic-entry', 'iroh-native', 'plugins-selected', 'plugins-other'];
    try {
      writeCliBundledHostPackage({ happyCliDir, bundledDependencies: bundledWorkspaceNames.map((name) => `@happier-dev/${name}`) });
      for (const name of [...bundledWorkspaceNames, 'transitive']) {
        writeWorkspacePackageFixture({
          repoRoot,
          workspacePath: name.startsWith('plugins-') ? `packages/plugins/${name.slice('plugins-'.length)}` : `packages/${name}`,
          packageName: `@happier-dev/${name}`,
          manifestOverrides: {
            files: name === 'iroh-native' ? ['dist', 'native'] : name === 'consumed' ? ['dist', 'required.txt'] : ['dist'],
            ...(name === 'plugins-selected' || name === 'plugins-other' ? { dependencies: { '@happier-dev/consumed': '0.0.0' } } : {}),
            ...(name === 'consumed' ? { dependencies: { '@happier-dev/transitive': '0.0.0' } } : {}),
          },
          files: { 'dist/index.js': `export const value = ${JSON.stringify(name)};\n`, ...(name === 'consumed' ? { 'required.txt': 'consumed asset' } : {}) },
        });
      }
      const authoringDir = join(happyCliDir, 'src/plugins/authoring');
      mkdirSync(authoringDir, { recursive: true });
      writeFileSync(join(authoringDir, 'sourceModule.ts'), "export { value } from '@happier-dev/consumed';\nexport const inspectDaemon = () => import('./daemonDiagnostic.ts');\n");
      const diagnosticPath = join(authoringDir, 'daemonDiagnostic.ts');
      writeFileSync(diagnosticPath, "export { value } from '@happier-dev/iroh-native';\n");
      // This separately loaded build-owned entrypoint is not reachable from
      // sourceModule and is not a plugin manifest dependency.
      writeFileSync(join(authoringDir, 'runtimeStagingSource.ts'), "export { value } from '@happier-dev/dynamic-entry';\n");
      const helperUrl = new URL('./authoringInputs.mjs', import.meta.url).href;
      const syncUrl = new URL('../../buildSharedDeps.mjs', import.meta.url).href;
      const run = () => execFileSync(process.execPath, ['--input-type=module', '-e', `
        import { resolveGeneratorAuthoringWorkspaceNames } from ${JSON.stringify(helperUrl)};
        import { syncBundledWorkspaceDist } from ${JSON.stringify(syncUrl)};
        const names = resolveGeneratorAuthoringWorkspaceNames({ repoRoot: ${JSON.stringify(repoRoot)}, bundledWorkspaceNames: ${JSON.stringify(bundledWorkspaceNames)}, canonicalWorkspacePackageNames: ['@happier-dev/protocol'] });
        syncBundledWorkspaceDist({ repoRoot: ${JSON.stringify(repoRoot)}, workspaceNames: names });
        const author = await import(${JSON.stringify(pathToFileURL(join(happyCliDir, 'node_modules/@happier-dev/consumed/dist/index.js')).href)});
        console.log(JSON.stringify({ names, value: author.value }));
      `], { cwd: repoRoot, env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      const result = JSON.parse(run()) as { names: string[]; value: string };
      expect(result.value).toBe('consumed');
      expect(result.names).toEqual(expect.arrayContaining(['consumed', 'transitive', 'dynamic-entry']));
      expect(result.names).not.toContain('iroh-native');
      expect(existsSync(join(repoRoot, 'packages/iroh-native/native'))).toBe(false);
      expect(readFileSync(join(happyCliDir, 'node_modules/@happier-dev/consumed/required.txt'), 'utf8')).toBe('consumed asset');

      const fingerprint = readGeneratorAuthoringSourceFingerprint(happyCliDir);
      writeFileSync(diagnosticPath, "export { value } from '@happier-dev/iroh-native';\nexport const changed = true;\n");
      expect(readGeneratorAuthoringSourceFingerprint(happyCliDir)).not.toBe(fingerprint);

      rmSync(join(repoRoot, 'packages/consumed/required.txt'));
      expect(run).toThrow(/declared file is missing: 'required\.txt'/u);
      // The failed consumed package publication preserves its prior complete tree.
      expect(readFileSync(join(happyCliDir, 'node_modules/@happier-dev/consumed/required.txt'), 'utf8')).toBe('consumed asset');
    } finally { cleanup(); }
  });
});
