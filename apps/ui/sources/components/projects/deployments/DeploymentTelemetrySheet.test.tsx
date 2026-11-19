import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployments/testing/v1';
import {
  createDeploymentEnvironmentHeaderV1,
} from '@happier-dev/deployment-protocol/testing/v1';
import {
  act,
  renderScreen,
  standardCleanup,
  waitForTestEvent,
} from '@/dev/testkit';

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
const router = await vi.hoisted(async () =>
  (await import('@/dev/testkit/mocks/router')).createExpoRouterMock(),
);
vi.mock('expo-router', () => router.module);
vi.mock(
  '@/modal',
  async () =>
    (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({
      renderCustomModals: true,
    }).module,
);
afterEach(standardCleanup);

const { showDeploymentTelemetrySheet } =
  await import('./DeploymentTelemetrySheet');
const { ModalProvider } = await import('@/modal');
const { View } = await import('react-native');

const lifetime = {
  scope: { serverId: 'home', accountId: 'owner' },
  isCurrent: () => true,
  onRetire: () => ({ dispose() {} }),
};

function setUpDetail() {
  const base = createDeploymentEnvironmentDetailV1({
    environment: createDeploymentEnvironmentHeaderV1({ id: 'production' }),
  });
  return {
    ...base,
    environment: { ...base.environment, telemetryMachineId: 'collector-old' },
    content: {
      ...base.content,
      telemetry: { metrics: false, appLlmCost: true, exceptions: true },
    },
  };
}

async function open(
  setTelemetry: Parameters<
    typeof showDeploymentTelemetrySheet
  >[0]['setTelemetry'],
  onSaved = vi.fn(),
) {
  const screen = await renderScreen(
    <ModalProvider>
      <View testID="host" />
    </ModalProvider>,
  );
  await act(async () => {
    showDeploymentTelemetrySheet({
      detail: setUpDetail() as never,
      lifetime,
      environmentName: 'Production',
      setTelemetry,
      onSaved,
    });
  });
  await act(async () => {
    await Promise.race([
      waitForTestEvent(
        screen.subscribe,
        () => screen.findByTestId('project-deployments.telemetry.save'),
        (node) => node !== null,
      ),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
  });
  return screen;
}

describe('Environment Telemetry tab', () => {
  it('opens the one setup sheet from the not-set-up scene, and names each recorded choice once set up', async () => {
    const { DeploymentTelemetryPanel } = await import('./DeploymentTelemetryPanel');
    const off = createDeploymentEnvironmentDetailV1({ environment: createDeploymentEnvironmentHeaderV1({ id: 'production' }) });
    const screen = await renderScreen(<ModalProvider><DeploymentTelemetryPanel detail={off as never} lifetime={lifetime}
      environmentName="Production" onChanged={() => {}} /></ModalProvider>);
    try {
      expect(screen.findByTestId('project-deployments.telemetry.off')).not.toBeNull();
      expect(screen.findByTestId('project-deployments.telemetry.recording')).toBeNull();
      await screen.pressByTestIdAsync('project-deployments.telemetry.setup');
      await act(async () => {
        await Promise.race([waitForTestEvent(screen.subscribe, () => screen.findByTestId('project-deployments.telemetry.save'),
          node => node !== null), new Promise(resolve => setTimeout(resolve, 5_000))]);
      });
      expect(screen.findByTestId('project-deployments.telemetry.save')).not.toBeNull();
      // The modal host outlives a screen: close the sheet so the next test owns the only one.
      await screen.pressByTestIdAsync('project-deployments.telemetry.cancel');
    } finally { await screen.unmount(); }
    const on = await renderScreen(<ModalProvider><DeploymentTelemetryPanel detail={setUpDetail() as never} lifetime={lifetime}
      environmentName="Production" onChanged={() => {}} /></ModalProvider>);
    try {
      expect(on.findByTestId('project-deployments.telemetry.off')).toBeNull();
      expect(on.findByTestId('project-deployments.telemetry.recording')).not.toBeNull();
    } finally { await on.unmount(); }
  });
});

describe('Environment telemetry sheet', () => {
  it('saves the collector with the three capability choices, then the next deploy applies them', async () => {
    const setTelemetry = vi.fn(async () => ({
      ok: true as const,
      environmentId: 'production',
      revision: 8,
      state: 'redeploy_required' as const,
    }));
    const onSaved = vi.fn();
    const screen = await open(setTelemetry, onSaved);
    try {
      // The D30 footer follows Exceptions: raw telemetry stays on the collector, issue metadata goes to the Account.
      expect(
        screen.findByTestId('project-deployments.telemetry.kept'),
      ).not.toBeNull();
      await screen.pressByTestIdAsync('project-deployments.telemetry.save');
      expect(setTelemetry).toHaveBeenCalledWith({
        collector: { machineId: 'collector-old' },
        capabilities: { metrics: false, appLlmCost: true, exceptions: true },
      });
      expect(onSaved).toHaveBeenCalledWith(
        expect.objectContaining({ ok: true, state: 'redeploy_required' }),
      );
    } finally {
      await screen.unmount();
    }
  });

  it('asks once before the previous collector deletes what it kept, then confirms that exact turn-off', async () => {
    const setTelemetry = vi.fn(async (input: { confirmDelete?: true }) =>
      input.confirmDelete
        ? {
            ok: true as const,
            environmentId: 'production',
            revision: 8,
            state: 'redeploy_required' as const,
          }
        : {
            ok: false as const,
            error: 'telemetry_deletion_confirmation_required' as const,
            details: { machineId: 'collector-old' },
          },
    );
    const onSaved = vi.fn();
    const screen = await open(setTelemetry as never, onSaved);
    try {
      // Turning Requests and queries off clears the collector and withdraws the capability choices.
      // The row owns its switch: pressing Requests and queries turns it off, as a person does.
      await screen.pressByTestIdAsync('project-deployments.telemetry.requests');
      await screen.pressByTestIdAsync('project-deployments.telemetry.save');
      expect(setTelemetry).toHaveBeenNthCalledWith(1, { collector: null });
      expect(onSaved).not.toHaveBeenCalled();
      expect(
        screen.findByTestId('project-deployments.telemetry.confirm-delete'),
      ).not.toBeNull();
      await screen.pressByTestIdAsync('project-deployments.telemetry.save');
      expect(setTelemetry).toHaveBeenNthCalledWith(2, {
        collector: null,
        confirmDelete: true,
      });
      expect(onSaved).toHaveBeenCalledTimes(1);
    } finally {
      await screen.unmount();
    }
  });

  it('keeps the choices and names the recovery when the Action refuses the collector', async () => {
    const setTelemetry = vi.fn(async () => ({
      ok: false as const,
      error: 'telemetry_role_inactive' as const,
    }));
    const onSaved = vi.fn();
    const screen = await open(setTelemetry, onSaved);
    try {
      await screen.pressByTestIdAsync('project-deployments.telemetry.save');
      expect(
        screen.findByTestId('project-deployments.telemetry.refused'),
      ).not.toBeNull();
      expect(
        screen.findByTestId('project-deployments.telemetry.save'),
      ).not.toBeNull();
      expect(onSaved).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });
});
