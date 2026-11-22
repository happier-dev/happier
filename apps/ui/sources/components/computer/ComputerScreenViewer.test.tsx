import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { PixelRatio, StyleSheet } from 'react-native';

import { renderScreen } from '@/dev/testkit';
import { SessionCockpitBottomChromeHeightContext } from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { LiveStreamInputLayer } from '@/components/stream/LiveStreamInputLayer';
import { BrowserPresenceCapsule } from '@/components/browser/copresence/BrowserPresenceCapsule';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { createComputerControlClient, getComputerSessionProjection, publishComputerStreamInputFailure } from '@/sync/domains/computer/computerControlClient';
import { projectComputerCopresence } from '@/sync/domains/computer/presence';

import {
  ComputerScreenViewer,
  resolveComputerPresenceCapsule,
  type ComputerScreenViewerProps,
} from './ComputerScreenViewer';

vi.mock('@expo/vector-icons', async () =>
  (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock(),
);
vi.mock('react-native', async () => {
  const React = await import('react');
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  // Image sizing is a platform boundary; retain the real viewer and input geometry.
  return createReactNativeWebMock({
    Image: Object.assign(
      (props: Record<string, unknown>) => React.createElement('Image', props),
      {
        getSize: (
          _url: string,
          success: (width: number, height: number) => void,
        ) => success(800, 600),
      },
    ),
  });
});
vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock({
    translate: (key, params) =>
      params ? `${key}:${JSON.stringify(params)}` : key,
  });
});
// The browser's primary-pointer media queries are the platform boundary: the remote-control bar
// stands over the picture only for a finger (a precise pointer by default here).
const pointer = vi.hoisted(() => ({ coarse: false }));
Object.defineProperty(globalThis, 'matchMedia', { configurable: true, value: (query: string) => ({
  matches: query === '(pointer: coarse)' || query === '(hover: none)' ? pointer.coarse
    : query === '(pointer: fine)' || query === '(hover: hover)' ? !pointer.coarse : false,
  media: query, onchange: null, addListener: () => {}, removeListener: () => {},
  addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true,
}) });
afterEach(() => { pointer.coarse = false; });

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

function pictureStage(screen: Awaited<ReturnType<typeof renderScreen>>) {
  // The viewport belongs to the picture's ancestor, not the first measured
  // control in the chrome surrounding it.
  let stage = screen.findHostByTestId('v-picture')?.parent ?? null;
  while (stage && (typeof stage.type !== 'string' || typeof stage.props.onLayout !== 'function')) {
    stage = stage.parent;
  }
  if (!stage) throw new Error('Expected the picture viewport layout owner');
  return stage;
}

