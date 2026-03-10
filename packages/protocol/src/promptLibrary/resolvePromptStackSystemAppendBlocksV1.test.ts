import { describe, expect, it } from 'vitest';

import { resolvePromptStackSystemAppendBlocksV1 } from './resolvePromptStackSystemAppendBlocksV1.js';

describe('resolvePromptStackSystemAppendBlocksV1', () => {
  it('skips malformed artifact JSON instead of throwing', async () => {
    await expect(resolvePromptStackSystemAppendBlocksV1({
      promptStacksV1: {
        v: 1,
        surfaces: {
          coding: [
            {
              id: 'e1',
              ref: { kind: 'doc', artifactId: 'd1' },
              enabled: true,
              placement: 'system_append',
              editPolicy: 'user_only',
            },
          ],
          voice: [],
          profilesById: {},
        },
      },
      profileId: null,
      readArtifactBody: async () => '{not-json',
    })).resolves.toEqual([]);
  });

  it('reads and truncates valid prompt docs', async () => {
    await expect(resolvePromptStackSystemAppendBlocksV1({
      promptStacksV1: {
        v: 1,
        surfaces: {
          coding: [
            {
              id: 'e1',
              ref: { kind: 'doc', artifactId: 'd1' },
              enabled: true,
              placement: 'system_append',
              editPolicy: 'user_only',
              maxChars: 5,
            },
          ],
          voice: [],
          profilesById: {},
        },
      },
      profileId: null,
      readArtifactBody: async () => JSON.stringify({
        v: 1,
        markdown: 'Hello world',
        createdAtMs: 1,
        updatedAtMs: 1,
      }),
    })).resolves.toEqual(['Hello']);
  });
});
