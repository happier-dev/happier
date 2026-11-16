import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { SimulatorPreviewPane } from '@/components/devices/simulator/SimulatorPreviewPane';
import { Text } from '@/components/ui/text/Text';
import { SurfaceStateSizeProvider } from '@/components/ui/surfaces/surfaceStateSize';
import { Typography } from '@/constants/Typography';
import type { SimulatorAccessibilitySnapshotV1 } from '@happier-dev/protocol/devices/simulator/accessibilityV1';
import type { SimulatorPreviewActions } from '@/sync/domains/devices/simulator/useSimulatorPreview';
import type { SimulatorPreviewViewModel } from '@/sync/domains/devices/simulator/types';

import { SIMULATOR_PHONE_SCREEN_FRAME } from './simulatorScreenFrame';

/**
 * Dev-only specimen of the device viewer drawn through the real components at static props, so its
 * states can be compared side by side without a booted simulator. The screen pixels are a fixture.
 */
const NOOP = async () => undefined;
const ACTIONS: Partial<SimulatorPreviewActions> = {
  selectDevice: () => undefined,
  openStream: NOOP,
  acquireLease: NOOP,
  releaseLease: NOOP,
  requestKeyframe: NOOP,
  lowerQuality: NOOP,
  setFps: NOOP,
  // Reading the screen answers with the fixture's elements, so the inspector shows real rows.
  runDeviceOperation: async (_simulatorId, request) => request.operation === 'accessibility_snapshot'
    ? { ok: true, snapshot: ACCESSIBILITY_SNAPSHOT }
    : { ok: true },
  requestSideband: NOOP,
};

const ACCESSIBILITY_SNAPSHOT: SimulatorAccessibilitySnapshotV1 = {
  truncated: false,
  nodes: [
    { index: 0, type: 'Heading', label: 'Good morning, Ana' },
    { index: 1, type: 'Button', identifier: 'week-summary', label: '12 of 18 tasks finished', enabled: true },
    { index: 2, type: 'Checkbox', identifier: 'task-onboarding-copy', label: 'Review onboarding copy', enabled: true },
    { index: 3, type: 'Checkbox', identifier: 'task-push-prompt', label: 'Ship push permissions prompt', enabled: true },
    { index: 4, type: 'Tab', identifier: 'tab-inbox', label: 'Inbox', enabled: true },
  ],
};

const DEVICES: SimulatorPreviewViewModel['devices'] = [
  {
    simulatorId: 'sim_ios',
    label: 'iPhone 16 Pro',
    platformLabel: 'iOS',
    selected: true, state: 'running', canBoot: false,
    availability: { state: 'available' },
  },
  {
    simulatorId: 'sim_android',
    label: 'Pixel 9',
    platformLabel: 'Android',
    selected: false, state: 'running', canBoot: false,
    availability: { state: 'available' },
  },
  {
    simulatorId: 'sim_ipad',
    label: 'iPad Air 13-inch',
    platformLabel: 'iOS',
    selected: false, state: 'running', canBoot: false,
    availability: { state: 'degraded', reasonCode: 'slow_consumer' },
  },
  {
    simulatorId: 'avd_tablet',
    label: 'Pixel Tablet',
    platformLabel: 'Android',
    selected: false, state: 'stopped', canBoot: true,
    availability: { state: 'unavailable', reasonCode: 'device_stopped' },
  },
];

function model(
  overrides: Partial<SimulatorPreviewViewModel> = {},
): SimulatorPreviewViewModel {
  return {
    kind: 'selected',
    viewerId: 'viewer_dev',
    devices: DEVICES,
    selectedSimulatorId: 'sim_android',
    resource: {
      v: 1,
      simulatorId: 'sim_android',
      platform: 'android',
      deviceId: 'emulator-5554',
      displayName: 'Pixel 9',
      capture: {
        status: 'available',
        sourceId: 'source_dev',
        supportedCodecs: ['image.mjpeg'],
        inputMode: 'exclusive',
      },
    },
    stream: {
      phase: 'playing',
      selectedCodec: 'image.mjpeg',
      activeRenderer: 'mjpeg',
      lastFrameUrl: SIMULATOR_PHONE_SCREEN_FRAME,
      lastFrameAtMs: 1_000,
      decodedFrames: 120,
      droppedFrames: 0,
      bufferedBytes: 0,
    },
    codec: { selected: 'image.mjpeg' },
    lease: { state: 'available' },
    activeLease: null,
    controls: {
      canWatch: true,
      canControl: false,
      canRequestKeyframe: true,
      canSetQuality: true,
      canSetFps: true,
      canSetScale: false,
      supportedInputKinds: ['tap', 'swipe', 'keyboard_text', 'hardware_button'],
      hardwareButtons: ['home', 'back', 'recents'],
      deviceOperations: ['screenshot', 'power_off', 'hardware', 'app_launch', 'app_terminate', 'open_url', 'appearance_set', 'text_size_set', 'location_set', 'permission_set', 'rotate', 'accessibility_snapshot', 'accessibility_press'],
    },
    sidebands: {
      capture_health: {
        v: 1,
        simulatorId: 'sim_android',
        emittedAtMs: 1_000,
        kind: 'capture_health',
        status: 'available',
      },
    },
    diagnostics: [],
    availability: { state: 'available' },
    ...overrides,
  };
}

