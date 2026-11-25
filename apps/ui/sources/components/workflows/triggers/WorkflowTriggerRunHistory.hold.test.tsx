import * as React from 'react';
import { AutomationTriggerIdSchema } from '@happier-dev/protocol/automations/automationTriggerIdentity';
import { t } from '@/text';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import {
  createHomeGovernanceHarness,
  installHomeGovernanceBoundaries,
  waitForHomeGovernance,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';

// Only Home HTTP/credentials and navigation leave the real path.
const routerPush = vi.hoisted(() => vi.fn());
vi.mock('expo-router', async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
  return createExpoRouterMock({
    pathname: () => '/workflows',
    params: () => ({}),
    router: { push: routerPush },
  }).module;
});
const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
installDisconnectedServerSocketBoundary();
beforeAll(loadSyncSingletonForTests);
const { storage } = await import('@/sync/domains/state/storageStore');
const { getActiveServerSnapshot } =
  await import('@/sync/domains/server/serverRuntime');
const {
  getAppliedActiveServerSnapshot,
  isAppliedActiveServerRuntimeAvailable,
  publishAppliedActiveServerSnapshot,
} = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { retireActiveServerAccountScopeLifetime } =
  await import('@/sync/domains/scope/activeServerAccountScope');
const { disconnectActiveServerConnection } =
  await import('@/sync/runtime/orchestration/connectionManager');
const { apiSocket } = await import('@/sync/api/session/apiSocket');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const { resetWorkflowLibraryReadsForTests } =
  await import('../library/workflowLibraryReads');
const { createWorkflowRunRoute } =
  await import('@/sync/domains/workflows/workflowRunRoute');
const { WorkflowTriggerRunHistory } =
  await import('./WorkflowTriggerRunHistory');

const route = '/v3/automations/runs/workflow-storage';
const triggerId = AutomationTriggerIdSchema.parse('hourly-trigger');
let serverId: string;
let previous = storage.getState();
let applied = getAppliedActiveServerSnapshot();
let available = isAppliedActiveServerRuntimeAvailable();

beforeEach(async () => {
  previous = storage.getState();
  applied = getAppliedActiveServerSnapshot();
  available = isAppliedActiveServerRuntimeAvailable();
  await home.reset();
  await disconnectActiveServerConnection();
  apiSocket.disconnect();
  serverId = await home.addHome({
    name: 'Hold Home',
    serverUrl: 'https://trigger-hold.test',
    accountId: 'account-a',
  });
  const target = getActiveServerSnapshot();
  const credentials = await TokenStorage.getCredentialsForServerUrl(
    target.serverUrl,
    { serverId: target.serverId },
  );
  if (!credentials)
    throw new Error(
      'Trigger hold fixture requires its captured Home credentials',
    );
  apiSocket.initialize(
    {
      endpoint: target.serverUrl,
      serverId: target.serverId,
      generation: target.generation,
      token: credentials.token,
      credentials,
    },
    null,
  );
  publishAppliedActiveServerSnapshot(target);
  storage.setState({
    profileScope: { serverId, accountId: 'account-a' },
    workflowRunsById: {},
    workflowRunListWindows: {},
    workflowRunInvocationsByRunId: {},
  });
  home.answer(serverId, '/v3/automations', {
    body: { automations: [], nextCursor: null },
  });
  home.answer(serverId, '/v1/account/encryption/currentness', {
    body: createPlainAccountEncryptionCurrentnessFixture(),
  });
  home.answer(serverId, route, {
    body: { runs: [], acceptedEnvelopesByRunId: {}, keyCensusByRunId: {} },
  });
  routerPush.mockReset();
});
afterEach(async () => {
  await standardCleanup();
  resetWorkflowLibraryReadsForTests();
  retireActiveServerAccountScopeLifetime();
  await disconnectActiveServerConnection();
  apiSocket.disconnect();
  await home.reset();
  storage.setState(previous);
  publishAppliedActiveServerSnapshot(applied, available);
});

it('says a due schedule waits for its interrupted previous run and opens that run', async () => {
  const hold = {
    triggerId,
    reason: 'open_occurrence' as const,
    runId: 'run-held',
    runState: 'interrupted' as const,
  };
  const screen = await renderScreen(
    <WorkflowTriggerRunHistory
      automationId="hourly"
      triggerId={triggerId}
      nextRunAt={Date.now() - 60_000}
      hold={hold}
    />,
  );
  await waitForHomeGovernance(() =>
    expect(screen.getTextContent()).toContain(t('workflows.empty.runsTitle')),
  );
  expect(screen.getTextContent()).toContain(
    t('workflows.triggers.row.heldByInterruptedRun'),
  );
  expect(screen.getTextContent()).not.toContain(
    t('automations.list.nextRunPending'),
  );
  // R11 M8: the reason is never clamped, and Open run may move beneath it on a narrow row.
  const reason = screen.findAll((node) => typeof node.type === 'string'
    && node.props.children === t('workflows.triggers.row.heldByInterruptedRun'));
  expect(reason.length).toBeGreaterThan(0);
  expect(reason.every((node) => !node.props.numberOfLines)).toBe(true);
  await screen.pressByTestIdAsync(
    'session-work-trigger-history:hourly-open-run',
  );
  expect(routerPush).toHaveBeenCalledWith(
    createWorkflowRunRoute(
      { kind: 'occurrence', automationId: 'hourly', runId: 'run-held' },
      serverId,
    ),
  );
});

