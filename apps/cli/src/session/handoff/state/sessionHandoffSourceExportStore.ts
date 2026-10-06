import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, posix, relative, resolve, sep, win32 } from 'node:path';

import { z } from 'zod';

import { TransferEndpointCandidateSchema } from '@happier-dev/protocol/machines/transfer/transferStream';

import type { SessionHandoffAgentBundle } from '../types';
import { writeSessionHandoffAgentBundleArtifact } from '../agentBundle/file';
import { buildSessionHandoffAgentBundleTransferId } from '../agentBundle/transferPublication';
import { writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';
import { disposeTransferPayloadSource, resolveTransferPayloadManifestHash, resolveTransferPayloadSizeBytes } from '@/machines/transfer/transferPayloadSource';
import type { createWorkspaceSyncSeedExport } from '@/workspaces/sync/workspaceSyncSeedTransfer';

const SOURCE_EXPORT_SCHEMA_VERSION = 1 as const;

const AgentBundleFileSchema = z.object({
  transferId: z.string().min(1),
  filePath: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  manifestHash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  endpointCandidates: z.array(TransferEndpointCandidateSchema).readonly().optional(),
}).strict();

const SourceExportRecordSchemaV1 = z.object({
  t: z.literal('session_handoff_source_export_v1'),
  schemaVersion: z.literal(SOURCE_EXPORT_SCHEMA_VERSION),
  handoffId: z.string().min(1),
  sessionId: z.string().min(1).optional(),
  sourceMachineId: z.string().min(1).optional(),
  targetMachineId: z.string().min(1).optional(),
  exportedAtMs: z.number().int().nonnegative(),
  agentBundle: AgentBundleFileSchema.optional(),
  workspaceSeed: z.object({
    transferId: z.string().min(1),
    files: z.record(z.string(), AgentBundleFileSchema),
    endpointCandidates: z.array(TransferEndpointCandidateSchema).readonly().optional(),
  }).strict().optional(),
}).strict();

export type SessionHandoffSourceExportRecord = z.infer<typeof SourceExportRecordSchemaV1>;

function assertSafeHandoffId(handoffIdRaw: string): string {
  const handoffId = String(handoffIdRaw ?? '').trim();
  // Keep this conservative: handoff ids become directory names under activeServerDir.
  if (!handoffId || handoffId.length > 200) {
    throw new Error(`Invalid handoffId: ${handoffIdRaw}`);
  }
  if (!/^[A-Za-z0-9._-]+$/.test(handoffId)) {
    throw new Error(`Invalid handoffId: ${handoffIdRaw}`);
  }
  if (handoffId.includes('..')) {
    throw new Error(`Invalid handoffId: ${handoffIdRaw}`);
  }
  return handoffId;
}

function resolveHandoffDirectory(activeServerDir: string, handoffId: string): string {
  const safe = assertSafeHandoffId(handoffId);
  return join(activeServerDir, 'session-handoff', safe);
}

function resolveRecordPath(activeServerDir: string, handoffId: string): string {
  return join(resolveHandoffDirectory(activeServerDir, handoffId), 'source-export.json');
}

function resolveAgentBundleFilePath(activeServerDir: string, handoffId: string): string {
  return join(resolveHandoffDirectory(activeServerDir, handoffId), 'agent-bundle.bin');
}

function resolveReceivedAgentBundleFilePath(activeServerDir: string, handoffId: string): string {
  return join(resolveHandoffDirectory(activeServerDir, handoffId), 'received-agent-bundle.bin');
}

function resolvePathRelativeToActiveServerDir(activeServerDir: string, filePath: string): string {
  const resolvedRoot = resolve(activeServerDir);
  const resolvedFile = resolve(filePath);
  const rel = relative(resolvedRoot, resolvedFile);
  if (rel === '' || posix.isAbsolute(rel) || win32.isAbsolute(rel) || rel.startsWith('..') || rel.includes(`..${sep}`)) {
    // Fail closed: we only persist paths rooted under activeServerDir to avoid escape attacks and
    // to keep the record relocatable across runs.
    throw new Error(`Invalid handoff file path (outside activeServerDir): ${filePath}`);
  }
  return rel;
}

function resolvePersistedPathUnderActiveServerDir(activeServerDir: string, persistedPath: string): string {
  // Persisted paths are stored relative to activeServerDir, but treat the on-disk record as untrusted:
  // ensure the resolved absolute path does not escape activeServerDir before returning it.
  const absPath = resolve(activeServerDir, persistedPath);
  resolvePathRelativeToActiveServerDir(activeServerDir, absPath);
  return absPath;
}

async function atomicWriteJson(filePath: string, payload: unknown): Promise<void> {
  // Prefer the repo's shared atomic writer so daemon restarts never observe a truncated record.
  await writeJsonAtomic(filePath, payload);
}

async function readPersistedSourceExportRecord(
  activeServerDir: string,
  handoffId: string,
): Promise<SessionHandoffSourceExportRecord | null> {
  const recordPath = resolveRecordPath(activeServerDir, handoffId);
  let raw: string;
  try {
    raw = await readFile(recordPath, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    throw new Error('Invalid session handoff source export record');
  }
  const parsed = SourceExportRecordSchemaV1.safeParse(parsedJson);
  if (!parsed.success) {
    throw new Error('Invalid session handoff source export record');
  }
  return parsed.data;
}

export function createSessionHandoffSourceExportStore(input: Readonly<{ activeServerDir: string }>) {
  const activeServerDir = input.activeServerDir;

  return {
    async prepareReceivedAgentBundleFilePath(handoffIdRaw: string): Promise<string> {
      const handoffId = assertSafeHandoffId(handoffIdRaw);
      await mkdir(resolveHandoffDirectory(activeServerDir, handoffId), { recursive: true });
      return resolveReceivedAgentBundleFilePath(activeServerDir, handoffId);
    },

    async load(handoffIdRaw: string): Promise<SessionHandoffSourceExportRecord | null> {
      const handoffId = assertSafeHandoffId(handoffIdRaw);
      const persistedRecord = await readPersistedSourceExportRecord(activeServerDir, handoffId);
      if (!persistedRecord) return null;

      // Rehydrate persisted relative paths to absolute paths under activeServerDir.
      const record = persistedRecord;
      try {
        return {
          ...record,
          ...(record.agentBundle
            ? {
                agentBundle: {
                  ...record.agentBundle,
                  filePath: resolvePersistedPathUnderActiveServerDir(activeServerDir, record.agentBundle.filePath),
                },
              }
            : {}),
          ...(record.workspaceSeed ? { workspaceSeed: { ...record.workspaceSeed,
            files: Object.fromEntries(Object.entries(record.workspaceSeed.files).map(([id, file]) => [id, {
              ...file, filePath: resolvePersistedPathUnderActiveServerDir(activeServerDir, file.filePath),
            }])),
          } } : {}),
        };
      } catch {
        throw new Error('Invalid session handoff source export record');
      }
    },

    async save(record: Readonly<Omit<SessionHandoffSourceExportRecord, 't' | 'schemaVersion'>>): Promise<void> {
      const handoffId = assertSafeHandoffId(record.handoffId);
      const payload: SessionHandoffSourceExportRecord = {
        t: 'session_handoff_source_export_v1',
        schemaVersion: SOURCE_EXPORT_SCHEMA_VERSION,
        handoffId,
        ...(record.sessionId ? { sessionId: record.sessionId } : {}),
        ...(record.sourceMachineId ? { sourceMachineId: record.sourceMachineId } : {}),
        ...(record.targetMachineId ? { targetMachineId: record.targetMachineId } : {}),
        exportedAtMs: record.exportedAtMs,
        ...(record.workspaceSeed ? { workspaceSeed: { ...record.workspaceSeed,
          files: Object.fromEntries(Object.entries(record.workspaceSeed.files).map(([id, file]) => [id, {
            ...file, filePath: resolvePathRelativeToActiveServerDir(activeServerDir, file.filePath),
          }])),
        } } : {}),
        ...(record.agentBundle
          ? {
              agentBundle: {
                ...record.agentBundle,
                filePath: resolvePathRelativeToActiveServerDir(activeServerDir, record.agentBundle.filePath),
              },
            }
          : {}),
      };

      const parsed = SourceExportRecordSchemaV1.safeParse(payload);
      if (!parsed.success) {
        throw new Error('Invalid session handoff source export record');
      }

      await atomicWriteJson(resolveRecordPath(activeServerDir, handoffId), payload);
    },

    async writeAgentBundleFile(params: Readonly<{
      handoffId: string;
      agentBundle: SessionHandoffAgentBundle;
      onProgress?: (progress: Readonly<{ currentBytes: number; totalBytes: number }>) => void;
    }>): Promise<z.infer<typeof AgentBundleFileSchema>> {
      const handoffId = assertSafeHandoffId(params.handoffId);
      const directory = resolveHandoffDirectory(activeServerDir, handoffId);
      await mkdir(directory, { recursive: true });
      const filePath = resolveAgentBundleFilePath(activeServerDir, handoffId);
      const artifact = await writeSessionHandoffAgentBundleArtifact({
        agentBundle: params.agentBundle,
        filePath,
        ...(params.onProgress ? { onProgress: params.onProgress } : {}),
      });
      return {
        transferId: buildSessionHandoffAgentBundleTransferId(handoffId),
        filePath,
        ...artifact,
      };
    },

    async writeWorkspaceSeedFiles(params: Readonly<{
      handoffId: string;
      transferId: string;
      seed: Awaited<ReturnType<typeof createWorkspaceSyncSeedExport>>;
    }>): Promise<NonNullable<SessionHandoffSourceExportRecord['workspaceSeed']>> {
      const directory = join(resolveHandoffDirectory(activeServerDir, params.handoffId), 'workspace-seed');
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const files: Record<string, z.infer<typeof AgentBundleFileSchema>> = {};
      for (const transferId of [params.transferId, ...params.seed.blobTransferIds]) {
        const source = transferId === params.transferId ? params.seed.payloadSource
          : await params.seed.onDemandScope.resolvePayloadSourceOnOpen({ transferId, requestBody: undefined });
        try {
          const filePath = join(directory, createHash('sha256').update(transferId).digest('hex'));
          if (source.kind === 'buffer') await writeFile(filePath, source.payload, { mode: 0o600 });
          else await copyFile(source.filePath, filePath);
          files[transferId] = { transferId, filePath,
            sizeBytes: await resolveTransferPayloadSizeBytes(source), manifestHash: await resolveTransferPayloadManifestHash(source),
          };
        } finally { await disposeTransferPayloadSource(source); }
      }
      return { transferId: params.transferId, files };
    },

    async releaseTransferFiles(handoffIdRaw: string): Promise<void> {
      const handoffId = assertSafeHandoffId(handoffIdRaw);
      const record = await readPersistedSourceExportRecord(activeServerDir, handoffId);
      if (record?.agentBundle || record?.workspaceSeed) {
        const { agentBundle: _releasedAgentBundle, workspaceSeed: _releasedWorkspaceSeed, ...durableRecord } = record;
        await atomicWriteJson(resolveRecordPath(activeServerDir, handoffId), durableRecord);
      }
      await Promise.all([
        rm(resolveAgentBundleFilePath(activeServerDir, handoffId), { force: true }),
        rm(resolveReceivedAgentBundleFilePath(activeServerDir, handoffId), { force: true }),
        rm(join(resolveHandoffDirectory(activeServerDir, handoffId), 'workspace-seed'), { recursive: true, force: true }),
      ]);
    },

  };
}
