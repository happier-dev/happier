import * as React from 'react';
import 'fake-indexeddb/auto';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createSessionFixture,
  renderScreen,
  standardCleanup,
} from '@/dev/testkit';
import { installSessionSubagentCommonModuleMocks } from '@/components/sessions/agents/sessionSubagentTestHelpers';
import {
  installDisconnectedServerSocketBoundary,
  restoreServerAccountForTest,
} from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import type { NormalizedMessage } from '@happier-dev/session-core/raw';
import type { Session } from '@/sync/domains/state/storageTypes';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { installTimerCensus } from '@/dev/testkit/performance/timerCensus';
import { readRelativeTimeShortRefreshAtMs } from '@/utils/time/formatShortRelativeTime';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const routerPush = vi.hoisted(() => vi.fn());
const deviceDimensions = vi.hoisted(() => ({
  width: 1400,
  height: 900,
  scale: 1,
  fontScale: 1,
}));

installSessionSubagentCommonModuleMocks({
  // Real copy: the digest's lead is a composed sentence, so its words are the contract.
  text: () => vi.importActual<typeof import('@/text')>('@/text'),
  storage: () =>
    vi.importActual<typeof import('@/sync/domains/state/storage')>(
      '@/sync/domains/state/storage',
    ),
  reactNative: async () => {
    const { createReactNativeWebMock } =
      await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
      Dimensions: {
        get: () => deviceDimensions,
        addEventListener: () => ({ remove() {} }),
      },
    });
  },
});
vi.mock('expo-router', async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
  return createExpoRouterMock({
    pathname: () => '/session/lead',
    params: () => ({}),
    router: { push: routerPush },
  }).module;
});
installDisconnectedServerSocketBoundary();

// Keep the Work producer, Recap resolver, selectors and pane real.
const { storage } = await import('@/sync/domains/state/storage');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const { AppPaneProvider } =
  await import('@/components/appShell/panes/AppPaneProvider');
const { PaneHeaderSlotProvider, PaneHeaderSlotScope } =
  await import('@/components/appShell/panes/paneHeaderSlot');
const { useSessionAgentActivity } =
  await import('@/hooks/session/useSessionAgentActivity');
const { SessionWorkSourcesProvider, useSessionWorkSourcesOwner } =
  await import('./sessionWorkSources');
const { SessionWorkView } = await import('./SessionWorkView');
const { createSessionPaneScopeId } =
  await import('@/components/sessions/panes/sessionPaneScopeId');
const { t } = await import('@/text');
// Loading the engine publishes the app's one sync singleton, the Session send owner the digest uses.
await import('@/sync/syncEngine');
const syncModule = await import('@/sync/sync');
const { Modal } = await import('@/modal');
const { getActiveServerAccountScope } =
  await import('@/sync/domains/scope/activeServerAccountScope');
const {
  ensureSessionDraftRepositoryHydrated,
  resetSessionDraftRepositoryForTests,
} = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');

function WorkHost(props: Readonly<{ serverId: string }>) {
  const activity = useSessionAgentActivity({
    sessionId: 'lead',
    serverId: props.serverId,
  });
  const sources = useSessionWorkSourcesOwner({
    sessionId: 'lead',
    serverId: props.serverId,
    ownerMetadata: storage.getState().sessions.lead?.metadata ?? null,
    agentActivity: activity,
  });
  return (
    <SessionWorkSourcesProvider value={sources}>
      <AppPaneProvider>
        <PaneHeaderSlotProvider>
          <PaneHeaderSlotScope slotKey="work">
            <SessionWorkView
              sessionId="lead"
              serverId={props.serverId}
              scopeId={createSessionPaneScopeId('lead', props.serverId)}
            />
          </PaneHeaderSlotScope>
        </PaneHeaderSlotProvider>
      </AppPaneProvider>
    </SessionWorkSourcesProvider>
  );
}

const settledUpdate: NormalizedMessage = {
  id: 'update',
  seq: 2,
  localId: null,
  createdAt: 5_000,
  role: 'event',
  isSidechain: false,
  content: {
    type: 'worker-update',
    update: {
      v: 1,
      workerKind: 'session',
      workerId: 'worker',
      ownerState: 'settled',
      wake: 'finished',
      headline: 'Runbook published',
      canInspect: false,
    },
  },
};

