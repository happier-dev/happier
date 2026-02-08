import { describe, expect, it } from 'vitest';

import type { Metadata } from '@/api/types';

import {
  applyStartupMetadataUpdateToSession,
  buildAcpSessionModeOverride,
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

  it('returns null when no explicit agent mode is provided', () => {
    expect(buildAcpSessionModeOverride({})).toBeNull();
  });

  it('builds an ACP session mode override when agentModeId is provided', () => {
    expect(buildAcpSessionModeOverride({ agentModeId: 'plan', agentModeUpdatedAt: 123 })).toEqual({
      modeId: 'plan',
      updatedAt: 123,
    });
  });

  it('returns null when no explicit model is provided', () => {
    expect(buildModelOverride({})).toBeNull();
  });

  it('builds a model override when modelId is provided', () => {
    expect(buildModelOverride({ modelId: 'gpt-5-codex-high', modelUpdatedAt: 123 })).toEqual({
      modelId: 'gpt-5-codex-high',
      updatedAt: 123,
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

  it('passes an explicit ACP session mode override through to startup metadata merge', () => {
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
      acpSessionModeOverride: { modeId: 'plan', updatedAt: 123 } as any,
    } as any);

    expect((updates[0] as any).acpSessionModeOverrideV1).toEqual({ v: 1, updatedAt: 123, modeId: 'plan' });
  });

  it('passes an explicit model override through to startup metadata merge', () => {
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
      modelOverride: { modelId: 'gpt-5-codex-high', updatedAt: 123 } as any,
    } as any);

    expect((updates[0] as any).modelOverrideV1).toEqual({ v: 1, updatedAt: 123, modelId: 'gpt-5-codex-high' });
  });
});
