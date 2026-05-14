import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import {
  WorkspaceAnchorsResolveRequestV1Schema,
  computeLineContentHashV1,
  type LineContentHashV1,
  type WorkspaceAnchorResolutionV1,
  type WorkspaceAnchorV1,
  type WorkspaceAnchorsResolveResponseV1,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import type { FilesystemAccessPolicy } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';
import { authorizeFilesystemPath } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemPathAuthorization';

type NormalizedAnchor =
  | Readonly<{
    kind: 'line';
    filePath: string;
    line: number;
    side?: 'before' | 'after';
    lineHash?: LineContentHashV1;
  }>
  | Readonly<{
    kind: 'range';
    filePath: string;
    startLine: number;
    endLine: number;
    side?: 'before' | 'after';
    startLineHash?: LineContentHashV1;
    endLineHash?: LineContentHashV1;
    selectedTextHash?: LineContentHashV1;
  }>;

type FileCacheEntry =
  | Readonly<{ ok: true; lines: readonly string[]; hashes: readonly LineContentHashV1[] }>
  | Readonly<{ ok: false; reason: string }>;

export function registerWorkspaceAnchorHandlers(
  rpcHandlerManager: RpcHandlerRegistrar,
  deps: Readonly<{
    defaultDirectory: string;
    accessPolicy: FilesystemAccessPolicy;
  }>,
): void {
  rpcHandlerManager.registerHandler<unknown, WorkspaceAnchorsResolveResponseV1>(
    RPC_METHODS.WORKSPACE_ANCHORS_RESOLVE,
    async (raw) => {
      const parsed = WorkspaceAnchorsResolveRequestV1Schema.safeParse(raw);
      if (!parsed.success) {
        return { success: false, errorCode: 'INVALID_REQUEST', error: 'Invalid workspace anchor resolution request' };
      }

      const workspace = authorizeFilesystemPath({
        targetPath: parsed.data.workspacePath,
        defaultDirectory: deps.defaultDirectory,
        accessPolicy: deps.accessPolicy,
      });
      if (!workspace.valid) {
        return { success: false, errorCode: 'INVALID_WORKSPACE_PATH', error: workspace.error };
      }

      const fileCache = new Map<string, Promise<FileCacheEntry>>();
      const readWorkspaceFile = (filePath: string): Promise<FileCacheEntry> => {
        const existing = fileCache.get(filePath);
        if (existing) return existing;
        const promise = readAuthorizedWorkspaceFile({
          workspacePath: workspace.resolvedPath,
          filePath,
          defaultDirectory: deps.defaultDirectory,
          accessPolicy: deps.accessPolicy,
        });
        fileCache.set(filePath, promise);
        return promise;
      };

      const resolutions: WorkspaceAnchorResolutionV1[] = [];
      for (const comment of parsed.data.comments) {
        const file = await readWorkspaceFile(comment.filePath);
        const originalAnchor = comment.anchor;
        if (!file.ok) {
          resolutions.push({
            id: comment.id,
            filePath: comment.filePath,
            originalAnchor,
            status: 'missing',
            confidence: 0,
            reason: file.reason,
          });
          continue;
        }

        resolutions.push(resolveAnchorAgainstFile({
          id: comment.id,
          filePath: comment.filePath,
          originalAnchor,
          anchor: normalizeWorkspaceAnchor({
            filePath: comment.filePath,
            anchor: originalAnchor,
          }),
          lines: file.lines,
          hashes: file.hashes,
        }));
      }

      return { success: true, resolutions };
    },
  );
}

async function readAuthorizedWorkspaceFile(params: Readonly<{
  workspacePath: string;
  filePath: string;
  defaultDirectory: string;
  accessPolicy: FilesystemAccessPolicy;
}>): Promise<FileCacheEntry> {
  if (isAbsolute(params.filePath) || params.filePath.includes('\0')) {
    return { ok: false, reason: 'Workspace file path must be relative' };
  }

  const absolutePath = resolve(params.workspacePath, params.filePath);
  const relativeToWorkspace = relative(params.workspacePath, absolutePath);
  if (relativeToWorkspace === '..' || relativeToWorkspace.startsWith(`..${sep}`) || isAbsolute(relativeToWorkspace)) {
    return { ok: false, reason: 'Workspace file path is outside the workspace' };
  }

  const validation = authorizeFilesystemPath({
    targetPath: absolutePath,
    defaultDirectory: params.defaultDirectory,
    accessPolicy: params.accessPolicy,
  });
  if (!validation.valid) {
    return { ok: false, reason: validation.error };
  }

  try {
    const content = await readFile(validation.resolvedPath, 'utf8');
    const lines = splitTextLines(content);
    const hashes = lines.map(computeLineContentHashV1);
    return { ok: true, lines, hashes };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : 'Unable to read workspace file',
    };
  }
}