/** A coordinator fact as the Session list owner reports it: how many Sessions it manages. */
function managed(total: number): NonNullable<Session['managedSessions']> {
  return { total, working: 0, needsYou: 0, stalled: 0, finished: total, attentionPrimary: null };
}

/** The text a rendered host shows, in order. */
function hostText(node: { children: readonly unknown[] }): string {
  return node.children
    .map((child) => (typeof child === 'string' ? child : hostText(child as { children: readonly unknown[] })))
    .join('');
}

async function renderWork(
  input: Readonly<{
    lead: Partial<Session>;
    worker?: Partial<Session>;
    messages: readonly NormalizedMessage[];
  }>,
) {
  const connection = await restoreServerAccountForTest({
    serverUrl: 'https://work-digest.test',
    serverIdentityId: 'srv_work_digest',
    accountId: 'account',
    request: async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption')
        return Response.json({ mode: 'plain', updatedAt: 1 });
      if (path === '/v1/account/encryption/currentness')
        return Response.json(createPlainAccountEncryptionCurrentnessFixture());
      if (path === '/v2/account/settings')
        return Response.json({ content: null, version: 0 });
      return Response.json({}, { status: 404 });
    },
  });
  const initial = storage.getState();
  const serverId = connection.home.id;
  const draftScope = getActiveServerAccountScope();
  if (!draftScope) throw new Error('Expected the restored Account draft scope');
  await ensureSessionDraftRepositoryHydrated(draftScope);
  const lead = createSessionFixture({ id: 'lead', serverId, ...input.lead });
  const worker = createSessionFixture({
    id: 'worker',
    serverId,
    manager: { sessionId: 'lead' },
    latestTurnStatus: 'completed',
    metadata: {
      ...createSessionFixture({ id: 'worker' }).metadata!,
      name: 'Support runbook',
    },
    ...input.worker,
  });
  storage.setState({
    sessions: { lead, worker },
    sessionListRowsByServerId: {},
  });
  await act(async () => {
    storage.getState().applyMessages('lead', [...input.messages]);
    storage.getState().applyMessagesLoaded('lead');
  });
  let setPresented: React.Dispatch<React.SetStateAction<boolean>>;
  function PresentedWorkHost() {
    const [presented, set] = React.useState(true);
    setPresented = set;
    return <PluginSurfaceFocusEligibilityProvider active={presented} presentationActive={presented}>
      <WorkHost serverId={serverId} />
    </PluginSurfaceFocusEligibilityProvider>;
  }
  const screen = await renderScreen(<PresentedWorkHost />, {
    wrapper: ({ children }) => (
      <InjectedAuthProvider credentials={connection.credentials}>
        {children}
      </InjectedAuthProvider>
    ),
  });
  return {
    screen,
    serverId,
    setPresented: async (presented: boolean) => {
      await act(async () => setPresented(presented));
    },
    dispose: async () => {
      await screen.unmount();
      storage.setState(initial, true);
      resetSessionDraftRepositoryForTests();
      await connection.dispose();
    },
  };
}

afterEach(async () => {
  routerPush.mockReset();
  vi.mocked(Modal.alert).mockClear();
  vi.restoreAllMocks();
  await standardCleanup();
});

