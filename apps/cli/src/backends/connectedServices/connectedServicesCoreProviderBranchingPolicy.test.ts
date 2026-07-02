import { readdir, readFile } from 'node:fs/promises';
import { relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Provider-branching policy for the SHARED connected-services backend core (K4).
 *
 * `src/backends/connectedServices/**` is provider-agnostic glue: the resume-reachability dispatcher,
 * the normalized reachability types, and the switch-continuity context. None of it may branch on a
 * provider id or hard-code a service id — the per-provider decision must live in
 * `src/backends/<provider>/...` and be resolved through the catalog hook
 * (`AgentCatalogEntry.verifyResumeReachable`), not a central `switch(agentId)`.
 *
 * This guard is what forces the dispatcher to stay de-switched: a `case 'pi':` / `case 'claude':`
 * (or a `@/backends/pi/...` provider import) here is a policy violation.
 */

const connectedServicesCoreRoot = fileURLToPath(new URL('.', import.meta.url));

const providerOrServiceIdPattern =
  /(['"])(codex|claude|opencode|gemini|pi|ohMyPi|openai-codex|claude-subscription|github|anthropic|openai)\1/gu;

const allowedProviderLiteralFiles: Readonly<Record<string, string>> = {};

async function listSourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const fullPath = `${dir}${sep}${entry.name}`;
    if (entry.isDirectory()) return await listSourceFiles(fullPath);
    if (!entry.isFile()) return [];
    if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) return [];
    return [fullPath];
  }));
  return files.flat();
}

describe('connected-services backend core provider branching policy', () => {
  it('keeps provider and service ids out of the shared backend core except documented seams', async () => {
    const files = await listSourceFiles(connectedServicesCoreRoot);
    const violations: string[] = [];

    for (const file of files) {
      const relativePath = relative(connectedServicesCoreRoot, file).split(sep).join('/');
      if (allowedProviderLiteralFiles[relativePath]) continue;

      const source = await readFile(file, 'utf8');
      const matches = Array.from(source.matchAll(providerOrServiceIdPattern), (match) => match[2]);
      if (matches.length === 0) continue;

      violations.push(`${relativePath}: ${Array.from(new Set(matches)).join(', ')}`);
    }

    expect(violations).toEqual([]);
  });
});
