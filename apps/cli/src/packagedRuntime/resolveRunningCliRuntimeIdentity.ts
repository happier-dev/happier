import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import cliDistBuildManifest from '@happier-dev/cli-common/cliDistBuildManifest';

import { isEmbeddedBunBundlePath } from '@/packagedRuntime/js/isEmbeddedBunBundlePath';
import { resolveRunnerSnapshotRuntimeRootFromPath } from '@/packagedRuntime/resolveRuntimeEntrypointArgv';
import { resolveExecutingPackagedRuntimeTree } from '@/packagedRuntime/resolvePackagedRuntimeEntrypoint';

export type RunningCliRuntimeIdentity = Readonly<{
  entrypoint: string | null;
  tree: 'dist' | 'package-dist' | 'runner-snapshot' | 'source' | null;
  builtAt: string | null;
  manifestVerified: boolean;
}>;

const UNKNOWN_RUNTIME_IDENTITY: RunningCliRuntimeIdentity = {
  entrypoint: null,
  tree: null,
  builtAt: null,
  manifestVerified: false,
};

function describeRuntimeEntrypoint(
  entrypoint: string,
  tree: NonNullable<RunningCliRuntimeIdentity['tree']>,
): RunningCliRuntimeIdentity {
  // Verified, not merely recorded: this runs once per daemon start (a source/tsx runtime
  // returns before reaching here), and a claim about which bytes are running is worth the
  // closure walk. `manifestVerified: false` means exactly that the closure did not check out
  // against its recorded identity — or that none was recorded, as on a managed install.
  const integrity = cliDistBuildManifest.readCliDistBuildManifest(entrypoint);
  return {
    entrypoint,
    tree,
    builtAt: integrity.ok ? String(integrity.manifest?.builtAt ?? '').trim() || null : null,
    manifestVerified: integrity.ok,
  };
}

/**
 * Which CLI bundle this process is actually executing.
 *
 * Derived from `import.meta.url` rather than `process.argv`, because `bin/happier.mjs`
 * rewrites argv to the wrapper path before importing the runtime — the same erasure that
 * let a superseded bundle run unnoticed. Reported so an operator and an automated QA lane
 * can tell current bytes from a bundle left behind by an earlier package build.
 */
export function resolveRunningCliRuntimeIdentity(
  moduleUrl: string = import.meta.url,
): RunningCliRuntimeIdentity {
  let modulePath: string;
  try {
    modulePath = fileURLToPath(moduleUrl);
  } catch {
    return UNKNOWN_RUNTIME_IDENTITY;
  }
  if (!modulePath || isEmbeddedBunBundlePath(modulePath)) {
    return UNKNOWN_RUNTIME_IDENTITY;
  }

  const snapshotRoot = resolveRunnerSnapshotRuntimeRootFromPath(modulePath);
  if (snapshotRoot) {
    return describeRuntimeEntrypoint(join(snapshotRoot, 'index.mjs'), 'runner-snapshot');
  }

  const packagedRuntime = resolveExecutingPackagedRuntimeTree(moduleUrl);
  if (packagedRuntime) {
    return describeRuntimeEntrypoint(
      join(packagedRuntime.root, packagedRuntime.tree, 'index.mjs'),
      packagedRuntime.tree,
    );
  }

  const sourceMarker = `${'/'}src${'/'}`;
  const normalizedModulePath = modulePath.replaceAll('\\', '/');
  const sourceIndex = normalizedModulePath.lastIndexOf(sourceMarker);
  if (sourceIndex >= 0) {
    return {
      entrypoint: join(normalizedModulePath.slice(0, sourceIndex), 'src', 'index.ts'),
      tree: 'source',
      builtAt: null,
      manifestVerified: false,
    };
  }

  return UNKNOWN_RUNTIME_IDENTITY;
}
