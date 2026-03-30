import { readFile } from 'node:fs/promises';

import { z } from 'zod';

import { writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';

import {
  buildWorkspaceReplicationBaselineCacheKey,
  type WorkspaceReplicationBaselineScope,
} from './baselineCacheKeys';
import { ReplicationManifestFingerprintSchema, ReplicationManifestSchema } from '../replicationManifestSchema';
import { createWorkspaceReplicationRelationshipStore } from '../relationships/workspaceReplicationRelationshipStore';
import { workspaceReplicationModes } from '../relationships/relationshipScope';
import { WORKSPACE_REPLICATION_SCHEMA_VERSION } from '../state/workspaceReplicationSchemaVersion';

export const WorkspaceReplicationBaselineRecordSchema = z
  .object({
    manifestFingerprint: ReplicationManifestFingerprintSchema,
    manifest: ReplicationManifestSchema,
    savedAtMs: z.number().int().min(0),
  })
  .strict();
export type WorkspaceReplicationBaselineRecord = z.infer<typeof WorkspaceReplicationBaselineRecordSchema>;

const PersistedWorkspaceReplicationBaselineSchema = z
  .object({
    schemaVersion: z.literal(WORKSPACE_REPLICATION_SCHEMA_VERSION),
    cacheKey: z.string().regex(/^workspace-replication-baseline-v1-[a-f0-9]{64}$/u),
    scope: z.object({
      sourceMachineId: z.string().min(1),
      sourceWorkspaceRoot: z.string().min(1),
      targetMachineId: z.string().min(1),
      targetWorkspaceRoot: z.string().min(1),
      mode: z.enum(workspaceReplicationModes),
      ignorePatterns: z.array(z.string().min(1)).optional(),
    }).strict(),
    baseline: WorkspaceReplicationBaselineRecordSchema,
  })
  .strict();

export type WorkspaceReplicationBaselineStore = Readonly<{
  load: (scope: WorkspaceReplicationBaselineScope) => Promise<WorkspaceReplicationBaselineRecord | null>;
  save: (input: Readonly<{ scope: WorkspaceReplicationBaselineScope; baseline: WorkspaceReplicationBaselineRecord }>) => Promise<void>;
  resolveFilePath: (scope: WorkspaceReplicationBaselineScope) => string;
}>;

async function readPersistedWorkspaceReplicationBaseline(path: string) {
  try {
    const raw = await readFile(path, 'utf8');
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new Error(`Invalid workspace replication baseline record: ${path}`);
    }
    const parsed = PersistedWorkspaceReplicationBaselineSchema.safeParse(value);
    if (!parsed.success) {
      throw new Error(`Invalid workspace replication baseline record: ${path}`);
    }
    return parsed.data;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError?.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export function createWorkspaceReplicationBaselineStore(input: Readonly<{
  activeServerDir: string;
}>): WorkspaceReplicationBaselineStore {
  const relationships = createWorkspaceReplicationRelationshipStore({
    activeServerDir: input.activeServerDir,
  });

  function resolveFilePath(scope: WorkspaceReplicationBaselineScope): string {
    return relationships.resolveBaselinePath(scope);
  }

  return {
    async load(scope) {
      const persisted = await readPersistedWorkspaceReplicationBaseline(resolveFilePath(scope));
      return persisted?.baseline ?? null;
    },
    async save(params) {
      const cacheKey = buildWorkspaceReplicationBaselineCacheKey(params.scope);
      const baseline = WorkspaceReplicationBaselineRecordSchema.parse(params.baseline);
      await relationships.ensureRelationship(params.scope);
      await writeJsonAtomic(resolveFilePath(params.scope), {
        schemaVersion: WORKSPACE_REPLICATION_SCHEMA_VERSION,
        cacheKey,
        scope: params.scope,
        baseline,
      });
    },
    resolveFilePath,
  };
}
