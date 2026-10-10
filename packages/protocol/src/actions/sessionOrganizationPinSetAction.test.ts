import { describe, expect, it, vi } from 'vitest';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';

function createPinExecutor(sessionOrganizationPinSet: NonNullable<ActionExecutorDeps['sessionOrganizationPinSet']>) {
  // Unused host effect ports fail loudly; admission, policy and dispatch remain real.
  const unexpectedBoundary = async (): Promise<never> => { throw new Error('unexpected host boundary'); };
  const deps: ActionExecutorDeps = {
    executionRunStart: unexpectedBoundary, executionRunList: unexpectedBoundary, executionRunGet: unexpectedBoundary,
    detachedExecutionRunSend: unexpectedBoundary, executionRunStop: unexpectedBoundary, executionRunAction: unexpectedBoundary,
    executionRunWait: unexpectedBoundary, sessionOpen: unexpectedBoundary, sessionFork: unexpectedBoundary,
    sessionRollback: unexpectedBoundary, sessionSpawnNew: unexpectedBoundary, pathsListRecent: unexpectedBoundary,
    machinesList: unexpectedBoundary, serversList: unexpectedBoundary, reviewEnginesList: unexpectedBoundary,
    agentsBackendsList: unexpectedBoundary, agentsModelsList: unexpectedBoundary, sessionSendMessage: unexpectedBoundary,
    sessionPermissionRespond: unexpectedBoundary, sessionUserActionAnswer: unexpectedBoundary, sessionModeSet: unexpectedBoundary,
    sessionModesList: unexpectedBoundary, sessionTargetPrimarySet: unexpectedBoundary, sessionTargetTrackedSet: unexpectedBoundary,
    sessionList: unexpectedBoundary, sessionActivityGet: unexpectedBoundary, sessionRecentMessagesGet: unexpectedBoundary,
    resetGlobalVoiceAgent: () => { throw new Error('unexpected host boundary'); },
    sessionOrganizationPinSet,
  };
  return createActionExecutor(deps);
}

describe('session.organization.pin.set', () => {
  it('writes a named surface through the Account transport and retains its acknowledged memberships', async () => {
    // The host port is the real Account HTTP write boundary.
    const sessionOrganizationPinSet = vi.fn(async () => ({ pin: {
      sessionId: 's1', sortKey: 'a', pinnedAt: 10, listPinned: false, railPinned: true,
    } }));
    const executor = createPinExecutor(sessionOrganizationPinSet);
    await expect(executor.execute('session.organization.pin.set',
      { sessionId: 's1', pinned: true, surface: 'rail' }, { surface: 'cli', authority: 'account_automation', serverId: 'home1' }))
      .resolves.toEqual({ ok: true, result: { pin: { sessionId: 's1', sortKey: 'a', pinnedAt: 10, listPinned: false, railPinned: true } } });
    expect(sessionOrganizationPinSet).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 's1', request: { pinned: true, surface: 'rail' }, serverId: 'home1',
    }));
  });

  it('rejects unsupported surface input before the Account mutation', async () => {
    const sessionOrganizationPinSet = vi.fn();
    const executor = createPinExecutor(sessionOrganizationPinSet);
    await expect(executor.execute('session.organization.pin.set',
      { sessionId: 's1', pinned: true, surface: 'other' }, { surface: 'cli', authority: 'account_automation' }))
      .resolves.toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    expect(sessionOrganizationPinSet).not.toHaveBeenCalled();
  });

  it('does not acknowledge a different target or membership as a successful pin write', async () => {
    for (const pin of [
      { sessionId: 'foreign', sortKey: 'a', pinnedAt: 10, listPinned: true, railPinned: true },
      { sessionId: 's1', sortKey: 'a', pinnedAt: 10, listPinned: true, railPinned: false },
    ]) {
      const executor = createPinExecutor(async () => ({ pin }));
      await expect(executor.execute('session.organization.pin.set',
        { sessionId: 's1', pinned: true, surface: 'rail' }, { surface: 'cli', authority: 'account_automation' }))
        .resolves.toMatchObject({ ok: false, errorCode: 'invalid_action_output' });
    }
  });
});
