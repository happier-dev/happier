import { createHash } from 'node:crypto';
import { lstat, rename, rm } from 'node:fs/promises';
import { posix, win32 } from 'node:path';
import { z } from 'zod/mini';
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
import { renameStoragePathNoReplace } from '@/storage/trash/renameStoragePath';
import { ensureExactUidDirectoryAccess, grantExactUidPathAccess, removeUnixPathTree, withPinnedUnixDirectory } from '@/utils/fs/unixPathAccess';
import type { WorkspaceMaterializedEntryAccess } from '@/scm/workspace/workspaceExportStaging/promoteStagedWorkspace';

const RecordSchema = z.strictObject({
  v: z.literal(1),
  origin: z.enum(['creation', 'handoff']),
  sessionCreationTag: z.nullable(z.string().check(z.minLength(1))),
  operationId: z.nullable(z.string().check(z.minLength(1))),
  sessionId: z.nullable(z.string().check(z.minLength(1))),
  payloadPlacement: z.optional(z.strictObject({
    root: z.string().check(z.minLength(1)),
    agentUid: z.number().check(z.int(), z.gte(1)),
  })),
  committed: z.optional(z.boolean()),
  pendingRemoval: z.optional(z.boolean()),
  inTrash: z.optional(z.strictObject({ payloadPath: z.string().check(z.minLength(1)) })),
}).check(z.superRefine((record, ctx) => {
  if (record.origin === 'creation'
    ? record.sessionCreationTag === null || record.operationId !== null || record.committed !== undefined
    : record.operationId === null || record.sessionCreationTag !== null || record.sessionId === null) {
    ctx.addIssue({ code: 'custom', message: 'Invalid managed directory ownership origin' });
  }
}));
const StoredRecordSchema = createStoredReadSchema(RecordSchema);
export type ManagedSessionDirectoryRecord = z.infer<typeof RecordSchema>;
export type ManagedSessionDirectoryPayloadPlacement = NonNullable<ManagedSessionDirectoryRecord['payloadPlacement']>;
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
export class ManagedSessionDirectoryTrashError extends Error {
  constructor(readonly code: 'owner_unavailable' | 'restore_path_unsupported' | 'restore_occupied') {
    super(code);
    this.name = 'ManagedSessionDirectoryTrashError';
  }
}

