import * as z from 'zod/mini';
import { lazyZodSchema } from '@happier-dev/protocol/lazyZodSchema';
import { realpathSync } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, open, rename, rm, stat, writeFile } from 'fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from 'path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import type { ZodMiniType as ZodType } from 'zod/mini';

import { HARD_OPENABLE_CONTENT_MAX_BYTES_V1 } from '@happier-dev/protocol/plugins/openableContent';
import type { WorkspaceStatFileRequestV1 } from '@happier-dev/protocol';

import type { RpcHandlerContext, RpcHandlerRegistrar } from '@/api/rpc/types';
import { logger } from '@/ui/logger';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { RPC_ERROR_CODES, RPC_ERROR_MESSAGES } from '@happier-dev/protocol/rpcErrors';
import {
  FilesystemCreateDirectoryInputSchema,
  FilesystemRenameInputSchema,
  FilesystemDeleteInputSchema,
  FilesystemCopyInputSchema,
  FilesystemLocalCopyInputSchema,
  type FilesystemMutationActionId,
  type FilesystemActionId,
  type FilesystemCreateDirectoryInput,
  type FilesystemRenameInput,
  type FilesystemDeleteInput,
  type FilesystemLocalCopyInput,
  type FilesystemMutationOutput,
  type FilesystemCopyOutput,
} from '@happier-dev/protocol/actions/filesystemActionFamily';

import { validatePath } from '../pathSecurity';
import { filesystemPathComparisonKey, type FilesystemAccessPolicy } from './accessPolicy/filesystemAccessPolicy';
import { authorizeFilesystemPath, authorizeFilesystemPathWithinRoot } from './accessPolicy/filesystemPathAuthorization';
import { registerActionSpecRpcHandlers } from '../registerActionSpecRpcHandlers';
import { assertFilesystemEffectCurrent } from './accessPolicy/filesystemEffectAdmission';
import { writeTransferPayloadSourceToFile } from '@/machines/transfer/transferPayloadFileSink';
import type { RpcActionExecutor } from '../_actionDispatchAdapter';

type StatFileRequest = WorkspaceStatFileRequestV1;
type StatFileResponse =
  | Readonly<{
      success: true;
      exists: boolean;
      kind?: 'file' | 'directory' | 'other';
      sizeBytes?: number;
      modifiedMs?: number;
      /** Metadata status-change time, retained for older metadata consumers. */
      changedMs?: number;
      /** SHA-256 of the current bytes when the file is within the inline read ceiling. */
      contentHash?: string;
    }>
  | Readonly<{ success: false; error: string; errorCode?: string }>;

export type FilesystemMutationDeps = Readonly<{
  workingDirectory: string;
  accessPolicy: FilesystemAccessPolicy;
  getAdditionalAllowedReadDirs: () => ReadonlyArray<string>;
  getAdditionalAllowedWriteDirs: () => ReadonlyArray<string>;
}>;

export type FilesystemMutationActionIngress = Readonly<{
  actionExecutor?: RpcActionExecutor;
  /** Late binding to the daemon's current full Action admission owner. */
  resolveMutationActionExecutor?: () => RpcActionExecutor<FilesystemActionId> | null;
  mutationMachineId?: string;
}>;

const unavailableMutationExecutor: RpcActionExecutor = {
  async execute() {
    return { ok: false, errorCode: 'filesystem_action_owner_unavailable', error: 'The current filesystem Action owner is unavailable' };
  },
};

const forbiddenRawMutationExecutor: RpcActionExecutor = {
  async execute() {
    return { ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN, error: RPC_ERROR_MESSAGES.FORBIDDEN };
  },
};

/** Rooted mutations share one admission route; only predecessor aliases retain incumbent effects. */
export function resolveFilesystemMutationActionExecutor(
  ingress: FilesystemMutationActionIngress,
  request: Readonly<{ actionId: FilesystemActionId; isAlias: boolean; input: unknown;
    ingress?: Pick<RpcHandlerContext, 'callerAuthority' | 'sessionActionOrigin' | 'localActionContext'> }>,
  incumbentExecutor: RpcActionExecutor,
): RpcActionExecutor<FilesystemActionId> {
  const data = request.input && typeof request.input === 'object' && !Array.isArray(request.input)
    ? request.input as Record<string, unknown> : null;
  if (request.isAlias && request.actionId !== 'daemon.filesystem.copy' && data
    && data.kind !== 'targeted_action_rpc' && !Object.hasOwn(data, 'rootPath')) {
    if (request.ingress?.callerAuthority === 'account_automation' || request.ingress?.sessionActionOrigin
      || request.ingress?.localActionContext?.authority === 'account_automation') return forbiddenRawMutationExecutor;
    return incumbentExecutor;
  }
  return (ingress.resolveMutationActionExecutor ? ingress.resolveMutationActionExecutor() : ingress.actionExecutor)
    ?? unavailableMutationExecutor;
}

