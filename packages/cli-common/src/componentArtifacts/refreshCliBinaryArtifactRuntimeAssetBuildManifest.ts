import { join } from 'node:path';

import cliDistBuildManifest from '../../cliDistBuildManifest.cjs';

export function writeCliBinaryArtifactRuntimeAssetBuildManifest(
  params: Readonly<{
    payloadDir: string;
    relativePath: string;
    workspaceRuntimeIdentity?: string;
  }>,
): void {
  if (params.workspaceRuntimeIdentity) {
    cliDistBuildManifest.writeCliDistWorkspaceRuntimeIdentity({
      entrypoint: join(params.payloadDir, 'package-dist', 'index.mjs'),
      workspaceRuntimeIdentity: params.workspaceRuntimeIdentity,
    });
  }
  cliDistBuildManifest.writeCliRuntimeAssetBuildManifest({
    runtimeRoot: params.payloadDir,
    entrypoint: join(params.payloadDir, 'package-dist', 'index.mjs'),
    relativePath: params.relativePath,
  });
}

export function refreshCliBinaryArtifactRuntimeAssetBuildManifest(
  params: Readonly<{ payloadDir: string }>,
): void {
  cliDistBuildManifest.refreshCliRuntimeAssetBuildManifest({
    runtimeRoot: params.payloadDir,
    entrypoint: join(params.payloadDir, 'package-dist', 'index.mjs'),
  });
}