describe('ComputerScreenViewer', () => {
  it.each(['computer_element_stale', 'point_outside_capture'] as const)('routes native %s through the Action client to fresh capture', async code => {
    // The remote daemon is the boundary; Action parsing, the client and viewer recovery stay real.
    const executor = createActionExecutor(createActionExecutorBoundaryFixture({ runtimeActionExecute: async () =>
      ({ ok: false, errorCode: code, error: code }) }));
    const client = createComputerControlClient({ machineId: 'native-failure-machine', sessionId: 'native-failure-session' }, executor.execute);
    const result = await client.observe();
    expect(result).toMatchObject({ ok: false, code });
    if (result.ok) throw new Error('Expected the daemon refusal');
    const onCheckAgain = vi.fn();
    const onChooseWindow = vi.fn();
    const onRefresh = vi.fn();
    const screen = await renderScreen(<ComputerScreenViewer {...props({ failure: result.code, onCheckAgain, onChooseWindow, onRefresh })} />);
    await screen.pressByTestIdAsync('v-recovery-action');
    expect(onCheckAgain).toHaveBeenCalledTimes(1);
    expect(onChooseWindow).not.toHaveBeenCalled();
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('retains the native background refusal through the input failure bus while control stays unconfirmed', async () => {
    const scope = { machineId: 'background-machine', sessionId: 'background-session' };
    const target = { kind: 'window', displayId: ':73', pid: 42, windowId: 123 } as const;
    const sourceId = 'background-source';
    // The daemon is the boundary; the projection, failure bus, recovery and viewer remain real.
    const executor = createActionExecutor(createActionExecutorBoundaryFixture({ runtimeActionExecute: async ({ actionId }) => {
      if (actionId === 'computer.target.get') return { sourceId, selectedTarget: target, access: 'use', consentGranted: true,
        approvalDisplay: { machineDisplayName: 'Studio', requiresTargetSelection: false, target: { kind: 'window', title: 'Editor' } } };
      if (actionId === 'computer.control.status') return { sourceId, target, controller: 'human', controlEpoch: 2, stopping: false, uncertain: true };
      throw new Error(`Unexpected Computer Action: ${actionId}`);
    } }));
    const projection = getComputerSessionProjection(scope, executor.execute);
    const onCheckAgain = vi.fn();
    function ProjectedViewer({ pictureUp = true }: { pictureUp?: boolean }) {
      const snapshot = React.useSyncExternalStore(projection.subscribe, projection.getSnapshot);
      return <ComputerScreenViewer {...props({ onCheckAgain, failure: snapshot.failure,
        presence: projectComputerCopresence({ status: snapshot.status, stopRequested: false }),
        stream: pictureUp ? { machineName: 'Studio', input: { sourceId, streamId: 'background-stream', send: vi.fn() },
          playerState: { phase: 'playing', selectedCodec: 'image.mjpeg', activeRenderer: 'mjpeg',
            lastFrameUrl: 'data:image/jpeg;base64,AQID', decodedFrames: 1, droppedFrames: 0, bufferedBytes: 0 } } : null })} />;
    }
    const screen = await renderScreen(<ProjectedViewer />);
    try {
      await act(async () => { await projection.refresh(); });
      await act(async () => { publishComputerStreamInputFailure(scope, sourceId, 'background_unavailable'); });
      expect(projection.getSnapshot()).toMatchObject({ failure: 'background_unavailable',
        status: { controller: 'human', uncertain: true } });
      expect(screen.getTextContent()).toContain('background_unavailable');
      expect(screen.getTextContent()).toContain('computerUse.presentation.inputUnknown');
      expect(screen.findHostByTestId('v-picture')).not.toBeNull();
      expect(screen.findByTestId('v-input')).toBeNull();
      expect(screen.root.findByType(BrowserPresenceCapsule).props.presence.kind).toBe('unconfirmed');
      await screen.pressByTestIdAsync('v-recovery-action');
      expect(onCheckAgain).toHaveBeenCalledTimes(1);
      expect(projection.getSnapshot().status?.uncertain).toBe(true);
      await screen.update(<ProjectedViewer pictureUp={false} />);
      expect(screen.root.findByType(SurfaceStateCard).props.reason).toContain('background_unavailable');
      expect(screen.getTextContent()).toContain('computerUse.presentation.inputUnknown');
      expect(screen.root.findByType(BrowserPresenceCapsule).props.presence.kind).toBe('unconfirmed');
    } finally { await screen.unmount(); }
  });

  it('reveals the typed refusal reason while retaining the last picture and Check again', async () => {
    const { installBrowserRuntimeForTests } = await import('@/dev/testkit/harness/browserRuntimeHarness');
    const browser = await installBrowserRuntimeForTests({ url: 'https://computer-viewer.test/' });
    const { installReactDomPortalBoundaryForTests } = await import('@/dev/testkit/mocks/reactDom');
    const portal = installReactDomPortalBoundaryForTests();
    let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
    try {
      const { ModalProvider } = await import('@/modal');
      const onRefresh = vi.fn();
      const failureCause = { phase: 'rpc.admission.machine', errorClass: 'Error',
        errorCode: 'machine_unavailable', httpStatus: 403 } satisfies NonNullable<ComputerScreenViewerProps['failureCause']>;
      screen = await renderScreen(<ModalProvider><ComputerScreenViewer {...props({
        failure: 'RPC_FORBIDDEN', failureCause, onRefresh,
        stream: { machineName: 'machine', playerState: { phase: 'playing', selectedCodec: 'image.mjpeg', activeRenderer: 'mjpeg',
          lastFrameUrl: 'data:image/jpeg;base64,AQID', decodedFrames: 1, droppedFrames: 0, bufferedBytes: 0 } },
      })} /></ModalProvider>);
      expect(screen.findHostByTestId('v-picture')).not.toBeNull();
      await screen.pressByTestIdAsync('v-recovery-action');
      expect(onRefresh).toHaveBeenCalledTimes(1);
      expect(screen.getTextContent()).not.toContain('rpc.admission.machine');
      await screen.pressByTestIdAsync('v-recovery-action-1');
      const revealed = screen.getTextContent();
      expect(revealed).toContain('RPC_FORBIDDEN');
      expect(revealed).toContain('rpc.admission.machine');
      expect(revealed).toContain('machine_unavailable');
      expect(screen.findHostByTestId('v-picture')).not.toBeNull();
    } finally {
      await screen?.unmount();
      portal.restore();
      browser.restore();
    }
  });

  it('keeps presence outside the input viewport and uses the inline footer layout', async () => {
    pointer.coarse = true;
    const viewerProps = props({ compact: true,
      presence: { kind: 'human', controlEpoch: 1, interruptedCompletion: null },
      stream: { machineName: 'machine', input: { sourceId: 'computer-source', streamId: 'stream', send: vi.fn() },
        playerState: { phase: 'playing', selectedCodec: 'image.mjpeg', activeRenderer: 'mjpeg',
          lastFrameUrl: 'data:image/jpeg;base64,AQID', decodedFrames: 1, droppedFrames: 0, bufferedBytes: 0 } } });
    const screen = await renderScreen(<ComputerScreenViewer {...viewerProps} />);
    const stage = pictureStage(screen);
    await act(async () => stage.props.onLayout({ nativeEvent: { layout: { width: 320, height: 380 } } }));
    await screen.pressByTestIdAsync('v-input-controls-tabs:arrows');

    // The viewport owns picture/input geometry; the existing inline primitive owns the footer's
    // reserved space. Actual browser hit testing remains a loaded-runtime QA check.
    expect(stage.findAllByType(BrowserPresenceCapsule).length).toBe(0);
    expect(screen.root.findByType(BrowserPresenceCapsule).props.placement).toBe('inline');
    expect(screen.findByTestId('v-input-controls-escape')?.props.disabled).toBe(false);
    expect(screen.findByTestId('v-input-controls-keyboard')?.props.disabled).toBe(false);

    // The floating/Session host owns its own footer, so the embedded body must not add another.
    await screen.update(<ComputerScreenViewer {...viewerProps} chrome="none" />);
    expect(screen.findByTestId('v-presence-frame')).toBeNull();
    await screen.unmount();
  });
  it('fits the picture above the touch controls, so their labels never stand on the remote screen', async () => {
    const viewerProps = props({ presence: { kind: 'human', controlEpoch: 1, interruptedCompletion: null },
      stream: { machineName: 'machine', input: { sourceId: 'computer-source', streamId: 'stream', send: vi.fn() },
        playerState: { phase: 'playing', selectedCodec: 'image.mjpeg', activeRenderer: 'mjpeg',
          lastFrameUrl: 'data:image/jpeg;base64,AQID', decodedFrames: 1, droppedFrames: 0, bufferedBytes: 0 } } });
    const pictureBottom = (screen: Awaited<ReturnType<typeof renderScreen>>) => {
      const picture = StyleSheet.flatten(screen.findHostByTestId('v-picture')!.props.style) as { top: number; height: number };
      return picture.top + picture.height;
    };
    // A mouse drives the picture directly: no bar, so the picture keeps the whole stage and reaches
    // below where a finger's bar would stand.
    const mouse = await renderScreen(<ComputerScreenViewer {...viewerProps} />);
    await act(async () => pictureStage(mouse).props.onLayout({ nativeEvent: { layout: { width: 800, height: 400 } } }));
    expect(mouse.findHostByTestId('v-input-controls')).toBeNull();
    expect(pictureBottom(mouse)).toBeGreaterThan(300);
    await mouse.unmount();

    pointer.coarse = true;
    const touch = await renderScreen(<ComputerScreenViewer {...viewerProps} />);
    await act(async () => pictureStage(touch).props.onLayout({ nativeEvent: { layout: { width: 800, height: 400 } } }));
    // The bar stands 12 above the stage's foot and is 88 tall: its top edge is at 300.
    await act(async () => touch.findHostByTestId('v-input-controls')!.props.onLayout({
      nativeEvent: { layout: { x: 12, y: 300, width: 776, height: 88 } } }));
    expect(pictureBottom(touch)).toBeLessThanOrEqual(300);
    // Closing a panel shortens the bar; the picture does not jump back under it.
    await act(async () => touch.findHostByTestId('v-input-controls')!.props.onLayout({
      nativeEvent: { layout: { x: 12, y: 344, width: 776, height: 44 } } }));
    expect(pictureBottom(touch)).toBeLessThanOrEqual(300);
    await touch.unmount();
  });
  it('mounts remote control panels on the live Machine viewer and sends keys and clipboard through its input owner', async () => {
    pointer.coarse = true;
    const send = vi.fn();
    const clipboardShortcut = vi.fn(async (_action: 'copy' | 'cut' | 'paste') => ({ ok: true as const }));
    const viewerProps = props({ presence: { kind: 'human', controlEpoch: 1, interruptedCompletion: null },
      stream: { machineName: 'machine', input: { sourceId: 'computer-source', streamId: 'stream', send, clipboardShortcut },
        playerState: { phase: 'playing', selectedCodec: 'image.mjpeg', activeRenderer: 'mjpeg',
          lastFrameUrl: 'data:image/jpeg;base64,AQID', decodedFrames: 1, droppedFrames: 0, bufferedBytes: 0 } } });
    const screen = await renderScreen(<ComputerScreenViewer {...viewerProps} />);
    await act(async () => pictureStage(screen).props.onLayout({ nativeEvent: { layout: { width: 800, height: 600 } } }));
    expect(screen.findByTestId('v-input-controls')).not.toBeNull();
    await screen.pressByTestIdAsync('v-input-controls-tabs:modifiers');
    await screen.pressByTestIdAsync('v-input-controls-modifier-control');
    await screen.pressByTestIdAsync('v-input-controls-escape');
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'keyboard_key', key: 'Escape', modifiers: ['control'] }));
    await screen.pressByTestIdAsync('v-input-controls-tabs:arrows');
    await screen.pressByTestIdAsync('v-input-controls-key-ArrowLeft');
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'keyboard_key', key: 'ArrowLeft' }));
    await screen.pressByTestIdAsync('v-input-controls-tabs:clipboard');
    await screen.pressByTestIdAsync('v-input-controls-paste');
    await screen.pressByTestIdAsync('v-input-controls-copy');
    expect(clipboardShortcut.mock.calls.map(call => call[0])).toEqual(['paste', 'copy']);
    expect(screen.findByTestId('v-input-controls-keyboard')).not.toBeNull();
    await screen.update(<ComputerScreenViewer {...viewerProps} presence={{ kind: 'agent', activity: null, target: null, controlEpoch: 2 }} />);
    // Once the agent has the screen again, the person watches: the bar leaves with their control.
    expect(screen.findHostByTestId('v-input-controls')).toBeFalsy();
    await screen.unmount();
  });
  it('allows hover only while this source is controlled by the person, preserving tap takeover', async () => {
    const inputProps = props({ stream: { machineName: 'machine',
      input: { sourceId: 'computer-source', streamId: 'stream', send: vi.fn() },
      playerState: { phase: 'playing', selectedCodec: 'image.mjpeg', activeRenderer: 'mjpeg',
        lastFrameUrl: 'data:image/jpeg;base64,AQID', decodedFrames: 1, droppedFrames: 0, bufferedBytes: 0 },
    } });
    const screen = await renderScreen(<ComputerScreenViewer {...inputProps} />);
    await act(async () => pictureStage(screen).props.onLayout({ nativeEvent: { layout: { width: 800, height: 600 } } }));
    const supports = () => screen.root.findByType(LiveStreamInputLayer).props.supports;
    expect(supports()('tap')).toBe(true);
    expect(supports()('move')).toBe(false);
    await screen.update(<ComputerScreenViewer {...inputProps} presence={{ kind: 'human', controlEpoch: 1, interruptedCompletion: null }} />);
    expect(supports()('move')).toBe(true);
    await screen.update(<ComputerScreenViewer {...inputProps} />);
    expect(supports()('move')).toBe(false);
  });
  it('shows connecting while the share selection is unread, then shows a confirmed empty selection', async () => {
    const screen = await renderScreen(<ComputerScreenViewer {...props({ shared: false, selectionPending: true })} />);
    expect(screen.findByTestId('v-not-shared')).toBeNull();
    expect(screen.findByTestId('v-connecting')).not.toBeNull();
    expect(screen.getTextContent()).not.toContain('computerUse.presentation.notSharedTitle');
    await screen.update(<ComputerScreenViewer {...props({ shared: false, selectionPending: false, targetTitle: null })} />);
    expect(screen.findByTestId('v-not-shared')).not.toBeNull();
    // The card says nothing is shared; the pane's tab already names the surface, so the bar names only
    // the Machine, once, as its identity chip (no "Computer · On mac-vm-1" line).
    expect(screen.findByTestId('v-title')).toBeNull();
    expect(screen.findByTestId('v-machine')).not.toBeNull();
    expect(screen.getTextContent()).not.toContain('computerUse.presentation.onMachine');
  });

  it('names no stand-in agent mid-sentence on a Machine with no Session agent (stop hint, picker card)', async () => {
    const machine = await renderScreen(<ComputerScreenViewer {...props({ failure: 'MACHINE_RPC_TIMEOUT', agentless: true })} />);
    const card = machine.findAllByType(SurfaceStateCard).find(node => node.props.testID === 'v-recovery');
    expect(card?.props.reason).toBe('computerUse.presentation.unavailableBodyMachine');
    const { computerTargetPickerChrome } = await import('./showComputerTargetPicker');
    const chrome = computerTargetPickerChrome({ agentName: 'The agent', agentless: true, machineName: 'mac-vm-1' });
    if (chrome.kind !== 'card') throw new Error('Expected card chrome');
    expect(chrome.title).toBe('computerUse.picker.titleMachine');
    expect(chrome.subtitle).toBe('computerUse.picker.descriptionMachine');
    const session = computerTargetPickerChrome({ agentName: 'Claude', machineName: 'mac-vm-1' });
    expect(session.title).toBe('computerUse.picker.title:{"agent":"Claude"}');
  });

  it('asks for a window for agents on the Machine when there is no Session agent to name', async () => {
    const machine = await renderScreen(<ComputerScreenViewer {...props({ shared: false, selectionPending: false, agentless: true })} />);
    expect(machine.getTextContent()).toContain('computerUse.presentation.notSharedBodyMachine');
    expect(machine.getTextContent()).not.toContain('computerUse.presentation.notSharedBody:');
    const session = await renderScreen(<ComputerScreenViewer {...props({ shared: false, selectionPending: false })} />);
    expect(session.getTextContent()).toContain('computerUse.presentation.notSharedBody:{"agent":"Claude"}');
  });

  it('keeps a removed-access refusal visible after the owner retires the selection, with no choose or repair bypass', async () => {
    const screen = await renderScreen(
      <ComputerScreenViewer
        {...props({ shared: false, failure: 'forbidden' })}
      />,
    );
    expect(screen.findByTestId('v-not-shared')).toBeNull();
    expect(screen.findByTestId('v-recovery')).toBeTruthy();
    expect(screen.findByTestId('v-recovery-action')).toBeNull();
  });
  it.each(['driver_unavailable', 'driver_result_invalid', 'driver_version_mismatch', 'driver_protocol_error'] as const)(
    'offers the native installation repair for %s before selection is available',
    async (failure) => {
      const onRepairDriver = vi.fn();
      const screen = await renderScreen(
        <ComputerScreenViewer
          {...props({ shared: false })}
          failure={failure}
          failureDetails={{ installHint: { actionId: 'machines.capabilities.install', capabilityId: 'dep.computer-agent-desktop' } }}
          onRepairDriver={onRepairDriver}
        />,
      );
      expect(screen.findByTestId('v-not-shared') === null).toBe(true);
      expect(screen.findByTestId('v-recovery')).toBeTruthy();
      await screen.pressByTestIdAsync('v-recovery-action');
      expect(onRepairDriver).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['stale_capture', 'human_input_interruption_uncertain'] as const)(
    'keeps the frame and recaptures without input replay for %s',
    async (failure) => {
      const onCheckAgain = vi.fn();
      const screen = await renderScreen(
        <ComputerScreenViewer
          {...props({
            onCheckAgain,
            presence: {
              kind: 'human',
              controlEpoch: 1,
              interruptedCompletion: null,
            },
            stream: {
              machineName: 'mac-vm-1',
              input: {
                sourceId: 'computer-window-a',
                streamId: 'stream-a',
                send: vi.fn(),
              },
              playerState: {
                phase: 'playing',
                selectedCodec: 'image.mjpeg',
                activeRenderer: 'mjpeg',
                lastFrameUrl: 'data:image/jpeg;base64,AQID',
                decodedFrames: 1,
                droppedFrames: 0,
                bufferedBytes: 0,
              },
            },
          })}
          failure={failure}
        />,
      );
      await act(async () =>
        screen.root
          .findAll((node) => typeof node.props.onLayout === 'function')[0]
          .props.onLayout({
            nativeEvent: { layout: { width: 800, height: 600 } },
          }),
      );
      expect(screen.findByTestId('v-player')).toBeTruthy();
      expect(screen.findByTestId('v-recovery')).toBeTruthy();
      await screen.pressByTestIdAsync('v-recovery-action');
      expect(onCheckAgain).toHaveBeenCalledTimes(1);
      expect(screen.findByTestId('v-input')).toBeNull();
    },
  );

  it('says once that control isn’t allowed and offers no Take control while the machine denies input', async () => {
    const denied = await renderScreen(
      <ComputerScreenViewer {...props({ inputDenied: true })} />,
    );
    const text = denied.getTextContent();
    expect(
      text.split('computerUse.presentation.controlNotAllowed').length - 1,
    ).toBe(1);
    expect(denied.findByTestId('v-presence-take-control')).toBeNull();
    expect(
      resolveComputerPresenceCapsule(props({ inputDenied: true }))
        .onTakeControl,
    ).toBeUndefined();

    const granted = await renderScreen(
      <ComputerScreenViewer {...props({ inputDenied: false })} />,
    );
    expect(granted.getTextContent()).not.toContain(
      'computerUse.presentation.controlNotAllowed',
    );
    expect(granted.findByTestId('v-presence-take-control')).toBeTruthy();
  });

  it('offers no Take control and says the agent only sees when the share is see-only', async () => {
    const seeOnly = resolveComputerPresenceCapsule(props({ access: 'see' }));
    expect(seeOnly.onTakeControl).toBeUndefined();
    expect(seeOnly.agentNote).toContain('computerUse.presentation.seeOnly');
    const rendered = await renderScreen(
      <ComputerScreenViewer {...props({ access: 'see' })} />,
    );
    expect(rendered.findByTestId('v-presence-take-control')).toBeNull();

    const use = resolveComputerPresenceCapsule(props({ access: 'use' }));
    expect(use.onTakeControl).toBeDefined();
    expect(use.agentNote).toBeUndefined();
  });

  it('never says the window closed when the stream stopped on a failure: it says it is unavailable and retries', async () => {
    const onRetry = vi.fn();
    const stopped = (reasonCode?: string) =>
      props({
        stream: {
          machineName: 'mac-vm-1',
          onRetry,
          playerState: {
            phase: 'stopped',
            selectedCodec: null,
            activeRenderer: null,
            avccChunks: [],
            decodedFrames: 0,
            droppedFrames: 0,
            bufferedBytes: 0,
            ...(reasonCode ? { diagnostic: { reasonCode } } : {}),
          },
        },
      });
    const failed = await renderScreen(
      <ComputerScreenViewer
        {...stopped('stream_encryption_material_unavailable')}
      />,
    );
    expect(failed.findByTestId('v-ended')).toBeNull();
    expect(failed.findByTestId('v-unavailable')).toBeTruthy();
    await failed.pressByTestIdAsync('v-unavailable-card-action');
    expect(onRetry).toHaveBeenCalledTimes(1);

    const ended = await renderScreen(<ComputerScreenViewer {...stopped()} />);
    expect(ended.findByTestId('v-ended')).toBeTruthy();
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
              lastFrameUrl: 'blob:last-frame',
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
    // Only the held picture dims; the empty stage around a small window keeps its own paint.
    const stage = pictureStage(paused);
    await act(async () => stage.props.onLayout({ nativeEvent: { layout: { width: 1600, height: 1200 } } }));
    const picture = StyleSheet.flatten(paused.findByTestId('v-picture')!.props.style);
    expect(StyleSheet.flatten(paused.findByTestId('v-paused-scrim')!.props.style)).toMatchObject({
      left: picture.left, top: picture.top, width: picture.width, height: picture.height,
    });
    expect(paused.getTextContent()).toContain(
      'computerUse.presentation.paused:{"time":',
    );
    await paused.pressByTestIdAsync('v-stalled-action');
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('never says a Machine that answers isn\u2019t answering when its screen read fails before anything is shared', async () => {
    // The Machine is reachable (presence says so) but the Computer read failed: the cause is its
    // screen, not the Machine. "isn't answering" stays for a Machine that is actually unreachable.
    const online = await renderScreen(<ComputerScreenViewer {...props({ failure: 'MACHINE_RPC_TIMEOUT', shared: false, machineOnline: true })} />);
    const card = online.findAllByType(SurfaceStateCard).find(node => node.props.testID === 'v-recovery');
    expect(card?.props.title).toBe('computerUse.presentation.screenUnavailableTitle:{"machine":"mac-\u2060vm-\u20601"}');
    expect(card?.props.reason).toBe('computerUse.presentation.screenUnavailableBody');
    expect(card?.props.diagnosticCode).toBe('MACHINE_RPC_TIMEOUT');
    expect(card?.props.action?.label).toBe('computerUse.permission.checkAgain');
    // An unreachable Machine still says so.
    const offline = await renderScreen(<ComputerScreenViewer {...props({ failure: 'machine_unreachable', shared: false, machineOnline: false })} />);
    expect(offline.findAllByType(SurfaceStateCard).find(node => node.props.testID === 'v-recovery')?.props.title)
      .toBe('computerUse.presentation.offlineTitle:{"machine":"mac-\u2060vm-\u20601"}');
  });

  it('tells a failed reopen as the same calm unavailable state as a lost stream, its code only under Details', async () => {
    const failed = await renderScreen(<ComputerScreenViewer {...props({ failure: 'MACHINE_RPC_TIMEOUT' })} />);
    const card = failed.findAllByType(SurfaceStateCard).find(node => node.props.testID === 'v-recovery');
    const lost = await renderScreen(<ComputerScreenViewer {...props()} />);
    const lostCard = lost.findAllByType(SurfaceStateCard).find(node => node.props.testID === 'v-unavailable-card');
    expect(card).toBeDefined();
    expect(lostCard).toBeDefined();
    expect(card?.props.kind).toBe(lostCard?.props.kind);
    expect(card?.props.iconName).toBe(lostCard?.props.iconName);
    expect(card?.props.title).toBe('computerUse.presentation.unavailableTitle');
    expect(card?.props.reason).toBe('computerUse.presentation.unavailableBody:{"agent":"Claude"}');
    expect(card?.props.diagnosticCode).toBe('MACHINE_RPC_TIMEOUT');
    // A see-only share offers no Take control, so it does not promise a stop here.
    const seeOnly = await renderScreen(<ComputerScreenViewer {...props({ failure: 'MACHINE_RPC_TIMEOUT', access: 'see' })} />);
    const seeOnlyCard = seeOnly.findAllByType(SurfaceStateCard).find(node => node.props.testID === 'v-recovery');
    expect(seeOnlyCard).toBeDefined();
    expect(seeOnlyCard?.props.reason).toBeUndefined();
    // Before any window is known to be shared, a call that timed out names the Machine that didn't
    // answer and promises no stop: there is no window to show and no capsule offering Take control.
    const unshared = await renderScreen(<ComputerScreenViewer {...props({ failure: 'MACHINE_RPC_TIMEOUT', shared: false })} />);
    const unsharedCard = unshared.findAllByType(SurfaceStateCard).find(node => node.props.testID === 'v-recovery');
    expect(unsharedCard).toBeDefined();
    expect(unsharedCard?.props.title).toBe('computerUse.presentation.offlineTitle:{"machine":"mac-\u2060vm-\u20601"}');
    expect(unsharedCard?.props.reason).toBeUndefined();
    // It reads like the offline Machine card, not a hidden window.
    expect(unsharedCard?.props.iconName).toBeUndefined();
    // Nor does the bar claim that nothing is shared: the read that would say so failed.
    const unread = await renderScreen(<ComputerScreenViewer {...props({ failure: 'MACHINE_RPC_TIMEOUT', shared: false, targetTitle: null })} />);
    expect(unread.findByTestId('v-title')).toBeNull();
    // A Machine whose name isn't readable yet is never a blank in the sentence.
    const unnamed = await renderScreen(<ComputerScreenViewer {...props({ failure: 'MACHINE_RPC_TIMEOUT', shared: false, machineName: null })} />);
    expect(unnamed.findAllByType(SurfaceStateCard).find(node => node.props.testID === 'v-recovery')?.props.title)
      .toBe('computerUse.presentation.offlineTitle:{"machine":"computerUse.presentation.tabFallback"}');
    expect(unsharedCard?.props.diagnosticCode).toBe('MACHINE_RPC_TIMEOUT');
  });

  it('says a failed Stop sharing failed and offers it again, never a generic unavailable window', async () => {
    const onStopSharing = vi.fn();
    const heldPicture = {
      machineName: 'mac-vm-1',
      playerState: {
        phase: 'error' as const, selectedCodec: null, activeRenderer: null, avccChunks: [new Uint8Array([0])],
        lastFrameUrl: 'blob:last-frame', lastFrameAtMs: Date.UTC(2026, 9, 10, 14, 2), decodedFrames: 1, droppedFrames: 0, bufferedBytes: 0,
      },
    };
    // Over the held picture: one line that names the failed press, with the press again.
    const over = await renderScreen(<ComputerScreenViewer {...props({ stream: heldPicture, failure: 'MACHINE_RPC_TIMEOUT', stopFailed: true, onStopSharing })} />);
    expect(over.getTextContent()).toContain('computerUse.presentation.stopFailed');
    expect(over.getTextContent()).not.toContain('computerUse.presentation.unavailableTitle');
    await over.pressByTestIdAsync('v-recovery-action');
    expect(onStopSharing).toHaveBeenCalledTimes(1);
    // Without a picture: the card says the same, its code under Details.
    const card = (await renderScreen(<ComputerScreenViewer {...props({ failure: 'MACHINE_RPC_TIMEOUT', stopFailed: true, onStopSharing })} />))
      .findAllByType(SurfaceStateCard).find(node => node.props.testID === 'v-recovery');
    expect(card?.props.title).toBe('computerUse.presentation.stopFailed');
    expect(card?.props.diagnosticCode).toBe('MACHINE_RPC_TIMEOUT');
    card?.props.action?.onPress();
    expect(onStopSharing).toHaveBeenCalledTimes(2);
    // While the stop is in flight the person sees that it is under way.
    const stopping = await renderScreen(<ComputerScreenViewer {...props({ stream: heldPicture, stopping: true })} />);
    expect(stopping.getTextContent()).toContain('computerUse.presentation.stopping');
    // One line says it: the paused-stream capsule doesn't repeat that the picture is held.
    expect(stopping.getTextContent()).not.toContain('computerUse.presentation.paused');
  });

  it('names an unreachable machine with its one recovery and no fault code to look up', async () => {
    const screen = await renderScreen(
      <ComputerScreenViewer
        {...props({ shared: false, failure: 'machine_unreachable' })}
      />,
    );
    expect(screen.getTextContent()).toContain(
      'computerUse.presentation.offlineTitle:{"machine":"mac-\u2060vm-\u20601"}',
    );
    expect(screen.findByTestId('v-recovery-action')).toBeTruthy();
    expect(screen.getTextContent()).not.toContain('common.details');
  });

  it('says the machine isn’t answering instead of a generic failure, and shows the missing permission in the picture', async () => {
    const offline = await renderScreen(
      <ComputerScreenViewer {...props({ machineOnline: false })} />,
    );
    expect(offline.getTextContent()).toContain(
      'computerUse.presentation.offlineTitle:{"machine":"mac-\u2060vm-\u20601"}',
    );
    expect(offline.getTextContent()).not.toContain(
      'computerUse.presentation.unavailableTitle',
    );

    // Nothing to choose on a machine that cannot answer: no "No window is shared" before the failure arrives.
    const unshared = await renderScreen(
      <ComputerScreenViewer
        {...props({ shared: false, machineOnline: false })}
      />,
    );
    expect(unshared.getTextContent()).toContain(
      'computerUse.presentation.offlineTitle:{"machine":"mac-\u2060vm-\u20601"}',
    );
    expect(unshared.findByTestId('v-not-shared')).toBeNull();
    expect(unshared.getTextContent()).toContain(
      'computerUse.permission.checkAgain',
    );

    const onOpenSettings = vi.fn();
    const denied = await renderScreen(
      <ComputerScreenViewer
        {...props({
          shared: false,
          grants: { capture: 'denied', input: 'granted' },
          onOpenSettings,
        })}
      />,
    );
    expect(denied.getTextContent()).toContain(
      'computerUse.permission.title:{"machine":"mac-\u2060vm-\u20601"}',
    );
    // Nobody acts on a screen that cannot be seen: no presence capsule beside the card.
    expect(denied.findByTestId('v-presence')).toBeNull();
    await denied.pressByTestIdAsync('v-permission-card-open-settings');
    expect(onOpenSettings).toHaveBeenCalledWith('capture');
  });

  it('uses the canonical reachability explanation in the offline card', async () => {
    const screen = await renderScreen(<ComputerScreenViewer {...props({
      machineOnline: false,
      offlineReason: 'NLDW4-5-40-40 is out of reach',
    })} />);
    expect(screen.getTextContent()).toContain('NLDW4-5-40-40 is out of reach');
    expect(screen.getTextContent()).not.toContain('computerUse.presentation.offlineBody');
    await screen.update(<ComputerScreenViewer {...props({
      machineOnline: false, failure: 'machine_unreachable',
      offlineReason: 'NLDW4-5-40-40 is out of reach',
    })} />);
    expect(screen.getTextContent()).toContain('NLDW4-5-40-40 is out of reach');
    expect(screen.getTextContent()).not.toContain('computerUse.presentation.offlineBody');
  });

  it('keeps the known Machine cause when a shared stream refresh fails with a generic timeout', async () => {
    const screen = await renderScreen(<ComputerScreenViewer {...props({
      machineOnline: false, failure: 'MACHINE_RPC_TIMEOUT',
      offlineReason: 'Studio is out of reach',
    })} />);
    const card = screen.findAllByType(SurfaceStateCard).find(node => node.props.testID === 'v-recovery');
    expect(card?.props.title).toBe('Studio is out of reach');
    expect(card?.props.reason).toBeUndefined();
  });

  // The menu's popover portal is a platform boundary; its items and selection are this viewer's own.
  const viewMenu = (screen: Awaited<ReturnType<typeof renderScreen>>) =>
    screen.tree.root.findByType(DropdownMenu).props;

  it('offers Record in the view menu, and while recording shows the capsule and Discard instead', async () => {
    const onStart = vi.fn();
    const onStop = vi.fn();
    const onDiscard = vi.fn();
    const idle = await renderScreen(
      <ComputerScreenViewer {...props({ shared: true, recording: { recording: null, onStart, onStop, onDiscard } })} />,
    );
    expect(viewMenu(idle).items.map((item) => item.id)).toContain('record');
    await act(async () => { viewMenu(idle).onSelect('record'); });
    expect(onStart).toHaveBeenCalledTimes(1);

    const running = { recordingId: 'recording-1', status: 'recording', startedAtMs: Date.now(), durationMs: 0 } as never;
    const active = await renderScreen(
      <ComputerScreenViewer {...props({ shared: true, recording: { recording: running, onStart, onStop, onDiscard } })} />,
    );
    await active.pressByTestIdAsync('v-recording-stop');
    expect(onStop).toHaveBeenCalledWith(running);
    expect(viewMenu(active).items.map((item) => item.id)).not.toContain('record');
    await act(async () => { viewMenu(active).onSelect('discard-recording'); });
    expect(onDiscard).toHaveBeenCalledTimes(1);
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

  it('says over the picture, while a stop is unconfirmed, that nobody can use the window from Happier and what helps', async () => {
    const stream = {
      machineName: 'mac-vm-1',
      playerState: {
        phase: 'playing' as const, selectedCodec: null, activeRenderer: null, lastFrameUrl: 'blob:frame', avccChunks: [],
        lastFrameAtMs: Date.now(), decodedFrames: 1, droppedFrames: 0, bufferedBytes: 0,
      },
    };
    const held = await renderScreen(
      <ComputerScreenViewer {...props({ appName: 'Simulator', stream, presence: { kind: 'unconfirmed', controlEpoch: 2 } })} />,
    );
    const line = held.findByTestId('v-unconfirmed');
    expect(line).not.toBeNull();
    expect(held.getTextContent()).toContain('computerUse.presentation.unconfirmedWarning:{"agent":"Claude","target":"Simulator","machine":"mac-\u2060vm-\u20601"}');
    expect(held.getTextContent()).toContain('computerUse.presentation.unconfirmedStuckHint');
    const watched = await renderScreen(<ComputerScreenViewer {...props({ appName: 'Simulator', stream })} />);
    expect(watched.findByTestId('v-unconfirmed')).toBeNull();
  });

  it('never draws a small shared window past its own pixels: it stays its native size, centred on the stage', async () => {
    const live = await renderScreen(
      <ComputerScreenViewer
        {...props({
          stream: {
            machineName: 'mac-vm-1',
            playerState: {
              phase: 'playing',
              selectedCodec: null,
              activeRenderer: null,
              lastFrameUrl: 'blob:frame',
              avccChunks: [],
              lastFrameAtMs: Date.now(),
              decodedFrames: 1,
              droppedFrames: 0,
              bufferedBytes: 0,
            },
          },
        })}
      />,
    );
    const stage = pictureStage(live);
    // The mocked frame is 800x600 device pixels; the stage is twice that. One device pixel per image pixel.
    const native = {
      width: 800 / PixelRatio.get(),
      height: 600 / PixelRatio.get(),
    };
    await act(async () =>
      stage.props.onLayout({
        nativeEvent: { layout: { width: 1600, height: 1200 } },
      }),
    );
    expect(
      StyleSheet.flatten(live.findByTestId('v-picture')!.props.style),
    ).toMatchObject({
      left: (1600 - native.width) / 2,
      top: (1200 - native.height) / 2,
      ...native,
    });
    // A stage smaller than the picture still fits it down, as before.
    await act(async () =>
      stage.props.onLayout({
        nativeEvent: { layout: { width: 200, height: 1200 } },
      }),
    );
    expect(
      StyleSheet.flatten(live.findByTestId('v-picture')!.props.style),
    ).toMatchObject({ left: 0, width: 200, height: 150 });
  });

  it('keeps its presence capsule above the phone cockpit tab bar, and leaves the floating frame to itself', async () => {
    const reservedBy = async (chrome: 'bar' | 'none') => {
      const screen = await renderScreen(
        <SessionCockpitBottomChromeHeightContext.Provider value={84}>
          <ComputerScreenViewer {...props({ chrome })} />
        </SessionCockpitBottomChromeHeightContext.Provider>,
      );
      return (
        StyleSheet.flatten(screen.findByTestId('v')!.props.style)
          ?.paddingBottom ?? 0
      );
    };
    expect(await reservedBy('bar')).toBe(84);
    expect(await reservedBy('none')).toBe(0);
  });
});
