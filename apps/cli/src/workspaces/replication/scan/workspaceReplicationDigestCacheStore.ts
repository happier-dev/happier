import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { z } from 'zod';

import { writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';

import {
  createWorkspaceReplicationPaths,
  resolveWorkspaceReplicationRelationshipDirectory,
} from '../state/workspaceReplicationPaths';
import { WORKSPACE_REPLICATION_SCHEMA_VERSION } from '../state/workspaceReplicationSchemaVersion';

const WorkspaceReplicationDigestCacheEntrySchema = z
  .object({
    sizeBytes: z.number().int().min(0),
    mtimeMs: z.number().int().min(0),
    executable: z.boolean(),
    inode: z.number().int().min(0).optional(),
    device: z.number().int().min(0).optional(),
    digest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  })
  .strict();

const WorkspaceReplicationDigestCacheSchema = z
  .object({
    schemaVersion: z.literal(WORKSPACE_REPLICATION_SCHEMA_VERSION),
    entries: z.record(z.string().min(1), WorkspaceReplicationDigestCacheEntrySchema),
  })
  .strict();

export type WorkspaceReplicationDigestCache = z.infer<typeof WorkspaceReplicationDigestCacheSchema>;

export type WorkspaceReplicationDigestCacheStore = Readonly<{
  load: (relationshipId: string) => Promise<WorkspaceReplicationDigestCache | null>;
  save: (input: Readonly<{ relationshipId: string; entries: WorkspaceReplicationDigestCache['entries'] }>) => Promise<void>;
  resolveFilePath: (relationshipId: string) => string;
}>;

async function readWorkspaceReplicationDigestCache(path: string): Promise<WorkspaceReplicationDigestCache | null> {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = WorkspaceReplicationDigestCacheSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError?.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export function createWorkspaceReplicationDigestCacheStore(input: Readonly<{
  activeServerDir: string;
}>): WorkspaceReplicationDigestCacheStore {
  const paths = createWorkspaceReplicationPaths({
    activeServerDir: input.activeServerDir,
  });

  function resolveFilePath(relationshipId: string): string {
    return join(
      resolveWorkspaceReplicationRelationshipDirectory({
        relationshipsDirectory: paths.relationshipsDirectory,
        relationshipId,
      }),
      'digestCache',
      'cache.json',
    );
  }

  return {
    async load(relationshipId) {
      return await readWorkspaceReplicationDigestCache(resolveFilePath(relationshipId));
    },
    async save(input) {
      const cache = WorkspaceReplicationDigestCacheSchema.parse({
        schemaVersion: WORKSPACE_REPLICATION_SCHEMA_VERSION,
        entries: input.entries,
      });
      await mkdir(dirname(resolveFilePath(input.relationshipId)), { recursive: true });
      await writeJsonAtomic(resolveFilePath(input.relationshipId), cache);
    },
    resolveFilePath,
  };
}
