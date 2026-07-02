import { readdir } from 'node:fs/promises';

import { codexStateSharingDescriptor } from '../../state/sharing/descriptor.js';

type CodexStateMode = 'shared' | 'isolated';

function dedupeEntries(entries: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of entries) {
    if (!entry || seen.has(entry)) continue;
    seen.add(entry);
    result.push(entry);
  }
  return result;
}

function resolveCodexStateDynamicEntryPatterns(): Readonly<Record<string, RegExp>> {
  const patterns: Record<string, RegExp> = {};
  for (const [patternId, entryPattern] of Object.entries(codexStateSharingDescriptor.dynamicEntryPatterns ?? {})) {
    if (entryPattern.scope !== 'state') continue;
    try {
      patterns[patternId] = new RegExp(entryPattern.pattern);
    } catch {
      continue;
    }
  }
  return patterns;
}

async function listCodexDynamicStateEntries(
  root: string,
  dynamicPatterns: Readonly<Record<string, RegExp>>,
): Promise<readonly string[]> {
  const entries: string[] = [];
  const patterns = Object.values(dynamicPatterns);
  if (patterns.length === 0) return entries;
  let names: string[];
  try {
    names = await readdir(root);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err?.code === 'ENOENT') return entries;
    throw error;
  }
  for (const name of names) {
    if (patterns.some((pattern) => pattern.test(name))) entries.push(name);
  }
  return entries;
}

export function resolveCodexSqliteStateEntryPattern(): RegExp | null {
  return resolveCodexStateDynamicEntryPatterns().sqlite ?? null;
}

export async function resolveCodexStateEntryNames(params: Readonly<{
  sourceSqliteHome: string;
  destinationCodexHome: string;
  stateMode: CodexStateMode;
}>): Promise<readonly string[]> {
  const dynamicStatePatterns = resolveCodexStateDynamicEntryPatterns();
  const staticStateEntries = codexStateSharingDescriptor.state.entries.map((entry) => entry.path);
  if (params.stateMode === 'shared') {
    return dedupeEntries([
      ...staticStateEntries,
      ...await listCodexDynamicStateEntries(params.sourceSqliteHome, dynamicStatePatterns),
      ...await listCodexDynamicStateEntries(params.destinationCodexHome, dynamicStatePatterns),
    ]);
  }
  return dedupeEntries([
    ...staticStateEntries,
    ...await listCodexDynamicStateEntries(params.destinationCodexHome, dynamicStatePatterns),
  ]);
}