const LIVE = model();
const FRAMES: readonly Readonly<{
  id: string;
  title: string;
  viewModel: SimulatorPreviewViewModel;
}>[] = [
  {
    id: 'discovery',
    title: 'Discovery',
    viewModel: model({
      kind: 'empty',
      selectedSimulatorId: null,
      resource: null,
    }),
  },
  {
    id: 'empty',
    title: 'No devices',
    viewModel: model({
      kind: 'empty',
      devices: [],
      selectedSimulatorId: null,
      resource: null,
    }),
  },
  {
    id: 'opening',
    title: 'Opening the device',
    viewModel: model({
      stream: { ...LIVE.stream, phase: 'idle', lastFrameUrl: undefined },
    }),
  },
  {
    id: 'connecting',
    title: 'Connecting the screen',
    viewModel: model({
      stream: { ...LIVE.stream, phase: 'opening', lastFrameUrl: undefined },
    }),
  },
  { id: 'watching', title: 'Watching', viewModel: LIVE },
  {
    id: 'controlling',
    title: 'Controlling',
    viewModel: model({
      lease: { state: 'held-by-me', leaseId: 'lease_dev' },
      controls: { ...LIVE.controls, canControl: true },
    }),
  },
  {
    id: 'reconnecting',
    title: 'Reconnecting (held frame)',
    viewModel: model({ stream: { ...LIVE.stream, phase: 'reconnecting' } }),
  },
  {
    id: 'failed',
    title: 'Video failed',
    viewModel: model({
      stream: {
        ...LIVE.stream,
        phase: 'error',
        lastFrameUrl: undefined,
        diagnostic: { reasonCode: 'stream_failed' },
      },
    }),
  },
  {
    // Only a browser without a video decoder shows the cause; elsewhere this frame connects.
    id: 'video',
    title: 'H.264 video in a browser that cannot decode it',
    viewModel: model({
      codec: { selected: 'h264.avcc' },
      stream: { ...LIVE.stream, phase: 'opening', selectedCodec: 'h264.avcc', activeRenderer: 'webcodecs', lastFrameUrl: undefined },
    }),
  },
  {
    id: 'setup',
    title: 'Capture unavailable',
    viewModel: model({
      resource: {
        ...LIVE.resource!,
        capture: {
          status: 'unavailable',
          sourceId: 'source_dev',
          reasonCode: 'capture_unavailable',
        },
      },
      controls: { ...LIVE.controls, canWatch: false },
    }),
  },
];

export function SimulatorSpecimen(
  props: Readonly<{ only: string | null; phone: boolean; width?: number | null }>,
) {
  const frames = props.only
    ? FRAMES.filter((frame) => frame.id === props.only)
    : FRAMES;
  return (
    <SurfaceStateSizeProvider size={props.phone ? 'phone' : 'details'}>
      <ScrollView style={styles.root} contentContainerStyle={styles.content}>
        {frames.map((frame) => (
          <View key={frame.id} style={styles.entry}>
            <Text style={styles.label}>{frame.title}</Text>
            <View
              testID={`simulator-specimen-${frame.id}`}
              style={[props.phone ? styles.framePhone : styles.frame, props.width ? { width: props.width } : null]}
            >
              <SimulatorPreviewPane
                sessionId="session_dev"
                viewModel={frame.viewModel}
                actions={ACTIONS}
                testID={`simulator-specimen-${frame.id}-pane`}
              />
            </View>
          </View>
        ))}
      </ScrollView>
    </SurfaceStateSizeProvider>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, backgroundColor: theme.colors.surface.inset },
  content: { padding: theme.space.s16, gap: theme.space.s24 },
  entry: { gap: theme.space.s8 },
  label: { ...Typography.variant('meta'), color: theme.colors.text.secondary },
  frame: {
    width: 902,
    height: 640,
    overflow: 'hidden',
    backgroundColor: theme.colors.surface.base,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border.default,
  },
  framePhone: {
    width: '100%',
    height: 720,
    overflow: 'hidden',
    backgroundColor: theme.colors.surface.base,
  },
}));

export default SimulatorSpecimen;
