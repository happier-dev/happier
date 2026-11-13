import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir, realpath, rename, rm, stat as nodeStat, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';

import { isPluginError, PluginError } from '@happier-dev/plugin-sdk/errors';
import { type FileSystemService } from '@happier-dev/plugin-sdk/fs';
import { type PluginPath } from '@happier-dev/plugin-sdk';
import { readPortablePathSegmentViolation } from '@happier-dev/protocol/filesystem/portablePathSegment';
import { isCanonicalAbsolutePathInsideRoot } from '@/utils/path/expandHomeDirPath';
import type { PluginFileSystemRoots } from './types';
import { observeMachinePath } from './machinePathObservation';

function fail(code: string, message: string): never {
  throw new PluginError({ code, message });
}

function translateFileSystemError(error: unknown): never {
  if (isPluginError(error)) throw error;
  const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : '';
  const mapped = (() => {
    if (code === 'ENOENT') return ['plugin_fs_not_found', false] as const;
    if (code === 'ENOTDIR' || code === 'EISDIR' || code === 'ERR_FS_EISDIR') return ['plugin_fs_unsupported_kind', false] as const;
    if (code === 'ENOTEMPTY') return ['plugin_fs_recursive_required', false] as const;
    if (code === 'EACCES' || code === 'EPERM') return ['plugin_fs_permission_denied', false] as const;
    if (code === 'ENOSPC' || code === 'EDQUOT') return ['plugin_fs_quota_exceeded', true] as const;
    if (code === 'EROFS') return ['plugin_fs_read_only', false] as const;
    if (code === 'ENAMETOOLONG' || code === 'EINVAL') return ['plugin_fs_path_denied', false] as const;
    return ['plugin_fs_io_failed', true] as const;
  })();
  throw new PluginError({ code: mapped[0], retryable: mapped[1], message: 'Filesystem operation failed' }, { cause: error });
}

async function withStableFileSystemErrors<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    return translateFileSystemError(error);
  }
}

function isInvalidPortableComponent(part: string): boolean {
  // Validate the canonical spelling without changing existing workspace names.
  return readPortablePathSegmentViolation(part.normalize('NFC')) !== null;
}

function normalizedRelativePath(value: string): string {
  const input = value.replaceAll('\\', '/');
  if (!input) return '';
  if (input.startsWith('/') || input.startsWith('//') || /^[a-z]:/iu.test(input) || isAbsolute(input)) {
    return fail('plugin_fs_path_denied', 'Filesystem path must be relative');
  }
  const parts = input.split('/');
  if (parts.some(isInvalidPortableComponent)) {
    return fail('plugin_fs_path_denied', 'Filesystem path traversal is not allowed');
  }
  return parts.join('/');
}

export function resolvePluginPathWithinRoots(
  roots: PluginFileSystemRoots,
  path: PluginPath,
): string {
  const relativePath = normalizedRelativePath(path.relativePath);
  const rawRoot = path.root === 'pluginData'
    ? roots.pluginData
    : path.root === 'workspace'
      ? roots.workspace ?? fail('plugin_fs_root_unavailable', 'Workspace root is unavailable')
      : roots.projects.get(path.projectId) ?? fail('plugin_fs_root_unavailable', 'Project root is unavailable');
  const root = resolve(rawRoot);
  const candidate = resolve(root, relativePath);
  if (!isCanonicalAbsolutePathInsideRoot(root, candidate)) fail('plugin_fs_path_denied', 'Filesystem path escapes its root');
  return candidate;
}

function cursorFingerprint(path: PluginPath, relativePath: string, offset: number): string {
  return createHash('sha256')
    .update(`${path.root}\0${path.root === 'project' ? path.projectId : ''}\0${relativePath}\0${offset}`)
    .digest('base64url')
    .slice(0, 16);
}

function encodeCursor(path: PluginPath, relativePath: string, offset: number): string {
  return `v1.${offset.toString(36)}.${cursorFingerprint(path, relativePath, offset)}`;
}

function decodeCursor(path: PluginPath, relativePath: string, cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const match = /^v1\.([0-9a-z]+)\.([A-Za-z0-9_-]{16})$/u.exec(cursor);
  if (!match) fail('plugin_fs_invalid_cursor', 'Filesystem list cursor is invalid');
  const offset = Number.parseInt(match[1]!, 36);
  if (!Number.isSafeInteger(offset) || offset < 0 || match[2] !== cursorFingerprint(path, relativePath, offset)) {
    fail('plugin_fs_invalid_cursor', 'Filesystem list cursor is invalid');
  }
  return offset;
}

function validateReadLimit(maxBytes: number | undefined): number | undefined {
  if (maxBytes === undefined) return undefined;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    fail('plugin_fs_invalid_limit', 'Filesystem read limit is invalid');
  }
  return maxBytes;
}