function splitTextLines(content: string): readonly string[] {
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (normalized.endsWith('\n')) {
    return normalized.slice(0, -1).split('\n');
  }
  return normalized.split('\n');
}

function normalizeWorkspaceAnchor(params: Readonly<{
  filePath: string;
  anchor: WorkspaceAnchorV1;
}>): NormalizedAnchor {
  const { anchor, filePath } = params;
  if (anchor.kind === 'fileLine') {
    return { kind: 'line', filePath, line: anchor.startLine, lineHash: anchor.lineHash };
  }
  if (anchor.kind === 'diffLine') {
    const line = anchor.side === 'after'
      ? (anchor.newLine ?? anchor.startLine)
      : (anchor.oldLine ?? anchor.startLine);
    return { kind: 'line', filePath, line, side: anchor.side, lineHash: anchor.lineHash };
  }
  if (anchor.kind === 'line') {
    return {
      kind: 'line',
      filePath: anchor.filePath || filePath,
      line: anchor.line,
      side: anchor.side,
      lineHash: anchor.lineHash,
    };
  }
  return {
    kind: 'range',
    filePath: anchor.filePath || filePath,
    startLine: anchor.startLine,
    endLine: anchor.endLine,
    side: anchor.side,
    startLineHash: anchor.startLineHash,
    endLineHash: anchor.endLineHash,
    selectedTextHash: anchor.selectedTextHash,
  };
}

function resolveAnchorAgainstFile(params: Readonly<{
  id?: string;
  filePath: string;
  originalAnchor: WorkspaceAnchorV1;
  anchor: NormalizedAnchor;
  lines: readonly string[];
  hashes: readonly LineContentHashV1[];
}>): WorkspaceAnchorResolutionV1 {
  const { anchor } = params;
  if (anchor.kind === 'line') {
    return resolveLineAnchor({ ...params, anchor });
  }
  return resolveRangeAnchor({ ...params, anchor });
}

function resolveLineAnchor(params: Readonly<{
  id?: string;
  filePath: string;
  originalAnchor: WorkspaceAnchorV1;
  anchor: Extract<NormalizedAnchor, { kind: 'line' }>;
  lines: readonly string[];
  hashes: readonly LineContentHashV1[];
}>): WorkspaceAnchorResolutionV1 {
  const zeroIndex = params.anchor.line - 1;
  if (zeroIndex >= 0 && zeroIndex < params.lines.length) {
    const hashMatches = !params.anchor.lineHash || params.hashes[zeroIndex] === params.anchor.lineHash;
    if (hashMatches) {
      const resolvedAnchor = {
        kind: 'line' as const,
        filePath: params.filePath,
        line: params.anchor.line,
        side: params.anchor.side,
        lineHash: params.hashes[zeroIndex],
      };
      return buildResolution({
        ...params,
        status: 'exact',
        confidence: 1,
        resolvedAnchor,
        startLine: params.anchor.line,
        endLine: params.anchor.line,
      });
    }
  }

  if (params.anchor.lineHash) {
    const matches = findHashMatches(params.hashes, params.anchor.lineHash);
    if (matches.length === 1) {
      const line = matches[0] + 1;
      const resolvedAnchor = {
        kind: 'line' as const,
        filePath: params.filePath,
        line,
        side: params.anchor.side,
        lineHash: params.anchor.lineHash,
      };
      return buildResolution({
        ...params,
        status: 'hash',
        confidence: 0.85,
        resolvedAnchor,
        startLine: line,
        endLine: line,
      });
    }
    if (matches.length > 1) {
      return {
        id: params.id,
        filePath: params.filePath,
        originalAnchor: params.originalAnchor,
        status: 'ambiguous',
        confidence: 0.2,
        reason: 'Line hash matched multiple lines',
      };
    }
  }

  return {
    id: params.id,
    filePath: params.filePath,
    originalAnchor: params.originalAnchor,
    status: 'missing',
    confidence: 0,
    reason: 'Line anchor could not be resolved',
  };
}

