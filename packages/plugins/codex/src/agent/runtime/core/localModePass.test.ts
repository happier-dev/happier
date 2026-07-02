import { describe, expect, it, vi } from 'vitest';

import { runCodexLocalModePass } from './localModePass.js';

type QueueMode = { localId?: string | null };

function createQueue(initialSize = 0) {
  let onMessage: (() => void) | null = null;
  return {
    size: () => initialSize,
    setOnMessage: (handler: (() => void) | null) => {
      onMessage = handler;
    },
    readOnMessage: () => onMessage,
  };
}

describe('runCodexLocalModePass', () => {
  it('launches local terminal mode through the injected terminal launcher', async () => {
    const session = {
      listPendingMessageQueueV2LocalIds: vi.fn(async () => []),
      discardPendingMessageQueueV2All: vi.fn(),
      discardCommittedMessageLocalIds: vi.fn(),
      sendSessionEvent: vi.fn(),
    };
    const launchLocal = vi.fn(async () => ({
      type: 'control_returned' as const,
      reason: 'switch_requested' as const,
      providerSessionId: 'resume-local',
    }));

    const result = await runCodexLocalModePass<QueueMode>({
      session,
      messageQueue: createQueue(),
      workspaceDir: '/tmp/project',
      api: { marker: 'api' },
      permissionMode: 'safe-yolo',
      resumeId: null,
      codexArgs: ['exec'],
      launchLocal,
      discardController: vi.fn(),
      formatError: (error) => String(error),
    });

    expect(result).toEqual({ type: 'remote', resumeId: 'resume-local' });
    expect(launchLocal).toHaveBeenCalledWith({
      path: '/tmp/project',
      api: { marker: 'api' },
      session,
      messageQueue: expect.any(Object),
      permissionMode: 'safe-yolo',
      resumeId: null,
      codexArgs: ['exec'],
    });
  });

  it('stays remote when queued-message discard is cancelled', async () => {
    const session = {
      listPendingMessageQueueV2LocalIds: vi.fn(async () => []),
      discardPendingMessageQueueV2All: vi.fn(),
      discardCommittedMessageLocalIds: vi.fn(),
      sendSessionEvent: vi.fn(),
    };
    const launchLocal = vi.fn();

    const result = await runCodexLocalModePass<QueueMode>({
      session,
      messageQueue: createQueue(1),
      workspaceDir: '/tmp/project',
      api: null,
      permissionMode: 'default',
      resumeId: 'existing',
      launchLocal,
      discardController: vi.fn(async () => 'cancelled'),
      formatError: (error) => String(error),
    });

    expect(result).toEqual({ type: 'remote', resumeId: 'existing' });
    expect(launchLocal).not.toHaveBeenCalled();
  });
});
