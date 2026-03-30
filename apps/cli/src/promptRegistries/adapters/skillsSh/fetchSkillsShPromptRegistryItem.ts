import { existsSync, readFileSync, rmSync } from 'node:fs';
import { basename, join, relative } from 'node:path';

import type { PromptRegistryFetchItemResponseV1 } from '@happier-dev/protocol';

import { buildPromptBundleBodyFromDirectory } from '@/promptAssets/shared/promptBundleDirectory';
import {
  clonePromptRegistryRepositoryToTempDir,
  collectPromptRegistrySkillDirectories,
} from '@/promptRegistries/shared/gitSkillRepository';
import { readSkillBundleFrontmatter } from '@/promptRegistries/shared/readSkillBundleFrontmatter';

import { readSkillsShGitHubBaseUrl } from './skillsShRegistryConfig';
import { isValidSkillsShSource } from './skillsShCatalogValidation';
import { readSkillsShRegistryItemRef } from './skillsShRegistryItemId';

function buildSkillsShRepositoryUrl(source: string): string {
  if (!isValidSkillsShSource(source)) {
    throw new Error('skills.sh source must be an owner/repository pair');
  }
  const baseUrl = readSkillsShGitHubBaseUrl();
  if (baseUrl.startsWith('file://')) {
    return `${baseUrl}/${source}`;
  }
  return `${baseUrl}/${source}.git`;
}

function scoreSkillDirectory(rootDirectory: string, skillDirectory: string, skillId: string): number {
  const normalizedSkillId = skillId.trim().toLowerCase();
  const directoryName = basename(skillDirectory).trim().toLowerCase();
  const relativePath = relative(rootDirectory, skillDirectory).split('\\').join('/').toLowerCase();
  const skillMarkdown = readFileSync(join(skillDirectory, 'SKILL.md'), 'utf8');
  const frontmatter = readSkillBundleFrontmatter(skillMarkdown);
  const frontmatterName = frontmatter.name?.trim().toLowerCase() ?? '';

  if (directoryName === normalizedSkillId) return 3;
  if (relativePath.endsWith(`/${normalizedSkillId}`) || relativePath === normalizedSkillId) return 2;
  if (frontmatterName === normalizedSkillId) return 1;
  return 0;
}

function resolveSkillDirectory(rootDirectory: string, skillId: string): string | null {
  let bestMatch: { path: string; score: number } | null = null;
  for (const skillDirectory of collectPromptRegistrySkillDirectories(rootDirectory)) {
    const score = scoreSkillDirectory(rootDirectory, skillDirectory, skillId);
    if (score <= 0) continue;
    if (!bestMatch || score > bestMatch.score) {
      bestMatch = { path: skillDirectory, score };
    }
  }
  return bestMatch?.path ?? null;
}

export async function fetchSkillsShPromptRegistryItem(args: Readonly<{
  sourceId: string;
  itemId: string;
}>): Promise<PromptRegistryFetchItemResponseV1> {
  const ref = readSkillsShRegistryItemRef(args.sourceId, args.itemId);
  if (!ref) {
    return {
      ok: false,
      errorCode: 'invalid_request',
      error: 'itemId does not belong to this source',
    };
  }

  const cloneDirectory = clonePromptRegistryRepositoryToTempDir(buildSkillsShRepositoryUrl(ref.source));
  try {
    const skillDirectory = resolveSkillDirectory(cloneDirectory, ref.skillId);
    if (!skillDirectory || !existsSync(join(skillDirectory, 'SKILL.md'))) {
      return {
        ok: false,
        errorCode: 'not_found',
        error: 'skill bundle not found',
      };
    }

    const skillMarkdown = readFileSync(join(skillDirectory, 'SKILL.md'), 'utf8');
    const frontmatter = readSkillBundleFrontmatter(skillMarkdown);
    const title = frontmatter.name?.trim() || basename(skillDirectory);
    const description = frontmatter.description?.trim() || ref.source;

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
