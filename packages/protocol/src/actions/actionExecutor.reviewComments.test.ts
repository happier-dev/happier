import { describe, expect, it, vi } from 'vitest';

import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';

function createDeps(overrides: Partial<ActionExecutorDeps> = {}): ActionExecutorDeps {
  return {
    executionRunStart: vi.fn(async () => ({})),
    executionRunList: vi.fn(async () => ({})),
    executionRunGet: vi.fn(async () => ({})),
    executionRunSend: vi.fn(async () => ({})),
    executionRunStop: vi.fn(async () => ({})),
    executionRunAction: vi.fn(async () => ({})),
    executionRunWait: vi.fn(async () => ({})),
    sessionOpen: vi.fn(async () => ({})),
    sessionFork: vi.fn(async () => ({})),
    sessionRollback: vi.fn(async () => ({})),
    sessionSpawnNew: vi.fn(async () => ({})),
    sessionSpawnPicker: vi.fn(async () => ({})),
    pathsListRecent: vi.fn(async () => ({ items: [] })),
    machinesList: vi.fn(async () => ({ items: [] })),
    serversList: vi.fn(async () => ({ items: [] })),
    reviewEnginesList: vi.fn(async () => ({ items: [] })),
    agentsBackendsList: vi.fn(async () => ({ items: [] })),
    agentsModelsList: vi.fn(async () => ({ items: [] })),
    sessionSendMessage: vi.fn(async () => ({})),
    sessionPermissionRespond: vi.fn(async () => ({})),
    sessionUserActionAnswer: vi.fn(async () => ({})),
    sessionModeSet: vi.fn(async () => ({})),
    sessionModesList: vi.fn(async () => ({ items: [] })),
    sessionTargetPrimarySet: vi.fn(async () => ({})),
    sessionTargetTrackedSet: vi.fn(async () => ({})),
    sessionList: vi.fn(async () => ({})),
    sessionActivityGet: vi.fn(async () => ({})),
    sessionRecentMessagesGet: vi.fn(async () => ({})),
    resetGlobalVoiceAgent: vi.fn(),
    ...overrides,
  };
}

describe('createActionExecutor (review comments)', () => {
  it('routes durable review-comment actions through the host review-comment executor', async () => {
    const reviewCommentAction = vi.fn(async () => ({ items: [], cursor: null }));
    const executor = createActionExecutor(createDeps({ reviewCommentAction }));

    const result = await executor.execute(
      'reviews.comments.list',
      { projectId: 'project-1', states: ['open'] },
      { surface: 'ui', serverId: 'server-1' },
    );

    expect(result).toEqual({ ok: true, result: { items: [], cursor: null } });
    expect(reviewCommentAction).toHaveBeenCalledWith({
      actionId: 'reviews.comments.list',
      input: { projectId: 'project-1', states: ['open'], includeHistory: false, limit: 50 },
      serverId: 'server-1',
    });
  });
});
