import { describe, expect, it } from 'vitest';

import { buildWorkspaceManifestEntry } from './buildWorkspaceManifestEntry';

function createStats(kind: 'file' | 'directory' | 'symlink', options?: Readonly<{ mode?: number; size?: number }>) {
  return {
    mode: options?.mode ?? 0o100644,
    size: options?.size ?? 0,
    isDirectory: () => kind === 'directory',
    isFile: () => kind === 'file',
    isSymbolicLink: () => kind === 'symlink',
  };
}

describe('buildWorkspaceManifestEntry', () => {
  it('builds a file entry with digest, size, and executable metadata', () => {
    expect(buildWorkspaceManifestEntry({
      relativePath: './bin/run.sh',
      stats: createStats('file', { mode: 0o100755, size: 42 }),
      fileDigest: 'sha256:file',
    })).toEqual({
      digest: 'sha256:file',
      executable: true,
      kind: 'file',
      relativePath: 'bin/run.sh',
      sizeBytes: 42,
    });
  });

  it('builds directory and symlink entries without file payload metadata', () => {
    expect(buildWorkspaceManifestEntry({
      relativePath: 'src',
      stats: createStats('directory'),
    })).toEqual({
      kind: 'directory',
      relativePath: 'src',
    });

    expect(buildWorkspaceManifestEntry({
      relativePath: 'current',
      stats: createStats('symlink'),
      symlinkTarget: './releases/current',
    })).toEqual({
      kind: 'symlink',
      relativePath: 'current',
      target: './releases/current',
    });
  });

  it('rejects unsafe relative paths and missing kind-specific metadata', () => {
    expect(() => buildWorkspaceManifestEntry({
      relativePath: '../outside.txt',
      stats: createStats('file', { size: 1 }),
      fileDigest: 'sha256:file',
    })).toThrow('Workspace manifest path must stay within the workspace root');

    expect(() => buildWorkspaceManifestEntry({
      relativePath: 'README.md',
      stats: createStats('file', { size: 1 }),
    })).toThrow('Workspace manifest file entries require a digest');

    expect(() => buildWorkspaceManifestEntry({
      relativePath: 'current',
      stats: createStats('symlink'),
    })).toThrow('Workspace manifest symlink entries require a target');
  });
});
