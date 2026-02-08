import { describe, expect, it } from 'vitest';

import {
  computeNextPermissionIntentMetadata,
  computeNextMetadataStringOverrideV1,
} from '@happier-dev/agents';

describe('sessionControls publish helpers (shared)', () => {
  it('canonicalizes permission intent aliases and stamps updatedAt when newer', () => {
    const next = computeNextPermissionIntentMetadata({
      metadata: { permissionMode: 'yolo', permissionModeUpdatedAt: 10 } as any,
      permissionMode: 'acceptEdits' as any,
      permissionModeUpdatedAt: 11,
    }) as any;

    expect(next.permissionMode).toBe('safe-yolo');
    expect(next.permissionModeUpdatedAt).toBe(11);
  });

  it('does not update permission mode when updatedAt is older', () => {
    const next = computeNextPermissionIntentMetadata({
      metadata: { permissionMode: 'yolo', permissionModeUpdatedAt: 10 } as any,
      permissionMode: 'read-only' as any,
      permissionModeUpdatedAt: 9,
    }) as any;

    expect(next.permissionMode).toBe('yolo');
    expect(next.permissionModeUpdatedAt).toBe(10);
  });

  it('updates a nested string override v1 when updatedAt is newer', () => {
    const next = computeNextMetadataStringOverrideV1({
      metadata: { modelOverrideV1: { v: 1, updatedAt: 10, modelId: 'model-a' } } as any,
      overrideKey: 'modelOverrideV1',
      valueKey: 'modelId',
      value: 'model-b',
      updatedAt: 11,
    }) as any;

    expect(next.modelOverrideV1).toEqual({ v: 1, updatedAt: 11, modelId: 'model-b' });
  });
});
