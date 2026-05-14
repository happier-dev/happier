import { readFile, readdir, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';

import {
  WorkspaceFaviconResolveRequestV1Schema,
  type WorkspaceFaviconMimeTypeV1,
  type WorkspaceFaviconResolveResponseV1,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import type { FilesystemAccessPolicy } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';
import { authorizeFilesystemPath } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemPathAuthorization';

const MAX_FAVICON_BYTES = 128 * 1024;
const MAX_WORKSPACE_PACKAGE_ROOTS = 24;

const DIRECT_FAVICON_CANDIDATES = [
  'favicon.svg',
  'favicon.ico',
  'favicon.png',
  'favicon.jpg',
  'favicon.jpeg',
  'favicon.webp',
  'public/favicon.svg',
  'public/favicon.ico',
  'public/favicon.png',
  'public/favicon.jpg',
  'public/favicon.jpeg',
  'public/favicon.webp',
  'app/favicon.ico',
  'app/favicon.png',
  'app/icon.svg',
  'app/icon.png',
  'app/icon.ico',
  'src/favicon.ico',
  'src/favicon.svg',
  'src/favicon.png',
  'src/favicon.webp',
  'src/app/favicon.ico',
  'src/app/icon.svg',
  'src/app/icon.png',
  'src/app/icon.ico',
  'assets/favicon.svg',
  'assets/favicon.ico',
  'assets/favicon.png',
  'assets/logo.svg',
  'assets/logo.png',
] as const;

const ICON_LINK_SOURCE_FILES = [
  'index.html',
  'public/index.html',
  'src/index.html',
  'app/layout.tsx',
  'app/root.tsx',
  'app/routes/__root.tsx',
  'src/app/layout.tsx',
  'src/app/root.tsx',
  'src/routes/__root.tsx',
  'src/root.tsx',
] as const;

const HTML_ICON_LINK_PATTERN = /<link\b(?=[^>]*\brel=["'][^"']*\b(?:icon|shortcut icon)\b[^"']*["'])(?=[^>]*\bhref=["']([^"'?]+))[^>]*>/gi;
const OBJECT_ICON_LINK_PATTERN = /(?=[^}]*\brel\s*:\s*["'][^"']*\b(?:icon|shortcut icon)\b[^"']*["'])(?=[^}]*\bhref\s*:\s*["']([^"'?]+))[^}]*/gi;

export function registerWorkspaceFaviconHandlers(
  rpcHandlerManager: RpcHandlerRegistrar,
  deps: Readonly<{
    defaultDirectory: string;
    accessPolicy: FilesystemAccessPolicy;
  }>,
): void {
  rpcHandlerManager.registerHandler<unknown, WorkspaceFaviconResolveResponseV1>(
    RPC_METHODS.WORKSPACE_FAVICON_RESOLVE,
    async (raw) => {
      const parsed = WorkspaceFaviconResolveRequestV1Schema.safeParse(raw);
      if (!parsed.success) {
        return { success: false, errorCode: 'INVALID_REQUEST', error: 'Invalid workspace favicon request' };
      }

      const workspace = authorizeFilesystemPath({
        targetPath: parsed.data.workspacePath,
        defaultDirectory: deps.defaultDirectory,
        accessPolicy: deps.accessPolicy,
      });
      if (!workspace.valid) {
        return { success: false, errorCode: 'INVALID_WORKSPACE_PATH', error: workspace.error };
      }

      return resolveWorkspaceFavicon({
        workspacePath: workspace.resolvedPath,
        defaultDirectory: deps.defaultDirectory,
        accessPolicy: deps.accessPolicy,
      });
    },
  );
}

async function resolveWorkspaceFavicon(params: Readonly<{
  workspacePath: string;
  defaultDirectory: string;
  accessPolicy: FilesystemAccessPolicy;
}>): Promise<WorkspaceFaviconResolveResponseV1> {
  for (const candidate of await buildFaviconCandidates(params)) {
    const resolved = await readWorkspaceFaviconCandidate({
      ...params,
      relativePath: candidate,
    });
    if (resolved) return resolved;
  }
  return { success: true, found: false };
}

async function buildFaviconCandidates(params: Readonly<{
  workspacePath: string;
  defaultDirectory: string;
  accessPolicy: FilesystemAccessPolicy;
}>): Promise<string[]> {
  const candidates = new Set<string>();
  await addFaviconCandidatesForRoot({ ...params, candidates, rootRelativePath: '' });
  for (const rootRelativePath of await readWorkspacePackageRoots(params)) {
    await addFaviconCandidatesForRoot({ ...params, candidates, rootRelativePath });
  }
  return Array.from(candidates);
}

