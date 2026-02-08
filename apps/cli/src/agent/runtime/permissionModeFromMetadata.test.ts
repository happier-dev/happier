import { describe, expect, it } from 'vitest';

import { resolveMetadataStringOverrideV1, resolvePermissionIntentFromSessionMetadata } from '@happier-dev/agents';
import * as permissionModeFromMetadata from './permissionModeFromMetadata';

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

describe('resolveAcpSessionModeOverrideFromMetadataSnapshot', () => {
  it('returns null when metadata does not include an override', () => {
    const fn = (permissionModeFromMetadata as any).resolveAcpSessionModeOverrideFromMetadataSnapshot;
    expect(typeof fn).toBe('function');

    expect(fn({ metadata: { path: '/tmp' } as any })).toBeNull();
  });
});

describe('computePendingAcpSessionModeOverrideApplication', () => {
  it('returns null when the override is not newer than the last applied timestamp', () => {
    const fn = (permissionModeFromMetadata as any).computePendingAcpSessionModeOverrideApplication;
    expect(typeof fn).toBe('function');

    const res = fn({
      metadata: { acpSessionModeOverrideV1: { v: 1, updatedAt: 10, modeId: 'plan' } } as any,
      lastAppliedUpdatedAt: 10,
    });
    expect(res).toBeNull();
  });

  it('returns the override when it is newer than the last applied timestamp', () => {
    const fn = (permissionModeFromMetadata as any).computePendingAcpSessionModeOverrideApplication;
    expect(typeof fn).toBe('function');

    const res = fn({
      metadata: { acpSessionModeOverrideV1: { v: 1, updatedAt: 11, modeId: 'plan' } } as any,
      lastAppliedUpdatedAt: 10,
    });
    expect(res).toEqual({ modeId: 'plan', updatedAt: 11 });
  });
});

describe('resolveModelOverrideFromMetadataSnapshot', () => {
  it('returns null when metadata does not include an override', () => {
    const fn = (permissionModeFromMetadata as any).resolveModelOverrideFromMetadataSnapshot;
    expect(typeof fn).toBe('function');

    expect(fn({ metadata: { path: '/tmp' } as any })).toBeNull();
  });

  it('parses modelOverrideV1 when present', () => {
    const fn = (permissionModeFromMetadata as any).resolveModelOverrideFromMetadataSnapshot;
    expect(typeof fn).toBe('function');

    expect(fn({ metadata: { modelOverrideV1: { v: 1, updatedAt: 12, modelId: 'gemini-2.5-pro' } } as any }))
      .toEqual({ modelId: 'gemini-2.5-pro', updatedAt: 12 });
  });

  it('treats modelOverrideV1.modelId="default" as no override', () => {
    const fn = (permissionModeFromMetadata as any).resolveModelOverrideFromMetadataSnapshot;
    expect(typeof fn).toBe('function');

    expect(fn({ metadata: { modelOverrideV1: { v: 1, updatedAt: 12, modelId: 'default' } } as any }))
      .toBeNull();
  });
});

describe('computePendingModelOverrideApplication', () => {
  it('returns null when the override is not newer than the last applied timestamp', () => {
    const fn = (permissionModeFromMetadata as any).computePendingModelOverrideApplication;
    expect(typeof fn).toBe('function');

    const res = fn({
      metadata: { modelOverrideV1: { v: 1, updatedAt: 10, modelId: 'gemini-2.5-pro' } } as any,
      lastAppliedUpdatedAt: 10,
    });
    expect(res).toBeNull();
  });

  it('returns the override when it is newer than the last applied timestamp', () => {
    const fn = (permissionModeFromMetadata as any).computePendingModelOverrideApplication;
    expect(typeof fn).toBe('function');

    const res = fn({
      metadata: { modelOverrideV1: { v: 1, updatedAt: 11, modelId: 'gemini-2.5-pro' } } as any,
      lastAppliedUpdatedAt: 10,
    });
    expect(res).toEqual({ modelId: 'gemini-2.5-pro', updatedAt: 11 });
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
