import { readFile, rename, writeFile } from 'node:fs/promises';
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
  const exports = {};
  const entry = source => ({
    'happier-source': source,
    types: source.replace(/^\.\/src\//, './dist/').replace(/\.ts$/, '.d.ts'),
    default: source.replace(/^\.\/src\//, './dist/').replace(/\.ts$/, '.js'),
  });
  for (const file of inputs.fileNames) {
    const source = relative(join(packageRoot, 'src'), file).replaceAll('\\', '/');
    // Compiler roots also include declaration inputs and support for tests.
    // They have no public executable module contract.
    if (source.startsWith('../') || !source.endsWith('.ts')
      || /(?:\.d|\.test|\.spec|\.testkit|\.test-d)\.ts$/.test(source)
      || /(?:^|\/)(?:test|tests|__tests__|fixtures|__fixtures__)(?:\/|$)/.test(source)) continue;
    exports[`./${source.slice(0, -3)}`] = entry(`./src/${source}`);
  }
  const aliases = JSON.parse(await readFile(join(packageRoot, 'export-aliases.json'), 'utf8'));
  for (const [specifier, alias] of Object.entries(aliases)) {
    const source = typeof alias === 'string' ? alias : alias['happier-source'];
    if (!Object.hasOwn(exports, source.replace(/^\.\/src\//, './').replace(/\.ts$/, ''))) {
      throw new Error(`Protocol export alias has no compiled source: ${specifier}`);
    }
    exports[specifier] = typeof alias === 'string' ? entry(source) : alias;
  }
  return Object.fromEntries(Object.entries(exports).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
}

export async function generateProtocolExports({ packageRoot = defaultPackageRoot, check = false, signal } = {}) {
  const run = async () => {
    const manifestPath = join(packageRoot, 'package.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const exports = await deriveProtocolExports(packageRoot);
    if (JSON.stringify(manifest.exports) === JSON.stringify(exports)) return manifest;
    if (check) throw new Error('Protocol exports are stale. Run pnpm --filter @happier-dev/protocol generate:exports.');
    const temporaryPath = `${manifestPath}.${randomUUID()}.tmp`;
    const generatedManifest = { ...manifest, exports };
    await writeFile(temporaryPath, `${JSON.stringify(generatedManifest, null, 2)}\n`);
    await rename(temporaryPath, manifestPath);
    return generatedManifest;
  };
  if (check) return run();
  return withWorkspaceBundleLock(run, {
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
