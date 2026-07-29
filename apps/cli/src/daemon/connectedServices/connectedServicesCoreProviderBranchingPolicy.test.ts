import { readdir, readFile } from 'node:fs/promises';
import { relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const connectedServicesRoot = fileURLToPath(new URL('.', import.meta.url));

const providerOrServiceIdPattern =
  /(['"])(codex|claude|opencode|gemini|pi|openai-codex|claude-subscription|github|anthropic|openai)\1/gu;

const allowedProviderLiteralFiles: Readonly<Record<string, string>> = {
  'github/githubConnectedAccountTarget.ts':
    'provider-owned GitHub connected-account target owns the GitHub service id',
  'notifications/dispatchConnectedServiceAccountSwitchNotification.ts':
    'notification copy maps canonical service ids to product display names',
  'requestAuth/firstPartyConnectedAccountRequestAuthAdapter.ts':
    'the host-private first-party adapter owns the Codex account header refinement after generated qualified-service resolution',
  'refresh/ConnectedServiceRefreshCoordinator.ts':
    'Codex app-server ChatGPT bridge refresh is the central daemon lifecycle entrypoint for openai-codex',
  'refresh/serviceRefreshers.ts':
    'the named old-peer OAuth adapter refines generated-eligible Codex and Claude modes until the supported V2/V3 client-refresh window ends',
};

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

describe('connected-services shared core provider branching policy', () => {
  it('keeps provider and service ids out of shared core except documented provider-owned seams', async () => {
    const files = await listSourceFiles(connectedServicesRoot);
    const violations: string[] = [];

    for (const file of files) {
      const relativePath = relative(connectedServicesRoot, file).split(sep).join('/');
      if (allowedProviderLiteralFiles[relativePath]) continue;

      const source = await readFile(file, 'utf8');
      const matches = Array.from(source.matchAll(providerOrServiceIdPattern), (match) => match[2]);
      if (matches.length === 0) continue;

      violations.push(`${relativePath}: ${Array.from(new Set(matches)).join(', ')}`);
    }

    expect(violations).toEqual([]);
  });
});
