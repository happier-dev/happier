import { describe, expect, it } from 'vitest';

import { PromptExternalLinksV1Schema } from './promptExternalLinksV1.js';

describe('promptExternalLinksV1 schemas', () => {
  it('parses an external prompt asset link collection', () => {
    const parsed = PromptExternalLinksV1Schema.parse({
      v: 1,
      links: [
        {
          id: 'link-1',
          artifactId: 'artifact-1',
          assetTypeId: 'claude.command',
          scope: 'project',
          machineId: 'machine-1',
          workspacePath: '/repo',
          externalRef: { relativePath: 'review/code.md' },
          syncMode: 'manual',
          baseDigest: 'sha256:base',
          lastLibraryDigest: 'sha256:library',
          lastExternalDigest: 'sha256:abc',
          lastSyncAtMs: 123,
        },
      ],
    });

    expect(parsed.links[0]?.externalRef).toEqual({ relativePath: 'review/code.md' });
    expect(parsed.links[0]?.syncMode).toBe('manual');
    expect(parsed.links[0]?.lastLibraryDigest).toBe('sha256:library');
  });
});
