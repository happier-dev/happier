import { describe, expect, it } from 'vitest';

import type { Metadata, PermissionMode } from '@/api/types';
import { syncClaudePermissionModeFromMetadata } from './syncPermissionModeFromMetadata';

type SessionStub = {
  client: { getMetadataSnapshot: () => Metadata | null };
  adoptLastPermissionModeFromMetadata: (mode: PermissionMode, updatedAt: number) => boolean;
};

type PermissionHandlerStub = { handleModeChange: (mode: PermissionMode) => void };

describe('syncClaudePermissionModeFromMetadata', () => {
  it('normalizes metadata permission mode for Claude and updates the permission handler', () => {
    const modeChanges: string[] = [];
    const session: SessionStub = {
      client: {
        getMetadataSnapshot: () => ({
          permissionMode: 'safe-yolo',
          permissionModeUpdatedAt: 123,
        } as unknown as Metadata),
      },
      adoptLastPermissionModeFromMetadata: () => true,
    };
    const permissionHandler: PermissionHandlerStub = {
      handleModeChange: (mode) => modeChanges.push(String(mode)),
    };

    const res = syncClaudePermissionModeFromMetadata({ session, permissionHandler });
    expect(res).toBe('acceptEdits');
    expect(modeChanges).toEqual(['acceptEdits']);
  });

  it('does nothing when the session rejects the metadata update', () => {
    const modeChanges: string[] = [];
    const session: SessionStub = {
      client: {
        getMetadataSnapshot: () => ({
          permissionMode: 'yolo',
          permissionModeUpdatedAt: 123,
        } as unknown as Metadata),
      },
      adoptLastPermissionModeFromMetadata: () => false,
    };
    const permissionHandler: PermissionHandlerStub = {
      handleModeChange: (mode) => modeChanges.push(String(mode)),
    };

    const res = syncClaudePermissionModeFromMetadata({ session, permissionHandler });
    expect(res).toBe(null);
    expect(modeChanges).toEqual([]);
  });
});
