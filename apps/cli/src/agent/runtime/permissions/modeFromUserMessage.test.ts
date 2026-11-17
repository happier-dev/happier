import { describe, expect, it } from 'vitest';

import { resolvePermissionModeForQueueingUserMessage } from './modeFromUserMessage';

describe('resolvePermissionModeForQueueingUserMessage', () => {
  it('keeps current mode when message has no permission override', () => {
    const result = resolvePermissionModeForQueueingUserMessage({
      currentPermissionMode: 'safe-yolo',
      messagePermissionModeRaw: undefined,
    });

    expect(result).toEqual({
      ok: true,
      currentPermissionMode: 'safe-yolo',
      queuePermissionMode: 'safe-yolo',
      didChange: false,
    });
  });

  it('normalizes the turn override without changing the owner baseline', () => {
    const result = resolvePermissionModeForQueueingUserMessage({
      currentPermissionMode: 'default',
      messagePermissionModeRaw: 'acceptEdits',
    });

    expect(result).toEqual({
      ok: true,
      currentPermissionMode: 'default',
      queuePermissionMode: 'safe-yolo',
      didChange: true,
    });
  });

  it('falls back to default when there is no current mode and override is invalid', () => {
    const result = resolvePermissionModeForQueueingUserMessage({
      currentPermissionMode: undefined,
      messagePermissionModeRaw: 123,
    });

    expect(result).toEqual({
      ok: true,
      currentPermissionMode: undefined,
      queuePermissionMode: 'default',
      didChange: false,
    });
  });

  it('reports no change for an alias respelling of the current mode (ported S-6)', () => {
    const result = resolvePermissionModeForQueueingUserMessage({
      currentPermissionMode: 'acceptEdits',
      messagePermissionModeRaw: 'safe-yolo',
    });

    expect(result).toEqual({
      ok: true,
      currentPermissionMode: 'safe-yolo',
      queuePermissionMode: 'safe-yolo',
      didChange: false,
    });
  });
});
