import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { act, renderHook, standardCleanup } from '@/dev/testkit';
import { createWorkflowDefinitionFixture, createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { workflowRunRowFromSummary } from '@/sync/store/domains/workflowRuns';

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
installDisconnectedServerSocketBoundary();
beforeAll(loadSyncSingletonForTests);
const { storage } = await import('@/sync/domains/state/storageStore');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { createWorkflowDefinition } = await import('@/sync/domains/workflows/workflowDefinitionActions');
const { useApprovalAutomaticCheckDetails } = await import('./useApprovalAutomaticCheckDetails');
const workflowId = '00000000-0000-4000-8000-000000000081';
const runId = '00000000-0000-4000-8000-000000000082';
const accountId = 'approval-account';
let serverId: string;
let previous = storage.getState();
let applied = getAppliedActiveServerSnapshot();
let available = isAppliedActiveServerRuntimeAvailable();

beforeEach(async () => {
  previous = storage.getState();
  applied = getAppliedActiveServerSnapshot();
  available = isAppliedActiveServerRuntimeAvailable();
  await home.reset();
  serverId = await home.addHome({ name: 'Approval Home', serverUrl: 'https://approval-details.test', accountId });
  publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
  storage.setState({ profileScope: { serverId, accountId } });
  home.answer(serverId, '/v3/automations', { body: { automations: [], nextCursor: null } });
  home.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
});

afterEach(async () => {
  await standardCleanup();
  retireActiveServerAccountScopeLifetime();
  await home.reset();
  storage.setState(previous);
  publishAppliedActiveServerSnapshot(applied, available);
});

it('names a skipped Workflow once when several of its checks share a reason', async () => {
  const { Alert } = await import('react-native');
  const { presentActionAutomationSkipNotice } = await import('@/sync/ops/actions/actionAutomationSkipNotice');
  const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
  const { t } = await import('@/text');
  await createWorkflowDefinition({ definitionId: workflowId,
    definition: createWorkflowDefinitionFixture({ blocks: [{ kind: 'wait', id: 'check-step',
      document: { text: 'Check', references: [], attachments: [] } }] }),
    metadata: { title: 'Review deployment' } });
  const notice = { code: 'action_automation_skipped', reason: 'machineRequired',
    automationId: 'check', workflowId } as const;
  const alert = vi.spyOn(Alert, 'alert').mockImplementation(() => {});
  try {
    const result = { automationNotices: ['first', 'second'].map(triggerId => ({ ...notice, triggerId })) };
    const lifetime = captureActiveServerAccountScopeLifetime();
    expect(lifetime?.scope).toEqual({ serverId, accountId });
    const beforeNotice = home.requests.length;
    await presentActionAutomationSkipNotice(result, lifetime);
    const requests = home.requests.slice(beforeNotice);
    expect(requests.filter(request => request.path === '/v1/artifacts/read').map(request => request.input),
      JSON.stringify(requests.map(({ path, method }) => ({ path, method }))))
      .toEqual([{ artifactIds: [workflowId], projection: 'headers' }]);
    expect(alert.mock.calls.map(([, message]) => message))
      .toEqual([t('workflows.triggers.checks.skippedNeedsMachine', { workflow: 'Review deployment' })]);
  } finally {
    alert.mockRestore();
  }
});

describe('approval check detail demand', () => {
  it('opens reviewed steps only on demand and shares the exact Run timestamps through pushed settlement', async () => {
    const definition = createWorkflowDefinitionFixture({ blocks: [{ kind: 'wait', id: 'reviewed-step',
      document: { text: 'Review this step', references: [], attachments: [] } }] });
    await createWorkflowDefinition({ definitionId: workflowId, definition, metadata: { title: 'Reviewed workflow' } });
    const scope = { serverId, accountId };
    const summary = createWorkflowRunSummaryFixture({ id: runId, ownerAccountId: accountId,
      stepProgress: { completed: 1, total: 3 } });
    storage.getState().upsertWorkflowRuns([workflowRunRowFromSummary(summary)], scope);
    const focusedHome = await home.addHome({ name: 'Focused Home', serverUrl: 'https://focused-details.test', accountId: 'focused-account' });
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    storage.setState({ profileScope: { serverId: focusedHome, accountId: 'focused-account' } });
    const readsBefore = home.requests.length;
    const runIds = [runId];
    const hook = await renderHook((props: { reviewWorkflowId: string | null }) => useApprovalAutomaticCheckDetails({
      runIds, serverId, reviewWorkflowId: props.reviewWorkflowId,
    }), { initialProps: { reviewWorkflowId: null as string | null } });
    await waitForHomeGovernance(() => expect(hook.getCurrent().progress).not.toBeNull());
    expect(home.requests.length).toBe(readsBefore);
    expect(hook.getCurrent().summaries.get(runId)).toEqual(summary);
    expect(hook.getCurrent().review.status).toBe('idle');
    await hook.rerender({ reviewWorkflowId: workflowId });
    await waitForHomeGovernance(() => expect(hook.getCurrent().review.definition).toEqual(definition));
    const readsAfterOpen = home.requests.length;
    expect(readsAfterOpen).toBeGreaterThan(readsBefore);
    expect(home.requests.slice(readsBefore).every(request => request.serverId === serverId)).toBe(true);
    await hook.rerender({ reviewWorkflowId: workflowId });
    expect(home.requests.length).toBe(readsAfterOpen);
    await hook.rerender({ reviewWorkflowId: null });
    const finished = { ...summary, state: 'failed' as const, revision: summary.revision + 1,
      finishedAt: '2026-09-08T10:01:04.000Z', updatedAt: '2026-09-08T10:01:04.000Z' };
    await act(async () => storage.getState().upsertWorkflowRuns([workflowRunRowFromSummary(finished)], scope));
    expect(hook.getCurrent().summaries.get(runId)).toEqual(finished);
    expect(hook.getCurrent().progress).toBeNull();
    expect(hook.getCurrent().review.status).toBe('idle');
    expect(home.requests.length).toBe(readsAfterOpen);
  });
});

// R11 M3: a check Run still queued is held, not progressing; only a running Run shows motion.
describe('checking block status truth', () => {
  it('shows a held glyph instead of a spinner while the check Run is queued', async () => {
    const { renderScreen } = await import('@/dev/testkit');
    const { ApprovalAutomaticChecksV1Schema } = await import('@happier-dev/protocol/approvals/approvalAutomaticChecks');
    const { AutomationTriggerIdSchema } = await import('@happier-dev/protocol/automations/automationTriggerIdentity');
    const { ApprovalAutomaticChecks } = await import('./ApprovalAutomaticChecks');
    const scope = { serverId, accountId };
    const queued = createWorkflowRunSummaryFixture({ id: runId, ownerAccountId: accountId, state: 'queued' });
    storage.getState().upsertWorkflowRuns([workflowRunRowFromSummary(queued)], scope);
    const ref = { automationId: 'automation-check', triggerId: AutomationTriggerIdSchema.parse('trigger-check') };
    const checks = ApprovalAutomaticChecksV1Schema.parse({ phase: 'checking', humanApprovalRequired: false, subjects: [],
      selectionStatus: 'ready', notices: [], consents: [], results: [], runs: [{ ...ref, runId }],
      selected: [{ ...ref, phase: 'before', actionIds: ['machines.command.run'], mode: 'wait', onFailure: 'ask',
        triggerRevision: 1, workflowId, workflowRevision: 1, ownerAccountId: accountId }] });
    const screen = await renderScreen(<ApprovalAutomaticChecks checks={checks} actionTitle="Deploy" serverId={serverId}
      testID="checks" />);
    await waitForHomeGovernance(() => expect(screen.findByTestId('checks:queued-glyph')).not.toBeNull());
    const running = { ...queued, state: 'running' as const, revision: queued.revision + 1 };
    await act(async () => storage.getState().upsertWorkflowRuns([workflowRunRowFromSummary(running)], scope));
    expect(screen.findByTestId('checks:queued-glyph')).toBeNull();
    await screen.unmount();
  });
});
