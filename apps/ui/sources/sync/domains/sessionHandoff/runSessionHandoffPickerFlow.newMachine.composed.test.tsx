import * as React from 'react';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';
import type { ManagedMachineFullV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { CustomModalChromeConfig } from '@/modal';
import type { SessionHandoffProgressModal } from '@/components/sessions/handoff/SessionHandoffProgressModal';
import { installSessionHandoffCommonModuleMocks } from '@/components/sessions/handoff/sessionHandoffTestHelpers';

type ShownModal = Readonly<{
  component: React.ComponentType<Record<string, unknown>>;
  props: Record<string, unknown>;
}>;
type ProgressProps = React.ComponentProps<typeof SessionHandoffProgressModal>;

// The modal host is the presentation boundary: it records what the flow shows and how it updates it.
const modal = vi.hoisted(() => ({
  shown: [] as Array<{ id: string; config: ShownModal }>,
  updates: [] as Array<{ id: string; props: Record<string, unknown> }>,
}));
installSessionHandoffCommonModuleMocks({
  storage: (importOriginal) => importOriginal(),
  modal: async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
      spies: {
        show: (config: unknown) => {
          const id = `modal-${modal.shown.length + 1}`;
          modal.shown.push({ id, config: config as ShownModal });
          return id;
        },
        update: (id: string, props: unknown) => {
          modal.updates.push({ id, props: props as Record<string, unknown> });
        },
        hide: () => {},
      },
    }).module;
  },
});

const { installSessionOpsNetworkBoundary } =
  await import('@/dev/testkit/harness/sessionOpsNetworkBoundary');
const network = await installSessionOpsNetworkBoundary();
const { loadSyncSingletonForTests } =
  await import('@/dev/testkit/harness/syncSingletonLoader');
await loadSyncSingletonForTests();
const { createActionExecutorBoundaryFixture, createUiActionExecutorBoundary } =
  await import('@/dev/testkit/fixtures/actionExecutorBoundary');
const frontDoor =
  await import('@/sync/ops/actions/frontDoorRuntimeActionExecutor');
const { createManagedMachineSelectionDraft } =
  await import('@/sync/domains/state/newSessionManagedMachineDraft');
await import('@/components/settings/machines/managed/managedMachineCreation');
const { SessionHandoffPickerModalEntry } =
  await import('@/components/sessions/handoff/SessionHandoffPickerModalEntry');
const { SessionHandoffProgressModal: ProgressModal } =
  await import('@/components/sessions/handoff/SessionHandoffProgressModal');
const { renderScreen, standardCleanup } = await import('@/dev/testkit');
const { runSessionHandoffPickerFlow } =
  await import('./runSessionHandoffPickerFlow');

afterEach(() => {
  standardCleanup();
  modal.shown.length = 0;
  modal.updates.length = 0;
  vi.restoreAllMocks();
});
afterAll(() => network.dispose());

