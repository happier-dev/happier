import { readdirSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

const CODEX_ROLLOUT_SEARCH_MAX_DEPTH = 10;

export function isMatchingCodexRolloutFileName(name: string, vendorResumeId: string): boolean {
  return name.startsWith('rollout-') && name.endsWith(`-${vendorResumeId}.jsonl`);
}

function compareDescending(a: string, b: string): number {
  return b.localeCompare(a);
}

export async function findCodexRolloutFileById(params: Readonly<{
  sessionsRoot: string;
  vendorResumeId: string;
}>): Promise<string | null> {
  async function walk(currentDir: string, depth: number): Promise<string | null> {
    if (depth > CODEX_ROLLOUT_SEARCH_MAX_DEPTH) return null;

    const subDirectoryNames: string[] = [];
    try {
      const entries = await readdir(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const entryName = String(entry.name);
        if (entry.isDirectory()) {
          subDirectoryNames.push(entryName);
          continue;
        }
        if (!entry.isFile()) continue;
        if (isMatchingCodexRolloutFileName(entryName, params.vendorResumeId)) {
          return join(currentDir, entryName);
        }
      }
    } catch {
      return null;
    }

    subDirectoryNames.sort(compareDescending);
    for (const subDirectoryName of subDirectoryNames) {
      const found = await walk(join(currentDir, subDirectoryName), depth + 1);
      if (found) return found;
    }
    return null;
  }

  return await walk(params.sessionsRoot, 0);
}

export function findCodexRolloutFileByIdSync(params: Readonly<{
  sessionsRoot: string;
  vendorResumeId: string;
}>): string | null {
  function walk(currentDir: string, depth: number): string | null {
    if (depth > CODEX_ROLLOUT_SEARCH_MAX_DEPTH) return null;

    const subDirectoryNames: string[] = [];
    try {
      const entries = readdirSync(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const entryName = String(entry.name);
        if (entry.isDirectory()) {
          subDirectoryNames.push(entryName);
          continue;
        }
        if (!entry.isFile()) continue;
        if (isMatchingCodexRolloutFileName(entryName, params.vendorResumeId)) {
          return join(currentDir, entryName);
        }
      }
    } catch {
      return null;
    }

    subDirectoryNames.sort(compareDescending);
    for (const subDirectoryName of subDirectoryNames) {
      const found = walk(join(currentDir, subDirectoryName), depth + 1);
      if (found) return found;
    }
    return null;
  }

  return walk(params.sessionsRoot, 0);
}
