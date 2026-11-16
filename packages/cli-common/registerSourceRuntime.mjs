import * as nodeModule from 'node:module';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initialize, resolve } from './sourceRuntimeEntries.mjs';

const repoDir = realpathSync(fileURLToPath(new URL('../../', import.meta.url)));
const entrypoint = process.argv[1] && existsSync(process.argv[1]) ? realpathSync(process.argv[1]) : null;
const cliDir = join(repoDir, 'apps', 'cli');
const isCliEntrypoint = ['src/index.ts', 'src/index.mjs', 'bin/happier.mjs', 'bin/happier-dev.mjs']
  .some(entry => entrypoint === join(cliDir, entry));
const cacheTransforms = isCliEntrypoint && !(await import(
  new URL('../../apps/cli/src/cli/readStartedByArg.mjs', import.meta.url)
)).isDaemonHostedCliInvocation(process.argv.slice(2));
// Controllers retain tsx's entire shared disk index for their lifetime. Keep
// them process-local; finite CLI invocations reuse tsx's content-keyed transforms
// under the same lifetime decision as the CLI's V8 compile cache.
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
// tsx snapshots this configuration for its ESM and CommonJS hooks. Do not
// export an inferred default to children with a different entry and package.
const inheritedTsconfig = process.env.TSX_TSCONFIG_PATH;
try {
  if (tsconfig) process.env.TSX_TSCONFIG_PATH = tsconfig;
  await import('tsx');
} finally {
  if (inheritedTsconfig === undefined) delete process.env.TSX_TSCONFIG_PATH;
  else process.env.TSX_TSCONFIG_PATH = inheritedTsconfig;
}

// Synchronous hooks run before asynchronous loaders. Register after tsx so
// workspace exports also win over its tsconfig paths and require(esm) graphs.
if (typeof nodeModule.registerHooks === 'function') {
  await initialize(repoDir);
  nodeModule.registerHooks({ resolve });
} else {
  nodeModule.register('./sourceRuntimeEntries.mjs', import.meta.url, { data: repoDir });
}
