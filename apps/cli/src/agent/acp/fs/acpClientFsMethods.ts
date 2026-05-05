import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import type { Client, InitializeRequest } from '@agentclientprotocol/sdk';

import type { AcpPermissionHandler } from '../permissions/acpPermissionHandler';

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
  // through the client (Happier). This is the only reliable way for Happier to enforce
  // workspace boundaries for ACP backends.
  const raw = process.env.HAPPIER_ACP_FS;
  if (raw === undefined) return true;
  return isTruthyEnv(raw);
}

export function buildInitializeRequest(params: {
  clientName: string;
  clientVersion: string;
  fsEnabled?: boolean;
}): InitializeRequest {
  const fsEnabled = params.fsEnabled ?? isAcpFsEnabled();
  return {
    protocolVersion: 1,
    clientCapabilities: {
      fs: {
        readTextFile: fsEnabled,
        writeTextFile: fsEnabled,
      },
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
}): Pick<Client, 'readTextFile' | 'writeTextFile'> {
  const rootResolved = resolve(params.cwd);
  const rootRealPromise = fs.realpath(rootResolved).catch(() => rootResolved);

  const isWithinRoot = (root: string, target: string): boolean => {
    const rel = relative(root, target);
    return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
  };

  const isWithinAnyRoot = (roots: string[], target: string): boolean => {
    for (const root of roots) {
      if (isWithinRoot(root, target)) return true;
    }
    return false;
  };

  const assertWithinCwd = async (targetPath: string, opts: { kind: 'read' | 'write' }): Promise<void> => {
    const targetResolved = resolve(targetPath);
    if (!isWithinRoot(rootResolved, targetResolved)) {
      throw new Error(`Permission denied for ${opts.kind}TextFile (path traversal)`);
    }

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
        if (errno === 'ENOENT') return targetResolved;
        throw new Error(`Permission denied for ${opts.kind}TextFile (cannot resolve path)`);
      });
      if (!isWithinAnyRoot(roots, targetReal)) {
        throw new Error(`Permission denied for ${opts.kind}TextFile (path traversal)`);
      }
      return;
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
  };

  const readTextFile: NonNullable<Client['readTextFile']> = async (req) => {
    const targetPath = isAbsolute(req.path) ? resolve(req.path) : resolve(rootResolved, req.path);
    await assertWithinCwd(targetPath, { kind: 'read' });
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

  const writeTextFile: NonNullable<Client['writeTextFile']> = async (req) => {
    const targetPath = isAbsolute(req.path) ? resolve(req.path) : resolve(rootResolved, req.path);
    await assertWithinCwd(targetPath, { kind: 'write' });
    const reqRecord = asRecord(req) ?? {};
    const meta = asRecord(reqRecord._meta) ?? {};
    const toolCallId = typeof meta.toolCallId === 'string' ? meta.toolCallId : `acp-fs-write:${randomUUID()}`;

    if (params.permissionHandler) {
      const result = await params.permissionHandler.handleToolCall(toolCallId, 'writeTextFile', {
        path: targetPath,
        bytes: Buffer.byteLength(req.content, 'utf8'),
      });

      const approved =
        result.decision === 'approved' ||
        result.decision === 'approved_for_session' ||
        result.decision === 'approved_execpolicy_amendment';

      if (!approved) {
        throw new Error(`Permission denied for writeTextFile (${toolCallId})`);
      }
    }

    await fs.mkdir(dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, req.content, 'utf8');
    return {};
  };

  return { readTextFile, writeTextFile };
}
