import { describe, expect, it, vi } from 'vitest';

import type { Metadata } from '@/api/types';
import { resolvePermissionModeForQueueingUserMessage } from './modeFromUserMessage';

describe('resolvePermissionModeForQueueingUserMessage', () => {
  it('keeps current mode when message has no permission override', () => {
    const updateMetadata = vi.fn<(updater: (current: Metadata) => Metadata) => void>();

    const result = resolvePermissionModeForQueueingUserMessage({
      currentPermissionMode: 'safe-yolo',
      messagePermissionModeRaw: undefined,
      updateMetadata,
      nowMs: () => 123,
    });

    expect(result).toEqual({
      currentPermissionMode: 'safe-yolo',
      queuePermissionMode: 'safe-yolo',
      didChange: false,
    });
    expect(updateMetadata).not.toHaveBeenCalled();
  });

  it('normalizes and applies message permission overrides', () => {
    const metadata = { permissionMode: 'default', permissionModeUpdatedAt: 0 } as unknown as Metadata;

    const result = resolvePermissionModeForQueueingUserMessage({
      currentPermissionMode: 'default',
      messagePermissionModeRaw: 'acceptEdits',
      updateMetadata: (updater) => {
        const next = updater(metadata);
        Object.assign(metadata, next);
      },
      nowMs: () => 42,
    });

    expect(result).toEqual({
      currentPermissionMode: 'safe-yolo',
      queuePermissionMode: 'safe-yolo',
      didChange: true,
    });
    expect(metadata.permissionMode).toBe('safe-yolo');
    expect(metadata.permissionModeUpdatedAt).toBe(42);
  });

  it('falls back to default when there is no current mode and override is invalid', () => {
    const updateMetadata = vi.fn<(updater: (current: Metadata) => Metadata) => void>();

    const result = resolvePermissionModeForQueueingUserMessage({
      currentPermissionMode: undefined,
      messagePermissionModeRaw: 123,
      updateMetadata,
      nowMs: () => 123,
    });

    expect(result).toEqual({
      currentPermissionMode: undefined,
      queuePermissionMode: 'default',
      didChange: false,
    });
    expect(updateMetadata).not.toHaveBeenCalled();
  });

  it('reports no change for an alias respelling of the current mode (ported S-6)', () => {
    const updateMetadata = vi.fn<(updater: (current: Metadata) => Metadata) => void>();

    const result = resolvePermissionModeForQueueingUserMessage({
      currentPermissionMode: 'acceptEdits',
      messagePermissionModeRaw: 'safe-yolo',
      updateMetadata,
      nowMs: () => 7,
    });

    expect(result).toEqual({
      currentPermissionMode: 'safe-yolo',
      queuePermissionMode: 'safe-yolo',
      didChange: false,
    });
    expect(updateMetadata).not.toHaveBeenCalled();
  });
});
