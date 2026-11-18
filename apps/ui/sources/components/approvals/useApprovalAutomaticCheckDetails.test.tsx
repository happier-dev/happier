import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

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
    const hook = await renderHook((props: { reviewWorkflowId: string | null }) => useApprovalAutomaticCheckDetails({
      runId, serverId, reviewWorkflowId: props.reviewWorkflowId,
    }), { initialProps: { reviewWorkflowId: null } });
    await waitForHomeGovernance(() => expect(hook.getCurrent().progress).not.toBeNull());
    expect(home.requests.length).toBe(readsBefore);
    expect(hook.getCurrent().runSummary).toEqual(summary);
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
    expect(hook.getCurrent().runSummary).toEqual(finished);
    expect(hook.getCurrent().progress).toBeNull();
    expect(hook.getCurrent().review.status).toBe('idle');
    expect(home.requests.length).toBe(readsAfterOpen);
  });
});