async function addFaviconCandidatesForRoot(params: Readonly<{
  workspacePath: string;
  rootRelativePath: string;
  candidates: Set<string>;
  defaultDirectory: string;
  accessPolicy: FilesystemAccessPolicy;
}>): Promise<void> {
  for (const candidate of DIRECT_FAVICON_CANDIDATES) {
    params.candidates.add(prefixWorkspaceRelativePath(params.rootRelativePath, candidate));
  }

  for (const sourceFile of ICON_LINK_SOURCE_FILES) {
    const content = await readWorkspaceTextFile({
      ...params,
      relativePath: prefixWorkspaceRelativePath(params.rootRelativePath, sourceFile),
    });
    if (!content) continue;
    for (const linkedPath of readIconLinksFromSource(content)) {
      for (const normalized of normalizeWorkspaceRelativeIconHref(linkedPath)) {
        params.candidates.add(prefixWorkspaceRelativePath(params.rootRelativePath, normalized));
      }
    }
  }
}

function readIconLinksFromSource(content: string): string[] {
  const out: string[] = [];
  for (const match of content.matchAll(HTML_ICON_LINK_PATTERN)) {
    if (match[1]) out.push(match[1]);
  }
  for (const match of content.matchAll(OBJECT_ICON_LINK_PATTERN)) {
    if (match[1]) out.push(match[1]);
  }
  return out;
}

