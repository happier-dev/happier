import { describe, expect, it } from 'vitest';

import {
  SessionStateModelReadCompatValueSchema,
  SessionStateModelValueSchema,
  SessionStateModelWriteValueSchema,
} from './model.js';

describe('session state model intent schemas', () => {
  const canonical = {
    v: 1 as const,
    updatedAt: 42,
    selection: {
      agentTargetKey: 'agent:codex',
      providerConnectionId: 'pc_work',
      modelId: 'vendor/model',
    },
  };

  it('accepts canonical model-selection intent for new state writes', () => {
    expect(SessionStateModelWriteValueSchema.parse(canonical)).toEqual(canonical);
    expect(SessionStateModelWriteValueSchema.safeParse({ v: 1, updatedAt: 42, modelId: 'legacy' }).success).toBe(false);
  });

  it('bounds generic metadata reads to canonical or deployed legacy intent', () => {
    expect(SessionStateModelReadCompatValueSchema.parse(canonical)).toEqual(canonical);
    expect(SessionStateModelValueSchema.parse(canonical)).toEqual(canonical);
    expect(SessionStateModelReadCompatValueSchema.parse({ v: 1, updatedAt: 41, modelId: null })).toEqual({
      v: 1,
      updatedAt: 41,
      modelId: null,
    });
    expect(SessionStateModelReadCompatValueSchema.safeParse({ v: 1, updatedAt: 41, value: 'unknown' }).success).toBe(false);
  });
});
