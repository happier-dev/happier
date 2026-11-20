import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Select the existing authored-tool authority before Node links any static
 * imports. Installed Stack layouts without a checkout keep their built graph. */
export function sourceBuildNodeArgs({ repoDir, scriptPath, args = [] }) {
  const bootstrap = join(repoDir, 'apps/stack/bin/localSourceRuntimeBootstrap.mjs');
  const sourceRuntime = join(repoDir, 'packages/cli-common/registerSourceRuntime.mjs');
  // Explicit finite tools can live outside their input checkout (for example
  // the Stack compiler consuming a captured UI). Inherited bootstrap scope
  // protects product children; it cannot establish this explicit tool intent.
  return [...(existsSync(bootstrap) ? ['--conditions=happier-source', `--import=${pathToFileURL(bootstrap).href}`] : []),
    ...(existsSync(sourceRuntime) ? [`--import=${pathToFileURL(sourceRuntime).href}`] : []), scriptPath, ...args];
}
