import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { GITHUB_API_VERSION } from './githubProviderContracts.js';

/**
 * One API-version owner.
 *
 * Four production spellings existed: the canonical constant here, two module-local
 * `const GITHUB_API_VERSION` copies, and one string literal in the account runtime. A
 * plugin that pins three different API versions on three of its own request paths is
 * one GitHub version bump away from three different failure modes, only one of which is
 * visible in the surface the user is looking at.
 */

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const PRODUCTION_REQUEST_OWNERS = [
  'auth/connectedAccountRuntime.ts',
  'pullRequests/restAdapter.ts',
  'repositoryProvisioning/githubRepositoryRestAdapter.ts',
  'observations/githubApiClient.ts',
];

describe('GitHub API version ownership', () => {
  it('sends the canonical API version from every production request owner', async () => {
    for (const relativePath of PRODUCTION_REQUEST_OWNERS) {
      const source = await readFile(resolve(sourceRoot, relativePath), 'utf8');

      expect(source, relativePath).toContain('GITHUB_API_VERSION');
      expect(source.match(/'\d{4}-\d{2}-\d{2}'/gu) ?? [], relativePath).toEqual([]);
    }
  });

  it('declares the canonical version exactly once, in the provider contract module', async () => {
    const contracts = await readFile(
      resolve(sourceRoot, 'observations/githubProviderContracts.ts'),
      'utf8',
    );

    expect(contracts).toContain(`export const GITHUB_API_VERSION = '${GITHUB_API_VERSION}'`);
    expect(GITHUB_API_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
  });
});
