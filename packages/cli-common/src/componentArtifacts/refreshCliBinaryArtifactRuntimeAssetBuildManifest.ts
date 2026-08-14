import { join } from 'node:path';

import cliDistBuildManifest from '../../cliDistBuildManifest.cjs';

export function refreshCliBinaryArtifactRuntimeAssetBuildManifest(
  params: Readonly<{ payloadDir: string }>,
): void {
  cliDistBuildManifest.refreshCliRuntimeAssetBuildManifest({
    runtimeRoot: params.payloadDir,
    entrypoint: join(params.payloadDir, 'package-dist', 'index.mjs'),
  });
}
