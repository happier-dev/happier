import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import {
  createHomeGovernanceHarness,
  installHomeGovernanceBoundaries,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { act } from 'react-test-renderer';
import { flushHookEffects, renderScreen } from '@/dev/testkit';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';

// The managed Home's HTTP answers are the external boundary; the operation store, naming owner and modal are real.
installApprovalCommonModuleMocks();
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { ActionOperationDetailModal } =
  await import('./ActionOperationDetailModal');
const { ActionOperationLedger } = await import('./ActionOperationLedger');
const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
const { actionOperationStore } =
  await import('@/sync/domains/actionOperations/actionOperationStore');
const { storage } = await import('@/sync/domains/state/storage');

const CONTROLLER = 'controller-machine';
const GUEST = 'enrolled-guest';

async function seedManagedPowerOperation(
  snapshot: Partial<ActionOperationSnapshotV1>,
) {
  const home = await harness.addHome({
    name: 'Operation Home',
    serverUrl: 'https://managed-operation.test',
    accountId: 'account',
    serverIdentityId: 'srv_operation',
  });
  const machine = ManagedMachineV1Schema.parse({
    id: 'managed-guest',
    homeId: 'srv_operation',
    custodianAccountId: 'account',
    controller: { machineId: CONTROLLER, installationId: 'installed' },
    launch: {
      provider: { pluginId: 'fixture.compute', localId: 'vm' },
      schemaVersion: 1,
      name: 'Studio guest',
      choices: {},
    },
    enrolledMachineId: GUEST,
    allocation: 'bound',
    creationState: 'active',
    desired: 'start',
    desiredWhen: 'now',
    resource: {
      contributionRef: { pluginId: 'fixture.compute', localId: 'vm' },
      schemaVersion: 1,
      value: {},
    },
    intentRevision: 2,
    retention: { kind: 'until-delete' },
    wakeOnAcceptedMessage: true,
  });
  harness.answer(home, 'POST /v1/machines/managed/actions/get', {
    body: machine,
  });
  storage.setState({
    machineListByServerId: {
      [home]: [
        createMachineFixture({
          id: CONTROLLER,
          metadata: {
            ...createMachineFixture().metadata!,
            displayName: 'NLDW3-5-36-33',
            host: 'controller-host',
          },
        }),
        createMachineFixture({
          id: GUEST,
          metadata: {
            ...createMachineFixture().metadata!,
            displayName: 'lima-happier-studio',
            host: 'studio-host',
          },
        }),
      ],
    },
  });
  actionOperationStore.mergeSnapshots({
    serverId: home,
    snapshots: [
      {
        version: 1,
        operationId: 'power-operation',
        revision: 3,
        actionId: 'machines.managed.power.set',
        state: 'running',
        scope: { accountId: 'account', machineId: CONTROLLER },
        title: 'Change machine power',
        createdAt: 1_000,
        startedAt: 1_100,
        domainRef: { kind: 'managedMachine', id: machine.id },
        cancellation: 'unsupported',
        ...snapshot,
      },
    ],
  });
  return { home, machine };
}

describe('Action details for a managed power operation', () => {
  beforeEach(async () => {
    standardCleanup();
    await harness.reset();
    actionOperationStore.reset();
  });
  afterEach(() => {
    standardCleanup();
    actionOperationStore.reset();
  });

  it('shares one demanded managed-resource read across operation rows, details and a Home refresh', async () => {
    const { home, machine } = await seedManagedPowerOperation({});
    const prototype = actionOperationStore.getSnapshot();
    const { actionOperationSelectors } = await import('@/sync/domains/actionOperations/actionOperationSelectors');
    const snapshot = actionOperationSelectors.selectAll(prototype)[0]!.snapshot;
    actionOperationStore.mergeSnapshots({ serverId: home, snapshots: [
      { ...snapshot, operationId: 'power-second' }, { ...snapshot, operationId: 'power-third' },
    ] });
    const readCount = () => harness.requests.filter(request => request.path === '/v1/machines/managed/actions/get').length;
    const detail = <ActionOperationDetailModal key="detail" serverId={home} operationId="power-operation" onClose={vi.fn()} setChrome={vi.fn()} />;
    const ledger = <ActionOperationLedger key="ledger" />;
    const screen = await renderScreen(<>{ledger}</>);
    await flushHookEffects({ cycles: 25 });
    expect(screen.getTextContent()).toContain('lima-happier-studio');
    expect(readCount()).toBe(1);
    // A later detail demand joins the settled inventory; removing the original
    // rows does not retire the detail's shared read or its next refresh.
    await screen.update(<>{ledger}{detail}</>);
    await flushHookEffects({ cycles: 25 });
    expect(readCount()).toBe(1);
    await screen.update(<>{detail}</>);
    await flushHookEffects({ cycles: 25 });
    expect(readCount()).toBe(1);
    harness.answer(home, 'POST /v1/machines/managed/actions/get', {
      body: { ...machine, enrolledMachineId: undefined, intentRevision: 3,
        launch: { ...machine.launch, name: 'Renamed managed guest' } },
    });
    await act(async () => publishHomeAccountChange(home));
    // Observe the consumer after the complete Action/transport refresh, rather
    // than assuming a fixed microtask count reaches the HTTP boundary.
    await vi.waitFor(async () => {
      await flushHookEffects();
      expect(screen.getTextContent()).toContain('Renamed managed guest');
    });
    expect(screen.getTextContent()).not.toContain('lima-happier-studio');
    expect(readCount()).toBe(2);
    await screen.unmount();
    await act(async () => publishHomeAccountChange(home));
    await flushHookEffects({ cycles: 25 });
    expect(readCount()).toBe(2);
  });

  it('names the managed guest rather than the controller it runs on', async () => {
    const { home } = await seedManagedPowerOperation({});
    const screen = await renderScreen(
      <ActionOperationDetailModal
        serverId={home}
        operationId="power-operation"
        onClose={vi.fn()}
        setChrome={vi.fn()}
      />,
    );
    await flushHookEffects({ cycles: 25 });
    expect(screen.getTextContent()).toContain('lima-happier-studio');
    expect(screen.getTextContent()).not.toContain('NLDW3-5-36-33');
    expect(screen.getTextContent()).not.toContain(CONTROLLER);
    await screen.unmount();
  });

  it('reads an unconfirmed outcome as neither running nor failed, and keeps a failure as failed', async () => {
    const { home } = await seedManagedPowerOperation({
      observation: {
        kind: 'outcome_uncertain',
        code: 'action_outcome_unknown',
      },
    });
    const uncertain = await renderScreen(
      <ActionOperationDetailModal
        serverId={home}
        operationId="power-operation"
        onClose={vi.fn()}
        setChrome={vi.fn()}
      />,
    );
    await flushHookEffects({ cycles: 25 });
    expect(uncertain.getTextContent()).toContain(
      'inbox.actionOperations.status.outcomeUncertain',
    );
    expect(uncertain.getTextContent()).not.toContain(
      'inbox.actionOperations.status.failed',
    );
    expect(uncertain.getTextContent()).not.toContain(
      'inbox.actionOperations.status.succeeded',
    );
    await uncertain.unmount();

    actionOperationStore.mergeSnapshots({
      serverId: home,
      snapshots: [
        {
          version: 1,
          operationId: 'power-failed',
          revision: 3,
          actionId: 'machines.managed.power.set',
          state: 'failed',
          scope: { accountId: 'account', machineId: CONTROLLER },
          title: 'Change machine power',
          createdAt: 1_000,
          startedAt: 1_100,
          settledAt: 2_000,
          domainRef: { kind: 'managedMachine', id: 'managed-guest' },
          cancellation: 'unsupported',
          error: {
            errorCode: 'database_transaction_conflict',
            error: 'database_transaction_conflict',
          },
        },
      ],
    });
    const failed = await renderScreen(
      <ActionOperationDetailModal
        serverId={home}
        operationId="power-failed"
        onClose={vi.fn()}
        setChrome={vi.fn()}
      />,
    );
    await flushHookEffects({ cycles: 25 });
    expect(failed.getTextContent()).toContain(
      'inbox.actionOperations.status.failed',
    );
    expect(failed.getTextContent()).not.toContain(
      'inbox.actionOperations.status.outcomeUncertain',
    );
    await failed.unmount();
  });

  it.each([
    ['database_transaction_conflict_exhausted', 'database_transaction_conflict_exhausted', 'approvals.transientFailure'],
    ['database_connection_unavailable', 'database_connection_unavailable', 'errors.scmOutcomeUnknown'],
    ['managed_power_refused', 'The guest could not be reached over SSH.', 'The guest could not be reached over SSH.'],
    ['managed_power_refused', 'managed_power_refused', 'inbox.actionOperations.failureGeneric'],
  ])('presents the failure %s as readable words once, with the code behind Technical details', async (errorCode, error, reason) => {
    const { home } = await seedManagedPowerOperation({
      state: 'failed',
      settledAt: 2_000,
      error: { errorCode, error },
    });
    const screen = await renderScreen(
      <ActionOperationDetailModal
        serverId={home}
        operationId="power-operation"
        onClose={vi.fn()}
        setChrome={vi.fn()}
      />,
    );
    await flushHookEffects({ cycles: 25 });
    const text = screen.getTextContent();
    expect(text.split(reason)).toHaveLength(2);
    // Raw keys neither label nor fill the section; the code waits behind the disclosure.
    expect(text).not.toContain(errorCode);
    expect(text).not.toMatch(/\bmessage\b/);
    const disclosure = screen.findAllByTestId('action-operation-technical-details')
      .find((node) => typeof node.props.onExpandedChange === 'function');
    expect(disclosure).toBeTruthy();
    await act(async () => { disclosure?.props.onExpandedChange(true); });
    expect(screen.getTextContent()).toContain(errorCode);
    await screen.unmount();
  });

});
