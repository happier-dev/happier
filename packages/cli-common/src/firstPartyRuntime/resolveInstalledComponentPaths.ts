import { join } from 'node:path';

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
  processEnv?: NodeJS.ProcessEnv;
}>): InstalledFirstPartyComponentPaths {
  const layout = resolveFirstPartyInstallLayout({
    componentId: params.componentId,
    processEnv: params.processEnv,
  });
  const component = getFirstPartyComponentCatalogEntry(params.componentId);

  return {
    installRoot: layout.installRoot,
    currentPath: layout.currentPath,
    previousPath: layout.previousPath,
    versionsDir: layout.versionsDir,
    binaryPath: join(layout.currentPath, component.binaryRelativePath),
    nodeEntrypointPath: component.nodeEntrypointRelativePath
      ? join(layout.currentPath, component.nodeEntrypointRelativePath)
      : null,
    shimPaths: component.installShims.map((shimName) => join(layout.shimDir, shimName)),
  };
}
