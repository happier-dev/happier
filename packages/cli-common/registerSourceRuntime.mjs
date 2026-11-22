import * as nodeModule from 'node:module';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoDir = realpathSync(fileURLToPath(new URL('../../', import.meta.url)));
// Install the existing tooling pin before any workspace graph or TypeScript
// loader. This registration can be an inherited preload that runs before the
// Stack bootstrap; a later pin cannot replace syntax tsx already rejected.
let toolingPin;
const toolingPinOwner = new URL('../../apps/stack/bin/localToolingPackagePin.mjs', import.meta.url);
if (existsSync(toolingPinOwner)) {
  const { registerStackToolingPackagePin } = await import(toolingPinOwner.href);
  toolingPin = registerStackToolingPackagePin({ repoDir });
}
const { initialize, resolve } = await import('./sourceRuntimeEntries.mjs');
const entrypoint = process.argv[1] && existsSync(process.argv[1]) ? realpathSync(process.argv[1]) : null;
const cliDir = join(repoDir, 'apps', 'cli');
const isCliEntrypoint = ['src/index.ts', 'src/index.mjs', 'bin/happier.mjs', 'bin/happier-dev.mjs']
  .some(entry => entrypoint === join(cliDir, entry));
const isRevisionCli = isCliEntrypoint && existsSync(join(repoDir, '.happier-revision-tree-ref.json'));
let revisionCacheRoot;
if (isRevisionCli) {
  const cacheRoot = join(repoDir, '.happier-tsx-cache');
  try {
    mkdirSync(cacheRoot, { mode: 0o700, recursive: true });
    revisionCacheRoot = cacheRoot;
  } catch (error) {
    console.error(`[source-runtime] revision tsx cache unavailable (${error?.code ?? 'mkdir_failed'})`);
  }
}
// tsx retains the index of its whole cache directory. Source revision trees
// own their directory and its cleanup. Other hosts keep the CLI lifetime policy.
const cacheTransforms = isRevisionCli
  ? revisionCacheRoot !== undefined
  : isCliEntrypoint && !(await import(
      new URL('../../apps/cli/src/cli/readStartedByArg.mjs', import.meta.url)
    )).isDaemonHostedCliInvocation(process.argv.slice(2));
if (cacheTransforms) delete process.env.TSX_DISABLE_CACHE;
else process.env.TSX_DISABLE_CACHE = '1';
let tsconfig = process.env.TSX_TSCONFIG_PATH || undefined;
if (!tsconfig && process.argv[1] && existsSync(process.argv[1])) {
  // Source entries belong to their package even when Stack or a test prebuild
  // launches them from another cwd. tsx remains the sole paths resolver.
  let directory = dirname(realpathSync(process.argv[1]));
  while (directory === repoDir || directory.startsWith(repoDir + sep)) {
    tsconfig = ['tsconfig.runtime.json', 'tsconfig.json'].map(name => join(directory, name)).find(existsSync);
    if (tsconfig) break;
    directory = dirname(directory);
  }
}
// tsx snapshots its config and os.tmpdir() when the hooks load. Limit the
// temporary directory override to that registration, keeping app temp IO local.
const overrides = new Map();
if (tsconfig) overrides.set('TSX_TSCONFIG_PATH', tsconfig);
if (revisionCacheRoot) {
  for (const key of ['TMPDIR', 'TMP', 'TEMP']) overrides.set(key, revisionCacheRoot);
}
const inheritedEnvironment = new Map();
try {
  for (const [key, value] of overrides) {
    inheritedEnvironment.set(key, process.env[key]);
    process.env[key] = value;
  }
  await import('tsx');
} finally {
  for (const [key, value] of inheritedEnvironment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

// Synchronous hooks run before asynchronous loaders. Register after tsx so
// workspace exports also win over its tsconfig paths and require(esm) graphs.
if (typeof nodeModule.registerHooks === 'function') {
  await initialize(repoDir);
  nodeModule.registerHooks({ resolve });
} else {
  nodeModule.register('./sourceRuntimeEntries.mjs', import.meta.url, { data: repoDir });
}
toolingPin?.registerResolution();
