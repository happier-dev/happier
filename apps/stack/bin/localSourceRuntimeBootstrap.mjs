import { existsSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Load checkout tooling from its authored workspace authority before the
 * entry's import graph can reach a partially refreshed vendored package.
 * Installed Stack packages retain the published dependency closure. */
export async function bootstrapLocalStackSourceRuntime() {
  const source = new URL('../../../packages/cli-common/registerSourceRuntime.mjs', import.meta.url);
  if (!existsSync(source)) return;
  const repoDir = fileURLToPath(new URL('../../../', import.meta.url));
  const entry = resolve(process.argv[1] ?? '');
  // Dependency preparation must reach its installer before source registration
  // can import packages from the installation it is preparing.
  if (entry === resolve(repoDir, 'apps/stack/scripts/utils/dev_targets/remote_dependency_bootstrap.mjs')) return;
  // This group leader only forwards OS commands and cancellation. Loading
  // source tooling here makes ps/ss depend on dependency-install custody and
  // can exhaust their observation deadline before the command even starts.
  if (entry === resolve(repoDir, 'apps/stack/scripts/utils/proc/proc.mjs')
      && process.argv[2] === '--happier-foreground-custody') return;
  const isToolEntry = ['apps/stack', 'scripts/workspaces'].some(directory => {
    const path = relative(resolve(repoDir, directory), entry);
    return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
  });
  // Inherited preloads must not turn emitted CLI/server product children into
  // source consumers. Only repository tooling participates in this bootstrap.
  if (!isToolEntry) return;
  // This preload precedes dependency repair and finite capacity admission.
  // Protect its installed import only, then release before the entry runs.
  const { withDependencyConsumption } = await import('../scripts/utils/proc/dependency_refresh.mjs');
  await withDependencyConsumption({ installDir: repoDir }, () => import(source.href));
  // Source-tool children inherit this registration and re-evaluate entry ownership.
  const option = `--import=${JSON.stringify(fileURLToPath(import.meta.url))}`;
  if (!String(process.env.NODE_OPTIONS ?? '').includes(option)) {
    process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, option].filter(Boolean).join(' ');
  }
  return resolve(repoDir, 'apps', 'stack');
}

export const localStackSourceRuntimeRoot = await bootstrapLocalStackSourceRuntime();
