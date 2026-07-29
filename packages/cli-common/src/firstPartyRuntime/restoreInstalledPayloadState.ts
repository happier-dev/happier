import { lstat, rename, rm } from 'node:fs/promises';

import type { FirstPartyInstallLayout } from './installLayout.js';
import { joinPathForPathShape } from '../path/pathShape.js';
import { syncInstalledPayloadPointer } from './syncInstalledPayloadPointer.js';
import { writeInstalledVersionMarker } from './versionMarkers.js';

export type InstalledPayloadStateSnapshot = Readonly<{
  currentVersionId: string | null;
  previousVersionId: string | null;
  currentPathWasPresent?: boolean;
  unversionedCurrentBackupPath?: string | null;
  unversionedCurrentWasMoved?: boolean;
}>;

export class FirstPartyPayloadStateRestoreIncompleteError extends Error {
  readonly code = 'FIRST_PARTY_PAYLOAD_STATE_RESTORE_INCOMPLETE';
  readonly stateRestored = false;
  readonly mutationError: unknown;
  readonly restorationErrors: readonly unknown[];

  constructor(params: Readonly<{
    mutationError: unknown;
    restorationErrors: readonly unknown[];
  }>) {
    super('First-party payload mutation failed and the prior installed state could not be completely restored.', {
      cause: params.mutationError,
    });
    this.name = 'FirstPartyPayloadStateRestoreIncompleteError';
    this.mutationError = params.mutationError;
    this.restorationErrors = params.restorationErrors;
  }
}

async function pathExists(path: string): Promise<boolean> {
  return await lstat(path).then(() => true).catch(() => false);
}

async function restoreVersionPointer(params: Readonly<{
  layout: FirstPartyInstallLayout;
  pointerPath: string;
  versionId: string | null;
}>): Promise<void> {
  if (!params.versionId) {
    await rm(params.pointerPath, { recursive: true, force: true });
    return;
  }
  await syncInstalledPayloadPointer({
    layout: params.layout,
    pointerPath: params.pointerPath,
    versionPath: joinPathForPathShape(params.layout.versionsDir, params.versionId),
  });
}

export async function restoreInstalledPayloadState(params: Readonly<{
  layout: FirstPartyInstallLayout;
  snapshot: InstalledPayloadStateSnapshot;
}>): Promise<void> {
  const restorationErrors: unknown[] = [];
  const attempt = async (operation: () => Promise<void>): Promise<void> => {
    try {
      await operation();
    } catch (error) {
      restorationErrors.push(error);
    }
  };

  if (params.snapshot.unversionedCurrentWasMoved) {
    await attempt(async () => {
      const backupPath = params.snapshot.unversionedCurrentBackupPath;
      if (!backupPath || !(await pathExists(backupPath))) {
        throw new Error('The unversioned current payload backup is missing.');
      }
      await rm(params.layout.currentPath, { recursive: true, force: true });
      await rename(backupPath, params.layout.currentPath);
    });
  } else if (params.snapshot.currentVersionId) {
    await attempt(async () => await restoreVersionPointer({
      layout: params.layout,
      pointerPath: params.layout.currentPath,
      versionId: params.snapshot.currentVersionId,
    }));
  } else if (params.snapshot.currentPathWasPresent !== true) {
    await attempt(async () => await rm(params.layout.currentPath, {
      recursive: true,
      force: true,
    }));
  }

  await attempt(async () => await restoreVersionPointer({
    layout: params.layout,
    pointerPath: params.layout.previousPath,
    versionId: params.snapshot.previousVersionId,
  }));
  await attempt(async () => await writeInstalledVersionMarker({
    layout: params.layout,
    marker: 'current',
    versionId: params.snapshot.currentVersionId,
  }));
  await attempt(async () => await writeInstalledVersionMarker({
    layout: params.layout,
    marker: 'previous',
    versionId: params.snapshot.previousVersionId,
  }));

  if (restorationErrors.length > 0) {
    throw new AggregateError(
      restorationErrors,
      'The prior first-party payload state could not be completely restored.',
    );
  }
}

export async function restoreInstalledPayloadStateAfterFailure(params: Readonly<{
  layout: FirstPartyInstallLayout;
  snapshot: InstalledPayloadStateSnapshot;
  mutationError: unknown;
}>): Promise<never> {
  try {
    await restoreInstalledPayloadState({
      layout: params.layout,
      snapshot: params.snapshot,
    });
  } catch (restorationError) {
    const restorationErrors = restorationError instanceof AggregateError
      ? restorationError.errors
      : [restorationError];
    throw new FirstPartyPayloadStateRestoreIncompleteError({
      mutationError: params.mutationError,
      restorationErrors,
    });
  }
  throw params.mutationError;
}
