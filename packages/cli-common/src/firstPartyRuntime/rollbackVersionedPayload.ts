import { randomUUID } from 'node:crypto';
import { rename, rm, stat } from 'node:fs/promises';

import type { PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

import type { FirstPartyComponentId } from './componentCatalog.js';
import { resolveFirstPartyInstallLayout, resolveFirstPartyVersionInstallPath } from './installLayout.js';
import { restoreInstalledPayloadStateAfterFailure } from './restoreInstalledPayloadState.js';
import { syncInstalledPayloadPointer } from './syncInstalledPayloadPointer.js';
import { readInstalledVersionMarkers, writeInstalledVersionMarker } from './versionMarkers.js';
import { withFirstPartyPayloadMutationLock } from './withFirstPartyPayloadMutationLock.js';
import { joinPathForPathShape } from '../path/pathShape.js';

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
  return await withFirstPartyPayloadMutationLock({
    layout,
    operation: async () => await rollbackVersionedPayloadWithoutLock(params),
  });
}

async function rollbackVersionedPayloadWithoutLock(params: Readonly<{
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
  const currentPayloadExists = await stat(layout.currentPath)
    .then((entry) => entry.isDirectory())
    .catch(() => false);
  const unversionedCurrentBackupPath = !currentVersionId && currentPayloadExists
    ? joinPathForPathShape(
      layout.installRoot,
      `.current.rollback-${process.pid}-${randomUUID()}`,
    )
    : null;
  let unversionedCurrentWasMoved = false;
  try {
    if (unversionedCurrentBackupPath) {
      await rename(layout.currentPath, unversionedCurrentBackupPath);
      unversionedCurrentWasMoved = true;
    }

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
      await rm(layout.previousPath, { recursive: true, force: true });
      await writeInstalledVersionMarker({ layout, marker: 'previous', versionId: null });
    }
  } catch (error) {
    await restoreInstalledPayloadStateAfterFailure({
      layout,
      mutationError: error,
      snapshot: {
        currentVersionId,
        currentPathWasPresent: currentPayloadExists,
        previousVersionId,
        unversionedCurrentBackupPath,
        unversionedCurrentWasMoved,
      },
    });
  }

  if (unversionedCurrentBackupPath) {
    await rm(unversionedCurrentBackupPath, { recursive: true, force: true });
  }

  return {
    currentVersionId: previousVersionId,
    previousVersionId: currentVersionId ?? null,
  };
}