it('updates the hold copy from the same Run admitted by History after the trigger snapshot', async () => {
  home.answer(serverId, route, {
    body: { runs: [createWorkflowRunSummaryFixture({
      id: 'run-held', ownerAccountId: 'account-a', state: 'interrupted',
      revision: 2, origin: { kind: 'automation', automationId: 'hourly' },
    })], acceptedEnvelopesByRunId: {}, keyCensusByRunId: {} },
  });
  const screen = await renderScreen(
    <WorkflowTriggerRunHistory
      automationId="hourly"
      triggerId={triggerId}
      nextRunAt={Date.now() - 60_000}
      hold={{ triggerId, reason: 'open_occurrence', runId: 'run-held', runState: 'running' }}
    />,
  );
  await waitForHomeGovernance(() =>
    expect(screen.findByTestId('session-work-trigger-history-row:run-held')).not.toBeNull(),
  );
  expect(screen.getTextContent()).toContain(t('workflows.triggers.row.heldByInterruptedRun'));
  expect(screen.getTextContent()).not.toContain(t('workflows.triggers.row.heldByRun'));
});

it('shows a pending occurrence when no Run holds the schedule', async () => {
  const plain = await renderScreen(
    <WorkflowTriggerRunHistory
      automationId="hourly"
      triggerId={triggerId}
      nextRunAt={Date.now() - 60_000}
    />,
  );
  await waitForHomeGovernance(() =>
    expect(plain.getTextContent()).toContain(
      t('automations.list.nextRunPending'),
    ),
  );
  expect(plain.getTextContent()).not.toContain(
    t('workflows.triggers.row.heldByRun'),
  );
  expect(
    plain.findByTestId('session-work-trigger-history:hourly-held'),
  ).toBeNull();
});

// R12 M12: a spent one-time schedule heads its History in the past tense, from the Run History already read.
const onceAt = Date.UTC(2026, 10, 24, 15, 0);
const spentOnce = { kind: 'schedule', schedule: { kind: 'once', scheduledAt: onceAt }, remainingOccurrences: 0, nextRunAt: null } as const;
it.each([
  ['succeeded', 'workflows.triggers.once.ranOn'],
  ['missed', 'workflows.triggers.once.missedOn'],
] as const)('says a spent one-time schedule whose Run %s ended in the past tense', async (state, key) => {
  home.answer(serverId, route, {
    body: { runs: [createWorkflowRunSummaryFixture({
      id: 'run-once', ownerAccountId: 'account-a', state,
      revision: 2, origin: { kind: 'automation', automationId: 'once' },
    })], acceptedEnvelopesByRunId: {}, keyCensusByRunId: {} },
  });
  const { formatOnceScheduleInstant } = await import('./triggerSchedule');
  const screen = await renderScreen(
    <WorkflowTriggerRunHistory automationId="once" triggerId={triggerId} nextRunAt={null} trigger={spentOnce} />,
  );
  await waitForHomeGovernance(() =>
    expect(screen.findByTestId('session-work-trigger-history-row:run-once')).not.toBeNull(),
  );
  expect(screen.getTextContent()).toContain(t(key, { time: formatOnceScheduleInstant(onceAt) }));
  expect(screen.getTextContent()).not.toContain(t('workflows.triggers.once.alreadyRan'));
});

it('states a missed one-time schedule once, then the one instruction, with no outcome sentence on its Run row (R12 M12)', async () => {
  const run = createWorkflowRunSummaryFixture({
    id: 'run-once', ownerAccountId: 'account-a', state: 'missed', errorCode: 'machine_offline',
    revision: 2, origin: { kind: 'automation', automationId: 'once' },
  });
  home.answer(serverId, route, { body: { runs: [run], acceptedEnvelopesByRunId: {}, keyCensusByRunId: {} } });
  const { formatOnceScheduleInstant } = await import('./triggerSchedule');
  const { resolveWorkflowRunProblemPresentation } = await import('../presentation/workflowProblemPresentation');
  const screen = await renderScreen(
    <WorkflowTriggerRunHistory automationId="once" triggerId={triggerId} nextRunAt={null} trigger={spentOnce} />,
  );
  await waitForHomeGovernance(() =>
    expect(screen.findByTestId('session-work-trigger-history-row:run-once')).not.toBeNull(),
  );
  const text = screen.getTextContent();
  const heading = t('workflows.triggers.once.missedOn', { time: formatOnceScheduleInstant(onceAt) });
  const instruction = t('workflows.triggers.once.runAgain');
  expect(text).toContain(heading);
  const cause = t('workflows.triggers.once.missedCauseOffline');
  expect(text.indexOf(cause)).toBeGreaterThan(text.indexOf(heading));
  expect(text.indexOf(instruction)).toBeGreaterThan(text.indexOf(cause));
  expect(text).not.toContain(resolveWorkflowRunProblemPresentation(run)!.message);
  expect(text).not.toContain(t('workflows.readState.historyTitle'));
});

it('says only that a spent one-time schedule already ran while its Run is not read', async () => {
  const screen = await renderScreen(
    <WorkflowTriggerRunHistory automationId="once" triggerId={triggerId} nextRunAt={null} trigger={spentOnce} />,
  );
  await waitForHomeGovernance(() =>
    expect(screen.getTextContent()).toContain(t('workflows.empty.runsTitle')),
  );
  expect(screen.getTextContent()).toContain(t('workflows.triggers.once.alreadyRan'));
  expect(screen.getTextContent()).not.toContain(t('workflows.runState.succeeded'));
});
