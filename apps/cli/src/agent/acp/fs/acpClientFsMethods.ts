import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, resolve } from 'node:path';

import type { InitializeRequest } from '@agentclientprotocol/sdk';

import { authorizeFilesystemPath } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemPathAuthorization';
import { isCanonicalAbsolutePathInsideRoot } from '@/utils/path/expandHomeDirPath';

import type { AcpPermissionHandler } from '../permissions/acpPermissionHandler';
import type { AcpClientConnectionHandlers } from '../connection/types';

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function isTruthyEnv(value: string | undefined): boolean {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

export function isAcpFsEnabled(): boolean {
  // Default ON: ACP agents that support the `fs` capability will route file reads/writes
  // through the client (Happier), so host-mediated operations can apply workspace policy.
  // This does not sandbox an Agent process that can access the filesystem directly.
  const raw = process.env.HAPPIER_ACP_FS;
  if (raw === undefined) return true;
  return isTruthyEnv(raw);
}

export function buildInitializeRequest(params: {
  clientName: string;
  clientVersion: string;
  fsEnabled?: boolean;
  parameterizedModelPicker?: boolean;
}): InitializeRequest {
  const fsEnabled = params.fsEnabled ?? isAcpFsEnabled();
  return {
    protocolVersion: 1,
    clientCapabilities: {
      fs: {
        readTextFile: fsEnabled,
        writeTextFile: fsEnabled,
      },
      ...(typeof params.parameterizedModelPicker === 'boolean'
        ? { _meta: { parameterizedModelPicker: params.parameterizedModelPicker } }
        : {}),
    },
    clientInfo: {
      name: params.clientName,
      version: params.clientVersion,
    },
  };
}

export function createAcpClientFsMethods(params: {
  cwd: string;
  permissionHandler?: AcpPermissionHandler;
}): Pick<AcpClientConnectionHandlers, 'readTextFile' | 'writeTextFile'> {
  const rootResolved = resolve(params.cwd);
  const rootRealPromise = fs.realpath(rootResolved).catch(() => rootResolved);

  const isWithinAnyRoot = (roots: string[], target: string): boolean => {
    for (const root of roots) {
      if (isCanonicalAbsolutePathInsideRoot(root, target)) return true;
    }
    return false;
  };

  const assertWithinCwd = async (
    targetPath: string,
    opts: { kind: 'read' | 'write' },
  ): Promise<string> => {
    const authorization = authorizeFilesystemPath({
      targetPath,
      defaultDirectory: rootResolved,
      accessPolicy: { kind: 'restrictedRoots', roots: [rootResolved] },
    });
    if (!authorization.valid) {
      throw new Error(`Permission denied for ${opts.kind}TextFile (path traversal)`);
    }
    const targetResolved = authorization.resolvedPath;

    const rootReal = await rootRealPromise;
    // `realpath()` can normalize the same directory into different spellings on some platforms
    // (for example: Windows mapped drive letters vs UNC paths). Treat both spellings as valid roots.
    const roots = rootReal === rootResolved ? [rootResolved] : [rootResolved, rootReal];
    const resolveExistingAncestorRealPath = async (startPath: string): Promise<string> => {
      let candidate = startPath;
      while (true) {
        const candidateReal = await fs.realpath(candidate).catch((error) => {
          const errno = (error as NodeJS.ErrnoException | undefined)?.code;
          if (errno === 'ENOENT') return null;
          throw new Error(`Permission denied for ${opts.kind}TextFile (cannot resolve path)`);
        });
        if (candidateReal) return candidateReal;
        const parent = dirname(candidate);
        if (parent === candidate) {
          throw new Error(`Permission denied for ${opts.kind}TextFile (cannot resolve path)`);
        }
        candidate = parent;
      }
    };

    if (opts.kind === 'read') {
      const targetReal = await fs.realpath(targetResolved).catch((error) => {
        const errno = (error as NodeJS.ErrnoException | undefined)?.code;
        if (errno === 'ENOENT') return null;
        throw new Error(`Permission denied for ${opts.kind}TextFile (cannot resolve path)`);
      });
      const targetOrAncestorReal = targetReal
        ?? await resolveExistingAncestorRealPath(dirname(targetResolved));
      if (!isWithinAnyRoot(roots, targetOrAncestorReal)) {
        throw new Error(`Permission denied for ${opts.kind}TextFile (path traversal)`);
      }
      return targetResolved;
    }

    const targetReal = await fs.realpath(targetResolved).catch((error) => {
      const errno = (error as NodeJS.ErrnoException | undefined)?.code;
      if (errno === 'ENOENT') return null;
      throw new Error(`Permission denied for ${opts.kind}TextFile (cannot resolve path)`);
    });
    if (targetReal && !isWithinAnyRoot(roots, targetReal)) {
      throw new Error(`Permission denied for ${opts.kind}TextFile (path traversal)`);
    }

    const existingAncestorReal = await resolveExistingAncestorRealPath(dirname(targetResolved));
    if (!isWithinAnyRoot(roots, existingAncestorReal)) {
      throw new Error(`Permission denied for ${opts.kind}TextFile (path traversal)`);
    }
    return targetResolved;
  };

  const readTextFile: NonNullable<AcpClientConnectionHandlers['readTextFile']> = async (req) => {
    const targetPath = await assertWithinCwd(req.path, { kind: 'read' });
    const full = await fs.readFile(targetPath, 'utf8');
    const line = typeof req.line === 'number' ? req.line : null;
    const limit = typeof req.limit === 'number' ? req.limit : null;

    if (line === null && limit === null) {
      return { content: full };
    }

    const lines = full.split('\n');
    const startIdx = Math.max(0, (line ?? 1) - 1);
    const endIdx = limit === null ? lines.length : startIdx + Math.max(0, limit);
    const slice = lines.slice(startIdx, endIdx);
    // Preserve behavior similar to "read lines": remove trailing empty line if caused by final newline.
    if (slice.length > 0 && slice[slice.length - 1] === '') slice.pop();
    return { content: slice.join('\n') };
  };

  const writeTextFile: NonNullable<AcpClientConnectionHandlers['writeTextFile']> = async (req) => {
    const targetPath = await assertWithinCwd(req.path, { kind: 'write' });
    const reqRecord = asRecord(req) ?? {};
    const meta = asRecord(reqRecord._meta) ?? {};
    const toolCallId = typeof meta.toolCallId === 'string' ? meta.toolCallId : `acp-fs-write:${randomUUID()}`;
    const permissionInput = {
      path: targetPath,
      bytes: Buffer.byteLength(req.content, 'utf8'),
    };
    const permissionContext = { origin: 'host_acp_fs_write' as const };
    const isApproved = (decision: string): boolean => (
      decision === 'approved'
      || decision === 'approved_for_session'
      || decision === 'approved_execpolicy_amendment'
    );

    if (params.permissionHandler) {
      const result = await params.permissionHandler.handleToolCall(
        toolCallId,
        'writeTextFile',
        permissionInput,
        permissionContext,
      );
      if (!isApproved(result.decision)) {
        throw new Error(`Permission denied for writeTextFile (${toolCallId})`);
      }
    }

    await fs.mkdir(dirname(targetPath), { recursive: true });
    const finalDecision = params.permissionHandler?.getImmediateDecision?.(
      toolCallId,
      'writeTextFile',
      permissionInput,
      permissionContext,
    );
    if (finalDecision && !isApproved(finalDecision.decision)) {
      throw new Error(`Permission denied for writeTextFile (${toolCallId})`);
    }
    await assertWithinCwd(targetPath, { kind: 'write' });
    await fs.writeFile(targetPath, req.content, 'utf8');
    return {};
  };

  return { readTextFile, writeTextFile };
}
