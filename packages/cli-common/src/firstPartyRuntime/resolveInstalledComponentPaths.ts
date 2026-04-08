import type { PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

import { joinPathForPathShape } from '../path/pathShape.js';
import type { FirstPartyComponentId } from './componentCatalog.js';
import { getFirstPartyComponentCatalogEntry } from './componentCatalog.js';
import { resolveFirstPartyInstallLayout } from './installLayout.js';

export interface InstalledFirstPartyComponentPaths {
  installRoot: string;
  currentPath: string;
  previousPath: string;
  versionsDir: string;
  binaryPath: string;
  nodeEntrypointPath: string | null;
  shimPaths: string[];
}

export function resolveInstalledFirstPartyComponentPaths(params: Readonly<{
  componentId: FirstPartyComponentId;
  channel?: PublicReleaseRingId;
  releaseRing?: PublicReleaseRingId;
  processEnv?: NodeJS.ProcessEnv;
}>): InstalledFirstPartyComponentPaths {
  const layout = resolveFirstPartyInstallLayout({
    componentId: params.componentId,
    channel: params.channel,
    releaseRing: params.releaseRing,
    processEnv: params.processEnv,
  });
  const component = getFirstPartyComponentCatalogEntry(params.componentId);
  const binaryRelativePath =
    process.platform === 'win32'
      ? `${component.binaryRelativePath}.exe`
      : component.binaryRelativePath;
  const shimNames =
    process.platform === 'win32'
      ? layout.installShims.map((shimName) => `${shimName}.exe`)
      : layout.installShims;

  return {
    installRoot: layout.installRoot,
    currentPath: layout.currentPath,
    previousPath: layout.previousPath,
    versionsDir: layout.versionsDir,
    binaryPath: joinPathForPathShape(layout.currentPath, binaryRelativePath),
    nodeEntrypointPath: component.nodeEntrypointRelativePath
      ? joinPathForPathShape(layout.currentPath, component.nodeEntrypointRelativePath)
      : null,
    shimPaths: shimNames.map((shimName) => joinPathForPathShape(layout.shimDir, shimName)),
  };
}
