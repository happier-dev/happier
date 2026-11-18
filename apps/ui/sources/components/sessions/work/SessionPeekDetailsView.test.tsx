import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createSessionFixture,
  renderScreen,
  standardCleanup,
} from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';

/**
 * `SessionView` is the one Session renderer (its own tests own the transcript and composer); the
 * probe records the composer's replies banner so this test observes only what the peek adds.
 */
const rendered = vi.hoisted(() => ({ banner: null as React.ReactNode }));
vi.mock('@/components/sessions/shell/SessionView', () => ({
  SessionView: (props: {
    presentation?: { repliesBanner?: React.ReactNode };
  }) => {
    rendered.banner = props.presentation?.repliesBanner ?? null;
    return React.createElement(
      'SessionView',
      null,
      props.presentation?.repliesBanner ?? null,
    );
  },
}));
// Session following is a Home feature bit (a server boundary): this Home offers it.
vi.mock('@/hooks/server/useFeatureEnabled', () => ({
  useFeatureEnabled: () => true,
}));

// Load the real Session/Follow graph during collection, not inside the assertion deadline.
const { SessionPeekDetailsView } = await import('./SessionPeekDetailsView');

describe('SessionPeekDetailsView', () => {
  let previousState = storage.getState();
  beforeEach(() => {
    previousState = storage.getState();
    storage.setState({
      sessions: {
        ...previousState.sessions,
        'worker-1': createSessionFixture({
          id: 'worker-1',
          serverId: 'home-one',
        } as never),
      },
    });
  });
  afterEach(() => {
    standardCleanup();
    storage.setState(previousState, true);
    rendered.banner = null;
  });

  it('offers this session’s notifications from the header bell, not as switches under its composer', async () => {
    const screen = await renderScreen(
      <SessionPeekDetailsView
        sessionId="worker-1"
        serverId="home-one"
        active
      />,
    );

    const header = screen.findByTestId('session-peek-header');
    expect(header).not.toBeNull();
    // The bell opens the Session's one Follow editor (it holds "Notify me when…"), beside Open session.
    expect(screen.findByTestId('session-header-follow-chip')).not.toBeNull();
    expect(screen.findByTestId('session-peek-open')).not.toBeNull();
    // The composer keeps only its hint; no notification switch hangs beneath it.
    const banner = await renderScreen(<>{rendered.banner}</>);
    expect(banner.findByTestId('session-peek-replies-banner')).not.toBeNull();
    expect(banner.getTextContent()).not.toMatch(/notify/i);
    expect(screen.findByTestId('notify-turn:worker-1')).toBeNull();
    expect(screen.findByTestId('notify-attention:worker-1')).toBeNull();
  });

  // The embedded Session has no header of its own and its control row is withheld when it offers nothing
  // (an imported Muse Session: no Take over, Replay off), so the peek's header carries the external state.
  it('keeps an imported external Session\'s needs-input state visible in the peek header', async () => {
    const now = Date.now();
    storage.setState({
      sessions: {
        ...storage.getState().sessions,
        'worker-1': createSessionFixture({
          id: 'worker-1',
          serverId: 'home-one',
          metadata: {
            path: '/tmp',
            host: 'nldw4',
            machineId: 'machine-1',
            flavor: 'muse',
            externalSessionV1: {
              v: 1,
              agentId: 'muse',
              machineId: 'machine-1',
              remoteSessionId: 'muse-session-1',
              source: { kind: 'museNative' },
            },
            externalAgentObservationV1: {
              v: 1,
              qualifiedLinkIdentity: {
                v: 1,
                agent: { pluginId: 'happier.muse', localId: 'muse' },
                source: { kind: 'museNative', contractVersion: 1 },
              },
              linkGeneration: 'link-generation-1',
              status: 'waiting',
              observedAtMs: now,
              expiresAtMs: now + 60 * 60 * 1000,
            },
          },
        } as never),
      },
    });

    const screen = await renderScreen(
      <SessionPeekDetailsView sessionId="worker-1" serverId="home-one" active />,
    );

    const header = screen.findByTestId('session-peek-header');
    expect(header).not.toBeNull();
    expect(screen.findByTestId('session-header-external-agent-status-waiting')).not.toBeNull();
  });
});