function normalizeWorkspaceRelativeIconHref(input: string): string[] {
  const trimmed = input.trim();
  if (!trimmed || trimmed.includes('\0')) return [];
  if (/^[a-z][a-z\d+.-]*:/i.test(trimmed) || trimmed.startsWith('//')) return [];
  const withoutQuery = trimmed.split(/[?#]/, 1)[0] ?? '';
  const relativePath = withoutQuery.replace(/^[/\\]+/, '');
  if (!relativePath || isAbsolute(relativePath)) return [];
  if (!readMimeType(relativePath)) return [];
  if (withoutQuery.startsWith('/') || withoutQuery.startsWith('\\')) {
    return [`public/${relativePath}`, relativePath];
  }
  return [relativePath];
}

async function readWorkspacePackageRoots(params: Readonly<{
  workspacePath: string;
  defaultDirectory: string;
  accessPolicy: FilesystemAccessPolicy;
}>): Promise<string[]> {
  const content = await readWorkspaceTextFile({ ...params, relativePath: 'package.json' });
  if (!content) return [];
  let manifest: unknown;
  try {
    manifest = JSON.parse(content);
  } catch {
    return [];
  }
  const patterns = readWorkspacePatterns(manifest);
  const roots: string[] = [];
  const seen = new Set<string>();
  for (const pattern of patterns) {
    for (const root of await expandWorkspacePattern({ ...params, pattern })) {
      if (seen.has(root)) continue;
      seen.add(root);
      roots.push(root);
      if (roots.length >= MAX_WORKSPACE_PACKAGE_ROOTS) return roots;
    }
  }
  return roots;
}

function readWorkspacePatterns(manifest: unknown): string[] {
  if (!manifest || typeof manifest !== 'object') return [];
  const workspaces = (manifest as { workspaces?: unknown }).workspaces;
  if (Array.isArray(workspaces)) return workspaces.filter((item): item is string => typeof item === 'string');
  if (workspaces && typeof workspaces === 'object') {
    const packages = (workspaces as { packages?: unknown }).packages;
    if (Array.isArray(packages)) return packages.filter((item): item is string => typeof item === 'string');
  }
  return [];
}

async function expandWorkspacePattern(params: Readonly<{
  workspacePath: string;
  pattern: string;
  defaultDirectory: string;
  accessPolicy: FilesystemAccessPolicy;
}>): Promise<string[]> {
  const pattern = normalizeWorkspacePattern(params.pattern);
  if (!pattern || pattern.startsWith('!')) return [];
  const starIndex = pattern.indexOf('*');
  if (starIndex < 0) {
    return await hasWorkspacePackageManifest({ ...params, relativePath: pattern }) ? [pattern] : [];
  }
  if (pattern.indexOf('*', starIndex + 1) >= 0) return [];
  const basePath = trimTrailingSlashes(pattern.slice(0, starIndex));
  const suffixPath = trimLeadingSlashes(pattern.slice(starIndex + 1));
  if (suffixPath.includes('*')) return [];
  const directoryNames = await readWorkspaceDirectoryNames({ ...params, relativePath: basePath || '.' });
  const roots: string[] = [];
  for (const directoryName of directoryNames) {
    const relativePath = prefixWorkspaceRelativePath(basePath, prefixWorkspaceRelativePath(directoryName, suffixPath));
    if (await hasWorkspacePackageManifest({ ...params, relativePath })) roots.push(relativePath);
  }
  return roots;
}

function normalizeWorkspacePattern(pattern: string): string | null {
  const normalized = trimTrailingSlashes(pattern.trim().replaceAll('\\', '/'));
  if (!normalized || normalized.includes('\0') || normalized.includes('..') || normalized.startsWith('/')) return null;
  if (/^[a-z][a-z\d+.-]*:/i.test(normalized)) return null;
  return normalized;
}

async function hasWorkspacePackageManifest(params: Readonly<{
  workspacePath: string;
  relativePath: string;
  defaultDirectory: string;
  accessPolicy: FilesystemAccessPolicy;
}>): Promise<boolean> {
  return Boolean(await readWorkspaceTextFile({
    ...params,
    relativePath: prefixWorkspaceRelativePath(params.relativePath, 'package.json'),
  }));
}

async function readWorkspaceDirectoryNames(params: Readonly<{
  workspacePath: string;
  relativePath: string;
  defaultDirectory: string;
  accessPolicy: FilesystemAccessPolicy;
}>): Promise<string[]> {
  const validation = resolveAuthorizedWorkspacePath(params);
  if (!validation.ok) return [];
  try {
    const stats = await stat(validation.path);
    if (!stats.isDirectory()) return [];
    const entries = await readdir(validation.path, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
}

function prefixWorkspaceRelativePath(prefix: string, relativePath: string): string {
  const normalizedPrefix = trimTrailingSlashes(prefix.replaceAll('\\', '/'));
  const normalizedRelativePath = trimLeadingSlashes(relativePath.replaceAll('\\', '/'));
  if (!normalizedPrefix) return normalizedRelativePath;
  if (!normalizedRelativePath) return normalizedPrefix;
  return `${normalizedPrefix}/${normalizedRelativePath}`;
}

function trimLeadingSlashes(value: string): string {
  return value.replace(/^\/+/, '');
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}

async function readWorkspaceTextFile(params: Readonly<{
  workspacePath: string;
  relativePath: string;
  defaultDirectory: string;
  accessPolicy: FilesystemAccessPolicy;
}>): Promise<string | null> {
  const validation = resolveAuthorizedWorkspacePath(params);
  if (!validation.ok) return null;
  try {
    const stats = await stat(validation.path);
    if (!stats.isFile() || stats.size > MAX_FAVICON_BYTES) return null;
    return await readFile(validation.path, 'utf8');
  } catch {
    return null;
  }
}

async function readWorkspaceFaviconCandidate(params: Readonly<{
  workspacePath: string;
  relativePath: string;
  defaultDirectory: string;
  accessPolicy: FilesystemAccessPolicy;
}>): Promise<WorkspaceFaviconResolveResponseV1 | null> {
  const mimeType = readMimeType(params.relativePath);
  if (!mimeType) return null;
  const validation = resolveAuthorizedWorkspacePath(params);
  if (!validation.ok) return null;
  try {
    const stats = await stat(validation.path);
    if (!stats.isFile() || stats.size > MAX_FAVICON_BYTES) return null;
    const buffer = await readFile(validation.path);
    return {
      success: true,
      found: true,
      relativePath: params.relativePath,
      mimeType,
      contentBase64: buffer.toString('base64'),
      sizeBytes: stats.size,
      modifiedMs: stats.mtimeMs,
    };
  } catch {
    return null;
  }
}

function resolveAuthorizedWorkspacePath(params: Readonly<{
  workspacePath: string;
  relativePath: string;
  defaultDirectory: string;
  accessPolicy: FilesystemAccessPolicy;
}>): { ok: true; path: string } | { ok: false } {
  if (isAbsolute(params.relativePath) || params.relativePath.includes('\0')) return { ok: false };
  const absolutePath = resolve(params.workspacePath, params.relativePath);
  const relativeToWorkspace = relative(params.workspacePath, absolutePath);
  if (relativeToWorkspace === '..' || relativeToWorkspace.startsWith(`..${sep}`) || isAbsolute(relativeToWorkspace)) {
    return { ok: false };
  }
  const validation = authorizeFilesystemPath({
    targetPath: absolutePath,
    defaultDirectory: params.defaultDirectory,
    accessPolicy: params.accessPolicy,
  });
  return validation.valid ? { ok: true, path: validation.resolvedPath } : { ok: false };
}

function readMimeType(filePath: string): WorkspaceFaviconMimeTypeV1 | null {
  switch (extname(filePath).toLowerCase()) {
    case '.gif':
      return 'image/gif';
    case '.ico':
      return 'image/x-icon';
    case '.jpeg':
    case '.jpg':
      return 'image/jpeg';
    case '.png':
      return 'image/png';
    case '.svg':
      return 'image/svg+xml';
    case '.webp':
      return 'image/webp';
    default:
      return null;
  }
}
