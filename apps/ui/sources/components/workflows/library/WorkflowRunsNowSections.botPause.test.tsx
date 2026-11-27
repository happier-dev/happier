import * as React from 'react';
import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { BotSetInputSchema } from '@happier-dev/protocol/sessions/identity/sessionBotV1';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { storage } from '@/sync/domains/state/storageStore';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { t } from '@/text';

import { projectWorkflowRunsBotPause } from './workflowRunsBotPause';
import type { WorkflowRunsNow } from './workflowRunsNow';
import { WorkflowRunsNowSections } from './WorkflowRunsNowSections';

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock(
  'expo-router',
  async () =>
    (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
      pathname: '/workflows/runs',
    }).module,
);

/** The Action front door is the transport boundary: each request must be one the Protocol owner admits. */
const sent = vi.hoisted(
  () =>
    [] as Array<
      Readonly<{ actionId: string; input: unknown; serverId: unknown }>
    >,
);
const refuse = vi.hoisted(() => new Set<string>());
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>()),
  createFrontDoorActionExecute:
    () =>
    async (
      actionId: string,
      input: unknown,
      options: { serverId?: unknown },
    ) => {
      const parsed = BotSetInputSchema.parse(input);
      sent.push({ actionId, input: parsed, serverId: options.serverId });
      return refuse.has(parsed.sessionId)
        ? { ok: false, errorCode: 'forbidden', error: 'forbidden' }
        : { ok: true, bot: parsed.bot };
    },
}));

afterEach(async () => {
  sent.length = 0;
  refuse.clear();
  await standardCleanup();
});

const SERVER = 'home-runs';
const NOW: WorkflowRunsNow = {
  needsYou: [],
  machines: [{ machineId: 'machine-1', working: 1, parked: 0 }],
  workingCount: 1,
  counted: { kind: 'all' },
};

function bot(
  id: string,
  extra: Parameters<typeof createSessionListRenderableSessionFixture>[0] = {},
) {
  return createSessionListRenderableSessionFixture({
    id,
    serverId: SERVER,
    metadata: { path: '/repo', bot: { kind: 'bot' } },
    ...extra,
  });
}

function seed(rows: Readonly<Record<string, ReturnType<typeof bot>>>) {
  storage.setState({
    sessionListBotRowsByServerId: {
      ...storage.getState().sessionListBotRowsByServerId,
      [SERVER]: rows,
    },
  });
}

it('counts only own Bots and keeps its projection while neither list changes', () => {
  const rows = {
    mine: bot('mine'),
    paused: bot('paused', { botPausedAt: 5 }),
    shared: bot('shared', { owner: 'someone-else', botPausedAt: null }),
  };
  const first = projectWorkflowRunsBotPause(rows);
  expect(first).toEqual({
    ownBotIds: ['mine', 'paused'],
    pausedBotIds: ['paused'],
  });
  expect(
    projectWorkflowRunsBotPause(
      { ...rows, mine: bot('mine', { seq: 9 }) },
      first,
    ),
  ).toBe(first);
  expect(projectWorkflowRunsBotPause(undefined)).toEqual({
    ownBotIds: [],
    pausedBotIds: [],
  });
});

it('pauses every own Bot not yet paused, shows the pushed pause, and resumes only the paused ones', async () => {
  const before = storage.getState();
  try {
    seed({
      a: bot('a'),
      b: bot('b'),
      shared: bot('shared', { owner: 'someone-else' }),
    });
    const screen = await renderScreen(
      <ListPresentationProvider value="page"><WorkflowRunsNowSections now={NOW} serverId={SERVER} /></ListPresentationProvider>,
    );
    expect(screen.findByTestId('workflow-runs:now:bots-paused')).toBeNull();

    await screen.pressByTestIdAsync('workflow-runs:now:bots-pause-all');
    expect(sent.map((request) => request.input)).toEqual([
      {
        sessionId: 'a',
        bot: { kind: 'bot' },
        expectedBot: { kind: 'bot' },
        pausedAt: expect.any(Number),
      },
      {
        sessionId: 'b',
        bot: { kind: 'bot' },
        expectedBot: { kind: 'bot' },
        pausedAt: expect.any(Number),
      },
    ]);
    expect(
      sent.every(
        (request) =>
          request.actionId === 'session.bot.set' && request.serverId === SERVER,
      ),
    ).toBe(true);

    // The pause arrives as each Bot's pushed row: the banner names it, Pause all steps back.
    await act(async () => {
      seed({
        a: bot('a', { botPausedAt: 7 }),
        b: bot('b', { botPausedAt: 7 }),
        shared: bot('shared', { owner: 'someone-else' }),
      });
    });
    expect(screen.getTextContent()).toContain(
      t('workflows.destination.now.botsPausedTitle', { count: 2, total: 2 }),
    );
    expect(screen.findByTestId('workflow-runs:now:bots-pause-all')).toBeNull();

    sent.length = 0;
    await act(async () => {
      seed({
        a: bot('a', { botPausedAt: 7 }),
        b: bot('b'),
        shared: bot('shared', { owner: 'someone-else' }),
      });
    });
    expect(screen.getTextContent()).toContain(
      t('workflows.destination.now.botsPausedTitle', { count: 1, total: 2 }),
    );
    await screen.pressByTestIdAsync('workflow-runs:now:bots-resume');
    expect(sent.map((request) => request.input)).toEqual([
      {
        sessionId: 'a',
        bot: { kind: 'bot' },
        expectedBot: { kind: 'bot' },
        pausedAt: null,
      },
    ]);
    await screen.unmount();
  } finally {
    storage.setState(before, true);
  }
});

it('draws nothing for a Home without own Bots', async () => {
  const before = storage.getState();
  try {
    seed({ shared: bot('shared', { owner: 'someone-else', botPausedAt: 3 }) });
    const screen = await renderScreen(
      <ListPresentationProvider value="page"><WorkflowRunsNowSections now={NOW} serverId={SERVER} /></ListPresentationProvider>,
    );
    expect(screen.findByTestId('workflow-runs:now:bots-paused')).toBeNull();
    expect(screen.findByTestId('workflow-runs:now:bots-pause-all')).toBeNull();
    await screen.unmount();
  } finally {
    storage.setState(before, true);
  }
});
