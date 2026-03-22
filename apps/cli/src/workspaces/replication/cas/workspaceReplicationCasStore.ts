import { createReadStream } from 'node:fs';
import { access } from 'node:fs/promises';

import {
  createWorkspaceReplicationPaths,
  resolveWorkspaceReplicationCasBlobPath,
} from '../state/workspaceReplicationPaths';
import {
  writeWorkspaceReplicationCasBlob,
  type WriteWorkspaceReplicationCasBlobResult,
} from './writeWorkspaceReplicationCasBlob';

export type WorkspaceReplicationCasStore = Readonly<{
  contains: (digest: string) => Promise<boolean>;
  commitFile: (input: Readonly<{ digest: string; sourcePath: string }>) => Promise<WriteWorkspaceReplicationCasBlobResult>;
  openReadStream: (digest: string) => ReturnType<typeof createReadStream>;
  resolveBlobPath: (digest: string) => string;
}>;

export function createWorkspaceReplicationCasStore(input: Readonly<{
  activeServerDir: string;
}>): WorkspaceReplicationCasStore {
  const paths = createWorkspaceReplicationPaths({
    activeServerDir: input.activeServerDir,
  });

  function resolveBlobPath(digest: string): string {
    return resolveWorkspaceReplicationCasBlobPath({
      casDirectory: paths.casDirectory,
      digest,
    });
  }

  return {
    async contains(digest) {
      try {
        await access(resolveBlobPath(digest));
        return true;
      } catch {
        return false;
      }
    },
    async commitFile(params) {
      return await writeWorkspaceReplicationCasBlob({
        digest: params.digest,
        sourcePath: params.sourcePath,
        blobPath: resolveBlobPath(params.digest),
      });
    },
    openReadStream(digest) {
      return createReadStream(resolveBlobPath(digest));
    },
    resolveBlobPath,
  };
}