describe('Work digest (C1 R12: the coordinator digest reads the existing Recap)', () => {
  it('releases relative-time deadline callbacks while hidden and shows a newly delivered result on reopening', async () => {
    const work = await renderWork({
      lead: { managedSessions: managed(0), receivedRuleCount: 2 },
      messages: [],
    });
    vi.useFakeTimers();
    const census = installTimerCensus(stack => stack.includes('sessionListRuntimeClock') ? 'relative-time' : null);
    try {
      const now = Date.now();
      await act(async () => { storage.getState().applyMessages('lead', [{ ...settledUpdate, createdAt: now }]); });
      expect(work.screen.getTextContent()).toContain('Runbook published');
      expect(census.read().some(timer => timer.consumer === 'relative-time')).toBe(true);
      await work.setPresented(false);
      const fires = census.readFires();
      await act(async () => { vi.advanceTimersByTime(180_000); });
      expect(census.readFires().timeout - fires.timeout).toBe(0);
      // This pane also has Work rows using the shared clock; their other deadlines are not this leaf's demand.
      const deliveredAt = Date.now();
      await act(async () => { storage.getState().applyMessages('lead', [{
        ...settledUpdate, id: 'new-update', seq: 3, createdAt: deliveredAt,
        content: { type: 'worker-update', update: {
          v: 1, workerKind: 'session', workerId: 'worker', ownerState: 'settled', wake: 'finished',
          headline: 'New delivered report', result: 'The reopened digest has the current result.', canInspect: false,
        } },
      }]); });
      await work.setPresented(true);
      expect(work.screen.getTextContent()).toContain('The reopened digest has the current result.');
      expect(census.read().some(timer => timer.consumer === 'relative-time')).toBe(true);
      const reopenedFires = census.readFires().timeout;
      const refreshAt = readRelativeTimeShortRefreshAtMs(deliveredAt, Date.now());
      if (refreshAt === null) throw new Error('Expected the current digest label to have a refresh deadline');
      await act(async () => { vi.advanceTimersByTime(refreshAt - Date.now()); });
      expect(census.readFires().timeout).toBeGreaterThan(reopenedFires);
    } finally {
      await work.dispose();
      census.stop();
      vi.useRealTimers();
    }
  });

  it('shows a coordinator its latest delivered update and when it arrived', async () => {
    const work = await renderWork({
      lead: { managedSessions: managed(1), receivedRuleCount: 0 },
      messages: [settledUpdate],
    });
    try {
      expect(
        work.screen.findHostByTestId('session-work-digest'),
      ).not.toBeNull();
      const lead = work.screen.findHostByTestId('session-work-digest-lead');
      expect(lead).not.toBeNull();
      const text = work.screen.getTextContent();
      expect(text).toContain('Runbook published');
      expect(text).toContain(t('sessionWork.digest.latestUpdate'));
    } finally {
      await work.dispose();
    }
  });

  it('leads with what the worker delivered, without repeating a sender Recent already shows', async () => {
    const delivered: NormalizedMessage = {
      ...settledUpdate,
      content: {
        type: 'worker-update',
        update: {
          v: 1,
          workerKind: 'session',
          workerId: 'worker',
          ownerState: 'settled',
          wake: 'finished',
          headline: 'Runbook published',
          result:
            'The support runbook converged in one round; two links still need owners.',
          canInspect: false,
        },
      },
    };
    const work = await renderWork({
      lead: { managedSessions: managed(1), receivedRuleCount: 0 },
      messages: [delivered],
    });
    try {
      const lead = work.screen.findHostByTestId('session-work-digest-lead');
      expect(lead && hostText(lead)).toBe(
        'The support runbook converged in one round; two links still need owners.',
      );
      // Recent already shows the finished sender; the digest does not draw it twice.
      expect(work.screen.findHostByTestId('session-work-digest-source')).toBeNull();
      expect(work.screen.findHostByTestId('session-work-state-recent')).not.toBeNull();
    } finally {
      await work.dispose();
    }
  });

  it('repeats the sender as a Work row when it needs you, as the list does', async () => {
    const now = Date.now();
    const work = await renderWork({
      lead: { managedSessions: managed(1), receivedRuleCount: 0 },
      worker: {
        active: true,
        activeAt: now,
        latestTurnStatus: undefined,
        pendingPermissionRequestCount: 1,
        pendingRequestObservedAt: now,
      },
      messages: [settledUpdate],
    });
    try {
      const source = work.screen.findHostByTestId('session-work-digest-source');
      expect(source).not.toBeNull();
      expect(
        source!.findAll(
          (node) =>
            typeof node.props.testID === 'string' &&
            node.props.testID.startsWith('session-work-row:'),
        ),
      ).not.toHaveLength(0);
      expect(hostText(source!)).toContain('Support runbook');
    } finally {
      await work.dispose();
    }
  });

  it('says a status-only update plainly in one sentence that names its Session', async () => {
    const work = await renderWork({
      lead: { managedSessions: managed(1), receivedRuleCount: 0 },
      messages: [settledUpdate],
    });
    try {
      const lead = work.screen.findHostByTestId('session-work-digest-lead');
      const text = lead ? hostText(lead) : '';
      expect(text).toMatch(/^Support runbook /);
      expect(text).toContain(t('sessionWork.workerUpdate.state.settled'));
      expect(text).toMatch(/\.$/);
    } finally {
      await work.dispose();
    }
  });

  it('shows no digest on a session that is not a coordinator, even with a delivered update', async () => {
    const work = await renderWork({
      lead: { managedSessions: managed(0), receivedRuleCount: 0 },
      messages: [settledUpdate],
    });
    try {
      expect(work.screen.findHostByTestId('session-work-digest')).toBeNull();
    } finally {
      await work.dispose();
    }
  });

  it('says what will appear when a coordinator has no Recap yet', async () => {
    const work = await renderWork({
      lead: { managedSessions: managed(0), receivedRuleCount: 2 },
      messages: [],
    });
    try {
      expect(
        work.screen.findHostByTestId('session-work-digest'),
      ).not.toBeNull();
      expect(
        work.screen.findHostByTestId('session-work-digest-empty'),
      ).not.toBeNull();
      expect(
        work.screen.findHostByTestId('session-work-digest-lead'),
      ).toBeNull();
    } finally {
      await work.dispose();
    }
  });

  describe('Ask for a fresh digest', () => {
    const sent = { type: 'success', persistence: 'pending', localId: 'local-refresh', wake: { attempted: false, state: 'not_needed' } } as const;

    it('sends the canned request to this coordinator once per press, through the Session send owner', async () => {
      let release!: () => void;
      const submit = vi.spyOn(syncModule.sync, 'submitMessage').mockImplementation(
        () => new Promise((resolve) => { release = () => resolve(sent); }),
      );
      const work = await renderWork({
        lead: { managedSessions: managed(1), receivedRuleCount: 0 },
        messages: [settledUpdate],
      });
      try {
        await act(async () => { work.screen.pressByTestId('session-work-digest-refresh'); });
        // A second press while the first is still being admitted is not a second request.
        await act(async () => { work.screen.pressByTestId('session-work-digest-refresh'); });
        expect(submit).toHaveBeenCalledTimes(1);
        const [sessionId, text, , , options] = submit.mock.calls[0]!;
        expect(sessionId).toBe('lead');
        expect(text).toBe(t('sessionWork.digest.refreshRequest'));
        expect(options).toMatchObject({ serverId: work.serverId });
        await act(async () => { release(); });
        expect(Modal.alert).not.toHaveBeenCalled();
        // Settled: the control is available again for the next request.
        await act(async () => { work.screen.pressByTestId('session-work-digest-refresh'); });
        expect(submit).toHaveBeenCalledTimes(2);
        await act(async () => { release(); });
      } finally {
        await work.dispose();
      }
    });

    it('shows the existing error when the send fails', async () => {
      // The send owner reports a failed send by rejecting (it throws on send_failed, rejected and wake_failed).
      vi.spyOn(syncModule.sync, 'submitMessage').mockRejectedValue(new Error('The coordinator is unreachable'));
      const work = await renderWork({
        lead: { managedSessions: managed(1), receivedRuleCount: 0 },
        messages: [settledUpdate],
      });
      try {
        await act(async () => { work.screen.pressByTestId('session-work-digest-refresh'); });
        expect(Modal.alert).toHaveBeenCalledWith(t('common.error'), 'The coordinator is unreachable');
      } finally {
        await work.dispose();
      }
    });

    it('is offered when the coordinator has no Recap yet', async () => {
      const work = await renderWork({
        lead: { managedSessions: managed(0), receivedRuleCount: 2 },
        messages: [],
      });
      try {
        expect(work.screen.findHostByTestId('session-work-digest-refresh')).not.toBeNull();
      } finally {
        await work.dispose();
      }
    });
  });
});
