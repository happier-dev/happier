import { readFileSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { FirstPartyInstallLayout } from './installLayout.js';

const CURRENT_VERSION_MARKER_FILE = 'current.version';
const PREVIOUS_VERSION_MARKER_FILE = 'previous.version';

function resolveMarkerPath(layout: FirstPartyInstallLayout, markerFileName: string): string {
  return join(layout.installRoot, markerFileName);
}

async function readOptionalTrimmedFile(path: string): Promise<string | null> {
  try {
    const value = (await readFile(path, 'utf8')).trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function readOptionalTrimmedFileSync(path: string): string | null {
  try {
    const value = readFileSync(path, 'utf8').trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

export async function readInstalledVersionMarkers(layout: FirstPartyInstallLayout): Promise<{
  currentVersionId: string | null;
  previousVersionId: string | null;
}> {
  return {
    currentVersionId: await readOptionalTrimmedFile(resolveMarkerPath(layout, CURRENT_VERSION_MARKER_FILE)),
    previousVersionId: await readOptionalTrimmedFile(resolveMarkerPath(layout, PREVIOUS_VERSION_MARKER_FILE)),
  };
}

/**
 * Sync companion to `readInstalledVersionMarkers`. The runtime path resolver
 * needs to read these synchronously to derive a junction-free
 * `<installRoot>/versions/<currentVersionId>` path before any fs check runs —
 * see `resolveJunctionFreeCurrentPath`. This is the only sane way to query the
 * "current" install on Windows, where reparse-point trust mitigations make
 * `<installRoot>/current` traversal unreliable for `existsSync`/`statSync`.
 */
export function readInstalledVersionMarkersSync(layout: FirstPartyInstallLayout): {
  currentVersionId: string | null;
  previousVersionId: string | null;
} {
  return {
    currentVersionId: readOptionalTrimmedFileSync(resolveMarkerPath(layout, CURRENT_VERSION_MARKER_FILE)),
    previousVersionId: readOptionalTrimmedFileSync(resolveMarkerPath(layout, PREVIOUS_VERSION_MARKER_FILE)),
  };
}

export async function writeInstalledVersionMarker(params: Readonly<{
  layout: FirstPartyInstallLayout;
  marker: 'current' | 'previous';
  versionId: string | null;
}>): Promise<void> {
  const markerPath = resolveMarkerPath(
    params.layout,
    params.marker === 'current' ? CURRENT_VERSION_MARKER_FILE : PREVIOUS_VERSION_MARKER_FILE,
  );
  if (!params.versionId) {
    await rm(markerPath, { force: true });
    return;
  }
  await writeFile(markerPath, `${params.versionId}\n`, 'utf8');
}
