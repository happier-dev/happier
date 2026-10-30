import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { isBuiltin } from 'node:module';
import cliDistBuildManifest from '../../../../../packages/cli-common/cliDistBuildManifest.cjs';
import { readWorkspacePackages, workspaceSourcePackageClosure } from '../../../../../packages/cli-common/sourceRuntimeEntries.mjs';
import { readBundledPluginPackageNames } from '../../../../cli/scripts/build-owned/bundledPluginMembership.ts';
import { resolveBundledPluginUiProjectionInputPaths } from '../../../../cli/scripts/build-owned/bundledPlugins/projectionPaths.mjs';

const SOURCE_ROOTS = ['src', 'sources', 'scripts'];
const TEST_DIRECTORY_NAMES = new Set(['__fixtures__', '__snapshots__', '__tests__', 'fixtures', 'test', 'testkit', 'tests', 'test-support']);

/** A native source-only test needs neither installed dependencies nor emitted
 * workspace outputs. Unknown imports and subprocess/module loaders retain the
 * normal component preparation; they can consume inputs outside this graph. */
export function readNativeTestSourceInputs(repoDir, entryPath) {
  let root;
  try { root = realpathSync(repoDir); }
  catch { return null; }
  const pending = [resolve(root, entryPath)];
  const files = new Set();
  while (pending.length) {
    let path = pending.pop();
    try {
      if (lstatSync(path).isSymbolicLink()) return null;
      path = realpathSync(path);
    } catch { return null; }
    if (files.has(path)) continue;
    const local = relative(root, path);
    if (local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)
      || !/\.mjs$/.test(path)) return null;
    let source;
    try { source = readFileSync(path, 'utf8'); }
    catch { return null; }
    files.add(path);
    // Nonliteral loads cannot prove a complete closure. Conservative matches
    // in fixture text only retain preparation; they never suppress it.
    if (/\b(?:import|require)\s*\(\s*[^'"\s]/.test(source)
      || /\b(?:eval|Function)\s*\(/.test(source)) return null;
    for (const specifier of cliDistBuildManifest.extractModuleSpecifiers(source)) {
      if (isBuiltin(specifier)) {
        if (['child_process', 'module', 'vm', 'worker_threads', 'cluster'].includes(specifier.replace(/^node:/, ''))) return null;
      } else if (specifier.startsWith('./') || specifier.startsWith('../')) {
        pending.push(resolve(dirname(path), specifier));
      } else return null;
    }
  }
  return [...files].map(path => relative(root, path).split(sep).join('/')).sort();
}

// Retained source daemon emission and its preparation watcher consume the same
// compiler/inventory inputs; neither borrows the app's unrelated source tree.
export function resolveSourcePluginUiBuildInputPaths(repoDir) {
  const root = join(repoDir, 'apps/ui');
  return readWorkspaceBuildInputs(root, { sourceRoots: ['scripts'] }).map(path => join(root, path));
}

/** Plugin UI can bundle declared build dependencies as well as runtime ones.
 * Host applications are not plugin source inputs; their test dependencies must
 * not make a CLI-only edit rebuild every UI artifact. */
export async function readSourcePluginUiBuildInputs({ repoDir, pluginDirectory, compiler = false, packages, includeDirectories = false }) {
  packages ??= await readWorkspacePackages(repoDir);
  const roots = compiler ? ['@happier-dev/plugin-sdk'] : [`@happier-dev/plugins-${pluginDirectory}`];
  // Remove host nodes before traversal: a CLI test dependency must not visit
  // the CLI's bundled-plugin census and pull every sibling into this input set.
  const sourcePackages = new Map([...packages].filter(([, { root }]) => relative(repoDir, root).split(sep)[0] !== 'apps'));
  const closure = workspaceSourcePackageClosure(sourcePackages, roots);
  const files = new Set();
  for (const name of closure) {
    const { root } = packages.get(name);
    for (const path of readWorkspaceBuildInputs(root, { excludeGeneratedPluginArtifacts: true, includeDirectories,
      includeShippedFiles: !compiler && name === roots[0] })) {
      files.add(relative(repoDir, join(root, path)).split(sep).join('/'));
    }
  }
  for (const path of ['pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
    if (existsSync(join(repoDir, path))) files.add(path);
  }
  if (compiler) for (const path of [
    'apps/ui/scripts/prepareSourcePluginUiArtifacts.mjs',
    'apps/ui/scripts/generateBundledPluginUiArtifacts.mjs',
    'apps/cli/scripts/build-owned/bundledPlugins/uiDeclarations.mjs',
    'apps/stack/scripts/build/build_source_web_ui.mjs',
    'apps/stack/scripts/utils/fs/workspaceBuildInputs.mjs',
    'packages/cli-common/registerSourceRuntime.mjs',
    'packages/cli-common/sourceRuntimeEntries.mjs',
    'scripts/workspaces/buildInputConvergence.mjs',
  ]) files.add(path);
  return [...files].sort();
}

/** Finite source consumers and their repair watchers share membership. Code
 * consumption remains the compiler's authority; this owner includes resolver
 * configuration and copied/native/Plugin UI resources that it cannot observe. */
export async function readSourceComponentBuildInputs({ repoDir, component }) {
  const packages = await readWorkspacePackages(repoDir);
  const project = component === 'expo' ? 'ui' : component === 'daemon' ? 'cli' : 'server';
  const roots = [...packages].filter(([, { root }]) =>
    [`apps/${project}`, 'apps/stack', 'packages/cli-common', ...(component === 'expo' ? ['packages/plugin-sdk'] : [])]
      .includes(relative(repoDir, root).replaceAll('\\', '/'))).map(([name]) => name);
  // Generated CLI entries use discovered shippable membership, which can be
  // newer than package.json's projected dependency list.
  if (component === 'daemon' || component === 'expo') roots.push(...readBundledPluginPackageNames(repoDir, { requireManifestSource: false }));
  if (component === 'expo') {
    const cli = [...packages.values()].find(({ root }) => relative(repoDir, root).replaceAll('\\', '/') === 'apps/cli');
    roots.push(...(cli?.manifest.bundledDependencies ?? []));
  }
  const closure = workspaceSourcePackageClosure(packages, roots);
  const owners = [...packages].filter(([name, { root }]) => {
    const path = relative(repoDir, root).replaceAll('\\', '/');
    return closure.has(name)
      || (component === 'daemon' && path === 'apps/ui');
  }).map(([, owner]) => owner);
  const files = new Set();
  const watchPaths = new Set();
  for (const root of [repoDir, ...owners.map(({ root }) => root)]) {
    const path = relative(repoDir, root).replaceAll('\\', '/');
    const options = {
      // Source author emission uses the workspace copier's declared package
      // files contract, including documentation/resources of SDK dependencies.
      // Capture those authored bytes; readWorkspaceBuildInputs excludes dist.
      includeShippedFiles: path.startsWith('packages/'),
      excludeGeneratedPluginArtifacts: path.startsWith('packages/plugins/'),
      sourceRoots: component === 'daemon' && path === 'apps/ui' ? ['scripts'] : SOURCE_ROOTS,
      additionalInputPaths: root === repoDir ? ['apps/cli/scripts/buildPublication.mjs',
        'apps/cli/scripts/build-owned/bundledPluginMembership.ts',
        ...(component === 'expo' ? ['patches'] : []),
        // This collector imports the generator's path owner even when the
        // component closure does not otherwise include CLI tooling.
        'apps/cli/scripts/build-owned/bundledPlugins/projectionPaths.mjs',
        ...(component === 'expo' || component === 'daemon'
          ? ['apps/cli/scripts/build-owned/bundledPlugins/uiDeclarations.mjs'] : [])]
        // Expo preparation imports the authored tools tree, including nested
        // postinstall modules. Capture and invalidate it with the same owner.
        : path === 'apps/ui' && component === 'expo' ? ['index.ts', 'public', 'plugins', 'modules', 'tools', 'sources/dev/testkit']
          : path === 'apps/ui' && component === 'daemon'
            ? resolveBundledPluginUiProjectionInputPaths(repoDir).map(input => relative(root, input))
          : path === 'apps/cli' ? ['native/processcustody', 'assets']
            : path === 'apps/server' ? ['prisma']
              : component === 'daemon' && path.startsWith('packages/plugins/') ? ['managed-runtime'] : [],
    };
    const inputs = readWorkspaceBuildInputs(root, options);
    for (const input of inputs) {
      // Retained checkout databases are data, never compiler inputs.
      if (path === 'apps/server' && input.startsWith('prisma/')
        && !/\.(?:prisma|sql)$/.test(input) && !input.endsWith('/migration_lock.toml')) continue;
      files.add(relative(repoDir, resolve(root, input)).split(sep).join('/'));
    }
    for (const input of resolveWorkspaceBuildInputWatchPaths(root, { ...options, inputPaths: inputs })) watchPaths.add(input);
  }
  for (const { root } of packages.values()) {
    const path = join(root, 'package.json');
    files.add(relative(repoDir, path).split(sep).join('/'));
    watchPaths.add(path);
  }
  if (component === 'daemon') for (const path of resolveSourcePluginUiBuildInputPaths(repoDir)) {
    if (existsSync(path)) files.add(relative(repoDir, path).split(sep).join('/'));
    watchPaths.add(path);
  }
  if (component === 'server' && existsSync(join(repoDir, 'apps/server/sources/app/account/profile/render/publicProfileFonts.ts'))) {
    const { readPublicProfileAssetFiles } = await import('../../../../server/scripts/buildPublicProfileRenderer.mjs');
    for (const { sourcePath } of await readPublicProfileAssetFiles({ projectDir: join(repoDir, 'apps/server') })) {
      files.add(relative(repoDir, sourcePath).split(sep).join('/'));
      watchPaths.add(sourcePath);
      watchPaths.add(dirname(sourcePath));
    }
  }
  for (const path of ['pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
    if (existsSync(join(repoDir, path))) files.add(path);
    watchPaths.add(join(repoDir, path));
  }
  return { files: [...files].sort(), workspaceDirs: owners.map(({ root }) => relative(repoDir, root)),
    watchPaths: [...watchPaths] };
}

export function isWorkspaceBuildSourcePath(path) {
  return SOURCE_ROOTS.includes(String(path).replaceAll('\\', '/').split('/')[0]);
}

// Package admission, recursive watch traversal and runtime capture share this
// source-membership rule. Explicit shipped resources are admitted separately.
export function isWorkspaceBuildInputIgnoredPath(path) {
  const parts = String(path).replaceAll('\\', '/').split('/').filter(Boolean);
  const name = parts.at(-1) ?? '';
  return parts.some(part => TEST_DIRECTORY_NAMES.has(part))
    || /\.(?:test|spec|testkit|test-support)\.[^.]+$/.test(name)
    || /^vitestSetup\.[cm]?[jt]sx?$/.test(name)
    || name.startsWith('vitest.')
    || name.startsWith('test-setup.');
}

export function createWorkspaceBuildInputIgnorePath(packageDirs, { repoDir, hostDir, ...options } = {}) {
  // Inventory is the authority for exceptions: shipped/native data and relative
  // extended configs may legitimately have test-like names.
  const directories = Array.isArray(packageDirs) ? packageDirs : [packageDirs];
  const inputPath = path => repoDir ? relative(repoDir, path) : path;
  const admitted = new Set(directories.flatMap(packageDir =>
    readWorkspaceBuildInputs(packageDir, { ...options, includeDirectories: true }).map(path => join(packageDir, path)))
    .filter(path => isWorkspaceBuildInputIgnoredPath(inputPath(path))));
  return path => {
    if (hostDir) {
      const hostRelative = relative(hostDir, path);
      const belongsToHost = !isAbsolute(hostRelative) && hostRelative !== '..' && !hostRelative.startsWith(`..${sep}`);
      // Host assets, native support and Prisma inputs are opaque build data.
      if (belongsToHost && !isWorkspaceBuildSourcePath(hostRelative)) return false;
    }
    return isWorkspaceBuildInputIgnoredPath(inputPath(path)) && !admitted.has(path);
  };
}

function isWorkspaceBuildConfigFile(name) {
  if (name === 'package.json') return true;
  if (/^tsconfig(?:\.[^.]+)*\.json$/.test(name)) {
    return !/\.(?:test|tests|type-tests)\.json$/.test(name);
  }
  return /^(?:rollup|vite|esbuild|babel|swc|rspack|tsup|happier-plugin-ui)\.config\.(?:js|cjs|mjs|ts|json)$/.test(name);
}

// Source capture and reconciliation share this package-output boundary. The
// authored hosted-web tree is an input; its generated parents are not membership.
export function isGeneratedPluginArtifactPath(path) {
  const parts = String(path).replaceAll('\\', '/').replace(/^packages\/(?:plugins\/)?[^/]+\//, '').split('/');
  if (parts[0] !== '.happier-plugin') return false;
  return parts[1] !== 'ui' || parts[2] !== 'hosted-web';
}

// Both package admission and Stack source identities consume this input set.
export function readWorkspaceBuildInputs(packageDir, {
  readDir = readdirSync,
  stat = lstatSync,
  includeShippedFiles = false,
  includeDirectories = false,
  excludeGeneratedPluginManifest = false,
  excludeGeneratedPluginArtifacts = false,
  additionalInputPaths = [],
  sourceRoots = SOURCE_ROOTS,
} = {}) {
  const inputs = new Set();
  const visit = (path, { ignoreTests = true, matches } = {}) => {
    const relativePath = relative(packageDir, path).split(sep).join('/');
    const generated = excludeGeneratedPluginArtifacts && isGeneratedPluginArtifactPath(relativePath);
    if (generated && relativePath !== '.happier-plugin' && relativePath !== '.happier-plugin/ui') return;
    if (excludeGeneratedPluginManifest && relativePath === '.happier-plugin/plugin.json') return;
    if (ignoreTests && isWorkspaceBuildInputIgnoredPath(relativePath)) return;

    let entryStat;
    try {
      entryStat = stat(path, { bigint: true });
    } catch {
      return;
    }
    if (entryStat.isDirectory()) {
      if (includeDirectories && !generated) inputs.add(relativePath);
      for (const childName of readDir(path)) visit(join(path, childName), { ignoreTests, matches });
      return;
    }
    if (!generated && (!matches || matches(relativePath))) inputs.add(relativePath);
  };

  let entries = [];
  try {
    entries = readDir(packageDir, { withFileTypes: true });
  } catch {
    return [...inputs];
  }
  for (const entry of entries) {
    if (
      (entry.isDirectory() && sourceRoots.includes(entry.name))
      // Authored declarations beside root JavaScript helpers are compiler
      // inputs, including before their package has any generated dist output.
      || (entry.isFile() && (isWorkspaceBuildConfigFile(entry.name) || /\.(?:[cm]?js|d\.[cm]?ts)$/.test(entry.name)))
    ) visit(join(packageDir, entry.name));
  }
  // Package admission and capture must consume the same explicitly referenced
  // build scripts, including TypeScript helpers outside the standard roots.
  if (existsSync(join(packageDir, 'package.json'))) {
    const packageJson = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
    const buildScript = String(packageJson.scripts?.build ?? '');
    for (const match of buildScript.matchAll(/(?:^|\s)(\.{1,2}\/[^\s;&|]+\.(?:[cm]?[jt]sx?|json))(?=$|\s|[;&|])/g)) {
      visit(resolve(packageDir, match[1]), { ignoreTests: false });
    }
  }
  visit(join(packageDir, '.happier-plugin', 'plugin.json'));
  visit(join(packageDir, '.happier-plugin', 'ui', 'hosted-web'), { ignoreTests: false });
  // Explicit shipped inputs can have test-like names (for example app QA specimens).
  for (const path of additionalInputPaths) visit(join(packageDir, path), { ignoreTests: false });
  if (includeShippedFiles) {
    const packageJson = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
    for (const entry of ['README.md', '.happier-plugin', ...(packageJson.files ?? [])]) {
      if (
        typeof entry !== 'string' || !entry || entry.includes('\\') || entry.startsWith('/')
        || entry.split('/').some((segment) => !segment || segment === '.' || segment === '..')
      ) throw new Error(`[workspace-build] invalid shipped package file: ${entry}`);
      if (entry === 'dist' || entry.startsWith('dist/') || entry === 'package.json') continue;
      // npm `files` accepts globs: walk the literal directory prefix and keep only matching files.
      const segments = entry.split('/');
      const globAt = segments.findIndex((segment) => /[*?{}[\]]/.test(segment));
      if (globAt === -1) {
        visit(join(packageDir, entry), { ignoreTests: isWorkspaceBuildSourcePath(entry) });
        continue;
      }
      const prefix = segments.slice(0, globAt).join('/');
      visit(join(packageDir, prefix), {
        ignoreTests: isWorkspaceBuildSourcePath(entry),
        matches: (relativePath) => posix.matchesGlob(relativePath, entry),
      });
    }
  }
  // A config excluded as a test-only root can still be a consumed build input
  // when another admitted config extends it. One path owner serves source
  // identity, package admission, and dedicated-workspace source capture.
  const configs = new Set();
  const visitConfig = (path) => {
    if (configs.has(path)) return;
    configs.add(path);
    const match = readFileSync(path, 'utf8').match(/"extends"\s*:\s*("[^"]+"|\[[^\]]+\])/);
    if (!match) return;
    const specs = match[1].startsWith('[')
      ? [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1])
      : [match[1].slice(1, -1)];
    for (const spec of specs) {
      if (!spec.startsWith('.')) continue;
      const base = resolve(dirname(path), spec);
      const target = existsSync(base) ? base : `${base}.json`;
      if (!existsSync(target)) throw new Error(`[workspace-build] missing extended tsconfig: ${target}`);
      inputs.add(relative(packageDir, target).split(sep).join('/'));
      visitConfig(target);
    }
  };
  for (const path of [...inputs]) if (/^tsconfig(?:\.[^.]+)*\.json$/.test(basename(path))) visitConfig(join(packageDir, path));
  return [...inputs].sort();
}

export function resolveWorkspaceBuildInputWatchPaths(packageDir, {
  existsSyncImpl = existsSync,
  excludeGeneratedPluginManifest = true,
  excludeGeneratedPluginArtifacts = false,
  includeShippedFiles = false,
  additionalInputPaths = [],
  sourceRoots = SOURCE_ROOTS,
  inputPaths,
} = {}) {
  const membershipRoots = [...sourceRoots, '.happier-plugin/ui/hosted-web', ...additionalInputPaths];
  let observedInputs = inputPaths;
  if (!observedInputs) {
    try {
      observedInputs = readWorkspaceBuildInputs(packageDir, { excludeGeneratedPluginManifest, excludeGeneratedPluginArtifacts, includeShippedFiles, includeDirectories: includeShippedFiles, additionalInputPaths, sourceRoots });
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      // A partially edited manifest blocks build admission, not observation of
      // the correction. Keep source roots and the manifest itself watched.
      observedInputs = ['package.json'];
    }
  }
  return [...new Set([
    ...membershipRoots.map((path) => join(packageDir, path)),
    ...observedInputs
      .filter((path) => !membershipRoots.some((root) => path.startsWith(`${root}/`)))
      .map((path) => join(packageDir, path)),
  ])].filter((path) => existsSyncImpl(path));
}
