import { describe, expect, it } from 'vitest';

import { resolveMetadataStringOverrideV1, resolvePermissionIntentFromSessionMetadata } from '@happier-dev/agents';
import * as permissionModeFromMetadata from './modeFromMetadata';

describe('resolvePermissionIntentFromMetadataSnapshot', () => {
  it('maps legacy ask to default', () => {
    const res = permissionModeFromMetadata.resolvePermissionIntentFromMetadataSnapshot({
      metadata: { permissionMode: 'ask', permissionModeUpdatedAt: 5 } as any,
    });
    expect(res).toEqual({ intent: 'default', updatedAt: 5 });
  });

  it('maps legacy bypassPermissions into yolo intent', () => {
    const res = permissionModeFromMetadata.resolvePermissionIntentFromMetadataSnapshot({
      metadata: { permissionMode: 'bypassPermissions', permissionModeUpdatedAt: 5 } as any,
    });
    expect(res).toEqual({ intent: 'yolo', updatedAt: 5 });
  });

  it('maps legacy acceptEdits into safe-yolo intent', () => {
    const res = permissionModeFromMetadata.resolvePermissionIntentFromMetadataSnapshot({
      metadata: { permissionMode: 'acceptEdits', permissionModeUpdatedAt: 5 } as any,
    });
    expect(res).toEqual({ intent: 'safe-yolo', updatedAt: 5 });
  });

  it('preserves plan intent', () => {
    const res = permissionModeFromMetadata.resolvePermissionIntentFromMetadataSnapshot({
      metadata: { permissionMode: 'plan', permissionModeUpdatedAt: 5 } as any,
    });
    expect(res).toEqual({ intent: 'plan', updatedAt: 5 });
  });
});

describe('resolveSessionModeOverrideFromMetadataSnapshot', () => {
  it('returns null when metadata does not include an override', () => {
    const fn = (permissionModeFromMetadata as any).resolveSessionModeOverrideFromMetadataSnapshot;
    expect(typeof fn).toBe('function');

    expect(fn({ metadata: { path: '/tmp' } as any })).toBeNull();
  });

  it('prefers the generic sessionModeOverrideV1 metadata key', () => {
    const fn = (permissionModeFromMetadata as any).resolveSessionModeOverrideFromMetadataSnapshot;
    expect(typeof fn).toBe('function');

    expect(fn({ metadata: { sessionModeOverrideV1: { v: 1, updatedAt: 14, modeId: 'plan' } } as any }))
      .toEqual({ modeId: 'plan', updatedAt: 14 });
  });

  it('uses the newest session-mode override alias instead of canonical-first state', () => {
    const fn = (permissionModeFromMetadata as any).resolveSessionModeOverrideFromMetadataSnapshot;
    expect(typeof fn).toBe('function');

    expect(fn({
      metadata: {
        sessionModeOverrideV1: { v: 1, updatedAt: 14, modeId: 'build' },
        acpSessionModeOverrideV1: { v: 1, updatedAt: 20, modeId: 'plan' },
      } as any,
    })).toEqual({ modeId: 'plan', updatedAt: 20 });
  });

  it('returns a clear sentinel for session-mode null tombstones', () => {
    const fn = (permissionModeFromMetadata as any).resolveSessionModeOverrideFromMetadataSnapshot;
    expect(typeof fn).toBe('function');

    expect(fn({ metadata: { sessionModeOverrideV1: { v: 1, updatedAt: 21, modeId: null } } as any }))
      .toEqual({ modeId: '', updatedAt: 21 });
  });

  it('uses the newest session-mode clear tombstone alias', () => {
    const fn = (permissionModeFromMetadata as any).resolveSessionModeOverrideFromMetadataSnapshot;
    expect(typeof fn).toBe('function');

    expect(fn({
      metadata: {
        sessionModeOverrideV1: { v: 1, updatedAt: 21, modeId: null },
        acpSessionModeOverrideV1: { v: 1, updatedAt: 10, modeId: 'plan' },
      } as any,
    })).toEqual({ modeId: '', updatedAt: 21 });

    expect(fn({
      metadata: {
        sessionModeOverrideV1: { v: 1, updatedAt: 10, modeId: 'plan' },
        acpSessionModeOverrideV1: { v: 1, updatedAt: 21, modeId: null },
      } as any,
    })).toEqual({ modeId: '', updatedAt: 21 });
  });

  it('normalizes modeId="default" to an empty string when the provider has no real default option', () => {
    const fn = (permissionModeFromMetadata as any).resolveSessionModeOverrideFromMetadataSnapshot;
    expect(typeof fn).toBe('function');

    expect(fn({
      metadata: {
        sessionModesV1: {
          v: 1,
          agentId: 'opencode',
          updatedAt: 1,
          currentModeId: 'build',
          availableModes: [
            { id: 'build', name: 'Build' },
            { id: 'plan', name: 'Plan' },
          ],
        },
        sessionModeOverrideV1: { v: 1, updatedAt: 15, modeId: 'default' },
      } as any,
    }))
      .toEqual({ modeId: '', updatedAt: 15 });
  });

  it('preserves modeId="default" when the provider exposes it as a real session mode option', () => {
    const fn = (permissionModeFromMetadata as any).resolveSessionModeOverrideFromMetadataSnapshot;
    expect(typeof fn).toBe('function');

    expect(fn({
      metadata: {
        sessionModesV1: {
          v: 1,
          agentId: 'codex',
          updatedAt: 1,
          currentModeId: 'plan',
          availableModes: [
            { id: 'default', name: 'Default' },
            { id: 'plan', name: 'Plan' },
          ],
        },
        sessionModeOverrideV1: { v: 1, updatedAt: 16, modeId: 'default' },
      } as any,
    }))
      .toEqual({ modeId: 'default', updatedAt: 16 });
  });
});

