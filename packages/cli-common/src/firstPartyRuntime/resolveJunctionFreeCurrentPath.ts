import { joinPathForPathShape } from '../path/pathShape.js';
import type { FirstPartyInstallLayout } from './installLayout.js';
import { readInstalledVersionMarkersSync } from './versionMarkers.js';

function isSafeVersionMarkerSegment(value: string): boolean {
  return value.length > 0
    && value !== '.'
    && value !== '..'
    && !value.includes('/')
    && !value.includes('\\')
    && !value.includes('\0');
}

/**
 * Resolve a path that points at the **same logical location** as
 * `layout.currentPath` but bypasses the `<installRoot>/current` junction.
 *
 * Why this exists: on Windows, `<installRoot>/current` is created as an NTFS
 * junction (reparse point) pointing at `<installRoot>/versions/<id>`. Recent
 * Windows versions apply mount-point hardening — when the reparse point sits
 * in a user-writable directory, the kernel refuses to traverse it for
 * non-elevated processes that haven't opted in. The user-visible symptom is
 * that **every Node fs API silently fails through the junction**:
 *
 * - `fs.existsSync('cli-dev/current/<file>')` → `false`
 * - `fs.statSync(...)` → `UNKNOWN: unknown error, stat`
 * - `fs.realpathSync(...)` → `UNKNOWN: unknown error, stat`
 *
 * even though the file exists at the junction's target. This breaks every
 * caller that probes through `current/`: the runtime entrypoint resolver,
 * doctor inventory reads, process-owner quiescing, and similar filesystem
 * checks.
 *
 * This helper reads the `current.version` marker file (a plain text pointer
 * file maintained alongside the junction) and returns
 * `<installRoot>/versions/<currentVersionId>`, which IS a directly-accessible
 * directory on every platform. When the marker file is missing or empty we
 * fall back to `layout.currentPath` so callers on legacy installs (no
 * marker file yet) keep working.
 *
 * This is not the normal service-wrapper contract. Default-following services
 * should invoke the managed shim so they track upgrades. This helper is for
 * probe/read paths and for explicit fixed-version runtime paths only.
 */
export function resolveJunctionFreeCurrentPath(layout: FirstPartyInstallLayout): string | null {
  const markers = readInstalledVersionMarkersSync(layout);
  if (markers.currentVersionId && isSafeVersionMarkerSegment(markers.currentVersionId)) {
    return joinPathForPathShape(layout.versionsDir, markers.currentVersionId);
  }
  return layout.currentPath || null;
}
