import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

import {
  PromptAssetDeleteRequest,
  PromptAssetDiscoverRequest,
  type PromptAssetDiscoveryItemV1,
  PromptAssetMutationResponseV1,
  PromptAssetReadRequest,
  PromptAssetReadResponseV1,
  PromptAssetTypeDescriptorV1,
  PromptAssetWriteDocRequest,
  PromptAssetWriteBundleRequest,
  type PromptAssetCapabilitiesV1,
} from '@happier-dev/protocol';

import type { PromptAssetAdapter } from '@/promptAssets/types';
import { toPromptAssetMutationError, toPromptAssetReadError } from '@/promptAssets/shared/promptAssetResponses';
import { resolveScopedPromptAssetRoot } from '@/promptAssets/shared/resolveScopedPromptAssetRoot';

type MarkdownDocPromptAssetAdapterConfig = Readonly<{
  assetTypeId: string;
  providerId: string;
  title: string;
  description: string;
  projectRootPath: readonly string[];
  projectRootDisplayPath: string;
  userRootPath: readonly string[];
  userRootDisplayPath: string;
  capabilities?: PromptAssetCapabilitiesV1;
}>;

function resolveRootPath(params: Readonly<{
  scope: 'user' | 'project';
  directory?: string | null | undefined;
  homedir?: () => string;
  config: MarkdownDocPromptAssetAdapterConfig;
}>): { ok: true; rootPath: string; displayRoot: string } | { ok: false; error: string } {
  return resolveScopedPromptAssetRoot(params);
}

function isSymlinkPath(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function collectMarkdownRelativePaths(rootPath: string): string[] {
  if (isSymlinkPath(rootPath)) return [];

  const out: string[] = [];
  const stack = [rootPath];

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (isSymlinkPath(current)) continue;
    const dirents = readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const dirent of dirents) {
      const absolutePath = join(current, dirent.name);
      if (isSymlinkPath(absolutePath)) continue;
      if (dirent.isDirectory()) {
        stack.push(absolutePath);
        continue;
      }
      if (!dirent.isFile()) continue;
      if (!dirent.name.toLowerCase().endsWith('.md')) continue;
      out.push(relative(rootPath, absolutePath).split(sep).join('/'));
    }
  }

  return out.sort((left, right) => left.localeCompare(right));
}

function resolvesThroughSymlink(rootPath: string, absolutePath: string): boolean {
  if (isSymlinkPath(rootPath)) return true;

  const relativePath = relative(rootPath, absolutePath);
  if (relativePath === '..' || relativePath.startsWith(`..${sep}`)) return true;

  let currentPath = rootPath;
  for (const segment of relativePath.split(sep)) {
    if (!segment || segment === '.') continue;
    currentPath = join(currentPath, segment);
    if (!existsSync(currentPath)) break;
    if (isSymlinkPath(currentPath)) return true;
  }

  return false;
}

function readRelativePathFromExternalRef(externalRef: Record<string, unknown>): string | null {
  const relativePath = typeof externalRef.relativePath === 'string' ? externalRef.relativePath.trim() : '';
  if (!relativePath) return null;
  if (
    relativePath.startsWith('/')
    || relativePath.startsWith('\\')
    || relativePath.includes('..')
    || relativePath.includes('\\')
    || /^[a-z]:/i.test(relativePath)
  ) return null;
  if (!relativePath.toLowerCase().endsWith('.md')) return null;
  return relativePath;
}

function readRelativePathFromTargetPath(targetPath: string): string | null {
  const relativePath = targetPath.trim();
  if (!relativePath) return null;
  if (
    relativePath.startsWith('/')
    || relativePath.startsWith('\\')
    || relativePath.includes('..')
    || relativePath.includes('\\')
    || /^[a-z]:/i.test(relativePath)
  ) return null;
  if (!relativePath.toLowerCase().endsWith('.md')) return null;
  return relativePath;
}

function computeMarkdownDigest(markdown: string): string {
  const hash = createHash('sha256');
  hash.update(markdown, 'utf8');
  return `sha256:${hash.digest('hex')}`;
}

function buildDocItem(params: Readonly<{
  assetTypeId: string;
  scope: 'user' | 'project';
  displayRoot: string;
  relativePath: string;
  markdown: string;
}>): PromptAssetDiscoveryItemV1 {
  const title = params.relativePath.replace(/\.md$/i, '');
  return {
    assetTypeId: params.assetTypeId,
    scope: params.scope,
    externalRef: { relativePath: params.relativePath },
    title,
    libraryKind: 'doc',
    digest: computeMarkdownDigest(params.markdown),
    displayPath: `${params.displayRoot}/${params.relativePath}`,
  };
}

function buildDocReadItem(params: Readonly<{
  assetTypeId: string;
  scope: 'user' | 'project';
  displayRoot: string;
  relativePath: string;
  markdown: string;
}>): Extract<PromptAssetReadResponseV1, { ok: true }>['item'] {
  const title = params.relativePath.replace(/\.md$/i, '');
  return {
    assetTypeId: params.assetTypeId,
    scope: params.scope,
    externalRef: { relativePath: params.relativePath },
    title,
    libraryKind: 'doc',
    digest: computeMarkdownDigest(params.markdown),
    displayPath: `${params.displayRoot}/${params.relativePath}`,
    markdown: params.markdown,
  };
}

