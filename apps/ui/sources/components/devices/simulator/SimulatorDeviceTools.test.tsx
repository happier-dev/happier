import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { renderScreen } from '@/dev/testkit';
import type { SimulatorPreviewViewModel } from '@/sync/domains/devices/simulator/types';
import type { SimulatorDeviceOperationKindV1 } from '@happier-dev/protocol/devices/simulator/operationsV1';

vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock({ translate: (key) => key });
});

function viewModel(
  platform: 'ios' | 'android',
  deviceOperations: readonly SimulatorDeviceOperationKindV1[],
): SimulatorPreviewViewModel {
  return {
    resource: {
      v: 1,
      simulatorId: 'sim_1',
      platform,
      deviceId: 'device_1',
      displayName: 'Device',
      appId: 'com.example.app',
      capture: {
        status: 'available',
        sourceId: 'source_1',
        supportedCodecs: ['image.mjpeg'],
        inputMode: 'exclusive',
      },
    },
    controls: { deviceOperations },
  } as unknown as SimulatorPreviewViewModel;
}

async function renderTools(
  model: SimulatorPreviewViewModel,
  run = vi.fn(async (): Promise<unknown> => ({ ok: true })),
) {
  const { SimulatorDeviceTools } = await import('./SimulatorDeviceTools');
  const screen = await renderScreen(
    // The tools draw inside the viewer's page-presented side pane; section actions live in its headers.
    <ListPresentationProvider value="page">
      <SimulatorDeviceTools
        viewModel={model}
        operations={{ pending: null, run: run as never }}
        testID="tools"
      />
    </ListPresentationProvider>,
  );
  return { screen, run };
}

describe('SimulatorDeviceTools', () => {
  it('shows only the sections whose operations the device advertises', async () => {
    const { screen } = await renderTools(
      viewModel('android', ['app_launch', 'appearance_set']),
    );

    expect(screen.findByTestId('tools-app')).toBeTruthy();
    expect(screen.findByTestId('tools-app-terminate')).toBeNull();
    expect(screen.findByTestId('tools-appearance')).toBeTruthy();
    expect(screen.findByTestId('tools-link')).toBeNull();
    expect(screen.findByTestId('tools-push')).toBeNull();
    expect(screen.findByTestId('tools-accessibility')).toBeNull();
  });

  it('launches the named app and sends each setting as its platform value', async () => {
    const { screen, run } = await renderTools(
      viewModel('android', ['app_launch', 'text_size_set', 'permission_set']),
    );

    await screen.pressByTestIdAsync('tools-app-launch');
    expect(run).toHaveBeenCalledWith('app_launch', 'sim_1', {
      operation: 'app_launch',
      appId: 'com.example.app',
    });
    await screen.pressByTestIdAsync('tools-text-size:large');
    expect(run).toHaveBeenCalledWith('textSize:large', 'sim_1', {
      operation: 'text_size_set',
      size: '1.3',
    });
    // One permission is chosen, then one decision applies to it (camera until another is picked).
    await screen.pressByTestIdAsync('tools-permission-grant');
    expect(run).toHaveBeenCalledWith('permission:camera:grant', 'sim_1', {
      operation: 'permission_set',
      appId: 'com.example.app',
      permission: 'android.permission.CAMERA',
      value: 'grant',
    });
  });

  it('shows the setting it last applied, and only once the device accepted it', async () => {
    let accept = false;
    const run = vi.fn(async (): Promise<unknown> => ({ ok: accept }));
    const { screen } = await renderTools(viewModel('ios', ['appearance_set']), run);

    await screen.pressByTestIdAsync('tools-appearance:dark');
    expect(screen.findByTestId('tools-appearance:dark')?.props.accessibilityState?.checked).not.toBe(true);
    accept = true;
    await screen.pressByTestIdAsync('tools-appearance:dark');
    expect(screen.findByTestId('tools-appearance:dark')?.props.accessibilityState?.checked).toBe(true);
  });

  it('reads the screen and presses an element by its identifier, then reads it again', async () => {
    const snapshot = {
      nodes: [
        {
          index: 0,
          type: 'Button',
          identifier: 'increment',
          label: 'Add one',
          enabled: true,
        },
      ],
      truncated: false,
    };
    const run = vi.fn(
      async (
        _key: string,
        _id: string,
        request: { operation: string },
      ): Promise<unknown> =>
        request.operation === 'accessibility_snapshot'
          ? { ok: true, snapshot }
          : { ok: true, pressedIdentifier: 'increment' },
    );
    const { screen } = await renderTools(
      viewModel('ios', ['accessibility_snapshot', 'accessibility_press']),
      run,
    );

    await screen.pressByTestIdAsync('tools-accessibility-read');
    expect(screen.findByTestId('tools-accessibility-node:0')).toBeTruthy();
    await screen.pressByTestIdAsync('tools-accessibility-press:increment');
    expect(run).toHaveBeenCalledWith('accessibility_press:increment', 'sim_1', {
      operation: 'accessibility_press',
      identifier: 'increment',
    });
    expect(
      run.mock.calls.filter(
        ([, , request]) => request.operation === 'accessibility_snapshot',
      ),
    ).toHaveLength(2);
  });
});
