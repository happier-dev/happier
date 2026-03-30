import { describe, expect, it } from 'vitest';

import { adoptReasoningEffortOverrideFromMetadata } from './adoptReasoningEffortOverrideFromMetadata';

describe('adoptReasoningEffortOverrideFromMetadata', () => {
  it('returns didChange=false when no override is present', () => {
    const res = adoptReasoningEffortOverrideFromMetadata({
      currentValueId: null,
      currentUpdatedAt: 0,
      metadata: null,
    });
    expect(res).toEqual({ valueId: null, updatedAt: 0, didChange: false });
  });

  it('adopts a newer reasoning_effort override from session metadata', () => {
    const res = adoptReasoningEffortOverrideFromMetadata({
      currentValueId: null,
      currentUpdatedAt: 0,
      metadata: {
        sessionConfigOptionOverridesV1: {
          v: 1,
          updatedAt: 10,
          overrides: {
            reasoning_effort: { updatedAt: 12, value: 'medium' },
          },
        },
      } as unknown as import('@/api/types').Metadata,
    });
    expect(res).toEqual({ valueId: 'medium', updatedAt: 12, didChange: true });
  });

  it('does not change when the override is not newer than the current updatedAt', () => {
    const res = adoptReasoningEffortOverrideFromMetadata({
      currentValueId: 'low',
      currentUpdatedAt: 50,
      metadata: {
        sessionConfigOptionOverridesV1: {
          v: 1,
          updatedAt: 10,
          overrides: {
            reasoning_effort: { updatedAt: 12, value: 'medium' },
          },
        },
      } as unknown as import('@/api/types').Metadata,
    });
    expect(res).toEqual({ valueId: 'low', updatedAt: 50, didChange: false });
  });
});
