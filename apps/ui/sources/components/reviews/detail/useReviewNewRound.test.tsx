import * as React from 'react';
import { Pressable, Text } from 'react-native';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { ExecutionRunGetRequestSchema, ExecutionRunGetResponseSchema, ExecutionRunPublicStateSchema, type ExecutionRunPublicState } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { REVIEW_ARTIFACT_KIND_V1, type ReviewArtifactV1 } from '@happier-dev/protocol/reviews/reviewArtifactV1';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { act, flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createProviderSettingsAccountHarness } from '@/dev/testkit/harness/providerSettingsHarness';
import { installSessionActionRpcBoundary } from '@/dev/testkit/harness/sessionActionRpcBoundary';
import { answerExternalActionAccountForHome } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { EXECUTION_RUN_CAPABILITIES_DESCRIBE_FIXTURE } from '@/dev/testkit/fixtures/executionRunCapabilitiesDescribe';
import { notifyExecutionRunActivity } from '@/sync/runtime/executionRuns/executionRunActivityBus';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { ModalProvider } from '@/modal';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ renderCustomModals: true }).module);

const machines = [createMachineFixture({ id: 'selected-machine', activeAt: Date.now() })];
const account = createProviderSettingsAccountHarness();
let run: ExecutionRunPublicState | null = null;
let headerReads = 0;
const rpcRequests = installSessionActionRpcBoundary(request => {
  if (request.method === `selected-machine:${RPC_METHODS.CAPABILITIES_DESCRIBE}`) return EXECUTION_RUN_CAPABILITIES_DESCRIBE_FIXTURE;
  if (request.method === `selected-machine:${SESSION_RPC_METHODS.EXECUTION_RUN_GET}`) {
    const input = ExecutionRunGetRequestSchema.parse(request.params);
    expect(input.runId).toBe('retained-run');
    headerReads++;
    return ExecutionRunGetResponseSchema.parse({ run });
  }
  throw new Error(`Unexpected daemon RPC: ${request.method}`);
});
const { useReviewNewRound } = await import('./useReviewNewRound');
let disposeExecutor: (() => void) | undefined;
beforeAll(async () => { disposeExecutor = await installRealActionExecutorModuleLoader(); });
afterAll(() => disposeExecutor?.());
afterEach(async () => { await standardCleanup(); await account.reset(); rpcRequests.length = 0; headerReads = 0; run = null; });

const review: ReviewArtifactV1 = { kind: REVIEW_ARTIFACT_KIND_V1, v: 1, reviewId: 'retained-review', title: 'Review', rounds: [{
  ordinal: 1, state: 'completed', startedAt: 1, finishedAt: 2, reviewerIds: ['step-1-reviewer-1'],
  runs: [{ kind: 'execution', machineId: 'selected-machine', runId: 'retained-run' }],
}] };
const people: readonly never[] = [];
function Harness({ scope }: Readonly<{ scope: ServerAccountScope }>) {
  const round = useReviewNewRound({ scope, record: review, canEdit: true, people });
  return <ModalProvider><Pressable testID="open-new-round" accessibilityRole="button"
    accessibilityState={{ disabled: !round.available }} disabled={!round.available} onPress={round.open}>
    <Text>New round</Text></Pressable></ModalProvider>;
}

