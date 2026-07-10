import { describe, expect, it } from 'vitest';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol';

import type { Metadata } from '@/api/types';

import {
  applyStartupMetadataUpdateToSession,
  buildSessionModeOverride,
  buildModelOverride,
  buildPermissionModeOverride,
} from './startupMetadataUpdate';

describe('startupMetadataUpdate', () => {
  it('returns null when no explicit permissionMode is provided', () => {
    expect(buildPermissionModeOverride({})).toBeNull();
  });

  it('builds a permissionMode override when permissionMode is provided', () => {
    expect(buildPermissionModeOverride({ permissionMode: 'yolo', permissionModeUpdatedAt: 123 })).toEqual({
      mode: 'yolo',
      updatedAt: 123,
    });
  });

  it('returns null when no explicit session mode is provided', () => {
    expect(buildSessionModeOverride({})).toBeNull();
  });

  it('builds a canonical session mode override when sessionModeId is provided', () => {
    expect(buildSessionModeOverride({ sessionModeId: 'plan', sessionModeUpdatedAt: 123 })).toEqual({
      modeId: 'plan',
      updatedAt: 123,
    });
  });

  it('returns null when no explicit model is provided', () => {
    expect(buildModelOverride({})).toBeNull();
  });

  it('builds a canonical model-selection intent when a selection is provided', () => {
    expect(buildModelOverride({ modelSelection: {
      v: 1,
      updatedAt: 123,
      ref: {
        agentTargetKey: 'backend:codex',
        providerConnectionId: ProviderConnectionIdSchema.parse('pc_work'),
        modelId: 'gpt-5-codex-high',
      },
    } })).toEqual({
      v: 1,
      updatedAt: 123,
      selection: {
        agentTargetKey: 'backend:codex',
        providerConnectionId: 'pc_work',
        modelId: 'gpt-5-codex-high',
      },
    });
  });

  it('applies mergeSessionMetadataForStartup via session.updateMetadata', () => {
    const updates: Metadata[] = [];
    const fakeSession = {
      updateMetadata: (updater: (current: Metadata) => Metadata) => {
        const current = {
          lifecycleState: 'archived',
          codexSessionId: 'codex-1',
        } as any as Metadata;
        updates.push(updater(current));
      },
    };

    applyStartupMetadataUpdateToSession({
      session: fakeSession,
      next: { hostPid: 42 } as any,
      nowMs: 999,
      permissionModeOverride: null,
    });

    expect(updates).toHaveLength(1);
    expect(updates[0].lifecycleState).toBe('running');
    expect((updates[0] as any).hostPid).toBe(42);
    expect((updates[0] as any).codexSessionId).toBe('codex-1');
  });

  it('passes an explicit canonical session mode override through to startup metadata merge', () => {
    const updates: Metadata[] = [];
    const fakeSession = {
      updateMetadata: (updater: (current: Metadata) => Metadata) => {
        const current = {
          lifecycleState: 'archived',
        } as any as Metadata;
        updates.push(updater(current));
      },
    };

    applyStartupMetadataUpdateToSession({
      session: fakeSession,
      next: { hostPid: 42 } as any,
      nowMs: 999,
      permissionModeOverride: null,
      sessionModeOverride: { modeId: 'plan', updatedAt: 123 },
    });

    expect((updates[0] as any).sessionModeOverrideV1).toEqual({ v: 1, updatedAt: 123, modeId: 'plan' });
    expect((updates[0] as any).acpSessionModeOverrideV1).toEqual({ v: 1, updatedAt: 123, modeId: 'plan' });
  });

  it('normalizes legacy session-mode metadata at the startup compat edge before applying updates', () => {
    const updates: Metadata[] = [];
    const fakeSession = {
      updateMetadata: (updater: (current: Metadata) => Metadata) => {
        const current = {
          lifecycleState: 'archived',
          acpSessionModeOverrideV1: { v: 1, updatedAt: 77, modeId: 'plan' },
        } as any as Metadata;
        updates.push(updater(current));
      },
    };

    applyStartupMetadataUpdateToSession({
      session: fakeSession,
      next: { hostPid: 42 } as any,
      nowMs: 999,
      permissionModeOverride: null,
    });

    expect((updates[0] as any).sessionModeOverrideV1).toEqual({ v: 1, updatedAt: 77, modeId: 'plan' });
    expect((updates[0] as any).acpSessionModeOverrideV1).toEqual({ v: 1, updatedAt: 77, modeId: 'plan' });
  });

  it('passes an explicit provider-bound model intent through to startup metadata merge', () => {
    const updates: Metadata[] = [];
    const fakeSession = {
      updateMetadata: (updater: (current: Metadata) => Metadata) => {
        const current = {
          lifecycleState: 'archived',
        } as any as Metadata;
        updates.push(updater(current));
      },
    };

    applyStartupMetadataUpdateToSession({
      session: fakeSession,
      next: { hostPid: 42 } as any,
      nowMs: 999,
      permissionModeOverride: null,
      modelOverride: {
        v: 1,
        updatedAt: 123,
        selection: {
          agentTargetKey: 'backend:codex',
          providerConnectionId: ProviderConnectionIdSchema.parse('pc_work'),
          modelId: 'gpt-5-codex-high',
        },
      },
    });

    expect((updates[0] as any).modelSelectionIntentV1).toEqual({
      v: 1,
      updatedAt: 123,
      selection: {
        agentTargetKey: 'backend:codex',
        providerConnectionId: 'pc_work',
        modelId: 'gpt-5-codex-high',
      },
    });
    expect((updates[0] as any).modelOverrideV1).toBeUndefined();
  });

  it('can remove specific metadata keys during attach startup updates', () => {
    const updates: Metadata[] = [];
    const fakeSession = {
      updateMetadata: (updater: (current: Metadata) => Metadata) => {
        const current = {
          lifecycleState: 'archived',
          acpSessionModesV1: { v: 1, provider: 'codex' },
          acpSessionModelsV1: { v: 1, provider: 'codex' },
          acpConfigOptionsV1: { v: 1, provider: 'codex' },
        } as any as Metadata;
        updates.push(updater(current));
      },
    };

    applyStartupMetadataUpdateToSession({
      session: fakeSession,
      next: { hostPid: 42 } as any,
      nowMs: 999,
      permissionModeOverride: null,
      mode: 'attach',
      metadataKeysToUnsetOnAttach: ['acpSessionModesV1', 'acpSessionModelsV1', 'acpConfigOptionsV1'],
    } as any);

    expect((updates[0] as any).acpSessionModesV1).toBeUndefined();
    expect((updates[0] as any).acpSessionModelsV1).toBeUndefined();
    expect((updates[0] as any).acpConfigOptionsV1).toBeUndefined();
    expect((updates[0] as any).hostPid).toBe(42);
  });
});
