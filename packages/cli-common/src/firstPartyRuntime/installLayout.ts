import { join } from 'node:path';

import { resolveHappyHomeDirFromEnvironment } from '../providers/resolveHappyHomeDir.js';
import type { FirstPartyComponentId } from './componentCatalog.js';
import { getFirstPartyComponentCatalogEntry } from './componentCatalog.js';

export interface FirstPartyInstallLayout {
  componentId: FirstPartyComponentId;
  installRootName: string;
  happyHomeDir: string;
  installRoot: string;
  versionsDir: string;
  currentPath: string;
  previousPath: string;
  shimDir: string;
}

export function resolveFirstPartyInstallLayout(params: Readonly<{
  componentId: FirstPartyComponentId;
  processEnv?: NodeJS.ProcessEnv;
}>): FirstPartyInstallLayout {
  const processEnv = params.processEnv ?? process.env;
  const component = getFirstPartyComponentCatalogEntry(params.componentId);
  const happyHomeDir = resolveHappyHomeDirFromEnvironment(processEnv);
  const installRoot = join(happyHomeDir, component.installRootName);

  return {
    componentId: params.componentId,
    installRootName: component.installRootName,
    happyHomeDir,
    installRoot,
    versionsDir: join(installRoot, 'versions'),
    currentPath: join(installRoot, 'current'),
    previousPath: join(installRoot, 'previous'),
    shimDir: join(happyHomeDir, 'bin'),
  };
}

export function resolveFirstPartyVersionInstallPath(params: Readonly<{
  componentId: FirstPartyComponentId;
  versionId: string;
  processEnv?: NodeJS.ProcessEnv;
}>): string {
  const layout = resolveFirstPartyInstallLayout({
    componentId: params.componentId,
    processEnv: params.processEnv,
  });
  return join(layout.versionsDir, params.versionId);
}
