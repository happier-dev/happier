import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, posix, relative, resolve, sep, win32 } from 'node:path';

import { z } from 'zod';

import { TransferEndpointCandidateSchema } from '@happier-dev/protocol/machines/transfer/transferStream';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { readPrivateBearerFile, replacePrivateBearerFile } from '@/daemon/privateBearerFile';
import { RequesterWorkAttributionV1Schema } from '@/daemon/lifecycle/requesterWorkAttribution';
import { configuration } from '@/configuration';

import type { SessionHandoffAgentBundle } from '../types';
import { writeSessionHandoffAgentBundleArtifact } from '../agentBundle/file';
import { buildSessionHandoffAgentBundleTransferId } from '../agentBundle/transferPublication';
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
  stateTransfer: z.enum(['transfer', 'existing']).optional(),
  exportedAtMs: z.number().int().nonnegative(),
  acceptedHandoffAuthorization: ExternalActionExecutionAuthorizationV1Schema.optional(),
  requesterSessionCredentialBinding: z.object({ sessionId: z.string().min(1),
    attribution: RequesterWorkAttributionV1Schema }).strict().optional(),
  agentBundle: AgentBundleFileSchema.optional(),
  workspaceSeed: z.object({
    transferId: z.string().min(1),
    files: z.record(z.string(), AgentBundleFileSchema),
    endpointCandidates: z.array(TransferEndpointCandidateSchema).readonly().optional(),
  }).strict().optional(),
}).strict();
const SourceExportStoredReadSchemaV1 = createStoredReadSchema(SourceExportRecordSchemaV1);

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
  // The accepted Home proof is private custody. Use the existing protection
  // owner for atomic publication and Windows DACLs as well as POSIX permissions.
  await replacePrivateBearerFile({ path: filePath, contents: JSON.stringify(payload) });
}

async function readPersistedSourceExportRecord(
  activeServerDir: string,
  handoffId: string,
): Promise<SessionHandoffSourceExportRecord | null> {
  const recordPath = resolveRecordPath(activeServerDir, handoffId);
  let raw: string;
  try {
    raw = await readPrivateBearerFile(recordPath);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    throw new Error('Invalid session handoff source export record');
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    throw new Error('Invalid session handoff source export record');
  }
  const parsed = SourceExportStoredReadSchemaV1.safeParse(parsedJson);
  if (!parsed.success) {
    throw new Error('Invalid session handoff source export record');
  }
  const record = parsed.data;
  const admission = record.acceptedHandoffAuthorization?.binding.handoffAdmission;
  if (record.acceptedHandoffAuthorization && (record.acceptedHandoffAuthorization.binding.actionId !== 'session.handoff'
    || record.acceptedHandoffAuthorization.binding.handoffContinuation || !admission
    || record.sessionId !== admission.sessionId || record.sourceMachineId !== admission.sourceMachineId
    || record.targetMachineId !== admission.targetMachineId)) throw new Error('Invalid session handoff source export authority');
  const credentialBinding = record.requesterSessionCredentialBinding;
  if (credentialBinding && (credentialBinding.sessionId !== record.sessionId
    || ![record.sourceMachineId, record.targetMachineId].includes(credentialBinding.attribution.machineId)
    || admission && (credentialBinding.attribution.accountId !== record.acceptedHandoffAuthorization!.binding.accountId
      || credentialBinding.attribution.machineId === admission.sourceMachineId
        && credentialBinding.attribution.installationId !== admission.sourceInstallationId
      || credentialBinding.attribution.machineId === admission.targetMachineId
        && credentialBinding.attribution.installationId !== admission.targetInstallationId))) {
    throw new Error('Invalid session handoff requester credential reference');
  }
  return parsed.data;
}