export function createPluginFileSystemService(params: Readonly<{
  roots: PluginFileSystemRoots;
  machineNative?: boolean;
  signal: AbortSignal;
  retirementSignal?: AbortSignal;
  isOccurrenceCurrent(): boolean;
}>): Omit<FileSystemService, 'prepareDownload'> {
  function guard(signal?: AbortSignal): void {
    if (!params.isOccurrenceCurrent()) fail('plugin_generation_stale', 'Plugin occurrenceId is stale');
    guardCancellation(signal);
  }
  function guardCancellation(signal?: AbortSignal): void {
    if (params.signal.aborted || signal?.aborted) fail('plugin_fs_aborted', 'Filesystem operation was aborted');
  }
  function rootFor(path: PluginPath): string {
    if (path.root === 'pluginData') return params.roots.pluginData;
    if (path.root === 'workspace') return params.roots.workspace ?? fail('plugin_fs_root_unavailable', 'Workspace root is unavailable');
    return params.roots.projects.get(path.projectId) ?? fail('plugin_fs_root_unavailable', 'Project root is unavailable');
  }
  function resolveOperationPath(path: PluginPath): { root: string; relativePath: string } {
    const relativePath = normalizedRelativePath(path.relativePath);
    const root = resolve(rootFor(path));
    resolvePluginPathWithinRoots(params.roots, path);
    return { root, relativePath };
  }
  async function resolvePortableSpelling(root: string, relativePath: string, allowMissing: boolean): Promise<string> {
    let current = root;
    const segments = relativePath ? relativePath.split('/') : [];
    for (const [index, segment] of segments.entries()) {
      const entries = await readdir(current).catch(() => fail('plugin_fs_not_found', 'Filesystem path does not exist'));
      const folded = segment.normalize('NFC').toLocaleLowerCase('en-US');
      const matches = entries.filter((entry) => entry.normalize('NFC').toLocaleLowerCase('en-US') === folded);
      if (matches.length === 0) {
        if (!allowMissing) fail('plugin_fs_not_found', 'Filesystem path does not exist');
        return resolve(current, ...segments.slice(index));
      }
      const matchedEntry = matches[0]!;
      if (
        matches.length !== 1
        || matchedEntry.normalize('NFC') !== segment.normalize('NFC')
      ) {
        fail('plugin_fs_case_collision', 'Filesystem path has a case or Unicode collision');
      }
      current = resolve(current, matchedEntry);
      await realpath(current).catch(() => fail('plugin_fs_not_found', 'Filesystem path does not exist'));
    }
    return current;
  }
  async function resolveNativePath(root: string, relativePath: string, allowMissing: boolean): Promise<string> {
    await realpath(root).catch(() => fail('plugin_fs_root_unavailable', 'Filesystem root is unavailable'));
    const candidate = await resolvePortableSpelling(root, relativePath, allowMissing);
    let checked = candidate;
    if (allowMissing) {
      await mkdir(dirname(candidate), { recursive: true });
      checked = dirname(candidate);
    }
    await realpath(checked).catch(() => fail('plugin_fs_not_found', 'Filesystem path does not exist'));
    return candidate;
  }
  const implementation: Omit<FileSystemService, 'prepareDownload'> = {
    async observeMachinePath(input, emit, options) {
      guard(options?.signal);
      if (params.machineNative !== true) fail('plugin_fs_machine_context_required', 'Native filesystem observation requires Machine execution');
      if (!isAbsolute(input.absolutePath)) fail('plugin_fs_path_denied', 'Native filesystem observation requires an absolute path');
      const absolutePath = resolve(input.absolutePath);
      const read = () => withStableFileSystemErrors(async () => {
        guard(options?.signal);
        const canonical = await realpath(absolutePath).catch((error: unknown) => {
          if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return null;
          throw error;
        });
        if (!canonical) { guard(options?.signal); return null; }
        const info = await nodeStat(canonical, { bigint: true });
        if (!info.isFile()) fail('plugin_fs_unsupported_kind', 'Native identity observation requires a file');
        if (info.size > BigInt(Number.MAX_SAFE_INTEGER)) fail('plugin_fs_invalid_limit', 'Native file size cannot be represented');
        guard(options?.signal);
        return { identity: `${info.dev}:${info.ino}`, size: Number(info.size) };
      });
      return await observeMachinePath({ absolutePath, signal: AbortSignal.any([params.signal,
        ...(params.retirementSignal ? [params.retirementSignal] : []),
        ...(options?.signal ? [options.signal] : [])]), read, emit });
    },
    async readFile(path, options) {
      guard(options?.signal);
      const target = resolveOperationPath(path);
      const absolutePath = await resolveNativePath(target.root, target.relativePath, false);
      const handle = await open(absolutePath, 'r');
      try {
        const info = await handle.stat();
        if (!info.isFile()) fail('plugin_fs_unsupported_kind', 'Filesystem entry kind is unsupported');
        const limit = validateReadLimit(options?.maxBytes);
        if (limit !== undefined && info.size > limit) fail('plugin_fs_too_large', 'Filesystem read exceeds byte limit');
        const buffer = await handle.readFile();
        if (limit !== undefined && buffer.byteLength > limit) fail('plugin_fs_too_large', 'Filesystem read exceeds byte limit');
        const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
        guardCancellation(options?.signal);
        return bytes;
      } finally { await handle.close(); }
    },
    async writeFile(path, data, options) {
      guard(options?.signal);
      if (!(data instanceof Uint8Array)) fail('plugin_fs_too_large', 'Filesystem write data must be bytes');
      const target = resolveOperationPath(path);
      if (!target.relativePath) fail('plugin_fs_path_denied', 'Filesystem write target must name a file');
      const absolutePath = await resolveNativePath(target.root, target.relativePath, true);
      const existing = await lstat(absolutePath).catch((error: unknown) => {
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return null;
        throw error;
      });
      if (existing?.isDirectory() || existing?.isSymbolicLink()) {
        fail('plugin_fs_unsupported_kind', 'Filesystem entry kind is unsupported');
      }
      const temporary = resolve(dirname(absolutePath), `.${randomUUID()}.tmp`);
      let handle: Awaited<ReturnType<typeof open>> | null = await open(temporary, 'wx');
      try {
        await handle.writeFile(data);
        await handle.sync();
        await handle.close();
        handle = null;
        guardCancellation(options?.signal);
        await rename(temporary, absolutePath);
      } finally {
        try {
          if (handle) await handle.close();
        } finally {
          await unlink(temporary).catch(() => undefined);
        }
      }
    },
    async stat(path, options) {
      guard(options?.signal);
      const target = resolveOperationPath(path);
      const absolutePath = await resolveNativePath(target.root, target.relativePath, false);
      const info = await nodeStat(absolutePath);
      if (!info.isFile() && !info.isDirectory()) fail('plugin_fs_unsupported_kind', 'Filesystem entry kind is unsupported');
      guardCancellation(options?.signal);
      return { kind: info.isFile() ? 'file' : 'directory', size: info.size, modifiedAtMs: info.mtimeMs };
    },
    async list(path, options) {
      guard(options?.signal);
      const target = resolveOperationPath(path);
      const absolutePath = await resolveNativePath(target.root, target.relativePath, false);
      const directoryInfo = await nodeStat(absolutePath);
      if (!directoryInfo.isDirectory()) fail('plugin_fs_unsupported_kind', 'Filesystem entry kind is unsupported');
      const entries = (await readdir(absolutePath, { withFileTypes: true })).filter((entry) => entry.isFile() || entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
      const foldedNames = new Set<string>();
      for (const entry of entries) {
        if (isInvalidPortableComponent(entry.name)) fail('plugin_fs_path_denied', 'Filesystem directory contains a non-portable entry name');
        const folded = entry.name.normalize('NFC').toLocaleLowerCase('en-US');
        if (foldedNames.has(folded)) fail('plugin_fs_case_collision', 'Filesystem directory contains a case or Unicode collision');
        foldedNames.add(folded);
      }
      const start = decodeCursor(path, target.relativePath, options?.cursor);
      const limit = options?.limit;
      if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) fail('plugin_fs_invalid_limit', 'Filesystem list limit is invalid');
      const page = entries.slice(start, limit === undefined ? undefined : start + limit);
      guardCancellation(options?.signal);
      return { items: Object.freeze(page.map((entry) => Object.freeze({ name: entry.name, kind: entry.isFile() ? 'file' as const : 'directory' as const }))), ...(start + page.length < entries.length ? { nextCursor: encodeCursor(path, target.relativePath, start + page.length) } : {}) };
    },
    async remove(path, options) {
      guard(options?.signal);
      const target = resolveOperationPath(path);
      if (!target.relativePath) fail('plugin_fs_path_denied', 'Filesystem root cannot be removed');
      const absolutePath = await resolveNativePath(target.root, target.relativePath, false);
      const info = await lstat(absolutePath);
      if (info.isSymbolicLink()) fail('plugin_fs_path_denied', 'Filesystem symlinks cannot be removed through this service');
      if (info.isDirectory() && options?.recursive !== true) {
        fail('plugin_fs_recursive_required', 'Recursive removal must be requested explicitly');
      }
      guardCancellation(options?.signal);
      await rm(absolutePath, { recursive: options?.recursive === true, force: false });
    },
  };
  const service: Omit<FileSystemService, 'prepareDownload'> = {
    observeMachinePath: (input, emit, options) => withStableFileSystemErrors(() => implementation.observeMachinePath(input, emit, options)),
    readFile: (path, options) => withStableFileSystemErrors(() => implementation.readFile(path, options)),
    writeFile: (path, data, options) => withStableFileSystemErrors(() => implementation.writeFile(path, data, options)),
    stat: (path, options) => withStableFileSystemErrors(() => implementation.stat(path, options)),
    list: (path, options) => withStableFileSystemErrors(() => implementation.list(path, options)),
    remove: (path, options) => withStableFileSystemErrors(() => implementation.remove(path, options)),
  };
  return Object.freeze(service);
}
