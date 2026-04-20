import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PermissionMode } from '@/api/types';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';

import { runCodexLocalModePass } from './localModePass';

const { resolveBackendExecutionSurfaces } = vi.hoisted(() => ({
  resolveBackendExecutionSurfaces: vi.fn(),
}));

vi.mock('@/agent/runtime/registry/engineRegistry', () => ({
  resolveBackendExecutionSurfaces,
}));

type Mode = { permissionMode: PermissionMode; localId?: string | null };

describe('runCodexLocalModePass', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses the shared terminal-runtime catalog launch path when no explicit launcher override is provided', async () => {
    const queue = new MessageQueue2<Mode>(() => 'hash');
    const session = {
      listPendingMessageQueueV2LocalIds: vi.fn().mockResolvedValue([]),
      discardPendingMessageQueueV2All: vi.fn(),
      discardCommittedMessageLocalIds: vi.fn(),
      sendSessionEvent: vi.fn(),
    };
    const launch = vi.fn(async () => ({ type: 'switch', resumeId: 'resume-catalog' }));
    resolveBackendExecutionSurfaces.mockResolvedValue({
      terminalRuntime: {
        launch,
      },
      directSessions: null,
      attach: null,
      sessionHandoff: null,
    });

    const result = await runCodexLocalModePass({
      session: session as unknown as ApiSessionClient,
      messageQueue: queue,
      workspaceDir: '/tmp/project',
      api: {},
      permissionMode: 'default',
      resumeId: null,
      discardController: vi.fn(),
      formatError: (error: unknown) => String(error),
    });

    expect(result).toEqual({ type: 'remote', resumeId: 'resume-catalog' });
    expect(resolveBackendExecutionSurfaces).toHaveBeenCalledWith('codex');
    expect(launch).toHaveBeenCalledWith({
      path: '/tmp/project',
      api: {},
      session,
      messageQueue: queue,
      permissionMode: 'default',
      resumeId: null,
    });
  });

  it('returns remote without launching local when discard is cancelled', async () => {
    const queue = new MessageQueue2<Mode>(() => 'hash');
    queue.push('hello', { permissionMode: 'default', localId: 'l1' });

    const session = {
      listPendingMessageQueueV2LocalIds: vi.fn().mockResolvedValue([]),
      discardPendingMessageQueueV2All: vi.fn(),
      discardCommittedMessageLocalIds: vi.fn(),
      sendSessionEvent: vi.fn(),
    };
    const launchLocal = vi.fn();
    const discardController = vi.fn().mockResolvedValue('cancelled');

    const result = await runCodexLocalModePass({
      session: session as unknown as ApiSessionClient,
      messageQueue: queue,
      workspaceDir: '/tmp/project',
      api: {},
      permissionMode: 'default',
      resumeId: null,
      launchLocal,
      discardController,
      formatError: (error: unknown) => String(error),
    });

    expect(result).toEqual({ type: 'remote', resumeId: null });
    expect(launchLocal).not.toHaveBeenCalled();
  });

  it('returns exit when local launcher exits', async () => {
    const queue = new MessageQueue2<Mode>(() => 'hash');
    const session = {
      listPendingMessageQueueV2LocalIds: vi.fn().mockResolvedValue([]),
      discardPendingMessageQueueV2All: vi.fn(),
      discardCommittedMessageLocalIds: vi.fn(),
      sendSessionEvent: vi.fn(),
    };
    const launchLocal = vi.fn().mockResolvedValue({ type: 'exit', code: 0 });

    const result = await runCodexLocalModePass({
      session: session as unknown as ApiSessionClient,
      messageQueue: queue,
      workspaceDir: '/tmp/project',
      api: {},
      permissionMode: 'default',
      resumeId: null,
      launchLocal,
      discardController: vi.fn(),
      formatError: (error: unknown) => String(error),
    });

    expect(result).toEqual({ type: 'exit' });
  });

  it('returns remote with resume id after local launcher switch', async () => {
    const queue = new MessageQueue2<Mode>(() => 'hash');
    const session = {
      listPendingMessageQueueV2LocalIds: vi.fn().mockResolvedValue([]),
      discardPendingMessageQueueV2All: vi.fn(),
      discardCommittedMessageLocalIds: vi.fn(),
      sendSessionEvent: vi.fn(),
    };
    const launchLocal = vi.fn().mockResolvedValue({ type: 'switch', resumeId: 'resume-123' });

    const result = await runCodexLocalModePass({
      session: session as unknown as ApiSessionClient,
      messageQueue: queue,
      workspaceDir: '/tmp/project',
      api: {},
      permissionMode: 'safe-yolo',
      resumeId: 'previous',
      launchLocal,
      discardController: vi.fn(),
      formatError: (error: unknown) => String(error),
    });

    expect(result).toEqual({ type: 'remote', resumeId: 'resume-123' });
  });
});
