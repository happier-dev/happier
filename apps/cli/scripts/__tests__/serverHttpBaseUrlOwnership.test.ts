import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const cliRoot = process.cwd();

describe('server HTTP base URL helper ownership', () => {
  it('keeps resolveServerHttpBaseUrl defined only in the canonical helper modules', () => {
    const trackedFiles = [
      'src/api/client/serverHttpBaseUrl.ts',
      'src/session/transport/http/serverHttpBaseUrl.ts',
      'src/approvals/cliApprovalsArtifactStore.ts',
      'src/agent/promptLibrary/resolveCliPromptStackSystemAppendBlocks.ts',
    ];

    const owners = trackedFiles.filter((relativePath) => {
      const source = readFileSync(resolve(cliRoot, relativePath), 'utf8');
      return /\b(?:export\s+)?function\s+resolveServerHttpBaseUrl\s*\(/.test(source);
    });

    expect(owners.map((path) => relative(cliRoot, resolve(cliRoot, path)))).toEqual(
      ['src/api/client/serverHttpBaseUrl.ts'],
    );

    expect(readFileSync(resolve(cliRoot, 'src/session/transport/http/serverHttpBaseUrl.ts'), 'utf8')).toMatch(
      /export\s*\{[^}]*\bresolveServerHttpBaseUrl\b[^}]*\}\s*from\s*['"]@\/api\/client\/serverHttpBaseUrl['"]/u,
    );
  });
});
