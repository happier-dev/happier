import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, stat } from 'node:fs/promises';

import type { PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

import type { FirstPartyComponentId } from './componentCatalog.js';
import { replaceRuntimePayloadTree } from './copyRuntimePayloadTree.js';
import { writeEmbeddedPublicReleaseRingMarker } from './embeddedPublicReleaseRingMarker.js';
import { resolveFirstPartyInstallLayout, resolveFirstPartyVersionInstallPath } from './installLayout.js';
import { restoreInstalledPayloadStateAfterFailure } from './restoreInstalledPayloadState.js';
import { syncInstalledPayloadPointer } from './syncInstalledPayloadPointer.js';
import { readInstalledVersionMarkers, writeInstalledVersionMarker } from './versionMarkers.js';
import { withFirstPartyPayloadMutationLock } from './withFirstPartyPayloadMutationLock.js';
import { joinPathForPathShape } from '../path/pathShape.js';

export interface FirstPartyPayloadPromotionResult {
  currentVersionId: string;
  previousVersionId: string | null;
  hadLegacyCurrentInstallWithoutVersionMarkers: boolean;
  versionPath: string;
}

export async function promoteVersionedPayload(params: Readonly<{
  componentId: FirstPartyComponentId;
  versionId: string;
  stagedPayloadPath: string;
  stagedPayloadAlreadyFiltered?: boolean;
  channel?: PublicReleaseRingId;
  releaseRing?: PublicReleaseRingId;
  processEnv?: NodeJS.ProcessEnv;
}>): Promise<FirstPartyPayloadPromotionResult> {
  const layout = resolveFirstPartyInstallLayout({
    componentId: params.componentId,
    channel: params.channel,
    releaseRing: params.releaseRing,
    processEnv: params.processEnv,
  });
  return await withFirstPartyPayloadMutationLock({
    layout,
    operation: async () => await promoteVersionedPayloadWithoutLock(params),
  });
}

export async function promoteVersionedPayloadWithoutLock(params: Readonly<{
  componentId: FirstPartyComponentId;
  versionId: string;
  stagedPayloadPath: string;
  stagedPayloadAlreadyFiltered?: boolean;
  channel?: PublicReleaseRingId;
  releaseRing?: PublicReleaseRingId;
  processEnv?: NodeJS.ProcessEnv;
}>): Promise<FirstPartyPayloadPromotionResult> {
  const layout = resolveFirstPartyInstallLayout({
    componentId: params.componentId,
    channel: params.channel,
    releaseRing: params.releaseRing,
    processEnv: params.processEnv,
  });
  const versionPath = resolveFirstPartyVersionInstallPath({
    componentId: params.componentId,
    versionId: params.versionId,
    channel: params.channel,
    releaseRing: params.releaseRing,
    processEnv: params.processEnv,
  });
  const { currentVersionId, previousVersionId } = await readInstalledVersionMarkers(layout);
  const currentPayloadExists = await stat(layout.currentPath)
    .then((entry) => entry.isDirectory())
    .catch(() => false);
  const hadLegacyCurrentInstallWithoutVersionMarkers = !currentVersionId && currentPayloadExists;
  const legacyCurrentBackupPath = hadLegacyCurrentInstallWithoutVersionMarkers
    ? joinPathForPathShape(
      layout.installRoot,
      `.current.rollback-${process.pid}-${randomUUID()}`,
    )
    : null;
  let legacyCurrentWasMoved = false;

  await mkdir(layout.versionsDir, { recursive: true });
  await replaceRuntimePayloadTree({
    sourcePath: params.stagedPayloadPath,
    destinationPath: versionPath,
    consumeSourcePath: true,
    sourcePathAlreadyFiltered: params.stagedPayloadAlreadyFiltered === true,
    existingDestinationPolicy: 'require-identical',
    onTempReady: async (tempPath) => {
      await writeEmbeddedPublicReleaseRingMarker({
        payloadRoot: tempPath,
        releaseRing: layout.channel,
      });
    },
  });

  let nextPreviousVersionId = previousVersionId;
  try {
    if (currentVersionId && currentVersionId !== params.versionId) {
      const currentVersionPath = resolveFirstPartyVersionInstallPath({
        componentId: params.componentId,
        versionId: currentVersionId,
        channel: params.channel,
        releaseRing: params.releaseRing,
        processEnv: params.processEnv,
      });
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
      nextPreviousVersionId = currentVersionId;
    } else if (!currentVersionId) {
      await rm(layout.previousPath, { recursive: true, force: true });
      await writeInstalledVersionMarker({ layout, marker: 'previous', versionId: null });
      nextPreviousVersionId = null;
    }

    if (legacyCurrentBackupPath) {
      await rm(legacyCurrentBackupPath, { recursive: true, force: true });
      await rename(layout.currentPath, legacyCurrentBackupPath);
      legacyCurrentWasMoved = true;
    }

    await syncInstalledPayloadPointer({
      layout,
      pointerPath: layout.currentPath,
      versionPath,
    });
    await writeInstalledVersionMarker({
      layout,
      marker: 'current',
      versionId: params.versionId,
    });
  } catch (error) {
    await restoreInstalledPayloadStateAfterFailure({
      layout,
      mutationError: error,
      snapshot: {
        currentVersionId,
        currentPathWasPresent: currentPayloadExists,
        previousVersionId,
        unversionedCurrentBackupPath: legacyCurrentBackupPath,
        unversionedCurrentWasMoved: legacyCurrentWasMoved,
      },
    });
  }

  if (legacyCurrentBackupPath) {
    await rm(legacyCurrentBackupPath, { recursive: true, force: true });
  }

  return {
    currentVersionId: params.versionId,
    previousVersionId: nextPreviousVersionId,
    hadLegacyCurrentInstallWithoutVersionMarkers,
    versionPath,
  };
}
