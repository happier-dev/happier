import { afterEach, describe, expect, it } from 'vitest';

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

  it('keeps a presented Session as the receipt when its launch later fails, worded by the Session start-failure banner', async () => {
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
    newSessionBackgroundLaunches.failed(
      'Couldn’t start the session. (Error spawn_failed)',
      'draft-1',
      '/session/s1',
    );

    const hook = await renderHook(() =>
      useNewSessionBackgroundLaunchStatus(actions),
    );
    const status = hook.getCurrent();
    expect(status?.text).toBe(
      resolveSessionStartFailureNotice({ issue, sessionActive: false })
        ?.message,
    );
    expect(status?.action?.testID).toBe('new-session-docked-open');
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
});