function resolveRangeAnchor(params: Readonly<{
  id?: string;
  filePath: string;
  originalAnchor: WorkspaceAnchorV1;
  anchor: Extract<NormalizedAnchor, { kind: 'range' }>;
  lines: readonly string[];
  hashes: readonly LineContentHashV1[];
}>): WorkspaceAnchorResolutionV1 {
  const startIndex = params.anchor.startLine - 1;
  const endIndex = params.anchor.endLine - 1;
  if (startIndex >= 0 && endIndex < params.lines.length && startIndex <= endIndex) {
    const startMatches = !params.anchor.startLineHash || params.hashes[startIndex] === params.anchor.startLineHash;
    const endMatches = !params.anchor.endLineHash || params.hashes[endIndex] === params.anchor.endLineHash;
    if (startMatches && endMatches) {
      const resolvedAnchor = {
        kind: 'range' as const,
        filePath: params.filePath,
        startLine: params.anchor.startLine,
        endLine: params.anchor.endLine,
        side: params.anchor.side,
        startLineHash: params.hashes[startIndex],
        endLineHash: params.hashes[endIndex],
      };
      return buildResolution({
        ...params,
        status: 'exact',
        confidence: 1,
        resolvedAnchor,
        startLine: params.anchor.startLine,
        endLine: params.anchor.endLine,
      });
    }
  }

  if (params.anchor.startLineHash && params.anchor.endLineHash) {
    const startMatches = findHashMatches(params.hashes, params.anchor.startLineHash);
    const endMatches = findHashMatches(params.hashes, params.anchor.endLineHash);
    if (startMatches.length === 1 && endMatches.length === 1 && startMatches[0] <= endMatches[0]) {
      const startLine = startMatches[0] + 1;
      const endLine = endMatches[0] + 1;
      const resolvedAnchor = {
        kind: 'range' as const,
        filePath: params.filePath,
        startLine,
        endLine,
        side: params.anchor.side,
        startLineHash: params.anchor.startLineHash,
        endLineHash: params.anchor.endLineHash,
      };
      return buildResolution({
        ...params,
        status: 'hash',
        confidence: 0.85,
        resolvedAnchor,
        startLine,
        endLine,
      });
    }
    if (startMatches.length > 1 || endMatches.length > 1) {
      return {
        id: params.id,
        filePath: params.filePath,
        originalAnchor: params.originalAnchor,
        status: 'ambiguous',
        confidence: 0.2,
        reason: 'Range hash matched multiple candidate lines',
      };
    }
  }

  return {
    id: params.id,
    filePath: params.filePath,
    originalAnchor: params.originalAnchor,
    status: 'missing',
    confidence: 0,
    reason: 'Range anchor could not be resolved',
  };
}

function findHashMatches(hashes: readonly LineContentHashV1[], hash: LineContentHashV1): number[] {
  const matches: number[] = [];
  for (let index = 0; index < hashes.length; index += 1) {
    if (hashes[index] === hash) matches.push(index);
  }
  return matches;
}

function buildResolution(params: Readonly<{
  id?: string;
  filePath: string;
  originalAnchor: WorkspaceAnchorV1;
  resolvedAnchor: WorkspaceAnchorV1;
  status: 'exact' | 'hash';
  confidence: number;
  lines: readonly string[];
  startLine: number;
  endLine: number;
}>): WorkspaceAnchorResolutionV1 {
  return {
    id: params.id,
    filePath: params.filePath,
    originalAnchor: params.originalAnchor,
    resolvedAnchor: params.resolvedAnchor,
    status: params.status,
    confidence: params.confidence,
    preview: buildPreview({
      lines: params.lines,
      startLine: params.startLine,
      endLine: params.endLine,
    }),
  };
}

function buildPreview(params: Readonly<{
  lines: readonly string[];
  startLine: number;
  endLine: number;
}>): { selectedLines: string[]; beforeContext: string[]; afterContext: string[] } {
  const startIndex = Math.max(0, params.startLine - 1);
  const endIndex = Math.min(params.lines.length - 1, params.endLine - 1);
  return {
    beforeContext: params.lines.slice(Math.max(0, startIndex - 2), startIndex),
    selectedLines: params.lines.slice(startIndex, endIndex + 1),
    afterContext: params.lines.slice(endIndex + 1, Math.min(params.lines.length, endIndex + 3)),
  };
}
