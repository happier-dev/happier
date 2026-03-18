import { join } from 'node:path';

import { readBundledWorkspaceSyncConfig } from '../readBundledWorkspaceSyncConfig.mjs';
import { resolveRuntimeManifestEntrypoint } from '../shared/runtime_manifest.mjs';

export function resolveCliRuntimeLaunchSpec({ snapshot }) {
  const runtimeRoot = snapshot.launchPath ?? snapshot.snapshotPath;
  const entrypoint =
    resolveRuntimeManifestEntrypoint({ snapshotPath: runtimeRoot, manifest: snapshot?.manifest, component: 'daemon' }) ||
    join(runtimeRoot, 'cli', 'happier');
  const bundledWorkspaceSync =
    snapshot?.bundledWorkspaceSync ??
    readBundledWorkspaceSyncConfig({
      snapshot: {
        ...snapshot,
        launchPath: runtimeRoot,
      },
    });
  return {
    source: 'runtime',
    cliDir: join(runtimeRoot, 'cli'),
    entrypoint,
    nodeEntrypoint: join(runtimeRoot, 'cli', 'package-dist', 'index.mjs'),
    command: entrypoint,
    args: [],
    ...(bundledWorkspaceSync ? { bundledWorkspaceSync } : {}),
  };
}
