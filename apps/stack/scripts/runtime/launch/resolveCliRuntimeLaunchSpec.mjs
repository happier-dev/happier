import { join } from 'node:path';

import { resolveRuntimeManifestEntrypoint } from '../shared/runtime_manifest.mjs';

export function resolveCliRuntimeLaunchSpec({ snapshot }) {
  const runtimeRoot = snapshot.launchPath ?? snapshot.snapshotPath;
  const entrypoint =
    resolveRuntimeManifestEntrypoint({ snapshotPath: runtimeRoot, manifest: snapshot?.manifest, component: 'daemon' }) ||
    join(runtimeRoot, 'cli', 'happier');
  return {
    source: 'runtime',
    cliDir: join(runtimeRoot, 'cli'),
    entrypoint,
    nodeEntrypoint: join(runtimeRoot, 'cli', 'package-dist', 'index.mjs'),
    command: entrypoint,
    args: [],
  };
}