type FilesystemMutationExecutionDeps = FilesystemMutationDeps & Readonly<{
  /** Host-derived only for historical unrooted incumbent RPC aliases; never wire input. */
  incumbentPolicyScope?: true;
  signal?: AbortSignal;
  /** Existing canonical operation identity when this effect is runner-owned. */
  operationId?: string;
  /** Current admitted host invocation; private, never a mutation input field. */
  assertCurrentAuthority?: () => Promise<void>;
}>;

function resolveRealPathBestEffort(path: string): string {
  const resolved = resolvePath(path);
  try {
    return realpathSync(resolved);
  } catch {
    try {
      const parent = realpathSync(dirname(resolved));
      return resolvePath(parent, basename(resolved));
    } catch {
      return resolved;
    }
  }
}

function pathIdentity(path: string): string {
  return filesystemPathComparisonKey(resolveRealPathBestEffort(path));
}

export function isFilesystemMutationRootPath(resolvedPath: string, rootPath: string | undefined, deps: FilesystemMutationDeps): boolean {
  const roots = [deps.workingDirectory, ...(rootPath ? [rootPath] : []),
    ...(deps.accessPolicy.kind === 'restrictedRoots' ? deps.accessPolicy.roots : [])];
  const target = pathIdentity(resolvedPath);
  return roots.some((root) => {
    const suffix = relative(target, pathIdentity(root));
    return suffix === '' || (suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
  });
}

function isRootPath(resolvedPath: string, rootPath: string | undefined, deps: FilesystemMutationExecutionDeps): boolean {
  if (!deps.incumbentPolicyScope) return isFilesystemMutationRootPath(resolvedPath, rootPath, deps);
  const policyRoots = deps.accessPolicy.kind === 'restrictedRoots' && deps.accessPolicy.roots.length > 0
    ? deps.accessPolicy.roots : [deps.workingDirectory];
  const target = pathIdentity(resolvedPath);
  return policyRoots.some((root) => target === pathIdentity(root));
}

function pathsOverlap(from: string, to: string): boolean {
  const source = pathIdentity(from);
  const destination = pathIdentity(to);
  const contains = (parent: string, child: string) => {
    const suffix = relative(parent, child);
    return suffix === '' || (suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
  };
  return contains(source, destination) || contains(destination, source);
}

type FilesystemLocalMutationInput = Readonly<{ rootPath?: string }> & (
  Omit<FilesystemCreateDirectoryInput, 'rootPath'>
  | Omit<FilesystemRenameInput, 'rootPath'>
  | Omit<FilesystemDeleteInput, 'rootPath'>
  | Omit<FilesystemLocalCopyInput, 'rootPath'>
);

function mutationSchema(actionId: FilesystemMutationActionId, incumbentPolicyScope = false): ZodType<FilesystemLocalMutationInput> {
  switch (actionId) {
    case 'daemon.filesystem.createDirectory': return incumbentPolicyScope ? lazyZodSchema(() => z.omit(FilesystemCreateDirectoryInputSchema, { rootPath: true })) : FilesystemCreateDirectoryInputSchema;
    case 'daemon.filesystem.rename': return incumbentPolicyScope ? lazyZodSchema(() => z.omit(FilesystemRenameInputSchema, { rootPath: true })) : FilesystemRenameInputSchema;
    case 'daemon.filesystem.delete': return incumbentPolicyScope ? lazyZodSchema(() => z.omit(FilesystemDeleteInputSchema, { rootPath: true })) : FilesystemDeleteInputSchema;
    case 'daemon.filesystem.copy': return FilesystemLocalCopyInputSchema;
  }
}

function failure(error: string, errorCode: string): FilesystemMutationOutput {
  return { success: false, error, errorCode };
}

export function authorizeFilesystemMutationPath(path: string, rootPath: string, mode: 'read' | 'write', deps: FilesystemMutationDeps) {
  return authorizeMutationPath(path, rootPath, mode, deps);
}

function authorizeMutationPath(path: string, rootPath: string | undefined, mode: 'read' | 'write', deps: FilesystemMutationExecutionDeps) {
  const allowances = mode === 'read' ? deps.getAdditionalAllowedReadDirs() : deps.getAdditionalAllowedWriteDirs();
  if (deps.incumbentPolicyScope) {
    return authorizeFilesystemPath({
      targetPath: path, defaultDirectory: deps.workingDirectory, accessPolicy: deps.accessPolicy,
      additionalAllowedDirs: allowances,
    });
  }
  return authorizeFilesystemPathWithinRoot({
    targetPath: path, rootPath: rootPath ?? '', defaultDirectory: deps.workingDirectory,
    accessPolicy: deps.accessPolicy, additionalAllowedDirs: allowances,
  });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** The local filesystem effect owner shared by captured Actions and incumbent RPC adapters. */
export async function executeFilesystemMutationAction(
  params: FilesystemMutationExecutionDeps & Readonly<{ actionId: FilesystemMutationActionId; input: unknown }>,
): Promise<FilesystemMutationOutput | FilesystemCopyOutput> {
  const { actionId } = params;
  const parsed = mutationSchema(actionId, params.incumbentPolicyScope).safeParse(params.input);
  if (!parsed.success) return failure('Invalid filesystem mutation input', 'invalid_input');
  const input = parsed.data;
  const rootPath = 'rootPath' in input ? input.rootPath : undefined;
  try {
    params.signal?.throwIfAborted();
    await params.assertCurrentAuthority?.();
    params.signal?.throwIfAborted();
    if ('path' in input) {
      const path = authorizeMutationPath(input.path, rootPath, 'write', params);
      if (!path.valid) return failure(path.error, path.errorCode);
      if (actionId === 'daemon.filesystem.createDirectory') {
        await params.assertCurrentAuthority?.();
        await mkdir(path.resolvedPath, { recursive: true });
        return { success: true };
      }
      if (isRootPath(path.resolvedPath, rootPath, params)) return failure('Cannot delete the working directory root', 'root_refused');
      if (!await pathExists(path.resolvedPath)) return { success: true };
      const stats = await lstat(path.resolvedPath);
      if (stats.isDirectory() && (!('recursive' in input) || !input.recursive)) {
        return failure('Refusing to delete a directory without recursive=true', 'recursive_required');
      }
      await params.assertCurrentAuthority?.();
      await rm(path.resolvedPath, { recursive: true, force: true });
      return { success: true };
    }

    const from = authorizeMutationPath(input.from, rootPath, actionId === 'daemon.filesystem.copy' ? 'read' : 'write', params);
    const to = authorizeMutationPath(input.to, rootPath, 'write', params);
    if (!from.valid) return failure(from.error, from.errorCode);
    if (!to.valid) return failure(to.error, to.errorCode);
    if (isRootPath(from.resolvedPath, rootPath, params) || isRootPath(to.resolvedPath, rootPath, params)) {
      return failure('Cannot mutate the working directory root', 'root_refused');
    }
    if (pathsOverlap(from.resolvedPath, to.resolvedPath)) {
      return failure('Source and destination paths overlap', 'paths_overlap');
    }
    // Establish source existence before any destructive overwrite of the destination.
    const source = await lstat(from.resolvedPath);
    if (await pathExists(to.resolvedPath) && !input.overwrite) return failure('Destination already exists', 'destination_exists');
    if (actionId === 'daemon.filesystem.copy') {
      const recursive = 'recursive' in input && input.recursive;
      if (source.isDirectory() && !recursive) return failure('Refusing to copy a directory without recursive=true', 'recursive_required');
      if (!rootPath) return failure('The filesystem root is required', 'invalid_input');
      // Resolve after this owner is initialized: the shared destination port
      // consumes these canonical admission helpers, not a second effect path.
      const [{ observeWorkspaceSyncEntryAtRoot }, { captureWorkspaceSyncEntryAtRoot },
        { createWorkspaceSyncEntryExport }, { createPreparedFilesystemEntryCopyDestination }] = await Promise.all([
        import('@/workspaces/sync/workspaceSyncFileRead'),
        import('@/workspaces/sync/workspaceSyncConflicts'),
        import('@/workspaces/sync/workspaceSyncEntryTransfer'),
        import('@/machines/transfer/preparedFilesystemEntryCopyDestination'),
      ]);
      const assertCurrentAuthority = async () => {
        params.signal?.throwIfAborted();
        await params.assertCurrentAuthority?.();
        params.signal?.throwIfAborted();
        const currentSource = authorizeMutationPath(from.resolvedPath, rootPath, 'read', params);
        const currentDestination = authorizeMutationPath(to.resolvedPath, rootPath, 'write', params);
        const denied = !currentSource.valid ? currentSource : !currentDestination.valid ? currentDestination : null;
        if (denied) throw Object.assign(new Error(denied.error), { code: denied.errorCode });
      };
      const custody = await mkdtemp(join(tmpdir(), 'filesystem-copy-'));
      const operationId = params.operationId ?? basename(custody);
      let retainCustody = false;
      try {
        const captureDirectory = join(custody, 'capture');
        const recoveryDirectory = join(custody, 'recovery');
        await Promise.all([mkdir(captureDirectory), mkdir(recoveryDirectory)]);
        const expectation = await observeWorkspaceSyncEntryAtRoot({ rootPath, relativePath: relative(rootPath, from.resolvedPath), assertCurrentAuthority });
        const captured = await captureWorkspaceSyncEntryAtRoot({ rootPath,
          relativePath: relative(rootPath, from.resolvedPath), expected: expectation,
          captureDirectory, operationId, assertCurrentAuthority });
        const exported = await createWorkspaceSyncEntryExport({ operationId, ...captured,
          assertEntryAllowed: entry => {
            const sourcePath = join(from.resolvedPath, ...entry.relativePath.split('/').slice(1));
            const admitted = authorizeMutationPath(sourcePath, rootPath, 'read', params);
            if (!admitted.valid) throw Object.assign(new Error(admitted.error), { code: admitted.errorCode });
            if (entry.kind === 'symlink') {
              const target = authorizeMutationPath(resolvePath(dirname(sourcePath), entry.target), rootPath, 'read', params);
              if (!target.valid) throw Object.assign(new Error(target.error), { code: target.errorCode });
            }
          },
        });
        const outcome = await createPreparedFilesystemEntryCopyDestination(params)({ operationId, rootPath,
          path: to.resolvedPath, overwrite: input.overwrite, recursive, expectation: captured.expectation,
          stagingDirectory: join(custody, 'stage'), recoveryDirectory, assertCurrentAuthority, signal: params.signal,
          requestPayload: async ({ transferId, destinationPath }) => {
            const payload = transferId === operationId ? exported.payloadSource
              : await exported.onDemandScope.resolvePayloadSourceOnOpen({ transferId, requestBody: null });
            if (payload.kind === 'buffer') await writeFile(destinationPath, payload.payload);
            else if (payload.kind === 'file') await copyFile(payload.filePath, destinationPath);
            else await writeTransferPayloadSourceToFile({ source: payload, destinationPath });
          },
        });
        if (outcome.status === 'recovery_needed') {
          retainCustody = true;
          return { success: false, status: 'unknown', errorCode: 'indeterminate',
            error: `Copy outcome is unknown; private recovery custody is retained at ${custody}` };
        }
        return outcome.status === 'installed' ? { success: true }
          : failure('Copy failed and the previous destination was restored', 'filesystem_copy_restored');
      } finally {
        if (!retainCustody) await rm(custody, { recursive: true, force: true });
      }
    }
    if (input.overwrite && await pathExists(to.resolvedPath)) {
      await params.assertCurrentAuthority?.();
      await rm(to.resolvedPath, { recursive: true, force: true });
    }
    await params.assertCurrentAuthority?.();
    await mkdir(dirname(to.resolvedPath), { recursive: true });
    await params.assertCurrentAuthority?.();
    await rename(from.resolvedPath, to.resolvedPath);
    return { success: true };
  } catch (error) {
    if (params.signal?.aborted) return failure('Filesystem mutation cancelled before commit', 'cancelled');
    if (error instanceof Error && 'code' in error && (error.code === 'filesystem_action_owner_unavailable'
      || error.code === 'filesystem_identity_custody_unavailable' || error.code === 'access_denied')) {
      return failure(error.message, error.code);
    }
    return failure(error instanceof Error ? error.message : 'Filesystem mutation failed', 'filesystem_error');
  }
}

export function registerFilesystemMutationActionHandlers(
  rpcHandlerManager: RpcHandlerRegistrar,
  deps: FilesystemMutationDeps & FilesystemMutationActionIngress,
  actionIds: readonly FilesystemMutationActionId[],
): void {
  const incumbentExecutor: RpcActionExecutor = {
    async execute(actionId, input, context) {
      const mutationId = actionIds.find((id) => id === actionId);
      if (!mutationId) {
        return { ok: false, errorCode: 'unsupported_action', error: `Unsupported action: ${actionId}` };
      }
      return { ok: true, result: await executeFilesystemMutationAction({ ...deps, actionId: mutationId, input,
        signal: context?.signal, assertCurrentAuthority: () => assertFilesystemEffectCurrent(context), incumbentPolicyScope: true }) };
    },
  };
  registerActionSpecRpcHandlers<FilesystemMutationActionId>({
    rpcHandlerManager, actionIds,
    ...(deps.mutationMachineId ? { targetMachineId: deps.mutationMachineId, defaultMachineTarget: true } : {}),
    resolveActionExecutor: request => resolveFilesystemMutationActionExecutor(deps, request, incumbentExecutor),
    mapRequestForMethod: ({ actionId, input, isAlias }) => {
      const mutationId = actionIds.find((id) => id === actionId);
      if (!mutationId) return { accepted: false, response: failure('Unsupported filesystem mutation', 'unsupported_action') };
      if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        return { accepted: false, response: failure('Invalid filesystem mutation input', 'invalid_input') };
      }
      const data = input as Record<string, unknown>;
      if (data.kind === 'targeted_action_rpc') return { accepted: true, input };
      // Only incumbent aliases translate historical omitted roots/choices.
      // Primary semantic methods never acquire a root from daemon defaults.
      const incumbentPolicyScope = isAlias && !Object.hasOwn(data, 'rootPath') && actionId !== 'daemon.filesystem.copy';
      const candidate = !incumbentPolicyScope ? data : {
        ...data,
        ...(actionId === 'daemon.filesystem.rename' ? { overwrite: data.overwrite === undefined ? false : data.overwrite } : {}),
        ...(actionId === 'daemon.filesystem.delete' ? { recursive: data.recursive === undefined ? false : data.recursive } : {}),
      };
      const parsed = (mutationId === 'daemon.filesystem.copy' ? FilesystemCopyInputSchema
        : mutationSchema(mutationId, incumbentPolicyScope)).safeParse(candidate);
      return parsed.success
        ? { accepted: true, input: parsed.data }
        : { accepted: false, response: failure('Invalid filesystem mutation input', 'invalid_input') };
    },
  });
}

/** Read one exact, bounded candidate buffer for an opt-in content revision. */
async function readFileWithinContentHashLimit(path: string, assertCurrentAuthority: () => Promise<void>): Promise<Buffer> {
  await assertCurrentAuthority();
  const handle = await open(path, 'r');
  try {
    const bytes = Buffer.alloc(HARD_OPENABLE_CONTENT_MAX_BYTES_V1 + 1);
    let offset = 0;
    while (offset < bytes.byteLength) {
      await assertCurrentAuthority();
      const { bytesRead } = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (bytesRead <= 0) break;
      offset += bytesRead;
    }
    return bytes.subarray(0, offset);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export function registerPathMutationHandlers(
  rpcHandlerManager: RpcHandlerRegistrar,
  deps: FilesystemMutationDeps & FilesystemMutationActionIngress,
): void {
  rpcHandlerManager.registerHandler<StatFileRequest, StatFileResponse>(RPC_METHODS.STAT_FILE, async (data, context) => {
    const path = typeof data?.path === 'string' ? data.path : '';
    logger.debug('Stat file request:', path);

    const validation = validatePath(path, deps.workingDirectory, deps.getAdditionalAllowedReadDirs(), deps.accessPolicy);
    if (!validation.valid) {
      return { success: false, error: validation.error, errorCode: validation.errorCode };
    }

    try {
      await assertFilesystemEffectCurrent(context);
      const stats = await stat(validation.resolvedPath);
      const kind = stats.isDirectory() ? 'directory' : stats.isFile() ? 'file' : 'other';
      let contentHash: string | undefined;
      let sizeBytes = stats.size;
      if (data?.includeContentHash === true && kind === 'file' && stats.size <= HARD_OPENABLE_CONTENT_MAX_BYTES_V1) {
        const bytes = await readFileWithinContentHashLimit(validation.resolvedPath, () => assertFilesystemEffectCurrent(context));
        // Name the exact buffer hashed, rather than pairing a pre-read stat
        // size with post-read bytes if a concurrent write changed the length.
        // A growth race that crosses the existing inline boundary is not
        // hashed; the next stat can truthfully report it as unsupported.
        if (bytes.byteLength <= HARD_OPENABLE_CONTENT_MAX_BYTES_V1) {
          sizeBytes = bytes.byteLength;
          contentHash = createHash('sha256').update(bytes).digest('hex');
        }
      }
      await assertFilesystemEffectCurrent(context);
      return {
        success: true,
        exists: true,
        kind,
        sizeBytes,
        modifiedMs: stats.mtimeMs,
        changedMs: stats.ctimeMs,
        ...(contentHash ? { contentHash } : {}),
      };
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === 'ENOENT') {
        return { success: true, exists: false };
      }
      return { success: false, error: error instanceof Error ? error.message : 'Failed to stat path' };
    }
  });

  registerFilesystemMutationActionHandlers(rpcHandlerManager, deps, [
    'daemon.filesystem.rename', 'daemon.filesystem.delete', 'daemon.filesystem.copy',
  ]);
}
