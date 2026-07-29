import { describe, expect, it } from 'vitest';

import { PromptStacksV1Schema } from './promptStacksV1.js';

describe('PromptStacksV1Schema', () => {
  it('defaults to empty stacks when missing', () => {
    const parsed = PromptStacksV1Schema.parse({});
    expect(parsed).toEqual({
      v: 1,
      surfaces: {
        coding: [],
        voice: [],
        profilesById: {},
      },
    });
  });

  it('parses stack entries with defaults', () => {
    const parsed = PromptStacksV1Schema.parse({
      v: 1,
      surfaces: {
        coding: [
          {
            id: 'e1',
            ref: { kind: 'doc', artifactId: 'a1' },
          },
        ],
      },
    });

    expect(parsed.surfaces.coding[0]).toEqual({
      id: 'e1',
      ref: { kind: 'doc', artifactId: 'a1' },
      enabled: true,
      placement: 'system_append',
      editPolicy: 'user_only',
    });
  });
});
