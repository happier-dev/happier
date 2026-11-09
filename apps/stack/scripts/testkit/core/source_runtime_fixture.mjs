import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { captureBuildInputFiles } from '../../../../../scripts/workspaces/buildInputConvergence.mjs';
import { readWorkspaceBuildInputs } from '../../utils/fs/workspaceBuildInputs.mjs';
import { chmod, mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildNativeAdmissionFixtureEnv, installNativeAdmissionFixture } from './native_admission_fixture.mjs';

/** Compiler/cache fixtures exercise the producer. QA fixtures name a separate
 * authority explicitly and retain the real consumer request path. */
export function sourceProducerFixtureOptions(options) {
  if (!options.stackBaseDir) return options;
  const env = options.env ?? process.env;
  return { ...options, env: { ...env, HAPPIER_STACK_RUNTIME_BUILD_AUTHORITY_STACK:
    env.HAPPIER_STACK_RUNTIME_BUILD_AUTHORITY_STACK || basename(options.stackBaseDir) } };
}

export async function installSourceAdmissionFixture(root) {
  const native = await installNativeAdmissionFixture({root});
  const runtimeSource = new URL('../../build/build_source_runtime.mjs', import.meta.url);
  const adapterSource = new URL('../utils/proc/runSourceBuildCommand.mjs', runtimeSource);
  const adapter = join(root,'native-owner/apps/stack/scripts/utils/proc/runSourceBuildCommand.mjs');
  await writeFile(adapter,(await readFile(adapterSource,'utf8')).replace(
    "from '../dev/devReloadCoordinator.mjs'",`from ${JSON.stringify(new URL('../dev/devReloadCoordinator.mjs',adapterSource).href)}`));
  const runtimePath = join(root,'native-owner/apps/stack/scripts/build/build_source_runtime.mjs');
  await mkdir(dirname(runtimePath),{recursive:true});
  // Install the genuine owner beside the fixture's genuine native launcher.
  // Remap imports only, preserving real selection/build/retention decisions.
  await writeFile(runtimePath,(await readFile(runtimeSource,'utf8')).replace(/^((?:import|export) [^\n]*from )'(\.[^']+)'/gm,(match,prefix,path)=> {
    if(path==='../utils/proc/runSourceBuildCommand.mjs' || path==='../utils/proc/workspace_build_admission.mjs') return match;
    return `${prefix}${JSON.stringify(new URL(path,runtimeSource).href)}`;
  }).replace(/import\('(\.[^']+)'\)/g, (_match, path) =>
    `import(${JSON.stringify(new URL(path, runtimeSource).href)})`)
    .replace(/new URL\('(\.[^']+)', import.meta.url\)/g, (match, path) => path === '../../bin/hstack-exec'
      ? match : `new URL(${JSON.stringify(new URL(path, runtimeSource).href)})`));
  const {buildSourceRuntimeBundle:buildOwner} = await import(pathToFileURL(runtimePath));
  const build = options => buildOwner(sourceProducerFixtureOptions(options));
  const reloadSource = new URL('../runtime/launch/prepareSourceRuntimeReload.mjs', runtimeSource);
  const reloadPath = join(root, 'native-owner/apps/stack/scripts/runtime/launch/prepareSourceRuntimeReload.mjs');
  await mkdir(dirname(reloadPath), { recursive: true });
  await writeFile(reloadPath, (await readFile(reloadSource, 'utf8')).replace(
    /^((?:import|export) [^\n]*from )'(\.[^']+)'/gm, (_match, prefix, path) =>
      `${prefix}${JSON.stringify(path === '../../build/build_source_runtime.mjs'
        ? pathToFileURL(runtimePath).href : new URL(path, reloadSource).href)}`));
  const prepareReload = async options => {
    const { prepareSourceRuntimeReload } = await import(pathToFileURL(reloadPath));
    return await prepareSourceRuntimeReload(options);
  };
  const {runSourceBuildCommand:runSourceCommand} = await import(pathToFileURL(adapter));
  await mkdir(join(root,'bin'));
  await writeFile(join(root,'bin/awk'),`#!/bin/sh\ncase "$*" in\n  */proc/meminfo*) printf '16777216 16777216\\n' ;;\n  */proc/loadavg*|*/proc/pressure/*) printf '0\\n' ;;\n  *) exec /usr/bin/awk "$@" ;;\nesac\n`);
  await chmod(join(root,'bin/awk'),0o755);
  const env = {...buildNativeAdmissionFixtureEnv(),PATH:`${join(root,'bin')}:/usr/bin:/bin`,HAPPIER_DEV_TARGET_EXECUTION:'1'};
  return {...native,runtimePath,build,prepareReload,runSourceCommand,env};
}


export async function installSourcePreparationInputs(repoDir, component) {
  // Model the checkout inputs watched by the real preparation owner. Missing
  // fixture roots must not replace the source failure each test exercises.
  await mkdir(join(repoDir, 'scripts/workspaces'), { recursive: true });
  await mkdir(join(repoDir, 'apps/stack/scripts/build'), { recursive: true });
  if (!existsSync(join(repoDir, 'package.json'))) await writeFile(join(repoDir, 'package.json'),
    JSON.stringify({ private: true, workspaces: ['apps/*'] }));
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
