import { describe, expect, it } from 'vitest';

import type { WorkspaceManifest } from '@happier-dev/protocol';

import type { ScmSourceControllerWorkspaceExportArtifacts } from './workspaceExportArtifacts';
import {
  createWorkspaceSyncArtifacts,
  createWorkspaceSyncArtifactsFromManifest,
} from './workspaceSyncArtifacts';

function createManifest(entries: WorkspaceManifest['entries']): WorkspaceManifest {
  return {
    entries,
  };
}

function createWorkspaceExportArtifacts(
  input: Readonly<{
    manifest: WorkspaceManifest;
  }>,
): ScmSourceControllerWorkspaceExportArtifacts {
  return {
    manifest: input.manifest,
  };
}

describe('workspaceSyncArtifacts', () => {
  it('derives changed sync artifacts from manifest comparison without requiring inline file blobs', () => {
    const currentManifest = createManifest([
      {
        kind: 'directory',
        relativePath: 'src',
      },
      {
        kind: 'file',
        relativePath: 'README.md',
        digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        executable: false,
        sizeBytes: 8,
      },
      {
        kind: 'file',
        relativePath: 'src/old.ts',
        digest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        executable: false,
        sizeBytes: 4,
      },
    ]);
    const workspaceExportArtifacts = createWorkspaceExportArtifacts({
      manifest: createManifest([
        {
          kind: 'directory',
          relativePath: 'src',
        },
        {
          kind: 'file',
          relativePath: 'README.md',
          digest: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
          executable: false,
          sizeBytes: 12,
        },
        {
          kind: 'file',
          relativePath: 'src/new.ts',
          digest: 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
          executable: true,
          sizeBytes: 6,
        },
        {
          kind: 'symlink',
          relativePath: 'current-readme',
          target: 'README.md',
        },
      ]),
    });

    const syncArtifacts = createWorkspaceSyncArtifacts({
      currentManifest,
      workspaceExportArtifacts,
    });

    expect(syncArtifacts.comparison.hasChanges).toBe(true);
    expect(syncArtifacts.removedRelativePaths).toEqual(['src/old.ts']);
    expect(syncArtifacts.changedWorkspaceArtifacts.manifest.entries).toEqual([
      {
        kind: 'symlink',
        relativePath: 'current-readme',
        target: 'README.md',
      },
      {
        kind: 'file',
        relativePath: 'README.md',
        digest: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
        executable: false,
        sizeBytes: 12,
      },
      {
        kind: 'file',
        relativePath: 'src/new.ts',
        digest: 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
        executable: true,
        sizeBytes: 6,
      },
    ]);
  });

  it('returns an empty changed-artifact set when manifests are equivalent', () => {
    const currentManifest = createManifest([
      {
        kind: 'file',
        relativePath: 'README.md',
        digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        executable: false,
        sizeBytes: 8,
      },
    ]);
    const workspaceExportArtifacts = createWorkspaceExportArtifacts({
      manifest: createManifest([
        {
          kind: 'file',
          relativePath: 'README.md',
          digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          executable: false,
          sizeBytes: 8,
        },
      ]),
    });

    const syncArtifacts = createWorkspaceSyncArtifacts({
      currentManifest,
      workspaceExportArtifacts,
    });

    expect(syncArtifacts.comparison.hasChanges).toBe(false);
    expect(syncArtifacts.removedRelativePaths).toEqual([]);
    expect(syncArtifacts.changedWorkspaceArtifacts.manifest.entries).toEqual([]);
  });

  it('derives changed sync artifacts without inline blobs for manifest-only transfer inputs', () => {
    const currentManifest = createManifest([
      {
        kind: 'file',
        relativePath: 'README.md',
        digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        executable: false,
        sizeBytes: 8,
      },
    ]);
    const nextManifest = createManifest([
      {
        kind: 'file',
        relativePath: 'README.md',
        digest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        executable: false,
        sizeBytes: 12,
      },
      {
        kind: 'symlink',
        relativePath: 'current-readme',
        target: 'README.md',
      },
    ]);

    const syncArtifacts = createWorkspaceSyncArtifactsFromManifest({
      currentManifest,
      nextManifest,
    });

    expect(syncArtifacts.comparison.hasChanges).toBe(true);
    expect(syncArtifacts.removedRelativePaths).toEqual([]);
    expect(syncArtifacts.changedWorkspaceArtifacts.manifest.entries).toEqual([
      {
        kind: 'symlink',
        relativePath: 'current-readme',
        target: 'README.md',
      },
      {
        kind: 'file',
        relativePath: 'README.md',
        digest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        executable: false,
        sizeBytes: 12,
      },
    ]);
  });
});
