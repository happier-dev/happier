import * as React from 'react';
import { act, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('socket.io-client', async importOriginal =>
  (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { AUTOMATION_ACTION_INDEX_HTTP_PATH_V1, createActionAutomationHttpPortV1 } from '@happier-dev/protocol/actions/executor/actionAutomationAdmission';
import { ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { ActionOperationSnapshotV1Schema } from '@happier-dev/protocol/actions/operations/v1';
import { MachineSetupEffectPlanV1Schema } from '@happier-dev/protocol/machines/setup/machineRecipeV1';

import {
  createMachineFixture,
  findTestInstanceByTypeWithProps,
  renderScreen,
  standardCleanup,
} from '@/dev/testkit';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { answerExternalActionAccountForHome } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installMachinesSettingsCommonModuleMocks } from '@/components/settings/machines/machinesSettingsTestHelpers';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { t } from '@/text';

installMachinesSettingsCommonModuleMocks();
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { actionOperationStore } = await import('@/sync/domains/actionOperations/actionOperationStore');
const { publishActionOperationObservation } = await import('@/sync/domains/actionOperations/actionOperationRuntime');
const { resolveServerCredentialAccountScope } = await import('@/sync/domains/scope/serverCredentialAccountScope');
const { storage } = await import('@/sync/domains/state/storageStore');
const { SurfaceStateCard } = await import('@/components/ui/surfaces/SurfaceStateCard');
const { MachineFleetUpdatesView } = await import('./MachineFleetUpdatesView');
const baseline = storage.getState();
afterEach(async () => {
  standardCleanup();
  actionOperationStore.reset();
  await homes.reset();
  storage.setState(baseline, true);
});

it.each(['run now', 'run after an additional review', 'save for later'] as const)('settles a fleet rollout when choosing %s', async (choice) => {
  const target = choice === 'save for later' ? 'save' : choice === 'run now' ? 'run' : 'review';
  const homeId = `srv_fleet_update_${target}`;
  const accountId = `fleet-${target}-owner`;
  const machineId = 'fleet-machine';
  const operationId = 'fleet-update-operation';
  const actionId = 'machines.setup.updates.rollout';
  const serverId = await homes.addHome({
    name: 'Fleet update', serverUrl: `https://fleet-updates-${target}.test`,
    serverIdentityId: homeId, accountId, currentAccount: true,
  });
  expect(await resolveServerCredentialAccountScope(serverId)).toMatchObject({ kind: 'bound' });
  const observation = { status: 'drifted', backend: 'apt', pendingAll: 1, pendingSecurity: 1 };
  const plan = MachineSetupEffectPlanV1Schema.parse({
    v: 1, basis: { kind: 'updates', machineId, scope: 'security' },
    steps: [{ id: 'update', kind: 'package', manager: 'apt', packages: [{ name: 'openssl', version: '1.2' }] }],
    nativeFacts: [{ stepId: 'update', status: 'drifted', facts: {} }], planDigest: 'b'.repeat(64),
  });
  const admittedRollout = vi.fn(async () => ({ operationId }));
  homes.answer(serverId, '/v1/actions/machines.setup.plan', { select: async body => {
    const envelope = ExternalActionRequestEnvelopeV1Schema.parse(body);
    return { body: { v: 1, actionId: 'machines.setup.plan', requestId: envelope.requestId, execution: {
      ok: true,
      result: { desiredRevision: 0, sources: [{ kind: 'direct', setup: {} }], exclusions: [], support: [],
        updates: { observation, plan }, review: { target: { homeId, machineId }, administratorRequired: true, downtime: 'possible' } },
    } } };
  } });
  const receiver = createActionExecutor(createActionExecutorBoundaryFixture({
    actionAutomations: createActionAutomationHttpPortV1({
      accountId,
      async request(path, { method }) {
        expect([method, path]).toEqual(['GET', AUTOMATION_ACTION_INDEX_HTTP_PATH_V1]);
        return { v: 1, rows: [] };
      },
    }),
    machineSetupUpdatesRollout: admittedRollout,
  }));
  const boundary = await answerExternalActionAccountForHome(homes, serverId, {
    machineId, actionId, tokenEpoch: 0, requesterInvocation: 'optional',
    failure: result => {
      const failure = ActionExecuteFailureSchema.safeParse(result);
      return failure.success ? failure.data : null;
    },
    execute: async (input, transport) => {
      const authorization = transport.authorization;
      if (!authorization) throw new Error('Rollout must use the signed Home admission');
      const result = await receiver.execute(actionId, input, {
        surface: transport.invocation?.surface ?? 'ui', authority: transport.invocation?.authority ?? 'present_user',
        actionCaller: transport.invocation?.caller ?? { kind: 'host' },
        serverId, serverIdentityId: homeId, runtimeAccountId: accountId, actionRequestId: transport.requestId,
        externalActionTarget: transport.target,
        // Model a receiving Machine that requires its own review before admitting the update.
        presentUserConfirmation: choice !== 'run after an additional review' || transport.invocation?.presentUserConfirmation?.reviewDigest
          ? transport.invocation?.presentUserConfirmation : undefined,
        externalActionExecutionAuthorization: authorization, originalActionEnvelope: transport.envelope,
        signExternalActionApprovalInput: ({ actionId, input: reviewedInput, target, requesterConfirmation, sessionTargetsV1 }) =>
          boundary.signApprovalInput({ authorizationToken: authorization.token, actionId, input: reviewedInput, target,
            ...(requesterConfirmation ? { requesterConfirmation } : {}), ...(sessionTargetsV1 ? { sessionTargetsV1 } : {}) }),
      });
      return result.ok ? result.result : result;
    },
  });
  const refuseSave = vi.fn(() => ({ status: 409, body: { error: 'conflict' } }));
  if (choice === 'save for later') homes.answer(serverId, 'POST /v1/artifacts', { select: refuseSave });
  storage.getState().applyMachines([machine(machineId, true, observation)], true, { sourceServerId: serverId });
  const screen = await renderScreen(<MachineFleetUpdatesView />);
  let rolloutPresses = 0;
  const press = async (testID: string) => {
    const button = screen.root.findAll(node => node.props.testID === testID && typeof node.props.onPress === 'function')[0]!;
    await act(async () => button.props.onPress());
    if (testID === 'machines.updates.start') rolloutPresses += 1;
  };
  const progress = () => findTestInstanceByTypeWithProps(screen, SurfaceStateCard, { testID: 'machines.updates.progress' })?.props;
  const failed = () => findTestInstanceByTypeWithProps(screen, SurfaceStateCard, { testID: 'machines.updates.failed' })?.props;
  try {
    await press('machines.updates.review');
    await press('machines.updates.prepare');
    await vi.waitFor(() => expect(screen.findByTestId('machines.updates.start'), String(failed()?.diagnosticCode)).toBeTruthy());
    if (choice === 'save for later') {
      const when = screen.root.findAll(node => node.props.testID === 'machines.updates.when' && typeof node.props.onChange === 'function')[0]!;
      await act(async () => when.props.onChange('later'));
      await press('machines.updates.start');
      await vi.waitFor(() => expect(refuseSave).toHaveBeenCalled());
      await vi.waitFor(() => expect(failed()).toMatchObject({
        kind: 'error',
        diagnosticCode: 'currentness_conflict',
        title: t('workflows.problem.conflict'),
      }));
      return;
    }
    await press('machines.updates.start');
    if (choice === 'run after an additional review') {
      await vi.waitFor(() => expect(screen.findByTestId('machines.updates.confirmation')).toBeTruthy());
      expect(admittedRollout).not.toHaveBeenCalled();
      await press('machines.updates.start');
    }
    await vi.waitFor(() => expect(admittedRollout).toHaveBeenCalledTimes(1));
    expect(rolloutPresses).toBe(choice === 'run now' ? 1 : 2);
    await vi.waitFor(() => expect(progress()).toMatchObject({ kind: 'loading' }));
    await act(async () => publishActionOperationObservation({ serverId: getActiveServerSnapshot().serverId, machineId, observation: 'available', snapshots: [
      ActionOperationSnapshotV1Schema.parse({ version: 1, operationId, revision: 2, actionId,
        scope: { accountId, machineId }, title: 'Roll out updates', state: 'failed',
        error: { errorCode: 'machine_offline', error: 'machine_offline' },
        createdAt: 1, startedAt: 2, settledAt: 3, cancellation: 'supported' }),
    ] }));
    await vi.waitFor(() => expect(progress()?.kind).toBe('error'));
    expect(progress()).toMatchObject({
      diagnosticCode: 'machine_offline',
      title: t('errors.machineNotAnswering'),
    });
  } finally {
    await screen.unmount();
  }
});

const machine = (id: string, online: boolean, updates: object) =>
  createMachineFixture({
    id,
    active: online,
    activeAt: online ? Date.now() : 1,
    daemonState: {
      status: 'running',
      setup: {
        version: 1,
        desiredRevision: 0,
        status: 'drifted',
        recipes: [],
        updates,
      },
    },
  });

function textOf(node: ReactTestInstance | null | undefined): string {
  if (!node) return '';
  return node.children
    .map((child) => (typeof child === 'string' ? child : textOf(child)))
    .join(' ');
}

it('heads the table with the fleet in one count line and offers the rollout only where updates of that kind wait', async () => {
  const serverId = getActiveServerSnapshot().serverId;
  storage.getState().applyMachines(
    [
      machine('hetzner', true, {
        status: 'drifted',
        backend: 'apt',
        pendingSecurity: 3,
        pendingAll: 7,
        rebootNeeded: false,
      }),
      machine('vps', true, {
        status: 'drifted',
        backend: 'apt',
        pendingSecurity: 0,
        pendingAll: 2,
        rebootNeeded: true,
      }),
      machine('build', false, {
        status: 'drifted',
        backend: 'apt',
        pendingSecurity: 4,
        pendingAll: 9,
      }),
    ],
    true,
    { sourceServerId: serverId },
  );
  const screen = await renderScreen(<MachineFleetUpdatesView />);
  const byTestID = (testID: string) =>
    screen.root.findAll(
      (node) =>
        node.props.testID === testID && typeof node.props.title === 'string',
    )[0];
  const pressable = (testID: string) =>
    screen.root.findAll(
      (node) =>
        node.props.testID === testID &&
        typeof node.props.onPress === 'function',
    )[0]!;

  // The page's count line says the fleet once, under its purpose.
  expect(
    textOf(screen.findByTestId('machines.updates.header:count')),
  ).toContain(t('machineFleetUpdates.statusPartial', { count: 2, checked: 2, total: 3 }));

  await act(async () => {
    pressable('machines.updates.review').props.onPress();
  });
  // Security only reaches hetzner; build is offline and is named as skipped, not counted.
  expect(byTestID('machines.updates.prepare')?.props.title).toBe(
    t('machineFleetUpdates.prepare', { count: 1 }),
  );
  expect(byTestID('machines.updates.scope')?.props.subtitle).toContain(
    t('machineFleetUpdates.skippedOffline', { names: 'build' }).split(': ')[0]!,
  );
  await act(async () => {
    byTestID('machines.updates.scope')!.props.onChange('all');
  });
  expect(byTestID('machines.updates.prepare')?.props.title).toBe(
    t('machineFleetUpdates.prepare', { count: 2 }),
  );
});