export function createMarkdownDocPromptAssetAdapter(
  config: MarkdownDocPromptAssetAdapterConfig,
  params?: Readonly<{ homedir?: () => string }>,
): PromptAssetAdapter {
  const descriptor: PromptAssetTypeDescriptorV1 = {
    id: config.assetTypeId,
    providerId: config.providerId,
    title: config.title,
    description: config.description,
    libraryKind: 'doc',
    supportsScope: { user: true, project: true },
    supportsFiles: false,
    formatId: 'markdown_utf8_v1',
    defaultRoots: [
      { label: 'Project commands', scope: 'project', pathTemplate: config.projectRootDisplayPath },
      { label: 'User commands', scope: 'user', pathTemplate: config.userRootDisplayPath },
    ],
    capabilities: config.capabilities ?? {},
  };

  return {
    descriptor,

    async discover(request: PromptAssetDiscoverRequest) {
      const root = resolveRootPath({
        scope: request.scope,
        directory: request.directory,
        homedir: params?.homedir,
        config,
      });
      if (!root.ok || !existsSync(root.rootPath)) return [];

      return collectMarkdownRelativePaths(root.rootPath).map((relativePath) => {
        const markdown = readFileSync(join(root.rootPath, relativePath.split('/').join(sep)), 'utf8');
        return buildDocItem({
          assetTypeId: config.assetTypeId,
          scope: request.scope,
          displayRoot: root.displayRoot,
          relativePath,
          markdown,
        });
      });
    },

    async read(request: PromptAssetReadRequest): Promise<PromptAssetReadResponseV1> {
      const root = resolveRootPath({
        scope: request.scope,
        directory: request.directory,
        homedir: params?.homedir,
        config,
      });
      if (!root.ok) return toPromptAssetReadError('invalid_request', root.error);

      const relativePath = readRelativePathFromExternalRef(request.externalRef);
      if (!relativePath) return toPromptAssetReadError('invalid_request', 'externalRef.relativePath is required');

      const absolutePath = join(root.rootPath, relativePath.split('/').join(sep));
      if (resolvesThroughSymlink(root.rootPath, absolutePath)) {
        return toPromptAssetReadError('access_denied', 'prompt asset path resolves through a symlink');
      }
      if (!existsSync(absolutePath)) return toPromptAssetReadError('not_found', 'prompt asset not found');
      const markdown = readFileSync(absolutePath, 'utf8');

      return {
        ok: true,
        item: buildDocReadItem({
          assetTypeId: config.assetTypeId,
          scope: request.scope,
          displayRoot: root.displayRoot,
          relativePath,
          markdown,
        }),
      };
    },

    async writeDoc(request: PromptAssetWriteDocRequest): Promise<PromptAssetMutationResponseV1> {
      const root = resolveRootPath({
        scope: request.scope,
        directory: request.directory,
        homedir: params?.homedir,
        config,
      });
      if (!root.ok) return toPromptAssetMutationError('invalid_request', root.error);

      const relativePath = readRelativePathFromTargetPath(request.targetPath);
      if (!relativePath) return toPromptAssetMutationError('invalid_request', 'targetPath must be a relative markdown path');

      const absolutePath = join(root.rootPath, relativePath.split('/').join(sep));
      if (resolvesThroughSymlink(root.rootPath, absolutePath)) {
        return toPromptAssetMutationError('access_denied', 'prompt asset path resolves through a symlink');
      }
      const currentDigest = existsSync(absolutePath) ? computeMarkdownDigest(readFileSync(absolutePath, 'utf8')) : null;
      if (request.expectedDigest && request.expectedDigest !== currentDigest) {
        return toPromptAssetMutationError('conflict', 'prompt asset has changed on disk', currentDigest);
      }

      const preview = {
        operation: 'write' as const,
        targetPath: `${root.displayRoot}/${relativePath}`,
        fileCount: 1,
      };

      if (request.previewOnly === true) {
        return {
          ok: true,
          externalRef: { relativePath },
          digest: computeMarkdownDigest(request.markdown),
          preview,
        };
      }

      mkdirSync(dirname(absolutePath), { recursive: true });
      writeFileSync(absolutePath, request.markdown, 'utf8');
      return {
        ok: true,
        externalRef: { relativePath },
        digest: computeMarkdownDigest(request.markdown),
        preview,
      };
    },

    async writeBundle(_request: PromptAssetWriteBundleRequest): Promise<PromptAssetMutationResponseV1> {
      return toPromptAssetMutationError('unsupported', 'bundle writes are not supported for this prompt asset type');
    },

    async delete(request: PromptAssetDeleteRequest): Promise<PromptAssetMutationResponseV1> {
      const root = resolveRootPath({
        scope: request.scope,
        directory: request.directory,
        homedir: params?.homedir,
        config,
      });
      if (!root.ok) return toPromptAssetMutationError('invalid_request', root.error);

      const relativePath = readRelativePathFromExternalRef(request.externalRef);
      if (!relativePath) return toPromptAssetMutationError('invalid_request', 'externalRef.relativePath is required');

      const absolutePath = join(root.rootPath, relativePath.split('/').join(sep));
      if (resolvesThroughSymlink(root.rootPath, absolutePath)) {
        return toPromptAssetMutationError('access_denied', 'prompt asset path resolves through a symlink');
      }
      const currentDigest = existsSync(absolutePath) ? computeMarkdownDigest(readFileSync(absolutePath, 'utf8')) : null;
      if (!currentDigest) return toPromptAssetMutationError('not_found', 'prompt asset not found');
      if (request.expectedDigest && request.expectedDigest !== currentDigest) {
        return toPromptAssetMutationError('conflict', 'prompt asset has changed on disk', currentDigest);
      }

      const preview = {
        operation: 'delete' as const,
        targetPath: `${root.displayRoot}/${relativePath}`,
        fileCount: 1,
      };

      if (request.previewOnly === true) {
        return {
          ok: true,
          externalRef: { relativePath },
          digest: currentDigest,
          preview,
        };
      }

      rmSync(absolutePath, { force: true });
      return {
        ok: true,
        externalRef: { relativePath },
        digest: currentDigest,
        preview,
      };
    },
  };
}
