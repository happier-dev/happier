import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { captureBuildInputFiles } from '../../../../../scripts/workspaces/buildInputConvergence.mjs';
import { readWorkspaceBuildInputs } from '../../utils/fs/workspaceBuildInputs.mjs';
import { mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function installSourcePreparationInputs(repoDir, component) {
  // Model the checkout inputs watched by the real preparation owner. Missing
  // fixture roots must not replace the source failure each test exercises.
  await mkdir(join(repoDir, 'scripts/workspaces'), { recursive: true });
  await mkdir(join(repoDir, 'apps/stack/scripts/build'), { recursive: true });
  if (!existsSync(join(repoDir, 'pnpm-lock.yaml'))) await writeFile(join(repoDir, 'pnpm-lock.yaml'), '');
  await writeFile(join(repoDir, 'pnpm-workspace.yaml'), 'packages: []\n');
  if (component !== 'daemon') return;
  const sdk = join(repoDir, 'packages/plugin-sdk/package.json');
  if (existsSync(sdk) && JSON.parse(await readFile(sdk, 'utf8')).happier?.publicSdkRelease) {
    const canonicalRoot = fileURLToPath(new URL('../../../../../packages/cli-common/', import.meta.url));
    const sharedPackages = await realpath(join(repoDir, 'packages')) === await realpath(dirname(canonicalRoot));
    // Native-admission fixtures borrow the canonical packages through a link.
    // Capturing onto that same authority would unlink its source files.
    if (!sharedPackages) {
      await captureBuildInputFiles({ sourceDir: canonicalRoot, captureDir: join(repoDir, 'packages/cli-common'),
        readPaths: () => readWorkspaceBuildInputs(canonicalRoot) });
      await mkdir(join(repoDir, 'packages/cli-common/node_modules'), { recursive: true });
      // This physical clone includes the real source registry, whose authored
      // tool dependencies must resolve just as they do in the owning checkout.
      const requireFromSource = createRequire(join(canonicalRoot, 'package.json'));
      for (const dependency of ['semver', 'tsx']) {
        await symlink(dirname(requireFromSource.resolve(`${dependency}/package.json`)),
          join(repoDir, 'packages/cli-common/node_modules', dependency), process.platform === 'win32' ? 'junction' : 'dir');
      }
    }
  }
  await mkdir(join(repoDir, 'apps/ui/scripts'), { recursive: true });
  // The fixture models the canonical publisher's process boundary. Its actual
  // authored-source drift semantics are covered by sourceGenerator.test.ts.
  const pluginChecker = join(repoDir, 'apps/cli/scripts/build-owned/generateBundledPluginEntries.ts');
  await mkdir(dirname(pluginChecker), { recursive: true });
  if (!existsSync(pluginChecker)) await writeFile(pluginChecker, `
    import {cpSync,existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
    import {join,dirname} from 'node:path';
    const root = process.argv[process.argv.indexOf('--daemon-output-root') + 1];
    const source = 'apps/cli/src/plugins/projection/registry/sources/generatedBundledPluginManifests.ts';
    const locator = join(root, source);
    mkdirSync(dirname(locator), {recursive:true});
    writeFileSync(locator, existsSync(source) ? readFileSync(source) : 'export const BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS = [];');
    if (existsSync('apps/cli/assets')) cpSync('apps/cli/assets', join(root,'apps/cli/assets'), {recursive:true});
    const failures = join(root,'apps/cli/.project/tmp/bundled-plugin-publication/failures.json');
    mkdirSync(dirname(failures), {recursive:true});
    writeFileSync(failures,'[]');
  `);
  for (const [path, contents] of [
    ['apps/ui/package.json', JSON.stringify({ name: '@happier-dev/ui' })],
    ['apps/ui/scripts/prepareSourcePluginUiArtifacts.mjs', ''],
    ['apps/ui/scripts/generateBundledPluginUiArtifacts.mjs', ''],
  ]) if (!existsSync(join(repoDir, path))) await writeFile(join(repoDir, path), contents);
}

/** Supply the real compiler and authored inputs consumed by a stub daemon's
 * immutable source producer. The producer, capture and runtime probe stay real. */
export async function installStubDaemonSourceBuildInputs(repoDir) {
  const cliDir = join(repoDir, 'apps/cli');
  const manifestPath = join(cliDir, 'package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  await writeFile(manifestPath, JSON.stringify({ ...manifest, type: 'module', exports: {} }));
  if (!existsSync(join(repoDir, 'package.json'))) {
    await writeFile(join(repoDir, 'package.json'), JSON.stringify({ private: true, workspaces: ['apps/*'] }));
  }
  await writeFile(join(cliDir, 'tsconfig.json'), '{}');
  await mkdir(join(cliDir, 'node_modules'), { recursive: true });
  await symlink(dirname(createRequire(import.meta.url).resolve('esbuild/package.json')),
    join(cliDir, 'node_modules/esbuild'), process.platform === 'win32' ? 'junction' : 'dir');
  await installSourcePreparationInputs(repoDir, 'daemon');
  await writeFile(join(repoDir, 'pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n');
}
