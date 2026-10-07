import { createHash } from 'node:crypto';
import { lstat, rm } from 'node:fs/promises';
import { posix, win32 } from 'node:path';
import { z } from 'zod';
import type { StopSessionResult } from '@happier-dev/protocol';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import {
  ensureProtectedLocalStateDirectory,
  listProtectedLocalStateDirectory,
  publishProtectedLocalStateFileIfAbsent,
  readProtectedLocalStateFile,
  removeProtectedLocalStateFile,
  writeProtectedLocalStateFileAtomic,
  type ProtectedLocalStateOptions,
} from '@/utils/fs/protectedLocalState';
import { realpathWithAbsentSuffix } from '@/utils/path/physicalAncestorPath';
import { canonicalAbsolutePathsEqual, isCanonicalAbsolutePathInsideRoot } from '@/utils/path/expandHomeDirPath';
import { isTerminalHostPhysicallyRetiredStopResult } from '@/daemon/sessions/stopSessionContract';
import { SessionCreationCorrespondenceConflictError } from '@/api/session/sessionCreationCorrespondenceConflictError';

const RecordSchema = z.object({
  v: z.literal(1),
  origin: z.enum(['creation', 'handoff']),
  sessionCreationTag: z.string().min(1).nullable(),
  operationId: z.string().min(1).nullable(),
  sessionId: z.string().min(1).nullable(),
  committed: z.boolean().optional(),
  pendingRemoval: z.boolean().optional(),
}).strict().superRefine((record, ctx) => {
  if (record.origin === 'creation'
    ? record.sessionCreationTag === null || record.operationId !== null || record.committed !== undefined
    : record.operationId === null || record.sessionCreationTag !== null || record.sessionId === null) {
    ctx.addIssue({ code: 'custom', message: 'Invalid managed directory ownership origin' });
  }
});
const StoredRecordSchema = createStoredReadSchema(RecordSchema);
export type ManagedSessionDirectoryRecord = z.infer<typeof RecordSchema>;
export type ManagedSessionDirectoryAllocation = Readonly<{ allocationId: string; directory: string }>;
export type ManagedSessionDirectoryEntry = ManagedSessionDirectoryAllocation & ManagedSessionDirectoryRecord;
export type ManagedSessionDirectoryResolution =
  | ({ ok: true; created?: boolean } & ManagedSessionDirectoryAllocation)
  | { ok: false; errorCode: 'SESSION_DIRECTORY_MISSING' };
type StopSession = (sessionId: string) => Promise<StopSessionResult>;

function absent(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
}
function conflict(): Error {
  return new SessionCreationCorrespondenceConflictError();
}
const missing = (): ManagedSessionDirectoryResolution => ({ ok: false, errorCode: 'SESSION_DIRECTORY_MISSING' });

