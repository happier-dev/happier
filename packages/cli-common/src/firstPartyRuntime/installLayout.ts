import type { PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

import { joinPathForPathShape } from '../path/pathShape.js';
import { resolveHappyHomeDirFromEnvironment } from '../agents/resolveHappyHomeDir.js';
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

const FIRST_PARTY_VERSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/u;
const FIRST_PARTY_VERSION_ID_MAX_LENGTH = 200;

export class InvalidFirstPartyVersionIdError extends Error {
  readonly code = 'FIRST_PARTY_VERSION_ID_INVALID';
  readonly versionId: string;

  constructor(versionId: string) {
    super(`Invalid first-party payload version id '${versionId}'. Expected one portable path segment.`);
    this.name = 'InvalidFirstPartyVersionIdError';
    this.versionId = versionId;
  }
}

export function assertValidFirstPartyVersionId(versionId: string): void {
  if (
    versionId.length === 0
    || versionId.length > FIRST_PARTY_VERSION_ID_MAX_LENGTH
    || !FIRST_PARTY_VERSION_ID_PATTERN.test(versionId)
  ) {
    throw new InvalidFirstPartyVersionIdError(versionId);
  }
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
  assertValidFirstPartyVersionId(params.versionId);
  return joinPathForPathShape(layout.versionsDir, params.versionId);
}
