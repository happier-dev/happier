import { mkdir, readFile, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

import { z } from 'zod';

import { TransferEndpointCandidateSchema } from '@happier-dev/protocol';

import type { SessionHandoffProviderBundle } from '../types';
import { SessionHandoffProviderBundleSchema } from '../sessionHandoffProviderBundleSchema';
import { buildSessionHandoffProviderBundleTransferId } from '../sessionHandoffProviderBundleTransferPublication';
import {
  buildSessionHandoffWorkspaceManifestTransferId,
} from '../workspaceReplicationAdapter/sessionHandoffWorkspaceReplicationServerRouted';
import { writeWorkspaceReplicationManifestToFile } from '../workspaceReplicationAdapter/workspaceReplicationManifestFile';
import { resolveTransferPayloadManifestHash } from '@/machines/transfer/transferPayloadSource';
import { writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';

const SOURCE_EXPORT_SCHEMA_VERSION = 1 as const;

const ProviderBundleFileSchema = z.object({
  transferId: z.string().min(1),
  filePath: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  manifestHash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  endpointCandidates: z.array(TransferEndpointCandidateSchema).readonly().optional(),
}).strict();

const WorkspaceManifestFileSchema = z.object({
  transferId: z.string().min(1),
  filePath: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  manifestHash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  entriesCount: z.number().int().nonnegative(),
  fileDigestsCount: z.number().int().nonnegative(),
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
  workspaceSourceRootPath: z.string().min(1).optional(),
  providerBundle: ProviderBundleFileSchema.optional(),
  workspaceManifest: WorkspaceManifestFileSchema.optional(),
}).strict();

export type SessionHandoffSourceExportRecord = z.infer<typeof SourceExportRecordSchemaV1>;

function assertCanonicalSessionHandoffProviderBundle(providerBundle: SessionHandoffProviderBundle): void {
  // Keep this aligned with `createSessionHandoffProviderBundlePayloadSource(...)` so the durable
  // source export path can't accidentally reintroduce legacy provider-bundle fields.
  if (
    providerBundle.providerId === 'codex'
    && 'codexBackendMode' in (providerBundle as SessionHandoffProviderBundle & { codexBackendMode?: unknown })
    && (providerBundle as SessionHandoffProviderBundle & { codexBackendMode?: unknown }).codexBackendMode !== undefined
  ) {
    throw new Error('Invalid session handoff transfer payload');
  }
}

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

function resolveProviderBundleFilePath(activeServerDir: string, handoffId: string): string {
  return join(resolveHandoffDirectory(activeServerDir, handoffId), 'provider-bundle.json');
}

function resolveWorkspaceManifestFilePath(activeServerDir: string, handoffId: string): string {
  return join(resolveHandoffDirectory(activeServerDir, handoffId), 'workspace-manifest.txt');
}

function resolvePathRelativeToActiveServerDir(activeServerDir: string, filePath: string): string {
  const resolvedRoot = resolve(activeServerDir);
  const resolvedFile = resolve(filePath);
  const rel = relative(resolvedRoot, resolvedFile);
  if (rel.startsWith('..') || rel.includes(`..${sep}`)) {
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

export function createSessionHandoffSourceExportStore(input: Readonly<{ activeServerDir: string }>) {
  const activeServerDir = input.activeServerDir;

  return {
    async load(handoffIdRaw: string): Promise<SessionHandoffSourceExportRecord | null> {
      const handoffId = assertSafeHandoffId(handoffIdRaw);
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

      // Rehydrate persisted relative paths to absolute paths under activeServerDir.
      const record = parsed.data;
      try {
        return {
          ...record,
          ...(record.providerBundle
            ? {
                providerBundle: {
                  ...record.providerBundle,
                  filePath: resolvePersistedPathUnderActiveServerDir(activeServerDir, record.providerBundle.filePath),
                },
              }
            : {}),
          ...(record.workspaceManifest
            ? {
                workspaceManifest: {
                  ...record.workspaceManifest,
                  filePath: resolvePersistedPathUnderActiveServerDir(activeServerDir, record.workspaceManifest.filePath),
                },
              }
            : {}),
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
        ...(record.workspaceSourceRootPath ? { workspaceSourceRootPath: record.workspaceSourceRootPath } : {}),
        ...(record.providerBundle
          ? {
              providerBundle: {
                ...record.providerBundle,
                filePath: resolvePathRelativeToActiveServerDir(activeServerDir, record.providerBundle.filePath),
              },
            }
          : {}),
        ...(record.workspaceManifest
          ? {
              workspaceManifest: {
                ...record.workspaceManifest,
                filePath: resolvePathRelativeToActiveServerDir(activeServerDir, record.workspaceManifest.filePath),
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

    async writeProviderBundleFile(params: Readonly<{
      handoffId: string;
      providerBundle: SessionHandoffProviderBundle;
    }>): Promise<z.infer<typeof ProviderBundleFileSchema>> {
      const handoffId = assertSafeHandoffId(params.handoffId);
      assertCanonicalSessionHandoffProviderBundle(params.providerBundle);
      const directory = resolveHandoffDirectory(activeServerDir, handoffId);
      await mkdir(directory, { recursive: true });
      const filePath = resolveProviderBundleFilePath(activeServerDir, handoffId);
      const normalized = SessionHandoffProviderBundleSchema.parse(params.providerBundle);
      await atomicWriteJson(filePath, normalized);
      const stats = await stat(filePath);
      const manifestHash = await resolveTransferPayloadManifestHash({
        kind: 'file',
        filePath,
        sizeBytes: stats.size,
      });
      return {
        transferId: buildSessionHandoffProviderBundleTransferId(handoffId),
        filePath,
        sizeBytes: stats.size,
        manifestHash,
      };
    },

    async writeWorkspaceReplicationManifestFile(params: Readonly<{
      handoffId: string;
      manifest: Parameters<typeof writeWorkspaceReplicationManifestToFile>[0]['manifest'];
    }>): Promise<z.infer<typeof WorkspaceManifestFileSchema>> {
      const handoffId = assertSafeHandoffId(params.handoffId);
      const directory = resolveHandoffDirectory(activeServerDir, handoffId);
      await mkdir(directory, { recursive: true });
      const filePath = resolveWorkspaceManifestFilePath(activeServerDir, handoffId);
      const { sizeBytes } = await writeWorkspaceReplicationManifestToFile({ manifest: params.manifest, filePath });
      const manifestHash = await resolveTransferPayloadManifestHash({
        kind: 'file',
        filePath,
        sizeBytes,
      });

      const entriesCount = params.manifest.entries.length;
      const fileDigestsCount = params.manifest.entries.filter((entry) => entry.kind === 'file').length;
      return {
        transferId: buildSessionHandoffWorkspaceManifestTransferId({ handoffId }),
        filePath,
        sizeBytes,
        manifestHash,
        entriesCount,
        fileDigestsCount,
      };
    },
  };
}
