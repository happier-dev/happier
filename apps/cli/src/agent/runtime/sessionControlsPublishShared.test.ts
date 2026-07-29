import { describe, expect, it } from 'vitest';

import {
  applyModelIntentSessionMetadata,
  applyPermissionModeIntentSessionMetadata,
} from '@happier-dev/agents/session/state/metadataWriters';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol';
import type { Metadata } from '@/api/types';
import { publishSessionControlsMetadataBestEffort } from './controls/publishSessionControlsMetadataBestEffort';

describe('sessionControls publish helpers (shared)', () => {
  it('canonicalizes permission intent aliases and stamps updatedAt when newer', () => {
    const next = applyPermissionModeIntentSessionMetadata({ permissionMode: 'yolo', permissionModeUpdatedAt: 10 } as any, {
      v: 1,
      permissionMode: 'acceptEdits' as any,
      updatedAt: 11,
    }) as any;

    expect(next.permissionMode).toBe('safe-yolo');
    expect(next.permissionModeUpdatedAt).toBe(11);
  });

  it('does not update permission mode when updatedAt is older', () => {
    const next = applyPermissionModeIntentSessionMetadata({ permissionMode: 'yolo', permissionModeUpdatedAt: 10 } as any, {
      v: 1,
      permissionMode: 'read-only' as any,
      updatedAt: 9,
    }) as any;

    expect(next.permissionMode).toBe('yolo');
    expect(next.permissionModeUpdatedAt).toBe(10);
  });

  it('writes only the canonical structured intent for a Provider-bound model', () => {
    const next = applyModelIntentSessionMetadata({ modelOverrideV1: { v: 1, updatedAt: 10, modelId: 'model-a' } } as any, {
      v: 1,
      selection: {
        agentTargetKey: 'backend:codex',
        providerConnectionId: ProviderConnectionIdSchema.parse('provider-connection-1'),
        modelId: 'model-b',
      },
      updatedAt: 11,
    }) as any;

    expect(next.modelSelectionIntentV1).toEqual({
      v: 1,
      updatedAt: 11,
      selection: {
        agentTargetKey: 'backend:codex',
        providerConnectionId: ProviderConnectionIdSchema.parse('provider-connection-1'),
        modelId: 'model-b',
      },
    });
    expect(next.modelOverrideV1).toBeUndefined();
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
        agentId: 'codex',
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
        agentId: 'codex',
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
        agentId: 'codex',
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
        agentId: 'codex',
        updatedAt: 99,
        currentModeId: 'default',
      }),
    );
    expect((state.metadata as Record<string, unknown>).acpSessionModesV1).toBeUndefined();
  });
});
