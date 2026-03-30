import { join } from 'node:path';

import { resolveRuntimeManifestEntrypoint } from '../shared/runtime_manifest.mjs';

export function resolveServerRuntimeLaunchSpec({ serverComponent, snapshot }) {
  void serverComponent;
  const runtimeRoot = snapshot.launchPath ?? snapshot.snapshotPath;
  const entrypoint =
    resolveRuntimeManifestEntrypoint({ snapshotPath: runtimeRoot, manifest: snapshot?.manifest, component: 'server' }) ||
    join(runtimeRoot, 'server', 'happier-server');

  return {
    source: 'runtime',
    serverDir: join(runtimeRoot, 'server'),
    entrypoint,
    command: entrypoint,
    args: [],
  };
}
