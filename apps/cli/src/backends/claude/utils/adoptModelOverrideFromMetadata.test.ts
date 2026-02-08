import { describe, expect, it } from 'vitest';

import type { Metadata } from '@/api/types';

import { adoptModelOverrideFromMetadata } from './adoptModelOverrideFromMetadata';

describe('adoptModelOverrideFromMetadata', () => {
  it('adopts modelOverrideV1 when newer than current', () => {
    const res = adoptModelOverrideFromMetadata({
      currentModelId: undefined,
      currentUpdatedAt: 0,
      metadata: { modelOverrideV1: { v: 1, updatedAt: 10, modelId: 'model-a' } } as unknown as Metadata,
    });

    expect(res).toEqual({
      modelId: 'model-a',
      updatedAt: 10,
      didChange: true,
    });
  });

  it('does nothing when metadata is missing', () => {
    const res = adoptModelOverrideFromMetadata({
      currentModelId: 'model-a',
      currentUpdatedAt: 10,
      metadata: null,
    });

    expect(res.didChange).toBe(false);
    expect(res.modelId).toBe('model-a');
    expect(res.updatedAt).toBe(10);
  });

  it('does not adopt when metadata is older', () => {
    const res = adoptModelOverrideFromMetadata({
      currentModelId: 'model-a',
      currentUpdatedAt: 10,
      metadata: { modelOverrideV1: { v: 1, updatedAt: 9, modelId: 'model-b' } } as unknown as Metadata,
    });

    expect(res).toEqual({
      modelId: 'model-a',
      updatedAt: 10,
      didChange: false,
    });
  });

  it('does not adopt when metadata has the same updatedAt timestamp', () => {
    const res = adoptModelOverrideFromMetadata({
      currentModelId: 'model-a',
      currentUpdatedAt: 10,
      metadata: { modelOverrideV1: { v: 1, updatedAt: 10, modelId: 'model-b' } } as unknown as Metadata,
    });

    expect(res).toEqual({
      modelId: 'model-a',
      updatedAt: 10,
      didChange: false,
    });
  });

  it('does nothing for malformed modelOverride metadata', () => {
    const res = adoptModelOverrideFromMetadata({
      currentModelId: 'model-a',
      currentUpdatedAt: 10,
      metadata: {
        modelOverrideV1: { v: 1, updatedAt: 'nope', modelId: 123 },
      } as unknown as Metadata,
    });

    expect(res).toEqual({
      modelId: 'model-a',
      updatedAt: 10,
      didChange: false,
    });
  });

  it('does not adopt the default sentinel model id', () => {
    const res = adoptModelOverrideFromMetadata({
      currentModelId: 'model-a',
      currentUpdatedAt: 10,
      metadata: {
        modelOverrideV1: { v: 1, updatedAt: 11, modelId: 'default' },
      } as unknown as Metadata,
    });

    expect(res).toEqual({
      modelId: 'model-a',
      updatedAt: 10,
      didChange: false,
    });
  });
});
