import { readdir } from 'node:fs/promises';

import type { PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

import { compareVersions } from '../update/index.js';
import type { FirstPartyComponentId } from './componentCatalog.js';
import { resolveFirstPartyInstallLayout } from './installLayout.js';

export async function listInstalledVersionIdsNewestFirst(params: Readonly<{
  componentId: FirstPartyComponentId;
  channel?: PublicReleaseRingId;
  releaseRing?: PublicReleaseRingId;
  processEnv?: NodeJS.ProcessEnv;
}>): Promise<string[]> {
  const layout = resolveFirstPartyInstallLayout({
    componentId: params.componentId,
    channel: params.channel,
    releaseRing: params.releaseRing,
    processEnv: params.processEnv,
  });
  const entries = await readdir(layout.versionsDir, { withFileTypes: true }).catch(() => []);

  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => compareVersions(right, left));
}
