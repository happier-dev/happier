import { decodeBase64 } from '../crypto/base64.js';
import { PromptBundleBodyV1Schema } from './promptBundleSchemas.js';
import { PromptDocBodyV1Schema } from './promptDocV2.js';
import type { PromptStackEntryV1, PromptStacksV1 } from './promptStacksV1.js';

function readSkillMarkdownFromPromptBundleBody(body: Readonly<{
  entries: ReadonlyArray<Readonly<{ path: string; contentBase64: string; contentKind: string }>>;
}>): string | null {
  const entry = body.entries.find((candidate) => candidate.path === 'SKILL.md');
  if (!entry) return null;
  if (entry.contentKind !== 'utf8') return null;

  try {
    return new TextDecoder().decode(decodeBase64(entry.contentBase64, 'base64'));
  } catch {
    return null;
  }
}

function listSystemAppendEntries(params: Readonly<{
  stacks: PromptStacksV1;
  surface: 'coding' | 'voice';
  profileId: string | null | undefined;
}>): PromptStackEntryV1[] {
  const surfaceEntries = params.surface === 'voice'
    ? (params.stacks.surfaces.voice ?? [])
    : (params.stacks.surfaces.coding ?? []);
  const profileId = typeof params.profileId === 'string' ? params.profileId.trim() : '';
  const profile = profileId ? (params.stacks.surfaces.profilesById?.[profileId] ?? []) : [];

  return [...surfaceEntries, ...profile].filter((entry) => {
    if (!entry.enabled) return false;
    return entry.placement === 'system_append' || entry.placement === 'skill_instructions';
  });
}

function parseJsonBodySafe(bodyRaw: string): unknown | null {
  try {
    return JSON.parse(bodyRaw);
  } catch {
    return null;
  }
}

export async function resolvePromptStackSystemAppendBlocksV1(args: Readonly<{
  surface: 'coding' | 'voice';
  promptStacksV1: PromptStacksV1 | null | undefined;
  profileId: string | null | undefined;
  readArtifactBody: (artifactId: string) => Promise<string | null | undefined>;
}>): Promise<string[]> {
  const stacks = args.promptStacksV1;
  if (!stacks) return [];

  const entries = listSystemAppendEntries({
    stacks,
    surface: args.surface,
    profileId: args.profileId,
  });
  if (entries.length === 0) return [];

  const out: string[] = [];
  for (const entry of entries) {
    const artifactId = entry.ref.artifactId;
    if (!artifactId) continue;

    const bodyRaw = await args.readArtifactBody(artifactId);
    if (typeof bodyRaw !== 'string') continue;

    let text: string | null = null;
    if (entry.ref.kind === 'doc') {
      const bodyJson = parseJsonBodySafe(bodyRaw);
      if (bodyJson == null) continue;
      const parsed = PromptDocBodyV1Schema.safeParse(bodyJson);
      if (!parsed.success) continue;
      text = parsed.data.markdown;
    } else if (entry.ref.kind === 'bundle') {
      const bodyJson = parseJsonBodySafe(bodyRaw);
      if (bodyJson == null) continue;
      const parsed = PromptBundleBodyV1Schema.safeParse(bodyJson);
      if (!parsed.success) continue;
      text = readSkillMarkdownFromPromptBundleBody(parsed.data);
    } else {
      continue;
    }

    const trimmed = typeof text === 'string' ? text.trim() : '';
    if (!trimmed) continue;

    if (typeof entry.maxChars === 'number' && Number.isFinite(entry.maxChars) && entry.maxChars > 0 && trimmed.length > entry.maxChars) {
      out.push(trimmed.slice(0, Math.floor(entry.maxChars)));
      continue;
    }

    out.push(trimmed);
  }

  return out;
}
