import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir, realpath, rename, rm, stat as nodeStat, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import { PluginError } from '@happier-dev/plugin-sdk';
import { type PluginFileSystemService, type PluginPath } from '@happier-dev/plugin-sdk/runtime';

const MAX_IO_BYTES = 16 * 1024 * 1024;
const MAX_LIST_ITEMS = 100;
const MAX_CURSOR_CHARS = 96;
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
type Access = 'read' | 'write' | 'delete';
export type PluginFileSystemScope = Readonly<{ root: PluginPath['root']; projectId?: string; pathPrefix?: string; access: readonly Access[] }>;

function fail(code: string, message: string): never {
  throw new PluginError({ code, message });
}

function translateFileSystemError(error: unknown): never {
  if (error instanceof PluginError) throw error;
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
  return !part
    || part === '.'
    || part === '..'
    || /[\u0000-\u001f<>:"|?*]/u.test(part)
    || /[ .]$/u.test(part)
    || WINDOWS_RESERVED_NAME.test(part);
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

export function isPluginPathAuthorizedByScope(
  path: PluginPath,
  scopes: readonly PluginFileSystemScope[],
  access: Access,
): boolean {
  const relativePath = normalizedRelativePath(path.relativePath);
  return scopes.some((scope) => {
    if (scope.root !== path.root || (path.root === 'project' && scope.projectId !== path.projectId)) return false;
    const prefix = scope.pathPrefix ? normalizedRelativePath(scope.pathPrefix) : '';
    return scope.access.includes(access) && (!prefix || relativePath === prefix || relativePath.startsWith(`${prefix}/`));
  });
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

export function resolvePluginPathWithinRoots(
  roots: Readonly<{ pluginData: string; workspace: string; projects: ReadonlyMap<string, string> }>,
  path: PluginPath,
): string {
  const relativePath = normalizedRelativePath(path.relativePath);
  const rawRoot = path.root === 'pluginData'
    ? roots.pluginData
    : path.root === 'workspace'
      ? roots.workspace
      : roots.projects.get(path.projectId) ?? fail('plugin_fs_root_unavailable', 'Project root is unavailable');
  const root = resolve(rawRoot);
  const candidate = resolve(root, relativePath);
  if (!isWithin(root, candidate)) fail('plugin_fs_path_denied', 'Filesystem path escapes its root');
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
  if (cursor.length > MAX_CURSOR_CHARS) fail('plugin_fs_invalid_cursor', 'Filesystem list cursor is invalid');
  const match = /^v1\.([0-9a-z]+)\.([A-Za-z0-9_-]{16})$/u.exec(cursor);
  if (!match) fail('plugin_fs_invalid_cursor', 'Filesystem list cursor is invalid');
  const offset = Number.parseInt(match[1]!, 36);
  if (!Number.isSafeInteger(offset) || offset < 0 || match[2] !== cursorFingerprint(path, relativePath, offset)) {
    fail('plugin_fs_invalid_cursor', 'Filesystem list cursor is invalid');
  }
  return offset;
}

function validateReadLimit(maxBytes: number | undefined): number {
  if (maxBytes === undefined) return MAX_IO_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    fail('plugin_fs_invalid_limit', 'Filesystem read limit is invalid');
  }
  return Math.min(MAX_IO_BYTES, maxBytes);
}

export function createPluginFileSystemService(params: Readonly<{
  roots: Readonly<{ pluginData: string; workspace: string; projects: ReadonlyMap<string, string> }>;
  scopes: readonly PluginFileSystemScope[];
  signal: AbortSignal;
  isGenerationCurrent(): boolean;
}>): PluginFileSystemService {
  function guard(signal?: AbortSignal): void {
    if (!params.isGenerationCurrent()) fail('plugin_generation_stale', 'Plugin generation is stale');
    if (params.signal.aborted || signal?.aborted) fail('plugin_fs_aborted', 'Filesystem operation was aborted');
  }
  function rootFor(path: PluginPath): string {
    if (path.root === 'pluginData') return params.roots.pluginData;
    if (path.root === 'workspace') return params.roots.workspace;
    return params.roots.projects.get(path.projectId) ?? fail('plugin_fs_root_unavailable', 'Project root is unavailable');
  }
  function authorize(path: PluginPath, access: Access): { root: string; relativePath: string; absolutePath: string } {
    const relativePath = normalizedRelativePath(path.relativePath);
    const allowed = isPluginPathAuthorizedByScope(path, params.scopes, access);
    if (!allowed) fail('plugin_fs_access_denied', 'Filesystem scope is not authorized');
    const root = resolve(rootFor(path));
    const absolutePath = resolvePluginPathWithinRoots(params.roots, path);
    return { root, relativePath, absolutePath };
  }
  async function assertPortableSpelling(root: string, relativePath: string, allowMissing: boolean): Promise<void> {
    let current = root;
    for (const segment of relativePath ? relativePath.split('/') : []) {
      const entries = await readdir(current).catch(() => fail('plugin_fs_not_found', 'Filesystem path does not exist'));
      const folded = segment.normalize('NFC').toLocaleLowerCase('en-US');
      const matches = entries.filter((entry) => entry.normalize('NFC').toLocaleLowerCase('en-US') === folded);
      if (matches.length === 0) {
        if (!allowMissing) fail('plugin_fs_not_found', 'Filesystem path does not exist');
        return;
      }
      if (matches.length !== 1 || matches[0] !== segment) {
        fail('plugin_fs_case_collision', 'Filesystem path has a case or Unicode collision');
      }
      current = resolve(current, segment);
      const canonicalRoot = await realpath(root).catch(() => fail('plugin_fs_root_unavailable', 'Filesystem root is unavailable'));
      const canonicalCurrent = await realpath(current).catch(() => fail('plugin_fs_not_found', 'Filesystem path does not exist'));
      if (!isWithin(canonicalRoot, canonicalCurrent)) {
        fail('plugin_fs_path_denied', 'Filesystem path resolves outside its root');
      }
    }
  }
  async function assertContained(root: string, relativePath: string, candidate: string, allowMissing: boolean): Promise<void> {
    const canonicalRoot = await realpath(root).catch(() => fail('plugin_fs_root_unavailable', 'Filesystem root is unavailable'));
    await assertPortableSpelling(root, relativePath, allowMissing);
    let checked = candidate;
    if (allowMissing) {
      await mkdir(dirname(candidate), { recursive: true });
      checked = dirname(candidate);
    }
    const canonical = await realpath(checked).catch(() => fail('plugin_fs_not_found', 'Filesystem path does not exist'));
    if (!isWithin(canonicalRoot, canonical)) fail('plugin_fs_path_denied', 'Filesystem path resolves outside its root');
  }
  const implementation: PluginFileSystemService = {
    async readFile(path, options) {
      guard(options?.signal);
      const target = authorize(path, 'read');
      await assertContained(target.root, target.relativePath, target.absolutePath, false);
      const handle = await open(target.absolutePath, 'r');
      try {
        const info = await handle.stat();
        if (!info.isFile()) fail('plugin_fs_unsupported_kind', 'Filesystem entry kind is unsupported');
        const limit = validateReadLimit(options?.maxBytes);
        if (info.size > limit) fail('plugin_fs_too_large', 'Filesystem read exceeds byte limit');
        const buffer = new Uint8Array(limit + 1);
        let offset = 0;
        while (offset < buffer.byteLength) {
          const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, offset);
          if (bytesRead === 0) break;
          offset += bytesRead;
        }
        if (offset > limit) fail('plugin_fs_too_large', 'Filesystem read exceeds byte limit');
        const bytes = buffer.slice(0, offset);
        guard(options?.signal);
        return bytes;
      } finally { await handle.close(); }
    },
    async writeFile(path, data, options) {
      guard(options?.signal);
      if (!(data instanceof Uint8Array) || data.byteLength > MAX_IO_BYTES) fail('plugin_fs_too_large', 'Filesystem write exceeds byte limit');
      const target = authorize(path, 'write');
      if (!target.relativePath) fail('plugin_fs_path_denied', 'Filesystem write target must name a file');
      await assertContained(target.root, target.relativePath, target.absolutePath, true);
      const existing = await lstat(target.absolutePath).catch((error: unknown) => {
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return null;
        throw error;
      });
      if (existing?.isDirectory() || existing?.isSymbolicLink()) {
        fail('plugin_fs_unsupported_kind', 'Filesystem entry kind is unsupported');
      }
      const temporary = resolve(dirname(target.absolutePath), `.${randomUUID()}.tmp`);
      let handle: Awaited<ReturnType<typeof open>> | null = await open(temporary, 'wx');
      try {
        await handle.writeFile(data);
        await handle.sync();
        await handle.close();
        handle = null;
        guard(options?.signal);
        await rename(temporary, target.absolutePath);
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
      const target = authorize(path, 'read');
      await assertContained(target.root, target.relativePath, target.absolutePath, false);
      const info = await nodeStat(target.absolutePath);
      if (!info.isFile() && !info.isDirectory()) fail('plugin_fs_unsupported_kind', 'Filesystem entry kind is unsupported');
      guard(options?.signal);
      return { kind: info.isFile() ? 'file' : 'directory', size: info.size, modifiedAtMs: info.mtimeMs };
    },
    async list(path, options) {
      guard(options?.signal);
      const target = authorize(path, 'read');
      await assertContained(target.root, target.relativePath, target.absolutePath, false);
      const directoryInfo = await nodeStat(target.absolutePath);
      if (!directoryInfo.isDirectory()) fail('plugin_fs_unsupported_kind', 'Filesystem entry kind is unsupported');
      const entries = (await readdir(target.absolutePath, { withFileTypes: true })).filter((entry) => entry.isFile() || entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
      const foldedNames = new Set<string>();
      for (const entry of entries) {
        if (isInvalidPortableComponent(entry.name)) fail('plugin_fs_path_denied', 'Filesystem directory contains a non-portable entry name');
        const folded = entry.name.normalize('NFC').toLocaleLowerCase('en-US');
        if (foldedNames.has(folded)) fail('plugin_fs_case_collision', 'Filesystem directory contains a case or Unicode collision');
        foldedNames.add(folded);
      }
      const start = decodeCursor(path, target.relativePath, options?.cursor);
      const requestedLimit = options?.limit ?? MAX_LIST_ITEMS;
      if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1) fail('plugin_fs_invalid_limit', 'Filesystem list limit is invalid');
      const limit = Math.min(MAX_LIST_ITEMS, requestedLimit);
      const page = entries.slice(start, start + limit);
      guard(options?.signal);
      return { items: Object.freeze(page.map((entry) => Object.freeze({ name: entry.name, kind: entry.isFile() ? 'file' as const : 'directory' as const }))), ...(start + page.length < entries.length ? { nextCursor: encodeCursor(path, target.relativePath, start + page.length) } : {}) };
    },
    async remove(path, options) {
      guard(options?.signal);
      const target = authorize(path, 'delete');
      if (!target.relativePath) fail('plugin_fs_path_denied', 'Filesystem root cannot be removed');
      await assertContained(target.root, target.relativePath, target.absolutePath, false);
      const info = await lstat(target.absolutePath);
      if (info.isSymbolicLink()) fail('plugin_fs_path_denied', 'Filesystem symlinks cannot be removed through this service');
      if (info.isDirectory() && options?.recursive !== true) {
        fail('plugin_fs_recursive_required', 'Recursive removal must be requested explicitly');
      }
      guard(options?.signal);
      await rm(target.absolutePath, { recursive: options?.recursive === true, force: false });
    },
  };
  const service: PluginFileSystemService = {
    readFile: (path, options) => withStableFileSystemErrors(() => implementation.readFile(path, options)),
    writeFile: (path, data, options) => withStableFileSystemErrors(() => implementation.writeFile(path, data, options)),
    stat: (path, options) => withStableFileSystemErrors(() => implementation.stat(path, options)),
    list: (path, options) => withStableFileSystemErrors(() => implementation.list(path, options)),
    remove: (path, options) => withStableFileSystemErrors(() => implementation.remove(path, options)),
  };
  return Object.freeze(service);
}
