import type { PromptRegistryItemSummaryV1 } from '@happier-dev/protocol';

import { buildSkillsShRegistryItemId } from './skillsShRegistryItemId';
import {
  readSkillsShBaseUrl,
  readSkillsShFeaturedLimit,
  readSkillsShSearchLimit,
} from './skillsShRegistryConfig';
import { normalizeSkillsShCatalogRef } from './skillsShCatalogValidation';

type SkillsShRegistryCatalogItem = Readonly<{
  source: string;
  skillId: string;
  title: string;
}>;

function buildPromptRegistryItem(sourceId: string, item: SkillsShRegistryCatalogItem): PromptRegistryItemSummaryV1 {
  return {
    sourceId,
    itemId: buildSkillsShRegistryItemId(sourceId, {
      source: item.source,
      skillId: item.skillId,
    }),
    title: item.title,
    description: item.source,
    bundleSchemaId: 'skills.skill_md_v1',
    displayPath: `${item.source}/${item.skillId}`,
    providerHints: ['agents.skill'],
  };
}

function parseFeaturedSkillsFromHtml(html: string): SkillsShRegistryCatalogItem[] {
  const matches = html.matchAll(/href="\/([^/"?#]+)\/([^/"?#]+)\/([^/"?#]+)"/g);
  const items: SkillsShRegistryCatalogItem[] = [];
  const seen = new Set<string>();
  for (const match of matches) {
    const owner = match[1]?.trim();
    const repo = match[2]?.trim();
    const skillId = match[3]?.trim();
    if (!owner || !repo || !skillId) continue;
    const source = `${owner}/${repo}`;
    const dedupeKey = `${source}/${skillId}`;
    if (seen.has(dedupeKey)) continue;
    const normalized = normalizeSkillsShCatalogRef({ source, skillId });
    if (!normalized) continue;
    seen.add(dedupeKey);
    items.push({
      source: normalized.source,
      skillId: normalized.skillId,
      title: normalized.skillId,
    });
  }
  return items;
}

function parseFeaturedSkillsFromSitemap(xml: string): SkillsShRegistryCatalogItem[] {
  const matches = xml.matchAll(/<loc>https:\/\/skills\.sh\/([^/<]+)\/([^/<]+)\/([^/<]+)<\/loc>/g);
  const items: SkillsShRegistryCatalogItem[] = [];
  const seen = new Set<string>();
  for (const match of matches) {
    const owner = match[1]?.trim();
    const repo = match[2]?.trim();
    const skillId = match[3]?.trim();
    if (!owner || !repo || !skillId) continue;
    const source = `${owner}/${repo}`;
    const dedupeKey = `${source}/${skillId}`;
    if (seen.has(dedupeKey)) continue;
    const normalized = normalizeSkillsShCatalogRef({ source, skillId });
    if (!normalized) continue;
    seen.add(dedupeKey);
    items.push({
      source: normalized.source,
      skillId: normalized.skillId,
      title: normalized.skillId,
    });
  }
  return items;
}

function parseSearchSkills(payload: unknown): SkillsShRegistryCatalogItem[] {
  const skills = Array.isArray((payload as { skills?: unknown }).skills)
    ? (payload as { skills: unknown[] }).skills
    : [];
  return skills.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const source = typeof (entry as { source?: unknown }).source === 'string'
      ? (entry as { source: string }).source.trim()
      : '';
    const skillId = typeof (entry as { skillId?: unknown }).skillId === 'string'
      ? (entry as { skillId: string }).skillId.trim()
      : '';
    const title = typeof (entry as { name?: unknown }).name === 'string'
      ? (entry as { name: string }).name.trim()
      : skillId;
    if (!title) return [];
    const normalized = normalizeSkillsShCatalogRef({ source, skillId });
    if (!normalized) return [];
    return [{
      source: normalized.source,
      skillId: normalized.skillId,
      title,
    }];
  });
}

export async function scanSkillsShPromptRegistrySource(args: Readonly<{
  sourceId: string;
  query?: string | null;
}>): Promise<PromptRegistryItemSummaryV1[]> {
  const query = String(args.query ?? '').trim();
  if (query.length > 0 && query.length < 2) {
    return [];
  }
  if (query.length > 0) {
    const response = await fetch(`${readSkillsShBaseUrl()}/api/search?q=${encodeURIComponent(query)}&limit=${readSkillsShSearchLimit()}`);
    if (!response.ok) {
      throw new Error(`skills.sh search failed with ${response.status}`);
    }
    const payload = await response.json();
    const items = parseSearchSkills(payload);
    const deduped = new Map(items.map((item) => [`${item.source}/${item.skillId}`, item]));
    return [...deduped.values()].map((item) => buildPromptRegistryItem(args.sourceId, item));
  }

  const response = await fetch(readSkillsShBaseUrl());
  if (!response.ok) {
    throw new Error(`skills.sh featured page failed with ${response.status}`);
  }
  const html = await response.text();
  const featuredItems = parseFeaturedSkillsFromHtml(html);
  if (featuredItems.length > 0) {
    return featuredItems
      .slice(0, readSkillsShFeaturedLimit())
      .map((item) => buildPromptRegistryItem(args.sourceId, item));
  }

  const sitemapResponse = await fetch(`${readSkillsShBaseUrl()}/sitemap.xml`);
  if (!sitemapResponse.ok) {
    throw new Error(`skills.sh sitemap failed with ${sitemapResponse.status}`);
  }
  const sitemapXml = await sitemapResponse.text();
  return parseFeaturedSkillsFromSitemap(sitemapXml)
    .slice(0, readSkillsShFeaturedLimit())
    .map((item) => buildPromptRegistryItem(args.sourceId, item));
}
