import { mkdir, readFile } from 'node:fs/promises';

import { z } from 'zod';

import { objectKey } from '@/utils/deterministicJson';
import { writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';

import {
  createWorkspaceReplicationPaths,
  resolveWorkspaceReplicationBaselinePath,
  resolveWorkspaceReplicationRelationshipDirectory,
  resolveWorkspaceReplicationRelationshipRecordPath,
} from '../state/workspaceReplicationPaths';
import { WORKSPACE_REPLICATION_SCHEMA_VERSION } from '../state/workspaceReplicationSchemaVersion';
import {
  normalizeWorkspaceReplicationDirectionScope,
  normalizeWorkspaceReplicationRelationshipScope,
  resolveWorkspaceReplicationRelationshipEndpoints,
  workspaceReplicationModes,
  type WorkspaceReplicationDirectionScope,
  type WorkspaceReplicationRelationshipScope,
} from './relationshipScope';

const WorkspaceReplicationRelationshipConfigSchema = z.object({
  mode: z.enum(workspaceReplicationModes),
  ignorePatterns: z.array(z.string().min(1)).optional(),
}).strict();

export const WorkspaceReplicationRelationshipRecordSchema = z.object({
  schemaVersion: z.literal(WORKSPACE_REPLICATION_SCHEMA_VERSION),
  relationshipId: z.string().regex(/^rel_[A-Za-z0-9_-]+$/u),
  endpoints: z.tuple([
    z.object({
      machineId: z.string().min(1),
      rootPath: z.string().min(1),
    }).strict(),
    z.object({
      machineId: z.string().min(1),
      rootPath: z.string().min(1),
    }).strict(),
  ]),
  config: WorkspaceReplicationRelationshipConfigSchema,
  createdAtMs: z.number().int().min(0),
  updatedAtMs: z.number().int().min(0),
}).strict();

export type WorkspaceReplicationRelationshipRecord = z.infer<typeof WorkspaceReplicationRelationshipRecordSchema>;

export type WorkspaceReplicationRelationshipStore = Readonly<{
  upsert: (input: Readonly<{
    scope: WorkspaceReplicationDirectionScope;
    now?: () => number;
  }>) => Promise<WorkspaceReplicationRelationshipRecord>;
  ensureRelationship: (scope: WorkspaceReplicationDirectionScope) => Promise<WorkspaceReplicationRelationshipRecord>;
  read: (relationshipId: string) => Promise<WorkspaceReplicationRelationshipRecord | null>;
  readByScope: (scope: WorkspaceReplicationDirectionScope) => Promise<WorkspaceReplicationRelationshipRecord | null>;
  readById: (relationshipId: string) => Promise<WorkspaceReplicationRelationshipRecord | null>;
  resolveFilePath: (relationshipId: string) => string;
  resolveRelationshipDirectory: (relationshipId: string) => string;
  resolveBaselinePath: (scope: WorkspaceReplicationDirectionScope) => string;
}>;

export function buildWorkspaceReplicationRelationshipId(scope: WorkspaceReplicationRelationshipScope): string {
  const normalized = normalizeWorkspaceReplicationRelationshipScope(scope);
  return `rel_${objectKey({
    endpoints: resolveWorkspaceReplicationRelationshipEndpoints(normalized),
    ...(normalized.mode ? { mode: normalized.mode } : {}),
    ...(normalized.ignorePatterns ? { ignorePatterns: normalized.ignorePatterns } : {}),
  })}`;
}

export function buildWorkspaceReplicationDirectionId(scope: WorkspaceReplicationDirectionScope): string {
  const normalized = normalizeWorkspaceReplicationDirectionScope(scope);
  return `dir_${objectKey({
    sourceMachineId: normalized.sourceMachineId,
    sourceWorkspaceRoot: normalized.sourceWorkspaceRoot,
    targetMachineId: normalized.targetMachineId,
    targetWorkspaceRoot: normalized.targetWorkspaceRoot,
    mode: normalized.mode,
    ...(normalized.ignorePatterns ? { ignorePatterns: normalized.ignorePatterns } : {}),
  })}`;
}

async function readWorkspaceReplicationRelationshipRecord(filePath: string): Promise<WorkspaceReplicationRelationshipRecord | null> {
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed = WorkspaceReplicationRelationshipRecordSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError?.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export function createWorkspaceReplicationRelationshipStore(input: Readonly<{
  activeServerDir: string;
}>): WorkspaceReplicationRelationshipStore {
  const paths = createWorkspaceReplicationPaths({
    activeServerDir: input.activeServerDir,
  });

  function resolveRelationshipDirectoryById(relationshipId: string): string {
    return resolveWorkspaceReplicationRelationshipDirectory({
      relationshipsDirectory: paths.relationshipsDirectory,
      relationshipId,
    });
  }

  function resolveFilePath(relationshipId: string): string {
    return resolveWorkspaceReplicationRelationshipRecordPath({
      relationshipDirectory: resolveRelationshipDirectoryById(relationshipId),
    });
  }

  async function read(relationshipId: string): Promise<WorkspaceReplicationRelationshipRecord | null> {
    return await readWorkspaceReplicationRelationshipRecord(resolveFilePath(relationshipId));
  }

  async function upsert(input: Readonly<{
    scope: WorkspaceReplicationDirectionScope;
    now?: () => number;
  }>): Promise<WorkspaceReplicationRelationshipRecord> {
    const normalizedScope = normalizeWorkspaceReplicationDirectionScope(input.scope);
    const relationshipId = buildWorkspaceReplicationRelationshipId(normalizedScope);
    const existing = await read(relationshipId);
    const now = input.now?.() ?? Date.now();
    const nextRecord = WorkspaceReplicationRelationshipRecordSchema.parse({
      schemaVersion: WORKSPACE_REPLICATION_SCHEMA_VERSION,
      relationshipId,
      endpoints: resolveWorkspaceReplicationRelationshipEndpoints(normalizedScope),
      config: {
        mode: normalizedScope.mode,
        ...(normalizedScope.ignorePatterns ? { ignorePatterns: normalizedScope.ignorePatterns } : {}),
      },
      createdAtMs: existing?.createdAtMs ?? now,
      updatedAtMs: now,
    });
    await mkdir(resolveRelationshipDirectoryById(relationshipId), { recursive: true });
    await writeJsonAtomic(resolveFilePath(relationshipId), nextRecord);
    return nextRecord;
  }

  async function readByScope(scope: WorkspaceReplicationDirectionScope): Promise<WorkspaceReplicationRelationshipRecord | null> {
    return await read(buildWorkspaceReplicationRelationshipId(scope));
  }

  function resolveBaselinePath(scope: WorkspaceReplicationDirectionScope): string {
    return resolveWorkspaceReplicationBaselinePath({
      relationshipDirectory: resolveRelationshipDirectoryById(buildWorkspaceReplicationRelationshipId(scope)),
      directionId: buildWorkspaceReplicationDirectionId(scope),
    });
  }

  return {
    upsert,
    async ensureRelationship(scope) {
      return await upsert({
        scope,
      });
    },
    read,
    readByScope,
    readById: read,
    resolveFilePath,
    resolveRelationshipDirectory: resolveRelationshipDirectoryById,
    resolveBaselinePath,
  };
}
