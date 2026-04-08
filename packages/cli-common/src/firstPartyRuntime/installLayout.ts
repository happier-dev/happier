import type { PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

import { joinPathForPathShape } from '../path/pathShape.js';
import { resolveHappyHomeDirFromEnvironment } from '../providers/resolveHappyHomeDir.js';
import type { FirstPartyComponentId } from './componentCatalog.js';
import {
  resolveFirstPartyComponentPublicReleaseVariant,
} from './componentCatalog.js';

export interface FirstPartyInstallLayout {
  componentId: FirstPartyComponentId;
  channel: PublicReleaseRingId;
  installRootName: string;
  installShims: readonly string[];
  happyHomeDir: string;
  installRoot: string;
  versionsDir: string;
  currentPath: string;
  previousPath: string;
  shimDir: string;
}

export function resolveFirstPartyInstallLayout(params: Readonly<{
  componentId: FirstPartyComponentId;
  channel?: PublicReleaseRingId;
  releaseRing?: PublicReleaseRingId;
  processEnv?: NodeJS.ProcessEnv;
}>): FirstPartyInstallLayout {
  const processEnv = params.processEnv ?? process.env;
  const channel = params.channel ?? params.releaseRing ?? 'stable';
  const component = resolveFirstPartyComponentPublicReleaseVariant({
    componentId: params.componentId,
    channel,
  });
  const happyHomeDir = resolveHappyHomeDirFromEnvironment(processEnv);
  const installRoot = joinPathForPathShape(happyHomeDir, component.installRootName);

  return {
    componentId: params.componentId,
    channel,
    installRootName: component.installRootName,
    installShims: component.installShims,
    happyHomeDir,
    installRoot,
    versionsDir: joinPathForPathShape(installRoot, 'versions'),
    currentPath: joinPathForPathShape(installRoot, 'current'),
    previousPath: joinPathForPathShape(installRoot, 'previous'),
    shimDir: joinPathForPathShape(happyHomeDir, 'bin'),
  };
}

export function resolveFirstPartyVersionInstallPath(params: Readonly<{
  componentId: FirstPartyComponentId;
  versionId: string;
  channel?: PublicReleaseRingId;
  releaseRing?: PublicReleaseRingId;
  processEnv?: NodeJS.ProcessEnv;
}>): string {
  const layout = resolveFirstPartyInstallLayout({
    componentId: params.componentId,
    channel: params.channel,
    releaseRing: params.releaseRing,
    processEnv: params.processEnv,
  });
  return joinPathForPathShape(layout.versionsDir, params.versionId);
}