/** The daemon record, never a metadata marker or path prefix, authorizes filesystem effects. */
export function createManagedSessionDirectories(input: Readonly<{
  activeServerDir?: string;
  platform?: NodeJS.Platform;
  protection?: ProtectedLocalStateOptions;
}> = {}) {
  const platform = input.platform ?? process.platform;
  const paths = platform === 'win32' ? win32 : posix;
  const root = paths.join(input.activeServerDir ?? configuration.activeServerDir, 'session-directories');
  const owners = paths.join(root, '.owners');
  const protection: ProtectedLocalStateOptions = { ...input.protection, authority: 'owned' };
  const allocation = (identity: string): ManagedSessionDirectoryAllocation => {
    const allocationId = createHash('sha256').update(identity).digest('hex');
    return { allocationId, directory: paths.join(root, allocationId) };
  };
  const recordPath = (allocationId: string) => {
    if (!/^[a-f0-9]{64}$/u.test(allocationId)) throw new Error('Invalid managed allocation id');
    return paths.join(owners, `${allocationId}.json`);
  };
  const prepareForCreation = ({ sessionCreationTag }: Readonly<{ sessionCreationTag: string }>) => {
    if (!sessionCreationTag.trim()) throw conflict();
    return allocation(`creation:${sessionCreationTag}`);
  };
  const prepareForHandoff = ({ operationId }: Readonly<{ operationId: string }>) => {
    if (!operationId.trim()) throw conflict();
    return allocation(`handoff:${operationId}`);
  };
  const readRecord = async (allocationId: string): Promise<ManagedSessionDirectoryRecord | null> => {
    let contents: string;
    try { contents = await readProtectedLocalStateFile(recordPath(allocationId), protection); }
    catch (error) { if (absent(error)) return null; throw error; }
    const record = StoredRecordSchema.parse(JSON.parse(contents) as unknown);
    const expected = record.origin === 'creation'
      ? prepareForCreation({ sessionCreationTag: record.sessionCreationTag! })
      : prepareForHandoff({ operationId: record.operationId! });
    if (expected.allocationId !== allocationId) throw conflict();
    return record;
  };
  const writeRecord = async (allocationId: string, record: ManagedSessionDirectoryRecord) => {
    await writeProtectedLocalStateFileAtomic(recordPath(allocationId), JSON.stringify(RecordSchema.parse(record)), protection);
  };
  const publishRecord = async (target: ManagedSessionDirectoryAllocation, record: ManagedSessionDirectoryRecord) => {
    await ensureProtectedLocalStateDirectory(root, protection);
    await ensureProtectedLocalStateDirectory(owners, protection);
    return await publishProtectedLocalStateFileIfAbsent(recordPath(target.allocationId), JSON.stringify(record), protection);
  };
  const protectExistingOwnerDirectories = async (): Promise<void> => {
    // Reading ownership must not materialize an absent root. Existing private
    // directories have daemon-owned permissions, after the usual identity checks.
    for (const directory of [root, owners]) {
      try { await lstat(directory); }
      catch (error) { if (absent(error)) return; throw error; }
      await ensureProtectedLocalStateDirectory(directory, { ...protection, createIfMissing: false });
    }
  };
  const listRecords = async (): Promise<readonly ManagedSessionDirectoryEntry[]> => {
    let names: readonly string[];
    try {
      await protectExistingOwnerDirectories();
      names = await listProtectedLocalStateDirectory(owners, protection);
    } catch (error) { if (absent(error)) return []; throw error; }
    const result: ManagedSessionDirectoryEntry[] = [];
    for (const name of names) {
      if (!/^[a-f0-9]{64}\.json$/u.test(name)) continue;
      const allocationId = name.slice(0, -5);
      try {
        const record = await readRecord(allocationId);
        if (record) result.push({ ...record, allocationId, directory: paths.join(root, allocationId) });
      } catch (error) {
        logger.warn('[MANAGED SESSION DIRECTORY] Ownership record unavailable', { allocationId, error });
      }
    }
    return result;
  };
  const assertContained = async (target: ManagedSessionDirectoryAllocation): Promise<void> => {
    recordPath(target.allocationId);
    await lstat(root);
    await ensureProtectedLocalStateDirectory(root, { ...protection, createIfMissing: false });
    try {
      const stats = await lstat(target.directory);
      if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error('Managed allocation must be a directory, never a symlink');
    } catch (error) { if (!absent(error)) throw error; }
    const [physicalRoot, physicalDirectory] = await Promise.all([
      realpathWithAbsentSuffix(root), realpathWithAbsentSuffix(target.directory),
    ]);
    if (canonicalAbsolutePathsEqual(physicalRoot, physicalDirectory)
      || !isCanonicalAbsolutePathInsideRoot(physicalRoot, physicalDirectory, { platform })) {
      throw new Error('Managed allocation is outside its protected root');
    }
  };
  const materializeForFreshSpawn = async (request: Readonly<{ sessionCreationTag: string }>) => {
    const target = prepareForCreation(request);
    const created = await publishRecord(target, {
      v: 1, origin: 'creation', sessionCreationTag: request.sessionCreationTag, operationId: null, sessionId: null,
    });
    const record = await readRecord(target.allocationId);
    if (!record || record.origin !== 'creation' || record.sessionCreationTag !== request.sessionCreationTag || record.sessionId !== null || record.pendingRemoval) throw conflict();
    await assertContained(target);
    await ensureProtectedLocalStateDirectory(target.directory, protection);
    return { ...target, created };
  };
  const bind = async ({ allocationId, sessionId }: Readonly<{ allocationId: string; sessionId: string }>) => {
    if (!sessionId.trim()) throw conflict();
    const record = await readRecord(allocationId);
    if (!record || record.pendingRemoval || (record.sessionId !== null && record.sessionId !== sessionId)) throw conflict();
    if (record.sessionId === sessionId) return;
    await writeRecord(allocationId, { ...record, sessionId });
  };
  const resolveForSession = async (request: Readonly<{
    sessionId: string;
    sessionCreationTag?: string | null;
    path: string;
    approvedNewDirectoryCreation?: boolean;
    resumeRequestId?: string;
  }>): Promise<ManagedSessionDirectoryResolution> => {
    let record: ManagedSessionDirectoryEntry | null = null;
    try {
      // The path selects one candidate; only its protected owner record can
      // establish authority. Resume does not scan unrelated allocations.
      const allocationId = paths.basename(request.path).toLowerCase();
      const directory = paths.join(root, allocationId);
      if (/^[a-f0-9]{64}$/u.test(allocationId) && canonicalAbsolutePathsEqual(directory, request.path)) {
        await protectExistingOwnerDirectories();
        const candidate = await readRecord(allocationId);
        if (candidate && !candidate.pendingRemoval
          && (candidate.sessionId === request.sessionId || (candidate.sessionId === null && candidate.origin === 'creation'
            && candidate.sessionCreationTag === request.sessionCreationTag))) {
          record = { ...candidate, allocationId, directory };
        }
      }
      if (record) {
        await assertContained(record);
      }
    } catch (error) {
      logger.warn('[MANAGED SESSION DIRECTORY] Ownership could not be established', { sessionId: request.sessionId, error });
      return missing();
    }
    if (record) {
      if (record.sessionId === null) await bind({ allocationId: record.allocationId, sessionId: request.sessionId });
      if (request.approvedNewDirectoryCreation !== true) {
        try { await lstat(record.directory); }
        catch (error) { if (absent(error)) return missing(); throw error; }
      }
      // A proven, existing allocation may have been chmod'ed by its Agent.
      // Repair its owned protection without discarding files. Protection
      // failures are spawn failures, never a false missing-folder notice.
      try {
        await ensureProtectedLocalStateDirectory(record.directory, {
          ...protection, createIfMissing: request.approvedNewDirectoryCreation === true,
        });
      } catch (error) {
        if (absent(error)) return missing();
        throw error;
      }
      return { ok: true, allocationId: record.allocationId, directory: record.directory };
    }
    if (request.approvedNewDirectoryCreation !== true || !request.resumeRequestId?.trim()) return missing();
    const sessionCreationTag = `resume:${request.sessionId}:${request.resumeRequestId}`;
    const target = prepareForCreation({ sessionCreationTag });
    const existing = await readRecord(target.allocationId);
    if (existing && (existing.pendingRemoval || (existing.sessionId !== null && existing.sessionId !== request.sessionId))) return missing();
    const created = !existing
      ? (await materializeForFreshSpawn({ sessionCreationTag })).created
      : false;
    if (existing) {
      await assertContained(target);
      await ensureProtectedLocalStateDirectory(target.directory, protection);
    }
    try {
      await bind({ allocationId: target.allocationId, sessionId: request.sessionId });
    } catch (error) {
      // No spawn can consume this new replacement until preparation returns.
      // Preserve older allocations; compensate only the allocation made here.
      if (created) await removeAllocation(target.allocationId);
      throw error;
    }
    return { ok: true, ...target, created };
  };
  const markPendingRemoval = async (allocationId: string, error: unknown) => {
    logger.warn('[MANAGED SESSION DIRECTORY] Removal pending', { allocationId, error });
    try {
      const record = await readRecord(allocationId);
      if (record) await writeRecord(allocationId, { ...record, pendingRemoval: true });
    } catch (recordError) {
      logger.warn('[MANAGED SESSION DIRECTORY] Could not persist pending removal', { allocationId, error: recordError });
    }
  };
  const removeAllocation = async (allocationId: string): Promise<void> => {
    try {
      const record = await readRecord(allocationId);
      if (!record) return;
      const target = { allocationId, directory: paths.join(root, allocationId) };
      await assertContained(target);
      // Node owns transient filesystem retries; prolonged locks remain durable pending removals.
      await rm(target.directory, { recursive: true, force: true, maxRetries: 1 });
      await removeProtectedLocalStateFile(recordPath(allocationId), protection);
    } catch (error) { await markPendingRemoval(allocationId, error); }
  };
  const removeSessionRecords = async (sessionId: string, records: readonly ManagedSessionDirectoryEntry[], stopSession: StopSession) => {
    if (!records.length) return;
    try {
      const stopped = await stopSession(sessionId);
      if (stopped.status !== 'not_found' && !isTerminalHostPhysicallyRetiredStopResult(stopped)) {
        throw new Error('Tracked Session process could not be stopped');
      }
    } catch (error) {
      await Promise.all(records.map(record => markPendingRemoval(record.allocationId, error)));
      return;
    }
    for (const record of records) await removeAllocation(record.allocationId);
  };
  const removeForSession = async ({ sessionId, stopSession }: Readonly<{ sessionId: string; stopSession: StopSession }>) => {
    let records: readonly ManagedSessionDirectoryEntry[];
    try { records = (await listRecords()).filter(record => record.sessionId === sessionId); }
    catch (error) { logger.warn('[MANAGED SESSION DIRECTORY] Removal inventory unavailable', { sessionId, error }); return; }
    await removeSessionRecords(sessionId, records, stopSession);
  };
  const removeUnboundCreation = async ({ allocationId }: Readonly<{ allocationId: string }>) => {
    const record = await readRecord(allocationId);
    if (record?.origin === 'creation' && record.sessionId === null) await removeAllocation(allocationId);
  };
  const retryPendingRemovals = async ({ stopSession }: Readonly<{ stopSession: StopSession }>) => {
    const records = (await listRecords()).filter(record => record.pendingRemoval === true);
    for (const sessionId of new Set(records.flatMap(record => record.sessionId ? [record.sessionId] : []))) {
      await removeSessionRecords(sessionId, records.filter(record => record.sessionId === sessionId), stopSession);
    }
    for (const record of records) if (record.sessionId === null) await removeAllocation(record.allocationId);
  };
  const allocateForHandoff = async (request: Readonly<{ operationId: string; sessionId: string }>) => {
    const target = prepareForHandoff(request);
    const created = await publishRecord(target, {
      v: 1, origin: 'handoff', sessionCreationTag: null, operationId: request.operationId, sessionId: request.sessionId,
    });
    const record = await readRecord(target.allocationId);
    if (!record || record.origin !== 'handoff' || record.sessionId !== request.sessionId || record.pendingRemoval) throw conflict();
    await assertContained(target);
    await ensureProtectedLocalStateDirectory(target.directory, protection);
    return { ...target, created };
  };
  const commitHandoff = async (request: Readonly<{ operationId: string; sessionId: string }>) => {
    const target = prepareForHandoff(request);
    const record = await readRecord(target.allocationId);
    if (!record || record.origin !== 'handoff' || record.sessionId !== request.sessionId || record.pendingRemoval) throw conflict();
    await writeRecord(target.allocationId, { ...record, committed: true });
  };
  const abortHandoff = async (request: Readonly<{ operationId: string; sessionId: string }>) => {
    const target = prepareForHandoff(request);
    const record = await readRecord(target.allocationId);
    if (record?.origin === 'handoff' && record.sessionId === request.sessionId && record.committed !== true) await removeAllocation(target.allocationId);
  };
  const rollbackFreshSpawn = async ({ allocationId, created, sessionId }: Readonly<{ allocationId: string; created: boolean; sessionId?: string }>) => {
    if (!created) return;
    const record = await readRecord(allocationId);
    if (record?.origin !== 'creation') return;
    if (record.sessionId === null || (sessionId && record.sessionId === sessionId
      && record.sessionCreationTag?.startsWith(`resume:${sessionId}:`))) {
      await removeAllocation(allocationId);
    }
  };
  const prepareForSpawn = async (request: Readonly<{
    directory: string;
    sessionCreationTag?: string | null;
    existingSessionId?: string;
    freshSessionCreation?: boolean;
    approvedNewDirectoryCreation?: boolean;
    resumeRequestId?: string;
  }>): Promise<ManagedSessionDirectoryResolution & { created?: boolean; directoryCreated?: boolean }> => {
    if (!request.existingSessionId || request.freshSessionCreation === true) {
      if (!request.sessionCreationTag) return missing();
      const target = await materializeForFreshSpawn({ sessionCreationTag: request.sessionCreationTag });
      return { ok: true, ...target, directoryCreated: target.created };
    }
    return await resolveForSession({
      sessionId: request.existingSessionId,
      sessionCreationTag: request.sessionCreationTag,
      path: request.directory,
      approvedNewDirectoryCreation: request.approvedNewDirectoryCreation,
      resumeRequestId: request.resumeRequestId,
    });
  };
  return { prepareForCreation, materializeForFreshSpawn, bind, listRecords, resolveForSession, removeForSession,
    removeUnboundCreation, retryPendingRemovals, allocateForHandoff, commitHandoff, abortHandoff, rollbackFreshSpawn, prepareForSpawn };
}
export type ManagedSessionDirectories = ReturnType<typeof createManagedSessionDirectories>;