describe('computePendingSessionModeOverrideApplication', () => {
  it('returns null when the override is not newer than the last applied timestamp', () => {
    const fn = (permissionModeFromMetadata as any).computePendingSessionModeOverrideApplication;
    expect(typeof fn).toBe('function');

    const res = fn({
      metadata: { acpSessionModeOverrideV1: { v: 1, updatedAt: 10, modeId: 'plan' } } as any,
      lastAppliedUpdatedAt: 10,
    });
    expect(res).toBeNull();
  });

  it('returns the override when it is newer than the last applied timestamp', () => {
    const fn = (permissionModeFromMetadata as any).computePendingSessionModeOverrideApplication;
    expect(typeof fn).toBe('function');

    const res = fn({
      metadata: { acpSessionModeOverrideV1: { v: 1, updatedAt: 11, modeId: 'plan' } } as any,
      lastAppliedUpdatedAt: 10,
    });
    expect(res).toEqual({ modeId: 'plan', updatedAt: 11 });
  });

  it('returns a newer clear tombstone', () => {
    const fn = (permissionModeFromMetadata as any).computePendingSessionModeOverrideApplication;
    expect(typeof fn).toBe('function');

    const res = fn({
      metadata: { sessionModeOverrideV1: { v: 1, updatedAt: 12, modeId: null } } as any,
      lastAppliedUpdatedAt: 11,
    });
    expect(res).toEqual({ modeId: '', updatedAt: 12 });
  });
});

describe('resolveModelSelectionIntentFromMetadataSnapshot', () => {
  it('resolves a provider-bound canonical selection only for the known agent target', () => {
    const fn = (permissionModeFromMetadata as any).resolveModelSelectionIntentFromMetadataSnapshot;
    expect(typeof fn).toBe('function');

    expect(fn({
      agentTargetKey: 'backend:codex',
      metadata: {
        modelSelectionIntentV1: {
          v: 1,
          updatedAt: 21,
          selection: {
            agentTargetKey: 'backend:codex',
            providerConnectionId: 'pc_work',
            modelId: 'gpt-provider',
          },
        },
      },
    })).toEqual({
      v: 1,
      updatedAt: 21,
      selection: {
        agentTargetKey: 'backend:codex',
        providerConnectionId: 'pc_work',
        modelId: 'gpt-provider',
      },
    });
  });

  it('preserves a canonical clear intent and refuses a mismatched target', () => {
    const fn = (permissionModeFromMetadata as any).resolveModelSelectionIntentFromMetadataSnapshot;
    const clear = {
      modelSelectionIntentV1: { v: 1, updatedAt: 22, selection: null },
    };
    expect(fn({ agentTargetKey: 'backend:codex', metadata: clear })).toEqual({
      v: 1,
      updatedAt: 22,
      selection: null,
    });
    expect(() => fn({
      agentTargetKey: 'backend:claude',
      metadata: {
        modelSelectionIntentV1: {
          v: 1,
          updatedAt: 23,
          selection: {
            agentTargetKey: 'backend:codex',
            providerConnectionId: null,
            modelId: 'gpt-provider',
          },
        },
      },
    })).toThrow(/target mismatch/i);
  });
});

describe('@happier-dev/agents session metadata helpers', () => {
  it('resolves nested override objects consistently', () => {
    expect(
      resolveMetadataStringOverrideV1(
        { modelOverrideV1: { v: 1, updatedAt: 12, modelId: 'gemini-2.5-pro' } },
        'modelOverrideV1',
        'modelId',
      ),
    ).toEqual({ value: 'gemini-2.5-pro', updatedAt: 12 });

    expect(
      resolveMetadataStringOverrideV1(
        { acpSessionModeOverrideV1: { v: 1, updatedAt: 13, modeId: 'plan' } },
        'acpSessionModeOverrideV1',
        'modeId',
      ),
    ).toEqual({ value: 'plan', updatedAt: 13 });
  });

  it('normalizes permission intents from session metadata', () => {
    expect(resolvePermissionIntentFromSessionMetadata({ permissionMode: 'ask', permissionModeUpdatedAt: 5 }))
      .toEqual({ intent: 'default', updatedAt: 5 });
    expect(resolvePermissionIntentFromSessionMetadata({ permissionMode: 'acceptEdits', permissionModeUpdatedAt: 6 }))
      .toEqual({ intent: 'safe-yolo', updatedAt: 6 });
  });
});
