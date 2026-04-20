import { describe, expect, it } from 'vitest';

import { listNativeReviewEngines } from '@happier-dev/protocol';

import {
  listNativeReviewEngineDescriptors,
  resolveNativeReviewExecutionRunBackendFactory,
  resolveNativeReviewOutputNormalizer,
  resolveNativeReviewStartPreflight,
} from './nativeReviewEngines';

describe('nativeReviewEngines', () => {
  it('exposes one shared descriptor source for execution-run factories and review output normalizers', () => {
    const nativeEngineIds = listNativeReviewEngines().map((engine) => engine.id);
    const descriptorIds = listNativeReviewEngineDescriptors().map((descriptor) => descriptor.id);

    expect(descriptorIds).toEqual(nativeEngineIds);
    for (const descriptor of listNativeReviewEngineDescriptors()) {
      expect(descriptor.executionRunBackendFactory).toBe(resolveNativeReviewExecutionRunBackendFactory(descriptor.id));
      expect(descriptor.reviewOutputNormalizer).toBe(resolveNativeReviewOutputNormalizer(descriptor.id));
      expect(descriptor.reviewStartPreflight).toBe(resolveNativeReviewStartPreflight(descriptor.id));
    }
  });
});
