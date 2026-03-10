import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';

import type {
  PromptRegistryFetchItemResponseV1,
  PromptRegistryItemSummaryV1,
} from '@happier-dev/protocol';

import { buildPromptBundleBodyFromDirectory } from '@/promptAssets/shared/promptBundleDirectory';

import {
  clonePromptRegistryRepositoryToTempDir,
  collectPromptRegistrySkillDirectories,
  resolvePromptRegistrySourceRoot,
} from './gitSkillRepository';
import { readSkillBundleFrontmatter } from './readSkillBundleFrontmatter';

function buildItemId(sourceId: string, relativeSkillPath: string): string {
  return `${sourceId}:${relativeSkillPath}`;
}

function readRelativeSkillPathFromItemId(sourceId: string, itemId: string): string | null {
  const prefix = `${sourceId}:`;
  if (!itemId.startsWith(prefix)) return null;
  const relativeSkillPath = itemId.slice(prefix.length).trim();
  if (!relativeSkillPath || relativeSkillPath.includes('..')) return null;
  return relativeSkillPath;
}

function isResolvedPathInsideRoot(rootPath: string, candidatePath: string): boolean {
  const relativePath = relative(rootPath, candidatePath);
  if (!relativePath || relativePath === '.') return true;
  return relativePath !== '..' && !relativePath.startsWith(`..${sep}`);
}

export async function scanGitPromptRegistrySource(args: Readonly<{
  sourceId: string;
  repositoryUrl: string;
  subdirectory?: string | null;
  query?: string | null;
}>): Promise<PromptRegistryItemSummaryV1[]> {
  const cloneDirectory = clonePromptRegistryRepositoryToTempDir(args.repositoryUrl);
  try {
    const sourceRoot = resolvePromptRegistrySourceRoot(cloneDirectory, args.subdirectory ?? null);
    const query = String(args.query ?? '').trim().toLowerCase();
    return collectPromptRegistrySkillDirectories(sourceRoot)
      .map((skillDirectory) => {
        const relativeSkillPath = relative(sourceRoot, skillDirectory).split('\\').join('/');
        const skillMarkdown = readFileSync(join(skillDirectory, 'SKILL.md'), 'utf8');
        const frontmatter = readSkillBundleFrontmatter(skillMarkdown);
        const title = frontmatter.name?.trim() || basename(skillDirectory);
        const description = frontmatter.description?.trim() || undefined;
        return {
          sourceId: args.sourceId,
          itemId: buildItemId(args.sourceId, relativeSkillPath),
          title,
          description,
          bundleSchemaId: 'skills.skill_md_v1' as const,
          displayPath: relativeSkillPath,
          providerHints: ['agents.skill'],
        };
      })
      .filter((item) => {
        if (!query) return true;
        const haystack = `${item.title}\n${item.description ?? ''}\n${item.displayPath}`.toLowerCase();
        return haystack.includes(query);
      });
  } finally {
    rmSync(cloneDirectory, { recursive: true, force: true });
  }
}

export async function fetchGitPromptRegistryItem(args: Readonly<{
  sourceId: string;
  itemId: string;
  repositoryUrl: string;
  subdirectory?: string | null;
}>): Promise<PromptRegistryFetchItemResponseV1> {
  const relativeSkillPath = readRelativeSkillPathFromItemId(args.sourceId, args.itemId);
  if (!relativeSkillPath) {
    return {
      ok: false,
      errorCode: 'invalid_request',
      error: 'itemId does not belong to this source',
    };
  }

  const cloneDirectory = clonePromptRegistryRepositoryToTempDir(args.repositoryUrl);
  try {
    const sourceRoot = resolvePromptRegistrySourceRoot(cloneDirectory, args.subdirectory ?? null);
    const skillDirectory = resolve(sourceRoot, relativeSkillPath);
    if (!isResolvedPathInsideRoot(resolve(sourceRoot), skillDirectory)) {
      return {
        ok: false,
        errorCode: 'invalid_request',
        error: 'itemId resolves outside the source root',
      };
    }
    if (!existsSync(join(skillDirectory, 'SKILL.md'))) {
      return {
        ok: false,
        errorCode: 'not_found',
        error: 'skill bundle not found',
      };
    }

    const skillMarkdown = readFileSync(join(skillDirectory, 'SKILL.md'), 'utf8');
    const frontmatter = readSkillBundleFrontmatter(skillMarkdown);
    const title = frontmatter.name?.trim() || basename(skillDirectory);
    const description = frontmatter.description?.trim() || undefined;

    return {
      ok: true,
      item: {
        sourceId: args.sourceId,
        itemId: args.itemId,
        title,
        description,
        bundleSchemaId: 'skills.skill_md_v1',
        bundleBody: buildPromptBundleBodyFromDirectory({
          rootDirectory: skillDirectory,
          preferredFirstPath: 'SKILL.md',
        }),
      },
    };
  } catch (error) {
    return {
      ok: false,
      errorCode: 'internal_error',
      error: error instanceof Error ? error.message : 'failed to fetch registry item',
    };
  } finally {
    rmSync(cloneDirectory, { recursive: true, force: true });
  }
}
