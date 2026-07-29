import type { ReadEntry } from 'tar';

import {
  createPortablePathCollisionRegistry,
  readPortablePathSegmentViolation,
} from '@happier-dev/protocol/filesystem/portablePathSegment';

import { PortableArchiveError } from './types';

const WINDOWS_DRIVE_PREFIX = /^[A-Za-z]:/u;

export type PortableEntryKind = 'file' | 'directory';

export type PortablePathRegistry = Readonly<{
  add(path: string, kind: PortableEntryKind): void;
}>;

function fail(code: 'archive_path_invalid' | 'archive_path_collision' | 'archive_root_invalid', message: string): never {
  throw new PortableArchiveError(code, message);
}

function describeUntrustedPath(path: string): string {
  const characters = Array.from(path);
  const prefix = characters.slice(0, 64).join('');
  return `${JSON.stringify(prefix)}${characters.length > 64 ? '…' : ''}`;
}

export function createPortablePathRegistry(): PortablePathRegistry {
  const registry = createPortablePathCollisionRegistry();

  return {
    add(path, kind) {
      const collision = registry.add(path, kind);
      if (collision) {
        fail(
          'archive_path_collision',
          `Archive path conflicts with ${collision.existingPath}: ${path}`,
        );
      }
    },
  };
}

function validateSegment(segment: string, rawPath: string): void {
  switch (readPortablePathSegmentViolation(segment)) {
    case null:
      return;
    case 'empty_or_traversal':
      fail('archive_path_invalid', `Archive contains an invalid path segment: ${describeUntrustedPath(rawPath)}`);
    case 'non_canonical_unicode':
    case 'non_portable_character':
      fail('archive_path_invalid', `Archive path is not portable: ${describeUntrustedPath(rawPath)}`);
    case 'non_portable_trailing_character':
      fail('archive_path_invalid', `Archive path has a non-portable trailing character: ${describeUntrustedPath(rawPath)}`);
    case 'reserved_windows_name':
      fail('archive_path_invalid', `Archive path uses a reserved Windows name: ${describeUntrustedPath(rawPath)}`);
    case 'segment_too_long':
      fail('archive_path_invalid', `Archive path segment exceeds portable filesystem limits: ${describeUntrustedPath(rawPath)}`);
  }
}

export function readPortableArchiveEntryPath(input: Readonly<{
  rawPath: string;
  expectedRootDirectory: string;
  entry: Pick<ReadEntry, 'type'>;
  maxPathBytes: number;
  maxPathDepth: number;
}>): Readonly<{ relativePath: string; kind: PortableEntryKind; isRootDirectory: boolean }> {
  const rawPath = input.rawPath.replace(/\/$/u, '');
  if (
    rawPath.length === 0
    || rawPath.startsWith('/')
    || rawPath.startsWith('\\')
    || rawPath.startsWith('//')
    || rawPath.includes('\\')
    || WINDOWS_DRIVE_PREFIX.test(rawPath)
  ) {
    fail('archive_path_invalid', `Archive path is absolute or ambiguous: ${describeUntrustedPath(input.rawPath)}`);
  }
  const rawSegments = rawPath.split('/');
  rawSegments.forEach((segment) => validateSegment(segment, input.rawPath));
  if (rawSegments[0] !== input.expectedRootDirectory) {
    fail('archive_root_invalid', `Archive entry is outside the required root: ${describeUntrustedPath(input.rawPath)}`);
  }

  const relativeSegments = rawSegments.slice(1);
  if (relativeSegments.length === 0) {
    if (input.entry.type !== 'Directory') {
      fail('archive_root_invalid', `Archive root must be a directory: ${describeUntrustedPath(input.rawPath)}`);
    }
    return { relativePath: '', kind: 'directory', isRootDirectory: true };
  }
  const relativePath = relativeSegments.join('/');
  const normalized = relativePath.normalize('NFC');
  if (relativePath !== normalized) {
    fail('archive_path_invalid', `Archive path must use canonical Unicode normalization: ${describeUntrustedPath(input.rawPath)}`);
  }
  if (Buffer.byteLength(normalized, 'utf8') > input.maxPathBytes) {
    throw new PortableArchiveError('archive_limit_path_bytes', `Archive path exceeds the byte limit: ${describeUntrustedPath(input.rawPath)}`);
  }
  if (relativeSegments.length > input.maxPathDepth) {
    throw new PortableArchiveError('archive_limit_path_depth', `Archive path exceeds the depth limit: ${describeUntrustedPath(input.rawPath)}`);
  }
  const kind = input.entry.type === 'Directory' ? 'directory' : 'file';
  return { relativePath: normalized, kind, isRootDirectory: false };
}