describe('handoff to a new machine that could not be created', () => {
  it('says which machine failed, why, and which session it was moving, through the real picker and progress dialogs', async () => {
    const controller = {
      machineId: 'controller',
      installationId: 'installation',
    };
    const launch = {
      provider: { pluginId: 'custom.compute', localId: 'native' },
      schemaVersion: 1,
      name: 'Boat · Node 22',
      choices: {},
    };
    const draft = createManagedMachineSelectionDraft({
      enrollmentIdentity: { kind: 'guestProcess', role: 'sandbox' },
      selection: {
        kind: 'one-off',
        homeId: 'home',
        launch,
        controller,
        retention: { kind: 'until-delete' },
        wakeOnAcceptedMessage: false,
      },
      receipt: {
        launch,
        controller,
        optionStatus: 'current',
        prerequisites: [],
        billing: { location: 'local', stoppedBilling: 'not-billed' },
        retentionCapabilities: {
          supportedIntents: ['start', 'stop', 'delete'],
        },
        retention: { kind: 'until-delete' },
        wakeOnAcceptedMessage: false,
      },
    });
    const machine: ManagedMachineFullV1 = {
      id: 'managed',
      homeId: 'home',
      custodianAccountId: 'account',
      controller,
      launch,
      allocation: 'confirmed-absent',
      creationState: 'active',
      desired: 'start',
      desiredWhen: 'now',
      intentRevision: 1,
      retention: { kind: 'until-delete' },
      wakeOnAcceptedMessage: false,
    };
    // The controller that would create the machine is offline: the acquisition settles with its typed refusal.
    const operation: ActionOperationSnapshotV1 = {
      version: 1,
      operationId: 'creation',
      revision: 2,
      actionId: 'machines.managed.acquire',
      state: 'failed',
      scope: { accountId: 'account', machineId: controller.machineId },
      title: 'Create guest',
      createdAt: 1,
      startedAt: 1,
      settledAt: 2,
      cancellation: 'supported',
      domainRef: { kind: 'managedMachine', id: machine.id, controller },
      error: {
        errorCode: 'controller_unavailable',
        error: 'controller_unavailable',
      },
    };
    const settings = ActionsSettingsV1Schema.parse({
      v: 1,
      approvalWaivedSurfaces: {
        'machines.managed.acquire': ['ui'],
        'machines.managed.get': ['ui'],
        'action.operations.get': ['ui'],
        'session.handoff': ['ui'],
      },
    });
    const handoffStarts = vi.fn();
    const executor = createUiActionExecutorBoundary(
      createActionExecutorBoundaryFixture({
        readActionsSettings: () => settings,
        managedMachineAction: async (request) =>
          request.actionId === 'machines.managed.get'
            ? machine
            : {
                managedId: machine.id,
                operation: { operationId: operation.operationId },
              },
        actionOperationAction: async () => ({ kind: 'found', operation }),
        sessionHandoffStart: async (request) => {
          handoffStarts(request);
          throw new Error('Nothing moves before the machine exists');
        },
      }),
      'account',
      settings,
    );
    vi.spyOn(frontDoor, 'createFrontDoorActionExecute').mockReturnValue(
      frontDoor.createFrontDoorActionExecute(executor),
    );

    const flow = runSessionHandoffPickerFlow({
      execute: executor.execute,
      sessionId: 'sess_1',
      sourceMachineId: 'source',
      serverId: 'server',
      placement: 'session_info',
    });
    // The person picks the preset on the real sheet; its submit hands the flow the sheet's choice and names.
    await vi.waitFor(() =>
      expect(modal.shown[0]?.config.component).toBe(
        SessionHandoffPickerModalEntry,
      ),
    );
    const sheet = modal.shown[0]!.config.props as {
      onResolve: (value: unknown) => void;
    };
    sheet.onResolve({
      managedTarget: {
        draft,
        lifetime: {
          scope: { serverId: 'server', accountId: 'account' },
          isCurrent: () => true,
          onRetire: () => ({ dispose: () => {} }),
        },
        onApprovalPending: () => {
          throw new Error('Unexpected approval');
        },
      },
      targetMachineLabel: 'Boat · Node 22',
      sessionLabel: 'Fix checkout total clipping',
      sourceMachineLabel: 'leeroy-mbp',
      workspaceAction: { kind: 'none' },
    });
    const result = await flow;
    expect(result).toMatchObject({
      ok: false,
      errorCode: 'controller_unavailable',
    });
    expect(handoffStarts).not.toHaveBeenCalled();

    const shown = modal.shown.find(
      (entry) => entry.config.component === ProgressModal,
    );
    if (!shown) throw new Error('The handoff never showed its progress dialog');
    const props = Object.assign(
      {},
      shown.config.props,
      ...modal.updates
        .filter((update) => update.id === shown.id)
        .map((update) => update.props),
    ) as ProgressProps;
    let chrome: CustomModalChromeConfig | null = null;
    const closeDialog = vi.fn();
    // As the dialog frame does: the body publishes its chrome, and the frame draws the footer under it.
    function DialogFrame() {
      const [published, setPublished] = React.useState<CustomModalChromeConfig | null>(null);
      const publish = React.useCallback((next: CustomModalChromeConfig | null) => {
        chrome = next;
        setPublished(next);
      }, []);
      return (
        <>
          <ProgressModal {...props} onClose={closeDialog} setChrome={publish} />
          {published && 'footer' in published ? published.footer : null}
        </>
      );
    }
    const screen = await renderScreen(<DialogFrame />);
    const card = chrome as Extract<
      CustomModalChromeConfig,
      { kind: 'card' }
    > | null;

    // What failed leads: the machine that couldn't be created, not a generic handoff failure.
    expect(card?.title).toBe('sessionHandoff.failure.couldntCreate');
    // Which session was moving, from where, to which new machine.
    expect(card?.subtitle).toBe('sessionHandoff.routeToNewMachine');
    // Why, under the failed step, in the words the machine list uses for the same refusal.
    expect(
      screen.findByTestId('session-handoff-progress-step:create-machine:detail')
        ?.props.children,
    ).toBe('managedMachines.controller.requiredUnnamed');
    expect(screen.getTextContent()).toContain(
      'sessionHandoff.failure.nothingMoved',
    );
    expect(
      screen.findByTestId('session-handoff-progress-retry'),
    ).not.toBeNull();
    await screen.unmount();
  });
});