export function createSessionHandoffSourceExportStore(input: Readonly<{ activeServerDir: string; happyHomeDir?: string }>) {
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
      const previous = await readPersistedSourceExportRecord(activeServerDir, handoffId);
      const acceptedHandoffAuthorization = record.acceptedHandoffAuthorization ?? previous?.acceptedHandoffAuthorization;
      const requesterSessionCredentialBinding = record.requesterSessionCredentialBinding ?? previous?.requesterSessionCredentialBinding;
      if (requesterSessionCredentialBinding && (requesterSessionCredentialBinding.sessionId !== record.sessionId
        || ![record.sourceMachineId, record.targetMachineId].includes(requesterSessionCredentialBinding.attribution.machineId)
        || previous?.requesterSessionCredentialBinding
          && !sameStrictJsonValue(previous.requesterSessionCredentialBinding, requesterSessionCredentialBinding))) {
        throw new Error('Invalid session handoff requester credential reference');
      }
      if (acceptedHandoffAuthorization) {
        const root = acceptedHandoffAuthorization.binding;
        const admission = root.handoffAdmission;
        if (root.actionId !== 'session.handoff' || root.handoffContinuation || !admission
          || record.sessionId !== admission.sessionId || record.sourceMachineId !== admission.sourceMachineId
          || record.targetMachineId !== admission.targetMachineId
          || previous?.acceptedHandoffAuthorization
            && (!sameStrictJsonValue(previous.acceptedHandoffAuthorization, acceptedHandoffAuthorization)
              || previous.sessionId !== record.sessionId || previous.sourceMachineId !== record.sourceMachineId
              || previous.targetMachineId !== record.targetMachineId)) {
          throw new Error('Invalid session handoff source export authority');
        }
        if (requesterSessionCredentialBinding && (requesterSessionCredentialBinding.attribution.accountId !== root.accountId
          || requesterSessionCredentialBinding.attribution.machineId === admission.sourceMachineId
            && requesterSessionCredentialBinding.attribution.installationId !== admission.sourceInstallationId
          || requesterSessionCredentialBinding.attribution.machineId === admission.targetMachineId
            && requesterSessionCredentialBinding.attribution.installationId !== admission.targetInstallationId)) {
          throw new Error('Invalid session handoff requester credential reference');
        }
      }
      const payload: SessionHandoffSourceExportRecord = {
        t: 'session_handoff_source_export_v1',
        schemaVersion: SOURCE_EXPORT_SCHEMA_VERSION,
        handoffId,
        ...(record.sessionId ? { sessionId: record.sessionId } : {}),
        ...(record.sourceMachineId ? { sourceMachineId: record.sourceMachineId } : {}),
        ...(record.targetMachineId ? { targetMachineId: record.targetMachineId } : {}),
        ...(record.stateTransfer ? { stateTransfer: record.stateTransfer } : {}),
        exportedAtMs: record.exportedAtMs,
        ...(acceptedHandoffAuthorization ? { acceptedHandoffAuthorization } : {}),
        ...(requesterSessionCredentialBinding ? { requesterSessionCredentialBinding } : {}),
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

    async releaseTransferFiles(handoffIdRaw: string, options?: Readonly<{ preserveRequesterSessionCustody?: boolean }>): Promise<void> {
      const handoffId = assertSafeHandoffId(handoffIdRaw);
      const record = await readPersistedSourceExportRecord(activeServerDir, handoffId);
      if (record?.requesterSessionCredentialBinding && !options?.preserveRequesterSessionCustody
        && record.sourceMachineId !== record.targetMachineId) {
        const { retireRequesterSessionCredentialCustody } = await import('@/daemon/sessionEncryption/requesterSessionCredentials');
        if (!await retireRequesterSessionCredentialCustody({ happyHomeDir: input.happyHomeDir ?? configuration.happyHomeDir,
          ...record.requesterSessionCredentialBinding })) throw new Error('Session handoff requester credential release failed');
      }
      if (record?.agentBundle || record?.workspaceSeed || record?.requesterSessionCredentialBinding) {
        const { agentBundle: _releasedAgentBundle, workspaceSeed: _releasedWorkspaceSeed,
          requesterSessionCredentialBinding: _releasedRequesterCredentialBinding, ...durableRecord } = record;
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
