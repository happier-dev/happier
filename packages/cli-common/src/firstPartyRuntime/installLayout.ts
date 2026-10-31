import type { PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

import { joinPathForPathShape } from '../path/pathShape.js';
import { resolveHappyHomeDirFromEnvironment } from '../agents/resolveHappyHomeDir.js';
import type { FirstPartyComponentId } from './componentCatalog.js';
import {
  resolveFirstPartyComponentPublicReleaseVariant,
} from './componentCatalog.js';
import { FIRST_PARTY_INSTALL_HOME_ENV_KEY, assertValidFirstPartyVersionId } from './installLayoutContract.js';
export { FIRST_PARTY_INSTALL_HOME_ENV_KEY, InvalidFirstPartyVersionIdError, assertValidFirstPartyVersionId } from './installLayoutContract.js';

export interface FirstPartyInstallLayout {
  componentId: FirstPartyComponentId;
  channel: PublicReleaseRingId;
  installRootName: string;
  installShims: readonly string[];
  /** Managed installation home; may differ from the private HAPPIER_HOME_DIR. */
  happyHomeDir: string;
  installRoot: string;
  versionsDir: string;
  currentPath: string;
  previousPath: string;
  shimDir: string;
}

/** Reuse the canonical home expansion rules without changing daemon-private state. */
export function resolveFirstPartyInstallHomeDir(processEnv: Readonly<Record<string, string | undefined>> = process.env): string {
  const override = processEnv[FIRST_PARTY_INSTALL_HOME_ENV_KEY]?.trim();
  return resolveHappyHomeDirFromEnvironment(override
    ? { ...processEnv, HAPPIER_HOME_DIR: override }
    : processEnv);
}

export function resolveFirstPartyInstallLayout(params: Readonly<{
  componentId: FirstPartyComponentId;
  channel?: PublicReleaseRingId;
  releaseRing?: PublicReleaseRingId;
  processEnv?: Readonly<Record<string, string | undefined>>;
}>): FirstPartyInstallLayout {
  const processEnv = params.processEnv ?? process.env;
  const channel = params.channel ?? params.releaseRing ?? 'stable';
  const component = resolveFirstPartyComponentPublicReleaseVariant({
    componentId: params.componentId,
    channel,
  });
  const happyHomeDir = resolveFirstPartyInstallHomeDir(processEnv);
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

/** The home-wide activation lock's target (`<home>/first-party-activation`; lock file `.lock`). */
export function resolveFirstPartyActivationLockTarget(layout: Pick<FirstPartyInstallLayout, 'happyHomeDir'>): string {
  return joinPathForPathShape(layout.happyHomeDir, 'first-party-activation');
}

export function resolveFirstPartyVersionInstallPath(params: Readonly<{
  componentId: FirstPartyComponentId;
  versionId: string;
  channel?: PublicReleaseRingId;
  releaseRing?: PublicReleaseRingId;
  processEnv?: Readonly<Record<string, string | undefined>>;
}>): string {
  const layout = resolveFirstPartyInstallLayout({
    componentId: params.componentId,
    channel: params.channel,
    releaseRing: params.releaseRing,
    processEnv: params.processEnv,
  });
  assertValidFirstPartyVersionId(params.versionId);
  return joinPathForPathShape(layout.versionsDir, params.versionId);
}
