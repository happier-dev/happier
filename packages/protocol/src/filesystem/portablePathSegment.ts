const WINDOWS_RESERVED_BASENAME =
  /^(?:(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?|clock\$|conin\$|conout\$)$/iu;
const WINDOWS_FORBIDDEN_CHARACTER = /[<>:"|?*]/u;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;
const MAX_PORTABLE_SEGMENT_BYTES = 255;
const MAX_WINDOWS_SEGMENT_UTF16_UNITS = 255;
const textEncoder = new TextEncoder();

export type PortablePathSegmentViolation =
  | 'empty_or_traversal'
  | 'non_canonical_unicode'
  | 'non_portable_character'
  | 'non_portable_trailing_character'
  | 'reserved_windows_name'
  | 'segment_too_long';

type PortablePathEntryKind = 'file' | 'directory';

type PortablePathCollision =
  | Readonly<{
      kind: 'duplicate_or_case_alias';
      existingPath: string;
    }>
  | Readonly<{
      kind: 'file_directory_conflict';
      existingPath: string;
    }>;

type PortablePathCollisionRegistry = Readonly<{
  add(path: string, kind: PortablePathEntryKind): PortablePathCollision | null;
}>;

/**
 * Returns the cross-platform filesystem violation for one path segment.
 *
 * This is the canonical segment policy shared by archive admission, durable
 * plugin storage, and author build-output planning. Callers retain ownership
 * of their boundary-specific error codes and messages.
 */
export function readPortablePathSegmentViolation(
  segment: string,
): PortablePathSegmentViolation | null {
  if (segment.length === 0 || segment === '.' || segment === '..') {
    return 'empty_or_traversal';
  }
  if (segment !== segment.normalize('NFC')) {
    return 'non_canonical_unicode';
  }
  if (CONTROL_CHARACTER.test(segment) || WINDOWS_FORBIDDEN_CHARACTER.test(segment)) {
    return 'non_portable_character';
  }
  if (segment.endsWith('.') || segment.endsWith(' ')) {
    return 'non_portable_trailing_character';
  }
  if (WINDOWS_RESERVED_BASENAME.test(segment)) {
    return 'reserved_windows_name';
  }
  if (
    textEncoder.encode(segment).byteLength > MAX_PORTABLE_SEGMENT_BYTES
    || segment.length > MAX_WINDOWS_SEGMENT_UTF16_UNITS
  ) {
    return 'segment_too_long';
  }
  return null;
}

/**
 * Returns whether a relative path uses the portable filesystem ABI.
 *
 * Portable relative paths use `/` as their only separator and apply the
 * canonical segment policy above to every component. Boundary schemas may
 * retain their own error messages while sharing this admission decision.
 */
export function isPortableRelativePath(path: string): boolean {
  return (
    path.length > 0
    && !path.startsWith('/')
    && !path.startsWith('\\')
    && !path.includes('\\')
    && path.split('/').every((segment) => readPortablePathSegmentViolation(segment) === null)
  );
}

/**
 * Returns the canonical comparison key for portable filesystem paths.
 *
 * Portable path collections use this key to reject aliases that would address
 * the same entry on a case-insensitive host filesystem.
 */
function portablePathCollisionKey(path: string): string {
  return path.normalize('NFC').toLowerCase();
}

/**
 * Tracks one portable filesystem tree and reports aliases or paths that would
 * require an existing file to become a directory.
 *
 * Callers validate individual relative paths before registering them. The
 * registry owns only collection-level identity and file/directory conflicts so
 * archive admission and generated artifact graphs cannot drift.
 */
export function createPortablePathCollisionRegistry(): PortablePathCollisionRegistry {
  const entriesByKey = new Map<string, Readonly<{
    path: string;
    kind: PortablePathEntryKind;
  }>>();
  const descendantPathByAncestorKey = new Map<string, string>();

  return {
    add(path, kind) {
      const key = portablePathCollisionKey(path);
      const exactOrAlias = entriesByKey.get(key);
      if (exactOrAlias) {
        return {
          kind: 'duplicate_or_case_alias',
          existingPath: exactOrAlias.path,
        };
      }

      const segments = key.split('/');
      for (let index = 1; index < segments.length; index += 1) {
        const ancestor = entriesByKey.get(segments.slice(0, index).join('/'));
        if (ancestor?.kind === 'file') {
          return {
            kind: 'file_directory_conflict',
            existingPath: ancestor.path,
          };
        }
      }

      if (kind === 'file') {
        const descendantPath = descendantPathByAncestorKey.get(key);
        if (descendantPath) {
          return {
            kind: 'file_directory_conflict',
            existingPath: descendantPath,
          };
        }
      }

      entriesByKey.set(key, { path, kind });
      for (let index = 1; index < segments.length; index += 1) {
        const ancestorKey = segments.slice(0, index).join('/');
        if (!descendantPathByAncestorKey.has(ancestorKey)) {
          descendantPathByAncestorKey.set(ancestorKey, path);
        }
      }
      return null;
    },
  };
}
