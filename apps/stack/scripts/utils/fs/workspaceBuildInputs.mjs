import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import cliDistBuildManifest from '../../../../../packages/cli-common/cliDistBuildManifest.cjs';
import { packageNameOfSpecifier, readWorkspacePackages, workspaceSourcePackageClosure } from '../../../../../packages/cli-common/sourceRuntimeEntries.mjs';
import { readBundledPluginPackageNames } from '../../../../cli/scripts/build-owned/bundledPluginMembership.ts';
import { resolveBundledPluginUiProjectionInputPaths } from '../../../../cli/scripts/build-owned/bundledPlugins/projectionPaths.mjs';
import { readSourcePluginUiGraph } from '../../../../ui/scripts/sourcePluginUiGraph.mjs';
import { SOURCE_UI_ASSET_OUTPUT_PATHS, SOURCE_UI_ASSET_RECORD_FILENAME } from '../../../../ui/scripts/sourceUiAssetPaths.mjs';
import { readBuildInputIdentity } from '../../../../../scripts/workspaces/buildInputConvergence.mjs';
import { readWorkspaceExportSourceInputs } from '../../../../../scripts/workspaces/workspaceExportSourceInputs.mjs';
import { readSourceRuntimeDependencyIdentity } from '../../build/source_author_inputs.mjs';
import { EMBEDDED_FEATURE_POLICIES_OUTPUT } from '../../../../../packages/protocol/scripts/generate-embedded-feature-policies.mjs';
export { EMBEDDED_FEATURE_POLICIES_OUTPUT };

const SOURCE_ROOTS = ['src', 'sources', 'scripts'];
const TEST_DIRECTORY_NAMES = new Set(['__fixtures__', '__snapshots__', '__tests__', 'fixtures', 'test', 'testkit', 'tests', 'test-support']);
// Generated outputs for owned and borrowed installations. @prisma/client itself
// is an installed dependency: borrowing it preserves the server layout owner's
// choice of a capture-local generated client instead of changing package ownership.
export const SERVER_GENERATED_INPUT_ROOTS = Object.freeze(['apps/server/node_modules/.prisma/client', 'apps/server/generated']);
export { SERVER_GENERATED_CLIENTS, SERVER_GENERATED_CLIENT_STAMP } from '../../build/server_generated_clients.mjs';
// UI postinstall vendors these from installed packages into the served public tree.
const UI_VENDORED_PUBLIC_ROOTS = ['apps/ui/public/monaco', 'apps/ui/public/pdfjs'];

/** Untracked inputs a source build consumes, each with a named producer. A
 * revision capture keeps no other untracked byte: stray ignored files (resource
 * forks, temporary configs) are neither inputs nor part of the build identity. */
export function isSourceGeneratedInput(path) {
  return isSourceServerGeneratedInput(path) || path === EMBEDDED_FEATURE_POLICIES_OUTPUT
    || UI_VENDORED_PUBLIC_ROOTS.some(root => path.startsWith(`${root}/`))
    || /^apps\/ui\/public\/pierre-diff-worker[^/]*\.js$/.test(path);
}

export function isSourceServerGeneratedInput(path) {
  return SERVER_GENERATED_INPUT_ROOTS.some(root => path.startsWith(`${root}/`));
}

export { readNativeTestSourceInputs, readNativeTestPreparationDemand } from './nativeTestInputs.mjs';

// Retained source daemon emission and its preparation watcher consume the same
// compiler/inventory inputs; neither borrows the app's unrelated source tree.
export function resolveSourcePluginUiBuildInputPaths(repoDir) {
  const root = join(repoDir, 'apps/ui');
  return readWorkspaceBuildInputs(root, { sourceRoots: ['scripts'] }).map(path => join(root, path));
}

/** Plugin UI can bundle declared build dependencies as well as runtime ones.
 * Host applications are not plugin source inputs; their test dependencies must
 * not make a CLI-only edit rebuild every UI artifact. Inventory observation
 * also follows evaluated manifests and declaration validation; those inputs
 * refresh the inventory without invalidating executable artifact bytes. */
