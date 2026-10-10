import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import {
  ComputerScreenViewer,
  resolveComputerPresenceCapsule,
  type ComputerScreenViewerProps,
} from './ComputerScreenViewer';

vi.mock('@expo/vector-icons', async () =>
  (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock(),
);
vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock({
    translate: (key, params) =>
      params ? `${key}:${JSON.stringify(params)}` : key,
  });
});

function props(
  overrides: Partial<ComputerScreenViewerProps> = {},
): ComputerScreenViewerProps {
  return {
    agent: { agentId: null, name: 'Claude' },
    targetTitle: 'Simulator — iPhone 17',
    targetKind: 'window',
    machineName: 'mac-vm-1',
    shared: true,
    stream: null,
    presence: { kind: 'agent', activity: null, target: null, controlEpoch: 0 },
    agentActing: false,
    onTakeControl: vi.fn(async () => ({ status: 'taken' }) as never),
    onHandBack: vi.fn(),
    onCheckAgain: vi.fn(),
    onChooseWindow: vi.fn(),
    onStopSharing: vi.fn(),
    testID: 'v',
    ...overrides,
  };
}

describe('ComputerScreenViewer', () => {
  it('says once that control isn’t allowed and offers no Take control while the machine denies input', async () => {
    const denied = await renderScreen(
      <ComputerScreenViewer {...props({ inputDenied: true })} />,
    );
    const text = denied.getTextContent();
    expect(text.split('computerUse.viewer.controlNotAllowed').length - 1).toBe(1);
    expect(denied.findByTestId('v-presence-take-control')).toBeNull();
    expect(resolveComputerPresenceCapsule(props({ inputDenied: true })).onTakeControl).toBeUndefined();

    const granted = await renderScreen(
      <ComputerScreenViewer {...props({ inputDenied: false })} />,
    );
    expect(granted.getTextContent()).not.toContain('computerUse.viewer.controlNotAllowed');
    expect(granted.findByTestId('v-presence-take-control')).toBeTruthy();
  });

  it('keeps the last picture dimmed with its time and a way to retry while the stream is paused', async () => {
    const onRetry = vi.fn();
    const paused = await renderScreen(
      <ComputerScreenViewer
        {...props({
          stream: {
            machineName: 'mac-vm-1',
            onRetry,
            playerState: {
              phase: 'error',
              selectedCodec: null,
              activeRenderer: null,
              // A decoded frame is held (the picture owner's own evidence of a renderable frame).
              avccChunks: [new Uint8Array([0])],
              lastFrameAtMs: Date.UTC(2026, 9, 10, 14, 2),
              decodedFrames: 1,
              droppedFrames: 0,
              bufferedBytes: 0,
            },
          },
        })}
      />,
    );
    expect(paused.findByTestId('v-paused-scrim')).toBeTruthy();
    expect(paused.getTextContent()).toContain('computerUse.viewer.paused:{"time":');
    await paused.pressByTestIdAsync('v-stalled-action');
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('says the machine isn’t answering instead of a generic failure, and shows the missing permission in the picture', async () => {
    const offline = await renderScreen(
      <ComputerScreenViewer {...props({ machineOnline: false })} />,
    );
    expect(offline.getTextContent()).toContain('computerUse.viewer.offlineTitle:{"machine":"mac-vm-1"}');
    expect(offline.getTextContent()).not.toContain('computerUse.viewer.unavailableTitle');

    const onOpenSettings = vi.fn();
    const denied = await renderScreen(
      <ComputerScreenViewer
        {...props({ grants: { capture: 'denied', input: 'granted' }, onOpenSettings })}
      />,
    );
    expect(denied.getTextContent()).toContain('computerUse.permission.captureTitle:{"machine":"mac-vm-1"}');
    // Nobody acts on a screen that cannot be seen: no presence capsule beside the card.
    expect(denied.findByTestId('v-presence')).toBeNull();
    await denied.pressByTestIdAsync('v-permission-card-open-settings');
    expect(onOpenSettings).toHaveBeenCalledWith('capture');
  });

  it('leaves identity to the floating frame when the picture is the viewer', async () => {
    const framed = await renderScreen(
      <ComputerScreenViewer {...props({ chrome: 'none' })} />,
    );
    expect(framed.findByTestId('v-title')).toBeNull();
    expect(framed.findByTestId('v-more')).toBeNull();
    const pane = await renderScreen(<ComputerScreenViewer {...props()} />);
    expect(pane.findByTestId('v-title')).toBeTruthy();
  });
});
