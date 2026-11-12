import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderHook, standardCleanup } from '@/dev/testkit';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { newSessionBackgroundLaunches } from '@/components/sessions/new/modules/newSessionBackgroundLaunches';
import { resolveSessionStartFailureNotice } from '@/components/sessions/startFailure/sessionStartFailureNotice';
import { storage } from '@/sync/domains/state/storage';

import { useNewSessionBackgroundLaunchStatus } from './useNewSessionBackgroundLaunchStatus';

const initialState = storage.getState();
const issue = {
  v: 1 as const,
  scope: 'primary_session' as const,
  status: 'failed' as const,
  code: 'agent_isolation_unavailable',
  source: 'dependency_failure' as const,
  occurredAt: 1,
};
const actions = { openSession: () => {}, openDraft: () => {} };

describe('useNewSessionBackgroundLaunchStatus', () => {
  afterEach(() => {
    standardCleanup();
    newSessionBackgroundLaunches.resetForTests();
    storage.setState(initialState, true);
  });

  it('recovers the retained draft when a presented Session later fails to start', async () => {
    storage.setState({
      sessions: {
        ...storage.getState().sessions,
        s1: createSessionFixture({
          id: 's1',
          active: false,
          lastRuntimeIssue: issue,
        }),
      },
    });
    newSessionBackgroundLaunches.begin();
    newSessionBackgroundLaunches.presented('/session/s1');
    const failureMessage = resolveSessionStartFailureNotice({ issue, sessionActive: false })!.message;
    newSessionBackgroundLaunches.failed(
      failureMessage,
      'draft-1',
      '/session/s1',
    );

    const openDraft = vi.fn();
    const openSession = vi.fn();
    const hook = await renderHook(() =>
      useNewSessionBackgroundLaunchStatus({ openDraft, openSession }),
    );
    const status = hook.getCurrent();
    expect(status?.text).toBe(
      resolveSessionStartFailureNotice({ issue, sessionActive: false })
        ?.message,
    );
    expect(status?.action?.testID).toBe('new-session-started-open-draft');
    act(() => { status?.action?.onPress(); });
    expect(openDraft).toHaveBeenCalledWith('draft-1');
    expect(openSession).not.toHaveBeenCalled();
  });

  it('recovers the launch-owned draft when its first-message projection settles failed', async () => {
    const openDraft = vi.fn();
    const openSession = vi.fn();
    storage.getState().upsertPendingMessage('s1', {
      id: 'first-turn', localId: 'first-turn', createdAt: 1, updatedAt: 1,
      source: 'local_outbound', text: 'Keep this prompt', rawRecord: {},
      pendingLaunch: { state: 'failed', message: 'All accounts are used up.', draftId: 'original-draft' },
    });
    newSessionBackgroundLaunches.presented('/session/s1');
    const hook = await renderHook(() => useNewSessionBackgroundLaunchStatus({ openDraft, openSession }));
    expect(hook.getCurrent()?.text).toBe('All accounts are used up.');
    expect(hook.getCurrent()?.action?.testID).toBe('new-session-started-open-draft');
    act(() => { hook.getCurrent()?.action?.onPress(); });
    expect(openDraft).toHaveBeenCalledWith('original-draft');
    expect(openSession).not.toHaveBeenCalled();
  });

  it('still reports a launch that failed before any Session existed, with the way back to its draft', async () => {
    newSessionBackgroundLaunches.begin();
    newSessionBackgroundLaunches.failed(
      'No machine selected.',
      'draft-1',
      null,
    );
    const hook = await renderHook(() =>
      useNewSessionBackgroundLaunchStatus(actions),
    );
    expect(hook.getCurrent()).toMatchObject({
      text: 'No machine selected.',
      action: { testID: 'new-session-started-open-draft' },
    });
  });

  it('keeps the presented Session reachable when a failed launch has no retained draft', async () => {
    const openSession = vi.fn();
    newSessionBackgroundLaunches.failed('Could not start.', null, '/session/s1');
    const hook = await renderHook(() => useNewSessionBackgroundLaunchStatus({ ...actions, openSession }));
    expect(hook.getCurrent()?.action?.testID).toBe('new-session-docked-open');
    hook.getCurrent()?.action?.onPress();
    expect(openSession).toHaveBeenCalledWith('/session/s1');
  });
});
