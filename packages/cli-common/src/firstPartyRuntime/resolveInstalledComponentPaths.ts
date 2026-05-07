import type { PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

import { joinPathForPathShape } from '../path/pathShape.js';
import type { FirstPartyComponentId } from './componentCatalog.js';
import { getFirstPartyComponentCatalogEntry } from './componentCatalog.js';
import { resolveFirstPartyInstallLayout } from './installLayout.js';
import { resolveJunctionFreeCurrentPath } from './resolveJunctionFreeCurrentPath.js';

/**
 * Paths describing a managed first-party component install.
 *
 * The two flavours of "current"-anchored paths are not interchangeable:
 *
 * - `currentPath`/`binaryPath`/`nodeEntrypointPath` go through the
 *   `<installRoot>/current` pointer. These are the right paths for shims and
 *   other "follow current across upgrades" references. On Windows they should
 *   not be used for Node fs probes because junction traversal can fail for
 *   non-elevated processes (see `resolveJunctionFreeCurrentPath` for the full
 *   rationale).
 * - `resolvedCurrentPath`/`resolvedBinaryPath`/`resolvedNodeEntrypointPath`
 *   bypass the junction by reading the `current.version` marker. These are
 *   the right paths to use for **fs probes** (existence, stat, read).
 *
 * Long-lived service definitions should normally invoke a managed shim (for
 * example `~/.happier/bin/hdev`) so they keep tracking upgrades. They should
 * not bake `resolved*` version paths unless the user explicitly requested a
 * fixed runtime path.
 *
 * On macOS and Linux the junction is a regular symlink and traversal works
 * fine, so the two sets of paths point at the same files; the distinction
 * exists primarily to make the Windows behaviour correct without requiring
 * each call site to know about the platform-specific quirk.
 *
 * When no version marker is present (legacy installs / fresh boxes), the
 * `resolved*` fields fall back to the `current*` fields so non-Windows and
 * pre-marker installs keep working.
 */
export interface InstalledFirstPartyComponentPaths {
  installRoot: string;
  currentPath: string;
  previousPath: string;
  versionsDir: string;
  binaryPath: string;
  nodeEntrypointPath: string | null;
  shimPaths: string[];
  resolvedCurrentPath: string | null;
  resolvedBinaryPath: string | null;
  resolvedNodeEntrypointPath: string | null;
}

export function resolveInstalledFirstPartyComponentPaths(params: Readonly<{
  componentId: FirstPartyComponentId;
  channel?: PublicReleaseRingId;
  releaseRing?: PublicReleaseRingId;
  processEnv?: NodeJS.ProcessEnv;
}>): InstalledFirstPartyComponentPaths {
  const layout = resolveFirstPartyInstallLayout({
    componentId: params.componentId,
    channel: params.channel,
    releaseRing: params.releaseRing,
    processEnv: params.processEnv,
  });
  const component = getFirstPartyComponentCatalogEntry(params.componentId);
  const binaryRelativePath =
    process.platform === 'win32'
      ? `${component.binaryRelativePath}.exe`
      : component.binaryRelativePath;
  const shimNames =
    process.platform === 'win32'
      ? layout.installShims.map((shimName) => `${shimName}.exe`)
      : layout.installShims;

  const resolvedCurrentPath = resolveJunctionFreeCurrentPath(layout);
  const resolvedBinaryPath = resolvedCurrentPath
    ? joinPathForPathShape(resolvedCurrentPath, binaryRelativePath)
    : null;
  const resolvedNodeEntrypointPath = resolvedCurrentPath && component.nodeEntrypointRelativePath
    ? joinPathForPathShape(resolvedCurrentPath, component.nodeEntrypointRelativePath)
    : null;

  return {
    installRoot: layout.installRoot,
    currentPath: layout.currentPath,
    previousPath: layout.previousPath,
    versionsDir: layout.versionsDir,
    binaryPath: joinPathForPathShape(layout.currentPath, binaryRelativePath),
    nodeEntrypointPath: component.nodeEntrypointRelativePath
      ? joinPathForPathShape(layout.currentPath, component.nodeEntrypointRelativePath)
      : null,
    shimPaths: shimNames.map((shimName) => joinPathForPathShape(layout.shimDir, shimName)),
    resolvedCurrentPath,
    resolvedBinaryPath,
    resolvedNodeEntrypointPath,
  };
}
