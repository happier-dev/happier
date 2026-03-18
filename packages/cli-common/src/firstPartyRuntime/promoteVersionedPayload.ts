import { cp, mkdir, rm } from 'node:fs/promises';

import type { FirstPartyComponentId } from './componentCatalog.js';
import { resolveFirstPartyInstallLayout, resolveFirstPartyVersionInstallPath } from './installLayout.js';
import { syncInstalledPayloadPointer } from './syncInstalledPayloadPointer.js';
import { readInstalledVersionMarkers, writeInstalledVersionMarker } from './versionMarkers.js';

export interface FirstPartyPayloadPromotionResult {
  currentVersionId: string;
  previousVersionId: string | null;
  versionPath: string;
}

export async function promoteVersionedPayload(params: Readonly<{
  componentId: FirstPartyComponentId;
  versionId: string;
  stagedPayloadPath: string;
  processEnv?: NodeJS.ProcessEnv;
}>): Promise<FirstPartyPayloadPromotionResult> {
  const layout = resolveFirstPartyInstallLayout({
    componentId: params.componentId,
    processEnv: params.processEnv,
  });
  const versionPath = resolveFirstPartyVersionInstallPath({
    componentId: params.componentId,
    versionId: params.versionId,
    processEnv: params.processEnv,
  });
  const { currentVersionId, previousVersionId } = await readInstalledVersionMarkers(layout);

  await mkdir(layout.versionsDir, { recursive: true });
  await rm(versionPath, { recursive: true, force: true });
  await cp(params.stagedPayloadPath, versionPath, { recursive: true });

  let nextPreviousVersionId = previousVersionId;
  if (currentVersionId && currentVersionId !== params.versionId) {
    const currentVersionPath = resolveFirstPartyVersionInstallPath({
      componentId: params.componentId,
      versionId: currentVersionId,
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

  return {
    currentVersionId: params.versionId,
    previousVersionId: nextPreviousVersionId,
    versionPath,
  };
}