it.each([false, true])('opens the actual native New round with exact inventory and fresh consent (paid=%s)', async paid => {
  await account.restore({ machines, currentAccount: true, serverIdentityId: 'srv_new_round',
    settings: { experiments: true, featureToggles: { 'execution.runs': true } } });
  const { storage } = await import('@/sync/domains/state/storage');
  const scope = storage.getState().profileScope;
  if (!scope) throw new Error('Expected the mounted Account scope');
  run = ExecutionRunPublicStateSchema.parse({ runId: 'retained-run', callId: 'call', sidechainId: 'sidechain',
    intent: 'review', backendTarget: { kind: 'builtInAgent', agentId: paid ? 'claude' : 'opencode' },
    ...(paid ? { profileId: 'paid-profile', profileSourceCustody: { kind: 'development', registeredRootId: 'selected-root' } } : {}),
    permissionMode: 'read_only', retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response',
    status: 'succeeded', startedAtMs: 1, finishedAtMs: 2 });
  const inventoryInputs: unknown[] = [];
  await answerExternalActionAccountForHome(account.home, scope.serverId, {
    machineId: 'selected-machine', actionId: 'review.engines.list', tokenEpoch: 0, requesterInvocation: 'none',
    execute(input, context) {
      inventoryInputs.push(input);
      expect(context.target.machineId).toBe('selected-machine');
      expect(input).toMatchObject({ sessionId: null, machineId: 'selected-machine',
        ...(paid ? { profileSelections: [{ engineId: 'claude', profileId: 'paid-profile',
          profileSourceCustody: { kind: 'development', registeredRootId: 'selected-root' } }] } : {}) });
      if (paid && inventoryInputs.length === 1) throw Object.assign(new Error('Catalog unavailable'), { code: 'target_unavailable' });
      const item = { engineId: paid ? 'claude' : 'opencode', value: paid ? 'claude' : 'opencode',
        label: paid ? 'Paid reviewer' : 'OpenCode', enabled: true, capabilities: { structuredNarration: false },
        ...(paid ? { profileId: 'paid-profile', costConsent: { optionKey: 'acceptCharge', title: 'Approve paid review' } } : {}) };
      return { items: paid ? [] : [item], ...(paid ? { selectionItems: [item] } : {}) };
    },
  });
  const launches: unknown[] = [];
  await answerExternalActionAccountForHome(account.home, scope.serverId, {
    machineId: 'selected-machine', actionId: 'execution.run.action', tokenEpoch: 0,
    execute(input) {
      launches.push(getActionSpec('execution.run.action').inputSchema.parse(input));
      return { ok: true, result: { runId: 'next-run', callId: 'next-call', sidechainId: 'next-sidechain',
        reviewRound: { reviewId: review.reviewId, roundOrdinal: 2 } } };
    },
  });
  const screen = await renderScreen(<Harness scope={scope} />);
  await vi.waitFor(() => expect(screen.findHostByTestId('open-new-round')?.props.disabled).toBe(false));
  await screen.pressByTestIdAsync('open-new-round');
  await vi.waitFor(() => expect(headerReads).toBeGreaterThan(0));
  await vi.waitFor(() => expect(inventoryInputs).toHaveLength(1));
  if (paid) {
    await vi.waitFor(() => expect(screen.findByTestId('review-new-round:retry')).not.toBeNull());
    await screen.pressByTestIdAsync('review-new-round:retry');
    await vi.waitFor(() => expect(screen.findByTestId('review-start-cost-consent')).not.toBeNull());
    expect(screen.findHostByTestId('review-new-round:start')?.props.accessibilityState?.disabled).toBe(true);
  } else await vi.waitFor(() => expect(screen.findHostByTestId('review-new-round:start')?.props.accessibilityState?.disabled).toBe(false));
  expect(inventoryInputs).toHaveLength(paid ? 2 : 1);
  run = ExecutionRunPublicStateSchema.parse({ ...run, finishedAtMs: 3 });
  const before = headerReads;
  const runId = run.runId;
  await act(async () => notifyExecutionRunActivity({ serverId: scope.serverId, machineId: 'selected-machine' }, { runId }));
  await vi.waitFor(() => expect(headerReads).toBeGreaterThan(before));
  await flushHookEffects();
  expect(inventoryInputs).toHaveLength(paid ? 2 : 1);
  if (paid) await screen.pressByTestIdAsync('review-start-cost-consent');
  await screen.pressByTestIdAsync('review-new-round:start');
  await vi.waitFor(() => expect(launches).toHaveLength(1));
  expect(launches[0]).toMatchObject({ sessionId: null, runId: 'retained-run', actionId: 'review.new_round',
    input: paid ? { costConsent: true } : {} });
  if (paid) {
    await screen.pressByTestIdAsync('open-new-round');
    await vi.waitFor(() => expect(screen.findByTestId('review-start-cost-consent')).not.toBeNull());
    expect(screen.findHostByTestId('review-start-cost-consent')?.props.accessibilityState?.checked).toBe(false);
  }
  await screen.unmount();
});
