import { stat } from 'node:fs/promises';

import type { PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

import type { FirstPartyComponentId } from './componentCatalog.js';
import { resolveFirstPartyInstallLayout, resolveFirstPartyVersionInstallPath } from './installLayout.js';
import { syncInstalledPayloadPointer } from './syncInstalledPayloadPointer.js';
import { readInstalledVersionMarkers, writeInstalledVersionMarker } from './versionMarkers.js';

export interface FirstPartyRollbackResult {
  currentVersionId: string;
  previousVersionId: string | null;
}

async function assertVersionPathExists(versionPath: string): Promise<void> {
  await stat(versionPath);
}

export async function rollbackVersionedPayload(params: Readonly<{
  componentId: FirstPartyComponentId;
  channel?: PublicReleaseRingId;
  releaseRing?: PublicReleaseRingId;
  processEnv?: NodeJS.ProcessEnv;
}>): Promise<FirstPartyRollbackResult> {
  const layout = resolveFirstPartyInstallLayout({
    componentId: params.componentId,
    channel: params.channel,
    releaseRing: params.releaseRing,
    processEnv: params.processEnv,
  });
  const { currentVersionId, previousVersionId } = await readInstalledVersionMarkers(layout);
  if (!previousVersionId) {
    throw new Error('Cannot rollback first-party payload without a previous installed version');
  }

  const previousVersionPath = resolveFirstPartyVersionInstallPath({
    componentId: params.componentId,
    versionId: previousVersionId,
    channel: params.channel,
    releaseRing: params.releaseRing,
    processEnv: params.processEnv,
  });
  await assertVersionPathExists(previousVersionPath);
  await syncInstalledPayloadPointer({
    layout,
    pointerPath: layout.currentPath,
    versionPath: previousVersionPath,
  });
  await writeInstalledVersionMarker({
    layout,
    marker: 'current',
    versionId: previousVersionId,
  });

  if (currentVersionId) {
    const currentVersionPath = resolveFirstPartyVersionInstallPath({
      componentId: params.componentId,
      versionId: currentVersionId,
      channel: params.channel,
      releaseRing: params.releaseRing,
      processEnv: params.processEnv,
    });
    await assertVersionPathExists(currentVersionPath);
    await syncInstalledPayloadPointer({
      layout,
      pointerPath: layout.previousPath,
      versionPath: currentVersionPath,
    });
    await writeInstalledVersionMarker({
      layout,
      marker: 'previous',
      versionId: currentVersionId,
    });
  } else {
    await writeInstalledVersionMarker({ layout, marker: 'previous', versionId: null });
  }

  return {
    currentVersionId: previousVersionId,
    previousVersionId: currentVersionId ?? null,
  };
}