/** The daemon record, never a metadata marker or path prefix, authorizes filesystem effects. */
export function createManagedSessionDirectories(input: Readonly<{
  activeServerDir?: string;
  platform?: NodeJS.Platform;
  protection?: ProtectedLocalStateOptions;
  /** Already admitted native identity and Workspace root; ownership records stay private. */
  payloadPlacement?: ManagedSessionDirectoryPayloadPlacement;
}> = {}) {
  const platform = input.platform ?? process.platform;
  const paths = platform === 'win32' ? win32 : posix;
  const root = paths.join(input.activeServerDir ?? configuration.activeServerDir, 'session-directories');
  const owners = paths.join(root, '.owners');
  const protection: ProtectedLocalStateOptions = { ...input.protection, authority: 'owned' };
  const allocation = (identity: string): ManagedSessionDirectoryAllocation => {
    const allocationId = createHash('sha256').update(identity).digest('hex');
    return { allocationId, directory: paths.join(input.payloadPlacement?.root ?? root, allocationId) };
  };
  const recordedAllocation = (allocationId: string, record: ManagedSessionDirectoryRecord): ManagedSessionDirectoryAllocation => ({
    allocationId, directory: paths.join(record.payloadPlacement?.root ?? root, allocationId),
  });
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
  const listRecords = async (options: Readonly<{ includeTrashed?: boolean }> = {}): Promise<readonly ManagedSessionDirectoryEntry[]> => {
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
        if (record && (options.includeTrashed || !record.inTrash)) result.push({ ...record, ...recordedAllocation(allocationId, record) });
      } catch (error) {
        logger.warn('[MANAGED SESSION DIRECTORY] Ownership record unavailable', { allocationId, error });
      }
    }
    return result;
  };
  const assertContained = async (target: ManagedSessionDirectoryAllocation, placement?: ManagedSessionDirectoryPayloadPlacement): Promise<void> => {
    recordPath(target.allocationId);
    await lstat(root);
    await ensureProtectedLocalStateDirectory(root, { ...protection, createIfMissing: false });
    const payloadRoot = placement?.root ?? root;
    const rootInfo = await lstat(payloadRoot);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('Managed allocation root must be a directory, never a symlink');
    try {
      const stats = await lstat(target.directory);
      if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error('Managed allocation must be a directory, never a symlink');
    } catch (error) { if (!absent(error)) throw error; }
    const [physicalRoot, physicalDirectory] = await Promise.all([
      realpathWithAbsentSuffix(payloadRoot), realpathWithAbsentSuffix(target.directory),
    ]);
    if (canonicalAbsolutePathsEqual(physicalRoot, physicalDirectory)
      || !isCanonicalAbsolutePathInsideRoot(physicalRoot, physicalDirectory, { platform })) {
      throw new Error('Managed allocation is outside its protected root');
    }
  };
  const protectPayload = async (target: ManagedSessionDirectoryAllocation, placement?: ManagedSessionDirectoryPayloadPlacement, createIfMissing = true) => {
    if (placement && platform === 'linux') {
      await ensureExactUidDirectoryAccess({ path: target.directory, uid: placement.agentUid, createIfMissing });
      return;
    }
    await ensureProtectedLocalStateDirectory(target.directory, { ...protection, createIfMissing });
    if (placement) await grantExactUidPathAccess({ path: target.directory, uid: placement.agentUid,
      access: 'rwx', directory: true, inherit: true });
  };
  const prepareSeedEntryAccess = async (allocationId: string): Promise<WorkspaceMaterializedEntryAccess | undefined> => {
    const record = await readRecord(allocationId);
    if (!record) throw conflict();
    const uid = record.payloadPlacement?.agentUid;
    return uid === undefined ? undefined : async ({ path, directory, pinnedRoot }) => {
      const grant = pinnedRoot ? pinnedRoot.grantExactUidPathAccess : grantExactUidPathAccess;
      await grant({ path: pinnedRoot ? paths.relative(pinnedRoot.path, path) : path, uid, directory, access: 'owner', preservePermissions: true,
        ...(directory ? { inherit: true } : {}) });
    };
  };
  const materializeForFreshSpawn = async (request: Readonly<{ sessionCreationTag: string }>) => {
    const prepared = prepareForCreation(request);
    const created = await publishRecord(prepared, {
      v: 1, origin: 'creation', sessionCreationTag: request.sessionCreationTag, operationId: null, sessionId: null,
      ...(input.payloadPlacement ? { payloadPlacement: input.payloadPlacement } : {}),
    });
    const record = await readRecord(prepared.allocationId);
    if (!record || record.origin !== 'creation' || record.sessionCreationTag !== request.sessionCreationTag || record.sessionId !== null || record.pendingRemoval || record.inTrash) throw conflict();
    if (input.payloadPlacement && (!record.payloadPlacement
      || !canonicalAbsolutePathsEqual(record.payloadPlacement.root, input.payloadPlacement.root)
      || record.payloadPlacement.agentUid !== input.payloadPlacement.agentUid)) throw conflict();
    const target = recordedAllocation(prepared.allocationId, record);
    await assertContained(target, record.payloadPlacement);
    await protectPayload(target, record.payloadPlacement);
    return { ...target, created };
  };
  const bind = async ({ allocationId, sessionId }: Readonly<{ allocationId: string; sessionId: string }>) => {
    if (!sessionId.trim()) throw conflict();
    const record = await readRecord(allocationId);
    if (!record || record.pendingRemoval || record.inTrash || (record.sessionId !== null && record.sessionId !== sessionId)) throw conflict();
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
      if (/^[a-f0-9]{64}$/u.test(allocationId)) {
        await protectExistingOwnerDirectories();
        const candidate = await readRecord(allocationId);
        const target = candidate ? recordedAllocation(allocationId, candidate) : null;
        if (candidate && target && canonicalAbsolutePathsEqual(target.directory, request.path)
          && (!input.payloadPlacement || (candidate.payloadPlacement
            && canonicalAbsolutePathsEqual(candidate.payloadPlacement.root, input.payloadPlacement.root)
            && candidate.payloadPlacement.agentUid === input.payloadPlacement.agentUid))
          && !candidate.pendingRemoval && !candidate.inTrash
          && (candidate.sessionId === request.sessionId || (candidate.sessionId === null && candidate.origin === 'creation'
            && candidate.sessionCreationTag === request.sessionCreationTag))) {
          record = { ...candidate, ...target };
        }
      }
      if (record) {
        await assertContained(record, record.payloadPlacement);
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
        await protectPayload(record, record.payloadPlacement, request.approvedNewDirectoryCreation === true);
      } catch (error) {
        if (absent(error)) return missing();
        throw error;
      }
      return { ok: true, allocationId: record.allocationId, directory: record.directory };
    }
    if (request.approvedNewDirectoryCreation !== true || !request.resumeRequestId?.trim()) return missing();
    const sessionCreationTag = `resume:${request.sessionId}:${request.resumeRequestId}`;
    const prepared = prepareForCreation({ sessionCreationTag });
    const existing = await readRecord(prepared.allocationId);
    const target = existing ? recordedAllocation(prepared.allocationId, existing) : prepared;
    if (existing && (existing.pendingRemoval || existing.inTrash || (existing.sessionId !== null && existing.sessionId !== request.sessionId)
      || input.payloadPlacement && (!existing.payloadPlacement
        || !canonicalAbsolutePathsEqual(existing.payloadPlacement.root, input.payloadPlacement.root)
        || existing.payloadPlacement.agentUid !== input.payloadPlacement.agentUid))) return missing();
    const created = !existing
      ? (await materializeForFreshSpawn({ sessionCreationTag })).created
      : false;
    if (existing) {
      await assertContained(target, existing.payloadPlacement);
      await protectPayload(target, existing.payloadPlacement);
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
  const removeAllocation = async (allocationId: string, options: Readonly<{
    beforeEffect?: () => Promise<void>; throwOnFailure?: boolean; removeDirectory?: () => Promise<void>;
  }> = {}): Promise<void> => {
    try {
      const record = await readRecord(allocationId);
      if (!record) return;
      const target = recordedAllocation(allocationId, record);
      if (record.inTrash) {
        const info = await lstat(record.inTrash.payloadPath);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Managed allocation must be a directory, never a symlink');
      } else await assertContained(target, record.payloadPlacement);
      // Node owns transient filesystem retries; prolonged locks remain durable pending removals.
      await options.beforeEffect?.();
      const payloadPath = record.inTrash?.payloadPath ?? target.directory;
      if (record.payloadPlacement && platform === 'linux') await removeUnixPathTree(payloadPath);
      else if (options.removeDirectory) await options.removeDirectory();
      else await rm(payloadPath, { recursive: true, force: true, maxRetries: 1 });
      await removeProtectedLocalStateFile(recordPath(allocationId), protection);
    } catch (error) {
      // Storage has its own per-item receipt/re-check path; a rejected approval
      // re-check must not turn an untouched allocation into a pending removal.
      if (options.throwOnFailure) throw error;
      await markPendingRemoval(allocationId, error);
    }
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
    try { records = (await listRecords({ includeTrashed: true })).filter(record => record.sessionId === sessionId); }
    catch (error) { logger.warn('[MANAGED SESSION DIRECTORY] Removal inventory unavailable', { sessionId, error }); return; }
    await removeSessionRecords(sessionId, records, stopSession);
  };
  const removeUnboundCreation = async ({ allocationId }: Readonly<{ allocationId: string }>) => {
    const record = await readRecord(allocationId);
    if (record?.origin === 'creation' && record.sessionId === null) await removeAllocation(allocationId);
  };
  const retryPendingRemovals = async ({ stopSession }: Readonly<{ stopSession: StopSession }>) => {
    const records = (await listRecords({ includeTrashed: true })).filter(record => record.pendingRemoval === true);
    for (const sessionId of new Set(records.flatMap(record => record.sessionId ? [record.sessionId] : []))) {
      await removeSessionRecords(sessionId, records.filter(record => record.sessionId === sessionId), stopSession);
    }
    for (const record of records) if (record.sessionId === null) await removeAllocation(record.allocationId);
  };
  const allocateForHandoff = async (request: Readonly<{ operationId: string; sessionId: string }>) => {
    const target = prepareForHandoff(request);
    const created = await publishRecord(target, {
      v: 1, origin: 'handoff', sessionCreationTag: null, operationId: request.operationId, sessionId: request.sessionId,
      ...(input.payloadPlacement ? { payloadPlacement: input.payloadPlacement } : {}),
    });
    const record = await readRecord(target.allocationId);
    if (!record || record.origin !== 'handoff' || record.sessionId !== request.sessionId || record.pendingRemoval || record.inTrash) throw conflict();
    if (input.payloadPlacement && (!record.payloadPlacement
      || !canonicalAbsolutePathsEqual(record.payloadPlacement.root, input.payloadPlacement.root)
      || record.payloadPlacement.agentUid !== input.payloadPlacement.agentUid)) throw conflict();
    const retainedTarget = recordedAllocation(target.allocationId, record);
    await assertContained(retainedTarget, record.payloadPlacement);
    await protectPayload(retainedTarget, record.payloadPlacement);
    return { ...retainedTarget, created };
  };
  const commitHandoff = async (request: Readonly<{ operationId: string; sessionId: string }>) => {
    const target = prepareForHandoff(request);
    const record = await readRecord(target.allocationId);
    if (!record || record.origin !== 'handoff' || record.sessionId !== request.sessionId || record.pendingRemoval || record.inTrash) throw conflict();
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
  const requireAbsent = async (path: string) => {
    try { await lstat(path); }
    catch (error) { if (absent(error)) return; throw error; }
    throw new ManagedSessionDirectoryTrashError('restore_occupied');
  };
  const movePayload = async (source: string, destination: string, placement: ManagedSessionDirectoryPayloadPlacement | undefined) => {
    if (!placement || platform !== 'linux') return rename(source, destination);
    return withPinnedUnixDirectory(paths.dirname(source), sourceParent =>
      withPinnedUnixDirectory(paths.dirname(destination), destinationParent =>
        rename(paths.join(sourceParent.path, paths.basename(source)), paths.join(destinationParent.path, paths.basename(destination)))));
  };
  const retireToTrash = async ({ allocationId, payloadPath, beforeEffect }: Readonly<{
    allocationId: string; payloadPath: string; beforeEffect?: () => Promise<void>;
  }>) => {
    const record = await readRecord(allocationId);
    if (!record || record.pendingRemoval || (record.inTrash && !canonicalAbsolutePathsEqual(record.inTrash.payloadPath, payloadPath))) {
      throw new ManagedSessionDirectoryTrashError('owner_unavailable');
    }
    const target = recordedAllocation(allocationId, record);
    await assertContained(target, record.payloadPlacement);
    const sourceInfo = await lstat(target.directory).catch(error => { if (absent(error)) return null; throw error; });
    if (!sourceInfo) {
      const retainedInfo = await lstat(payloadPath);
      if (!retainedInfo.isDirectory() || retainedInfo.isSymbolicLink()) throw new ManagedSessionDirectoryTrashError('owner_unavailable');
      // The Trash owner has proved the retained payload identity before a
      // move-before-owner-commit recovery re-enters this operation.
      await beforeEffect?.();
      if (!record.inTrash) await writeRecord(allocationId, { ...record, inTrash: { payloadPath } });
      return;
    }
    if (record.inTrash) throw new ManagedSessionDirectoryTrashError('owner_unavailable');
    await requireAbsent(payloadPath);
    await beforeEffect?.();
    await movePayload(target.directory, payloadPath, record.payloadPlacement);
    try { await writeRecord(allocationId, { ...record, inTrash: { payloadPath } }); }
    catch (error) { await movePayload(payloadPath, target.directory, record.payloadPlacement); throw error; }
  };
  const reinstateFromTrash = async ({ allocationId, payloadPath, restorePath, beforeEffect }: Readonly<{
    allocationId: string; payloadPath: string; restorePath: string; beforeEffect?: () => Promise<void>;
  }>) => {
    const record = await readRecord(allocationId);
    if (!record || record.pendingRemoval || (record.inTrash && !canonicalAbsolutePathsEqual(record.inTrash.payloadPath, payloadPath))) {
      throw new ManagedSessionDirectoryTrashError('owner_unavailable');
    }
    const target = recordedAllocation(allocationId, record);
    if (!canonicalAbsolutePathsEqual(restorePath, target.directory)) throw new ManagedSessionDirectoryTrashError('restore_path_unsupported');
    await assertContained(target, record.payloadPlacement);
    let payloadPresent = true;
    try {
      const info = await lstat(payloadPath);
      if (!record.inTrash || !info.isDirectory() || info.isSymbolicLink()) throw new ManagedSessionDirectoryTrashError('owner_unavailable');
    } catch (error) { if (absent(error)) payloadPresent = false; else throw error; }
    const { inTrash: _inTrash, ...activeRecord } = record;
    if (!payloadPresent) {
      const info = await lstat(target.directory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new ManagedSessionDirectoryTrashError('owner_unavailable');
      // Trash proves the target's original filesystem identity before invoking
      // this same owner operation after a move-before-record-commit crash.
      await beforeEffect?.();
      if (record.inTrash) await writeRecord(allocationId, activeRecord);
      return;
    }
    await requireAbsent(target.directory);
    await beforeEffect?.();
    // The native no-replace owner already pins both parents before renameat2.
    await renameStoragePathNoReplace(payloadPath, target.directory);
    try { await writeRecord(allocationId, activeRecord); }
    catch (error) { await movePayload(target.directory, payloadPath, record.payloadPlacement); throw error; }
  };
  const discardFromTrash = async ({ allocationId, payloadPath, removePayload, beforeEffect }: Readonly<{
    allocationId: string; payloadPath: string; removePayload: () => Promise<void>; beforeEffect?: () => Promise<void>;
  }>) => {
    const record = await readRecord(allocationId);
    if (record && (!record.inTrash || !canonicalAbsolutePathsEqual(record.inTrash.payloadPath, payloadPath))) {
      throw new ManagedSessionDirectoryTrashError('owner_unavailable');
    }
    const info = await lstat(payloadPath).catch(error => { if (absent(error)) return null; throw error; });
    if (info && (!record || !info.isDirectory() || info.isSymbolicLink())) throw new ManagedSessionDirectoryTrashError('owner_unavailable');
    await beforeEffect?.();
    if (info) {
      if (record?.payloadPlacement && platform === 'linux') await removeUnixPathTree(payloadPath);
      else await removePayload();
    }
    await requireAbsent(payloadPath);
    // Payload deletion commits removal; finish its owner record without
    // rechecking the identity of a path that has already been removed.
    if (record) await removeProtectedLocalStateFile(recordPath(allocationId), protection);
  };
  return { prepareForCreation, materializeForFreshSpawn, prepareSeedEntryAccess, bind, listRecords, resolveForSession, removeForSession, removeAllocation,
    retireToTrash, reinstateFromTrash, discardFromTrash,
    removeUnboundCreation, retryPendingRemovals, allocateForHandoff, commitHandoff, abortHandoff, rollbackFreshSpawn, prepareForSpawn };
}
export type ManagedSessionDirectories = ReturnType<typeof createManagedSessionDirectories>;
