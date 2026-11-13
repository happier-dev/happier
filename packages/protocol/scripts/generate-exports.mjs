import { readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import ts from 'typescript';
import { withWorkspaceBundleLock } from '../../../scripts/workspaces/workspaceBundleLock.mjs';
import { resolveWorkspacePackageBuildLockPath } from '../../../scripts/workspaces/workspacePackageBuildLock.mjs';

const defaultPackageRoot = fileURLToPath(new URL('../', import.meta.url));

export async function deriveProtocolExports(packageRoot) {
  const configPath = join(packageRoot, 'tsconfig.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  const inputs = ts.parseJsonConfigFileContent(config.config, ts.sys, packageRoot);
  if (inputs.errors.length) {
    throw new Error(inputs.errors.map(error => ts.flattenDiagnosticMessageText(error.messageText, '\n')).join('\n'));
  }
  const entry = source => ({
    'happier-source': source,
    types: source.replace(/^\.\/src\//, './dist/').replace(/\.ts$/, '.d.ts'),
    default: source.replace(/^\.\/src\//, './dist/').replace(/\.ts$/, '.js'),
  });
  // Compiler roots also include declaration inputs and support for tests.
  // They have no public executable module contract.
  const privateSuffix = /(?:\.d|\.test|\.spec|\.testkit|\.test-d)$/;
  const isPublic = source => !privateSuffix.test(source)
    && !/(?:^|\/)(?:test|tests|__tests__|fixtures|__fixtures__)(?:\/|$)/.test(source);
  const publicSources = new Set();
  for (const file of inputs.fileNames) {
    const source = relative(join(packageRoot, 'src'), file).replaceAll('\\', '/');
    if (source.startsWith('../') || !source.endsWith('.ts') || !isPublic(source.slice(0, -3))) continue;
    publicSources.add(source.slice(0, -3));
  }
  // One subpath pattern publishes every public module. Node re-reads the
  // nearest package.json for each loaded file, so an enumerated map (3,000+
  // entries, ~750 KB) cost ~5 ms CPU per protocol module on every Node import.
  // Tests, specs, testkits and type tests are excluded by suffix patterns; the
  // few remaining private files (fixtures, test support) by exact keys.
  // Vite 7 (resolve.exports 2.0.3) turns a pattern key into an unescaped RegExp,
  // so the `.` in `./*.test` matches any character there. A public module ending
  // in one of these words (`latest`, `tasks/spec`) therefore gets an exact entry,
  // which wins in every resolver. Declaration inputs (`*.d.ts`) get no key: the
  // compiler emits no `dist` target for them, and a `./*.d` pattern would hide
  // every public subpath ending in `d` under Vite.
  const privatePatternSuffixes = ['.test', '.spec', '.testkit', '.test-d'];
  const exports = { './*': entry('./src/*.ts') };
  for (const suffix of privatePatternSuffixes) exports[`./*${suffix}`] = null;
  for (const source of publicSources) {
    if (privatePatternSuffixes.some(suffix => source.endsWith(suffix.slice(1)))) exports[`./${source}`] = entry(`./src/${source}.ts`);
  }
  for (const source of await listSourceModules(join(packageRoot, 'src'))) {
    if (!publicSources.has(source) && !source.endsWith('.d')
      && !privatePatternSuffixes.some(suffix => source.endsWith(suffix))) {
      exports[`./${source}`] = null;
    }
  }
  const aliases = JSON.parse(await readFile(join(packageRoot, 'export-aliases.json'), 'utf8'));
  for (const [specifier, alias] of Object.entries(aliases)) {
    const source = typeof alias === 'string' ? alias : alias['happier-source'];
    if (!publicSources.has(source.replace(/^\.\/src\//, '').replace(/\.ts$/, ''))) {
      throw new Error(`Protocol export alias has no compiled source: ${specifier}`);
    }
    exports[specifier] = typeof alias === 'string' ? entry(source) : alias;
  }
  return { './package.json': './package.json',
    ...Object.fromEntries(Object.entries(exports).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) };
}

async function listSourceModules(directory, prefix = '') {
  const modules = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (item.isDirectory()) modules.push(...await listSourceModules(join(directory, item.name), `${prefix}${item.name}/`));
    else if (item.name.endsWith('.ts')) modules.push(`${prefix}${item.name.slice(0, -3)}`);
  }
  return modules;
}

export async function generateProtocolExports({ packageRoot = defaultPackageRoot, check = false, signal } = {}) {
  if (!check) signal?.throwIfAborted();
  const readProjection = async () => {
    const manifestPath = join(packageRoot, 'package.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const exports = await deriveProtocolExports(packageRoot);
    return { manifestPath, manifest, exports, current: JSON.stringify(manifest.exports) === JSON.stringify(exports) };
  };
  const projection = await readProjection();
  // Current exports are a read: a compiler publishing dist must not hold up
  // unrelated remote dispatch merely because it owns the package build lock.
  if (projection.current) return projection.manifest;
  if (check) throw new Error('Protocol exports are stale. Run pnpm --filter @happier-dev/protocol generate:exports.');
  return withWorkspaceBundleLock(async () => {
    // The manifest may have changed while waiting for the writer. Read its
    // current fields under that same publication owner before replacing it.
    const { manifestPath, manifest, exports, current } = await readProjection();
    if (current) return manifest;
    const temporaryPath = `${manifestPath}.${randomUUID()}.tmp`;
    const generatedManifest = { ...manifest, exports };
    await writeFile(temporaryPath, `${JSON.stringify(generatedManifest, null, 2)}\n`);
    await rename(temporaryPath, manifestPath);
    return generatedManifest;
  }, {
    signal,
    lockPath: resolveWorkspacePackageBuildLockPath(packageRoot, { name: '@happier-dev/protocol' }),
    heldLockValue: process.env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD,
    errorLabel: 'Protocol exports publication',
  });
}

// Preparation publishes the authoring projection before workspace capture.
// Workers, CI and publication consume the projection without repairing it.
export async function prepareProtocolExports({
  packageRoot = defaultPackageRoot, env = process.env, publicationMode = 'live', signal,
} = {}) {
  const check = Boolean(env.CI) || env.HAPPIER_DEV_TARGET_EXECUTION === '1' || publicationMode === 'artifact'
    || /^(?:prepack|pack|publish|prepublishOnly)$/.test(String(env.npm_lifecycle_event ?? ''));
  return generateProtocolExports({ packageRoot, check, signal });
}

// Authoring command only: runtime and capture readers consume package.json.
export async function watchProtocolExports({ packageRoot = defaultPackageRoot, onError = console.error } = {}) {
  const { watchDebounced } = await import('../../../apps/stack/scripts/utils/proc/watch.mjs');
  let pending = Promise.resolve();
  const watcher = watchDebounced({ paths: [join(packageRoot, 'src')],
    onChange: () => {
      pending = pending.then(() => generateProtocolExports({ packageRoot })).catch(onError);
    },
  });
  try {
    await generateProtocolExports({ packageRoot });
  } catch (error) {
    watcher.close();
    throw error;
  }
  return { async close() { watcher.close(); await pending; } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--watch')) {
    const watcher = await watchProtocolExports();
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void watcher.close(); });
  } else {
    if (!process.argv.includes('--write') && !process.argv.includes('--check')) {
      throw new Error('Use --write, --check or --watch.');
    }
    await generateProtocolExports({ check: process.argv.includes('--check') });
  }
}