export async function readSourcePluginUiBuildInputs({ repoDir, pluginDirectory, compiler = false, packages, includeDirectories = false,
  packageInputs = new Map(), resolveSourceImport, retainedInputs, inputOptions = [], inventory = false }) {
  packages ??= await readWorkspacePackages(repoDir);
  const graphKey = sourcePluginUiGraphKey({ compiler, pluginDirectory, inventory });
  let graph = packageInputs.get(graphKey);
  if (!graph) {
    const unchanged = retainedInputs?.files && (inventory || Array.isArray(retainedInputs.installedImports))
      && retainedInputs.identity === (await readSourcePluginUiBuildInputRecord({
        repoDir, files: retainedInputs.files, installedImports: retainedInputs.installedImports, packages, packageInputs, inputOptions,
      })).identity;
    graph = unchanged ? { files: retainedInputs.files, installedImports: retainedInputs.installedImports ?? [] }
      : readSourcePluginUiGraph({ repoDir, compiler, pluginDirectory, packages, resolveSourceImport, inventory });
    packageInputs.set(graphKey, graph);
  }
  const files = new Set((await graph).files.filter(path => !isWorkspaceBuildInputIgnoredPath(path)
    && !path.split('/').some(part => part === 'dist' || part === 'package-dist')
    && !isGeneratedPluginArtifactPath(path)));
  // Compiler scripts under apps/ run in Node beside their host app; the host's
  // manifest and the install's lockfile do not reach a bundle. The compile key
  // takes bundled installed packages by content instead
  // (readSourcePluginUiInstalledIdentity). Inventory observation keeps both.
  const hostTooling = !inventory && compiler;
  if (compiler) for (const path of [
    'apps/ui/scripts/prepareSourcePluginUiArtifacts.mjs',
    'apps/ui/scripts/generateBundledPluginUiArtifacts.mjs',
    'apps/cli/scripts/build-owned/bundledPlugins/uiDeclarations.mjs',
    'apps/stack/scripts/build/build_source_web_ui.mjs',
    'apps/stack/scripts/utils/fs/workspaceBuildInputs.mjs',
    'packages/cli-common/registerSourceRuntime.mjs',
    'packages/cli-common/sourceRuntimeEntries.mjs',
    'scripts/workspaces/sourcePluginUiBuildOptions.mjs',
    'scripts/workspaces/buildInputConvergence.mjs',
    'apps/ui/scripts/sourcePluginUiGraph.mjs',
  ]) files.add(path);
  const packageRoots = new Set([...packages.values()].map(({ root }) => relative(repoDir, root).split(sep).join('/')));
  for (const path of [...files]) {
    let parent = posix.dirname(path);
    if (includeDirectories) files.add(parent);
    if (hostTooling && path.startsWith('apps/')) continue;
    while (parent !== '.' && !packageRoots.has(parent)) parent = posix.dirname(parent);
    if (packageRoots.has(parent)) files.add(`${parent}/package.json`);
  }
  // Executable inputs come from the resolved UI graph above. Retain shipped
  // Resources and hosted-static files without treating every daemon source
  // edit in this plugin as a UI change. Explicitly shipped sources still count.
  for (const name of compiler ? [] : [`@happier-dev/plugins-${pluginDirectory}`]) {
    if (!packages.has(name)) continue;
    const { root } = packages.get(name);
    const includeShippedFiles = true;
    // Publication uses a new pass so additions made while compiling still
    // invalidate unchanged-input reuse.
    const key = JSON.stringify([root, includeShippedFiles, includeDirectories]);
    let inputs = packageInputs.get(key);
    if (!inputs) {
      inputs = readWorkspaceBuildInputs(root, { sourceRoots: [], excludeGeneratedPluginArtifacts: true, includeDirectories, includeShippedFiles });
      packageInputs.set(key, inputs);
    }
    for (const path of inputs) {
      files.add(relative(repoDir, join(root, path)).split(sep).join('/'));
    }
  }
  if (inventory) for (const path of ['pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
    if (existsSync(join(repoDir, path))) files.add(path);
  }
  return [...files].sort();
}

function sourcePluginUiGraphKey({ compiler = false, pluginDirectory, inventory = false }) {
  return `plugin-ui-graph:${compiler ? 'compiler' : pluginDirectory}:${inventory}`;
}

/** Installed packages the graph read by readSourcePluginUiBuildInputs (same
 * `packageInputs`) leaves to the bundler, as [packageName, resolveFrom]. */
export async function readSourcePluginUiInstalledImports({ compiler = false, pluginDirectory, inventory = false, packageInputs }) {
  const graph = packageInputs.get(sourcePluginUiGraphKey({ compiler, pluginDirectory, inventory }));
  if (!graph) throw new Error(`[plugin-ui] read build inputs before installed imports (${compiler ? 'compiler' : pluginDirectory})`);
  return (await graph).installedImports;
}

/** The installed content those packages bundle, by the same closure owner that
 * keys package dists: an unrelated lockfile line leaves it unchanged. Paths are
 * checkout-relative (`node_modules/...` for installed files), so a snapshot that
 * mounts the source checkout's node_modules keeps the same identity. */
export function readSourcePluginUiInstalledIdentity({ repoDir, installedImports }) {
  return readSourceRuntimeDependencyIdentity({
    imports: installedImports.map(([name, resolveFrom]) => ({ path: name, resolveFrom: join(repoDir, resolveFrom) })),
    identityPathFor: path => {
      const normalized = path.split(sep).join('/');
      const installed = normalized.indexOf('/node_modules/');
      if (installed >= 0) return normalized.slice(installed + 1);
      const local = relative(repoDir, path);
      return local && !local.startsWith('..') && !isAbsolute(local) ? local.split(sep).join('/') : normalized;
    },
  });
}

/** Retain the compiler's consumed graph in its existing publication record.
 * Membership matters too: adding panel.ts can supersede panel/index.ts without
 * editing an old input. Enumerate only consumed owners, once per preparation. */
export async function readSourcePluginUiBuildInputRecord({ repoDir, files, installedImports, packages, packageInputs = new Map(), inputOptions = [] }) {
  packages ??= await readWorkspacePackages(repoDir);
  const workspaceRoots = [...packages.values()].map(({ root }) => relative(repoDir, root).split(sep).join('/'))
    .sort((left, right) => right.length - left.length);
  const roots = new Set(files.map(path => workspaceRoots.find(root => path.startsWith(`${root}/`)) ?? ''));
  const membership = [];
  for (const root of [...roots].sort()) {
    const prefix = root ? `${root}/` : '';
    const sourceRoots = [...new Set(files.filter(path => existsSync(join(repoDir, path))
      && (workspaceRoots.find(owner => path.startsWith(`${owner}/`)) ?? '') === root)
      .map(path => path.slice(prefix.length)).filter(path => path.includes('/'))
      .map(path => path.split('/')[0]))].sort();
    const key = JSON.stringify(['plugin-ui-membership', root, sourceRoots]);
    let inputs = packageInputs.get(key);
    if (!inputs) {
      inputs = readWorkspaceBuildInputs(join(repoDir, root), { excludeGeneratedPluginManifest: true,
        excludeGeneratedPluginArtifacts: true, sourceRoots });
      packageInputs.set(key, inputs);
    }
    membership.push([root, inputs]);
  }
  const workspaceMembership = [...packages].map(([name, { root }]) => [name, relative(repoDir, root).split(sep).join('/')])
    .sort(([left], [right]) => left.localeCompare(right));
  return { files, ...(installedImports ? { installedImports } : {}), identity: await readBuildInputIdentity({ sourceDir: repoDir, files,
    options: [inputOptions, workspaceMembership, membership, ...(installedImports ? [installedImports] : [])] }) };
}

/** Finite source consumers and their repair watchers share membership. Code
 * consumption remains the compiler's authority; this owner includes resolver
 * configuration and copied/native/Plugin UI resources that it cannot observe. */
/** The `[workspace] members` a Cargo.toml declares (literal member paths; this repository uses no globs). */
function readCargoWorkspaceMembers(cargoDir) {
  let manifest;
  try { manifest = readFileSync(join(cargoDir, 'Cargo.toml'), 'utf8'); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const members = /\[workspace\][^[]*?members\s*=\s*\[([^\]]*)\]/su.exec(manifest)?.[1] ?? '';
  return [...members.matchAll(/"([^"]+)"/gu)].map(match => match[1]);
}

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
  const ownerRoots = new Set(owners.map(({ root }) => root));
  const pendingRoots = [repoDir, ...ownerRoots];
  for (const root of pendingRoots) {
    const path = relative(repoDir, root).replaceAll('\\', '/');
    const options = {
      // Source author emission uses the workspace copier's declared package
      // files contract, including documentation/resources of SDK dependencies.
      // Capture those authored bytes; readWorkspaceBuildInputs excludes dist.
      includeShippedFiles: path.startsWith('packages/'),
      excludeGeneratedPluginArtifacts: path.startsWith('packages/plugins/'),
      sourceRoots: component === 'daemon' && path === 'apps/ui' ? ['scripts'] : SOURCE_ROOTS,
      additionalInputPaths: root === repoDir ? ['apps/cli/scripts/buildPublication.mjs',
        // Protocol's embedded feature-policy module is generated from these.
        '.github/feature-policy',
        // The guest CLI's SEA compiler reads the pin from its captured repo.
        ...(component === 'daemon' ? ['.node-version', 'apps/stack/scripts/build/build_source_runtime.mjs'] : []),
        // Captured Stack tooling imports this shared CLI admission policy.
        'apps/cli/scripts/vitestPreparation.mjs',
        // Stack's generated-client owner imports the server layout even when
        // the guest/daemon closure does not otherwise include the server.
        'apps/server/scripts/prismaInstallLayout.mjs',
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
              // Cargo resolves every declared workspace member, so the capture holds
              // each one, shipped in the Node package's files or not (WASM, the holder).
              : path === 'packages/iroh-native' ? readCargoWorkspaceMembers(join(root, 'rust')).map(member => `rust/${member}`)
                : component === 'daemon' && path.startsWith('packages/plugins/') ? ['managed-runtime'] : [],
    };
    // The first-party addon is built from captured Rust, never captured from a
    // host's previously published native output.
    const inputs = readWorkspaceBuildInputs(root, options).filter(input =>
      path !== 'packages/iroh-native' || !/^native(?:-test)?\//.test(input));
    for (const input of inputs) {
      if (path === 'apps/ui' && (Object.values(SOURCE_UI_ASSET_OUTPUT_PATHS).includes(input)
        || basename(input) === SOURCE_UI_ASSET_RECORD_FILENAME)) continue;
      // Retained checkout databases are data, never compiler inputs.
      if (path === 'apps/server' && input.startsWith('prisma/')
        && !/\.(?:prisma|sql)$/.test(input) && !input.endsWith('/migration_lock.toml')) continue;
      files.add(relative(repoDir, resolve(root, input)).split(sep).join('/'));
      // The source resolver admits discovered workspace imports even before
      // manifests acquire their dependency projection. Capture those owners
      // and their declared closure through this same inventory and watcher.
      if (/\.[cm]?[jt]sx?$/.test(input)) {
        for (const specifier of cliDistBuildManifest.extractModuleSpecifiers(readFileSync(resolve(root, input), 'utf8'))) {
          const name = packageNameOfSpecifier(specifier);
          if (!packages.has(name) || ownerRoots.has(packages.get(name).root)) continue;
          for (const dependency of workspaceSourcePackageClosure(packages, [name])) {
            const owner = packages.get(dependency);
            if (ownerRoots.has(owner.root)) continue;
            ownerRoots.add(owner.root);
            owners.push(owner);
            pendingRoots.push(owner.root);
          }
        }
      }
    }
    for (const input of resolveWorkspaceBuildInputWatchPaths(root, { ...options, inputPaths: inputs })) watchPaths.add(input);
  }
  if (component === 'server') {
    // These generated clients and their Prisma runtime are mutable build
    // outputs, not shareable installed tools. Capture their physical files
    // alongside the server source and schemas that consume them.
    for (const directory of SERVER_GENERATED_INPUT_ROOTS) {
      const root = join(repoDir, directory);
      for (const path of readWorkspaceBuildInputs(root, { sourceRoots: [], additionalInputPaths: ['.'], stat: statSync })) {
        files.add(`${directory}/${path}`);
      }
      if (existsSync(root)) watchPaths.add(root);
    }
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
  if (name === 'package.json' || name === 'export-aliases.json') return true;
  if (/^tsconfig(?:\.[^.]+)*\.json$/.test(name)) {
    return !/\.(?:test|tests|type-tests)\.json$/.test(name);
  }
  return /^(?:rollup|vite|esbuild|babel|swc|rspack|tsup|happier-plugin-ui)\.config\.(?:js|cjs|mjs|ts|json)$/.test(name);
}

// Source capture and reconciliation share this package-output boundary. The
// authored hosted-web tree is an input; its generated parents are not membership.
export function isGeneratedPluginArtifactPath(path) {
  const parts = String(path).replaceAll('\\', '/').replace(/^packages\/(?:plugins\/)?[^/]+\//, '').split('/');
  // Daemon bundles are publications too, even when listed in package files.
  if (parts[0] === '.happier-plugin-build') return true;
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
    // Protocol's export generator inventories private .ts modules to publish
    // null subpaths. Its captured verifier needs those inputs too, even though
    // the compiler does not emit them. Keep this exception at the shared input
    // owner so admission, watching and capture observe the same source tree.
    if (packageJson.name === '@happier-dev/protocol' && existsSync(join(packageDir, 'scripts/generate-exports.mjs'))) {
      visit(join(packageDir, 'src'), { ignoreTests: false, matches: path => path.endsWith('.ts') });
    } else {
      for (const path of readWorkspaceExportSourceInputs(packageDir, packageJson)) {
        visit(join(packageDir, path), { ignoreTests: false });
        if (includeDirectories) {
          for (let parent = dirname(path); parent !== '.'; parent = dirname(parent)) inputs.add(parent.split(sep).join('/'));
        }
      }
    }
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
