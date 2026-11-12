import { afterEach, expect, it, vi } from 'vitest';
vi.mock('socket.io-client', async importOriginal =>
  (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
import * as React from 'react';
import { act } from 'react-test-renderer';
import { ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createMachineFixture, createDeferred, renderHook, renderScreen, findTestInstanceByTypeWithProps, standardCleanup } from '@/dev/testkit';
import { installMachinesSettingsCommonModuleMocks } from '@/components/settings/machines/machinesSettingsTestHelpers';
import { MachineSetupEffectPlanV1Schema } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { answerExternalActionAccountForHome } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { ActionOperationSnapshotV1Schema } from '@happier-dev/protocol/actions/operations/v1';
import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';
import { publishActionOperationObservation } from '@/sync/domains/actionOperations/actionOperationRuntime';

installMachinesSettingsCommonModuleMocks();

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { useMachineUpdates } = await import('./useMachineUpdates');
const { storage } = await import('@/sync/domains/state/storageStore');
const baseline = storage.getState();
afterEach(async () => { standardCleanup(); actionOperationStore.reset(); await homes.reset(); storage.setState(baseline, true); });

it.each(['accepted', 'plan_changed', 'settled'] as const)('uses the first Install decision for the exact Machine plan and shows its %s outcome', async outcome => {
  const { useMachineUpdatesReview } = await import('./useMachineUpdatesReview');
  const { MachineSecurityView } = await import('./MachineSecuritySection');
  const { RoundButton } = await import('@/components/ui/buttons/RoundButton');
  const { Item } = await import('@/components/ui/lists/Item');
  const { SurfaceStateCard } = await import('@/components/ui/surfaces/SurfaceStateCard');
  const homeId = `srv_updates_first_install_${outcome}`;
  const serverId = await homes.addHome({ name: 'Updates first Install', serverUrl: `https://updates-first-${outcome}.test`,
    serverIdentityId: homeId, accountId: 'updates-owner', currentAccount: true });
  const machineId = 'updates-machine';
  const observation = { status: 'drifted' as const, backend: 'apt', pendingAll: 1, pendingSecurity: 1 };
  const plan = MachineSetupEffectPlanV1Schema.parse({ v: 1, basis: { kind: 'updates', machineId, scope: 'all' },
    steps: [{ id: 'os-updates', kind: 'package', manager: 'apt', packages: [{ name: 'openssl', version: '1.2' }] }],
    nativeFacts: [{ stepId: 'os-updates', status: 'drifted', facts: {} }], planDigest: 'b'.repeat(64) });
  homes.answer(serverId, '/v1/actions/machines.setup.plan', { select: async body => {
    const envelope = ExternalActionRequestEnvelopeV1Schema.parse(body);
    return { body: { v: 1, actionId: 'machines.setup.plan', requestId: envelope.requestId, execution: { ok: true,
      result: { desiredRevision: 0, sources: [{ kind: 'direct', setup: {} }], exclusions: [], support: [],
        updates: { observation, plan }, review: { target: { homeId, machineId }, administratorRequired: true, downtime: 'possible' } },
    } } };
  } });
  const nativeInputs: unknown[] = [];
  const receiver = createActionExecutor(createActionExecutorBoundaryFixture({
    // Installed native host boundary: admission and exact-input consent remain in the real receiving executor.
    machineSetupUpdatesApply: async ({ input }) => {
      nativeInputs.push(input);
      return outcome === 'plan_changed' ? { ok: false, errorCode: 'plan_changed', error: 'plan_changed' }
        : { operationId: 'updates-operation' };
    },
  }));
  const boundary = await answerExternalActionAccountForHome(homes, serverId, { machineId, actionId: 'machines.setup.updates.apply', tokenEpoch: 0,
    requesterInvocation: 'optional', failure: result => {
      const failure = ActionExecuteFailureSchema.safeParse(result);
      return failure.success ? failure.data : null;
    }, execute: async (input, transport) => {
      const authorization = transport.authorization;
      if (!authorization) throw new Error('The first Install must use the signed Home admission');
      const result = await receiver.execute('machines.setup.updates.apply', input, {
        surface: transport.invocation?.surface ?? 'ui', authority: transport.invocation?.authority ?? 'present_user',
        actionCaller: transport.invocation?.caller ?? { kind: 'host' },
        serverId, serverIdentityId: homeId, runtimeAccountId: 'updates-owner', actionRequestId: transport.requestId,
        externalActionTarget: transport.target, presentUserConfirmation: transport.invocation?.presentUserConfirmation,
        externalActionExecutionAuthorization: authorization, originalActionEnvelope: transport.envelope,
        signExternalActionApprovalInput: ({ actionId, input: reviewedInput, target, requesterConfirmation, sessionTargetsV1 }) =>
          boundary.signApprovalInput({ authorizationToken: authorization.token, actionId, input: reviewedInput, target,
            ...(requesterConfirmation ? { requesterConfirmation } : {}), ...(sessionTargetsV1 ? { sessionTargetsV1 } : {}) }),
      });
      return result.ok ? result.result : result;
    } });
  storage.getState().applyMachines([createMachineFixture({ id: machineId, daemonState: { status: 'running', setup: {
    version: 1, desiredRevision: 0, status: 'drifted', recipes: [], updates: observation,
  } } })], true, { sourceServerId: serverId });
  const onSettled = vi.fn();
  const hook = await renderHook(() => ({
    updates: useMachineUpdates({ serverId, machineId, reachable: true, enabled: false }),
    review: useMachineUpdatesReview({ serverId, machineId, onSettled }),
  }));
  await act(async () => { await hook.getCurrent().review.prepare('all'); });
  expect(hook.getCurrent().review.review).toMatchObject({ kind: 'review', plan });
  let apply: Promise<void> | undefined;
  await act(async () => { apply = hook.getCurrent().review.apply(); });
  // A second pending Install would leave the first decision without a visible progress/outcome.
  await vi.waitFor(() => expect(hook.getCurrent().review.review.kind).toBe(outcome === 'plan_changed' ? 'failed' : 'installing'));
  await act(async () => { await apply; });
  expect(nativeInputs).toEqual([{ homeId, machineId, scope: 'all', plan }]);
  expect(homes.artifacts(serverId).list()).toEqual([]);
  if (outcome === 'settled') {
    // Existing push ingress and real store subscription settle the accepted operation; no second Action/read/poll.
    await act(async () => publishActionOperationObservation({ serverId, machineId, observation: 'available', snapshots: [
      ActionOperationSnapshotV1Schema.parse({ version: 1, operationId: 'updates-operation', revision: 2,
        actionId: 'machines.setup.updates.apply', scope: { accountId: 'updates-owner', machineId }, title: 'Install updates',
        state: 'succeeded', createdAt: 1, startedAt: 2, settledAt: 3, cancellation: 'supported', result: { operationId: 'updates-operation' } }),
    ] }));
    expect(hook.getCurrent().review.review).toMatchObject({ kind: 'settled', state: 'succeeded', operationId: 'updates-operation' });
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(nativeInputs).toHaveLength(1);
  }
  const { updates, review } = hook.getCurrent();
  const screen = await renderScreen(React.createElement(MachineSecurityView, { updates, machineName: 'shop-prod', online: true,
    controls: { review: review.review, onPrepare: scope => { void review.prepare(scope); }, onApply: () => { void review.apply(); },
      onCancel: review.cancel, reboot: { kind: 'idle' }, canReboot: true, onReboot: () => {}, onDismissReboot: () => {},
      onOpenApproval: () => {}, onOpenOperation: () => {} } }));
  if (outcome === 'accepted') {
    expect(findTestInstanceByTypeWithProps(screen, Item, { testID: 'machine-security-installing-row' })).toBeTruthy();
  } else if (outcome === 'settled') {
    expect(findTestInstanceByTypeWithProps(screen, SurfaceStateCard, { testID: 'machine-security-installed' })?.props.kind).toBe('success');
  } else {
    expect(hook.getCurrent().review.review).toMatchObject({ kind: 'failed', during: 'apply', failure: { errorCode: 'plan_changed' } });
    expect(findTestInstanceByTypeWithProps(screen, SurfaceStateCard, { testID: 'machine-security-review-failed' })).toBeTruthy();
    expect(findTestInstanceByTypeWithProps(screen, RoundButton, { testID: 'machine-security-apply' })).toBeUndefined();
  }
  await screen.unmount();
  await hook.unmount();
});

it('keeps the receiving Plan administrator prerequisite through the Security review and disables Install until a fresh usable Plan', async () => {
  await homes.reset();
  const { useMachineUpdatesReview } = await import('./useMachineUpdatesReview');
  const { MachineSecurityView } = await import('./MachineSecuritySection');
  const { RoundButton } = await import('@/components/ui/buttons/RoundButton');
  const { describeActionExecutionPrerequisite } = await import('@/sync/ops/actions/resolveActionExecutionFailureMessage');
  const serverId = await homes.addHome({ name: 'Updates review', serverUrl: 'https://updates-review.test',
    serverIdentityId: 'srv_updates_review', accountId: 'updates-owner', currentAccount: true });
  const machineId = 'updates-machine';
  const machineRow = { ...createPlainMachineRowFixture({ id: machineId, accountId: 'updates-owner' }), installationId: 'installation-a' };
  homes.answer(serverId, 'POST /v1/machines/read-batch', { select: async body => ({
    body: await createMachineReadBatchResponseFixture(body, () => machineRow).json(),
  }) });
  const observation = { status: 'drifted' as const, backend: 'apt', pendingAll: 1, pendingSecurity: 1 };
  const plan = MachineSetupEffectPlanV1Schema.parse({ v: 1, basis: { kind: 'updates', machineId, scope: 'security' },
    steps: [{ id: 'update', kind: 'package', manager: 'apt', packages: [{ name: 'openssl', version: '1.2' }] }],
    nativeFacts: [{ stepId: 'update', status: 'drifted', facts: {} }], planDigest: '0'.repeat(64) });
  let unavailable = true;
  homes.answer(serverId, '/v1/actions/machines.setup.plan', { select: async body => {
    const envelope = ExternalActionRequestEnvelopeV1Schema.parse(body);
    return { body: { v: 1, actionId: 'machines.setup.plan', requestId: envelope.requestId, execution: { ok: true,
      result: { desiredRevision: 0, sources: [{ kind: 'direct', setup: {} }], exclusions: [], support: [],
        updates: { observation, plan }, review: { target: { homeId: 'srv_updates_review', machineId },
          administratorRequired: true, downtime: 'possible', ...(unavailable ? { administratorUnavailable: { reasonCode: 'mode_none' } } : {}) } },
    } } };
  } });
  storage.getState().applyMachines([createMachineFixture({ id: machineId, daemonState: { status: 'running', setup: {
    version: 1, desiredRevision: 0, status: 'drifted', recipes: [], updates: observation,
  } } })], true, { sourceServerId: serverId });
  const hook = await renderHook(() => ({
    updates: useMachineUpdates({ serverId, machineId, reachable: true, enabled: false }),
    review: useMachineUpdatesReview({ serverId, machineId, onSettled: () => {} }),
  }));
  const showReview = () => {
    const { updates, review } = hook.getCurrent();
    return renderScreen(React.createElement(MachineSecurityView, { updates, machineName: 'shop-prod', online: true,
      controls: { review: review.review, onPrepare: scope => { void review.prepare(scope); }, onApply: () => { void review.apply(); },
        onCancel: review.cancel, reboot: { kind: 'idle' }, canReboot: true, onReboot: () => {}, onDismissReboot: () => {},
        onOpenApproval: () => {}, onOpenOperation: () => {} } }));
  };
  await act(async () => { await hook.getCurrent().review.prepare('security'); });
  const blocked = await showReview();
  expect(findTestInstanceByTypeWithProps(blocked, RoundButton, { testID: 'machine-security-apply' })?.props.disabled).toBe(true);
  expect(blocked.getTextContent()).toContain(describeActionExecutionPrerequisite('mode_none')!.message);
  await act(async () => { findTestInstanceByTypeWithProps(blocked, RoundButton, { testID: 'machine-security-cancel' })?.props.onPress(); });
  expect(hook.getCurrent().review.review.kind).toBe('idle');
  await blocked.unmount();
  unavailable = false;
  await act(async () => { await hook.getCurrent().review.prepare('security'); });
  const ready = await showReview();
  expect(findTestInstanceByTypeWithProps(ready, RoundButton, { testID: 'machine-security-apply' })?.props.disabled).toBe(false);
  await ready.unmount();
  await hook.unmount();
});

it('reads updates on visible demand, joins refreshes, and consumes pushes without starting another read', async () => {
  await homes.reset();
  const serverId = await homes.addHome({ name: 'Updates', serverUrl: 'https://updates.test',
    serverIdentityId: 'srv_updates', accountId: 'updates-owner', currentAccount: true });
  const machineId = 'updates-machine';
  const row = { ...createPlainMachineRowFixture({ id: machineId, accountId: 'updates-owner' }), installationId: 'installation-a' };
  homes.answer(serverId, 'POST /v1/machines/read-batch', { select: async body => ({
    body: await createMachineReadBatchResponseFixture(body, () => row).json(),
  }) });
  const held = createDeferred<unknown>();
  const requests: unknown[] = [];
  const observation = { status: 'drifted' as const, backend: 'apt', pendingAll: 4, pendingSecurity: 2, rebootNeeded: true };
  const result = { desiredRevision: 0, sources: [{ kind: 'direct', setup: {} }], exclusions: [], support: [], updates: { observation } };
  let execution: unknown = held.promise;
  homes.answer(serverId, '/v1/actions/machines.setup.plan', { select: async body => {
    const envelope = ExternalActionRequestEnvelopeV1Schema.parse(body);
    requests.push(envelope.input);
    return { body: { v: 1, actionId: 'machines.setup.plan', requestId: envelope.requestId, execution: await execution } };
  } });
  let machine = createMachineFixture({ id: machineId, daemonState: { status: 'running', setup: {
    version: 1, desiredRevision: 0, status: 'unverifiable', recipes: [], updates: observation,
  } } });
  storage.getState().applyMachines([machine], true, { sourceServerId: serverId });
  const hook = await renderHook((props: { enabled: boolean }) => useMachineUpdates({
    serverId, machineId, reachable: true, ...props,
  }), { initialProps: { enabled: false } });
  expect(requests).toHaveLength(0);
  await hook.rerender({ enabled: true });
  await vi.waitFor(() => expect(requests).toHaveLength(1));
  expect(requests[0]).toEqual({ homeId: 'srv_updates', machineId, mode: 'check', updates: { scope: 'all' } });
  const first = hook.getCurrent().refresh();
  expect(hook.getCurrent().refresh()).toBe(first);
  expect(hook.getCurrent()).toMatchObject({ pendingAll: 4, rebootNeeded: true, refreshing: true });
  machine = { ...machine, daemonStateVersion: machine.daemonStateVersion + 1,
    daemonState: { ...machine.daemonState, setup: { ...machine.daemonState!.setup!,
      updates: { ...observation, pendingAll: 3 } } } };
  await act(async () => storage.getState().applyMachines([machine], false, { sourceServerId: serverId }));
  expect(hook.getCurrent().pendingAll).toBe(3);
  expect(requests).toHaveLength(1);
  held.resolve({ ok: true, result });
  await act(async () => { await first; });
  expect(hook.getCurrent()).toMatchObject({ refreshing: false, read: { kind: 'settled' } });
  execution = { ok: true, result };
  await act(async () => { await hook.getCurrent().refresh(); });
  expect(requests).toHaveLength(2);
  machine = { ...machine, daemonStateVersion: machine.daemonStateVersion + 1,
    daemonState: { ...machine.daemonState, setup: { ...machine.daemonState!.setup!,
      updates: { ...observation, status: 'unavailable', reason: 'required_fact_unavailable' } } } };
  await act(async () => storage.getState().applyMachines([machine], false, { sourceServerId: serverId }));
  expect(hook.getCurrent()).toMatchObject({ status: 'unavailable', pendingAll: 4, rebootNeeded: true,
    stale: true, read: { kind: 'settled' } });
  expect(requests).toHaveLength(2);
  await hook.rerender({ enabled: false });
  await act(async () => { await hook.getCurrent().refresh(); });
  expect(requests).toHaveLength(2);
});
