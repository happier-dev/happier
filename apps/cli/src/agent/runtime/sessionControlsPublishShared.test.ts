import { describe, expect, it } from 'vitest';

import {
  computeNextPermissionIntentMetadata,
  computeNextMetadataStringOverrideV1,
} from '@happier-dev/agents';
import type { Metadata } from '@/api/types';
import { publishSessionControlsMetadataBestEffort } from './controls/publishSessionControlsMetadataBestEffort';

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

  it('publishes config options only to canonical metadata keys from the shared publisher', async () => {
    const state: { metadata: Metadata } = { metadata: {} as Metadata };

    await publishSessionControlsMetadataBestEffort({
      session: {
        ensureMetadataSnapshot: async () => state.metadata,
        updateMetadata: async (updater) => {
          state.metadata = updater(state.metadata);
        },
      },
      sessionConfigOptionsState: {
        v: 1,
        provider: 'codex',
        updatedAt: 42,
        configOptions: [
          {
            id: 'service_tier',
            name: 'Speed',
            type: 'select',
            currentValue: 'fast',
            options: [
              { value: 'standard', name: 'Standard' },
              { value: 'fast', name: 'Fast' },
            ],
          },
        ],
      },
    });

    expect(state.metadata.sessionConfigOptionsV1).toEqual(
      expect.objectContaining({
        v: 1,
        provider: 'codex',
        updatedAt: 42,
        configOptions: expect.any(Array),
      }),
    );
    expect((state.metadata as Record<string, unknown>).acpConfigOptionsV1).toBeUndefined();
  });

  it('publishes session controls even when a legacy session only exposes updateMetadata', async () => {
    const state: { metadata: Metadata } = { metadata: { machineId: 'machine_1' } as Metadata };

    await publishSessionControlsMetadataBestEffort({
      session: {
        updateMetadata: async (updater: (prev: Metadata) => Metadata) => {
          state.metadata = updater(state.metadata);
        },
      } as any,
      sessionModesState: {
        v: 1,
        provider: 'codex',
        updatedAt: 99,
        currentModeId: 'default',
        availableModes: [
          {
            id: 'default',
            name: 'Default',
          },
        ],
      },
    });

    expect(state.metadata.sessionModesV1).toEqual(
      expect.objectContaining({
        v: 1,
        provider: 'codex',
        updatedAt: 99,
        currentModeId: 'default',
      }),
    );
    expect((state.metadata as Record<string, unknown>).acpSessionModesV1).toBeUndefined();
  });
});
