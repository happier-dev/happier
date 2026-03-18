import { join } from 'node:path';

import { getFirstPartyComponentCatalogEntry } from '@happier-dev/cli-common/firstPartyRuntime';

import { resolveRuntimeManifestEntrypoint } from '../shared/runtime_manifest.mjs';

export function resolveCliRuntimeLaunchSpec({ snapshot }) {
  const daemonComponent = getFirstPartyComponentCatalogEntry('happier-daemon');
  const runtimeRoot = snapshot.launchPath ?? snapshot.snapshotPath;
  const entrypoint =
    resolveRuntimeManifestEntrypoint({ snapshotPath: runtimeRoot, manifest: snapshot?.manifest, component: 'daemon' }) ||
    join(runtimeRoot, 'cli', daemonComponent.binaryRelativePath);
  return {
    source: 'runtime',
    cliDir: join(runtimeRoot, 'cli'),
    entrypoint,
    nodeEntrypoint: daemonComponent.nodeEntrypointRelativePath
      ? join(runtimeRoot, 'cli', daemonComponent.nodeEntrypointRelativePath)
      : '',
    command: entrypoint,
    args: [],
  };
}
