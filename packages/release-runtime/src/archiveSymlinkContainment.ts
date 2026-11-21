/**
 * Pure cross-runtime archive symlink containment.
 *
 * Node release extraction, web/native/desktop clients and the Happier Runner package assembler
 * share this one stepwise symlink decision; platform adapters own byte acquisition, file sinks
 * and link creation. Nothing here touches the filesystem, the network, Node crypto or the
 * Node `Buffer` global.
 */

// Resolution follows links declared by the SAME archive, so a cycle (`a -> b`, `b -> a`) would
// otherwise never terminate. Matches the SYMLOOP_MAX that kernels apply for the same reason.
export const MAX_SYMLINK_RESOLUTION_HOPS = 40;

export class ArchiveSymlinkTargetOutsideRootError extends Error {
  readonly code = 'archive-symlink-target-outside-root';

  constructor(message: string) {
    super(`[release-runtime] ${message}`);
    this.name = 'ArchiveSymlinkTargetOutsideRootError';
  }
}

function splitPortableSymlinkTarget(rawTarget: string, linkPath: string): readonly string[] {
  if (rawTarget.length === 0) {
    throw new Error(`[release-runtime] archive symlink has an empty target: ${linkPath}`);
  }
  if (rawTarget.includes('\u0000')) {
    throw new Error(`[release-runtime] archive symlink target contains a NUL byte: ${linkPath}`);
  }
  if (rawTarget.includes('\\')) {
    throw new Error(
      `[release-runtime] archive symlink target has a non-portable separator: ${linkPath} -> ${rawTarget}`,
    );
  }
  if (rawTarget.startsWith('/') || /^[a-z]:/iu.test(rawTarget)) {
    throw new ArchiveSymlinkTargetOutsideRootError(
      `archive symlink target is absolute: ${linkPath} -> ${rawTarget}`,
    );
  }
  return rawTarget.split('/');
}

/**
 * Containment rule for one symlink target, resolved the way the kernel resolves a path.
 *
 * Lexical containment of each link IN ISOLATION is not sufficient: `a/b/hop -> ../..` lands exactly
 * on the root, and `a/b/escape -> hop/../../x` is lexically contained too, yet following `hop`
 * first and only then applying `..` lands ABOVE the root. So `..` is resolved against the
 * accumulated stack and any component that the same archive declares as a symlink is FOLLOWED,
 * bounded by `MAX_SYMLINK_RESOLUTION_HOPS`. If the stack is ever popped past empty, the target
 * escapes and the archive is rejected.
 *
 * Lookups are case-folded to match the case-insensitive collision key the path validator already
 * enforces, so a target written in a different case cannot dodge the link graph on a
 * case-insensitive filesystem.
 */
function resolveSingleArchiveSymlinkTarget(params: Readonly<{
  linkPath: string;
  rawTarget: string;
  targetsByFoldedPath: ReadonlyMap<string, string>;
}>): string {
  const resolvedSegments = params.linkPath.split('/');
  resolvedSegments.pop();
  let pendingSegments: string[] = [...splitPortableSymlinkTarget(params.rawTarget, params.linkPath)];
  let followedLinks = 0;

  while (pendingSegments.length > 0) {
    const segment = pendingSegments.shift()!;
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (resolvedSegments.length === 0) {
        throw new ArchiveSymlinkTargetOutsideRootError(
          `archive symlink target leaves the extraction root: ${params.linkPath} -> ${params.rawTarget}`,
        );
      }
      resolvedSegments.pop();
      continue;
    }
    resolvedSegments.push(segment);
    const nestedTarget = params.targetsByFoldedPath.get(resolvedSegments.join('/').normalize('NFC').toLowerCase());
    if (nestedTarget === undefined) continue;
    followedLinks += 1;
    if (followedLinks > MAX_SYMLINK_RESOLUTION_HOPS) {
      throw new Error(
        `[release-runtime] archive symlink target does not resolve: ${params.linkPath} -> ${params.rawTarget}`,
      );
    }
    resolvedSegments.pop();
    pendingSegments = [
      ...splitPortableSymlinkTarget(nestedTarget, params.linkPath),
      ...pendingSegments,
    ];
  }
  return resolvedSegments.join('/');
}

/**
 * Resolve every declared symlink to its stepwise final target, proving containment first.
 * The returned map preserves the input iteration order; an empty string denotes the archive
 * root itself, which exists as the extraction directory. Throws with the same
 * `[release-runtime]` containment errors the Node extractor enforces.
 */
export function resolveArchiveSymlinkTargets(
  targetsByPortablePath: ReadonlyMap<string, string>,
): Map<string, string> {
  const targetsByFoldedPath = new Map<string, string>();
  for (const [portablePath, rawTarget] of targetsByPortablePath) {
    targetsByFoldedPath.set(portablePath.normalize('NFC').toLowerCase(), rawTarget);
  }
  const resolved = new Map<string, string>();
  for (const [linkPath, rawTarget] of targetsByPortablePath) {
    resolved.set(
      linkPath,
      resolveSingleArchiveSymlinkTarget({ linkPath, rawTarget, targetsByFoldedPath }),
    );
  }
  return resolved;
}

export function assertArchiveSymlinkTargetsAreContained(
  targetsByPortablePath: ReadonlyMap<string, string>,
): void {
  resolveArchiveSymlinkTargets(targetsByPortablePath);
}
