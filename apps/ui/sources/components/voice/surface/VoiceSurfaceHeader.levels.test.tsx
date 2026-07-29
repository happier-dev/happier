import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const reducedMotionState = { current: false };
const platformState = { OS: 'android' };

vi.mock('react-native', () => ({
  View: 'View',
  Pressable: 'Pressable',
  Platform: platformState,
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('@/components/ui/status/StatusDot', () => ({ StatusDot: 'StatusDot' }));
vi.mock('@/components/ui/text/Text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/buttons/IconButton', () => ({ IconButton: 'IconButton' }));
vi.mock('./VoiceLevelVisualizer', () => ({ VoiceLevelVisualizer: 'VoiceLevelVisualizer' }));
vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
  useReducedMotionPreference: () => reducedMotionState.current,
}));

const baseProps = {
  announceSubtitle: false,
  bargeInLabel: 'barge in',
  canBargeIn: false,
  isMicCaptureActive: false,
  isMuted: false,
  micBadgeStyle: {},
  micIconColor: '#fff',
  microphoneActiveLabel: 'microphone active',
  microphoneInactiveLabel: 'microphone inactive',
  microphoneMutedLabel: 'microphone muted',
  modeTestID: 'voice-mode',
  onBargeIn: () => undefined,
  dataDisclosureLabel: 'How Grok handles voice data',
  dataDisclosureTestID: 'voice-surface-data:sidebar',
  onOpenDataDisclosure: () => undefined,
  showDataDisclosure: true,
  statusDotColor: '#0f0',
  statusLabel: 'active',
  providerLabel: 'Grok · BYOK',
  statusTextColor: '#fff',
  styles: {},
  subtitle: null,
  subtitleColor: '#aaa',
} as const;

describe('VoiceSurfaceHeader level semantics', () => {
  beforeEach(() => {
    platformState.OS = 'android';
  });

  it('keeps the selected provider/credential cue visible without exposing a key', async () => {
    const { VoiceSurfaceHeader } = await import('./VoiceSurfaceHeader');
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<VoiceSurfaceHeader {...baseProps} surfaceState="idle" />);
    });
    expect(tree.root.findByProps({ children: 'Grok · BYOK' })).toBeTruthy();
  });

  it('keeps essential status, provider, target, and error text visually reachable without one-line clamps', async () => {
    const { VoiceSurfaceHeader } = await import('./VoiceSurfaceHeader');
    const statusLabel = 'A deliberately long localized Voice connection status';
    const providerLabel = 'A deliberately long localized provider and account identity';
    const subtitle = 'A deliberately long exact target and recoverable error explanation';
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <VoiceSurfaceHeader
          {...baseProps}
          providerLabel={providerLabel}
          statusLabel={statusLabel}
          subtitle={subtitle}
          surfaceState="error"
        />,
      );
    });

    expect(tree.root.findByProps({ children: statusLabel }).props.numberOfLines).toBeUndefined();
    expect(tree.root.findByProps({ children: providerLabel }).props.numberOfLines).toBeUndefined();
    expect(tree.root.findByProps({ children: subtitle }).props.numberOfLines).toBeUndefined();
  });

  it('announces the specific recoverable error once instead of duplicating a generic status announcement', async () => {
    const { VoiceSurfaceHeader } = await import('./VoiceSurfaceHeader');
    const subtitle = 'Reconnect the selected machine to retry Codex Voice.';
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <VoiceSurfaceHeader
          {...baseProps}
          announceSubtitle
          statusLabel="Connection error"
          subtitle={subtitle}
          surfaceState="permission_required"
        />,
      );
    });

    expect(tree.root.findByProps({ children: 'Connection error' }).props.accessibilityLiveRegion).toBeUndefined();
    expect(tree.root.findByProps({ children: subtitle }).props.accessibilityLiveRegion).toBe('polite');
    expect(tree.root.findAll((node) => node.props.accessibilityLiveRegion === 'polite')).toHaveLength(1);
  });

  it('uses input level while microphone capture is active', async () => {
    const { VoiceSurfaceHeader } = await import('./VoiceSurfaceHeader');
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <VoiceSurfaceHeader
          {...baseProps}
          isMicCaptureActive
          surfaceState="listening"
        />,
      );
    });
    expect(tree.root.findByType('VoiceLevelVisualizer' as any).props).toMatchObject({
      channel: 'input',
      fallbackPulse: false,
    });
  });

  it('uses output level with an honest state fallback while speaking', async () => {
    const { VoiceSurfaceHeader } = await import('./VoiceSurfaceHeader');
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<VoiceSurfaceHeader {...baseProps} surfaceState="speaking" />);
    });
    expect(tree.root.findByType('VoiceLevelVisualizer' as any).props).toMatchObject({
      channel: 'output',
      fallbackPulse: true,
    });
  });

  it('shows live microphone capture while a non-barge-in full-duplex provider is speaking', async () => {
    const { VoiceSurfaceHeader } = await import('./VoiceSurfaceHeader');
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <VoiceSurfaceHeader
          {...baseProps}
          isMicCaptureActive
          surfaceState="speaking"
        />,
      );
    });

    expect(tree.root.findByProps({ testID: 'voice-mode' }).props.accessibilityLabel).toBe('microphone active');
    expect(tree.root.findByType('Ionicons' as any).props.name).toBe('mic');
    expect(tree.root.findByType('VoiceLevelVisualizer' as any).props).toMatchObject({
      channel: 'input',
      fallbackPulse: false,
    });
  });

  it('shows a muted microphone independently of full-duplex capture and speaking output', async () => {
    const { VoiceSurfaceHeader } = await import('./VoiceSurfaceHeader');
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <VoiceSurfaceHeader
          {...baseProps}
          isMicCaptureActive
          isMuted
          surfaceState="speaking"
        />,
      );
    });

    expect(tree.root.findByProps({ testID: 'voice-mode' }).props.accessibilityLabel).toBe('microphone muted');
    expect(tree.root.findByType('Ionicons' as any).props.name).toBe('mic-off-outline');
    expect(tree.root.findByType('VoiceLevelVisualizer' as any).props).toMatchObject({
      channel: 'output',
      fallbackPulse: true,
    });
  });

  it('exposes a compact provider-data disclosure button with a real 48dp Android target', async () => {
    const { VoiceSurfaceHeader } = await import('./VoiceSurfaceHeader');
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<VoiceSurfaceHeader {...baseProps} surfaceState="idle" />);
    });
    const disclosure = tree.root.findByProps({ accessibilityLabel: 'How Grok handles voice data' });
    expect(disclosure.props.testID).toBe('voice-surface-data:sidebar');
    expect(disclosure.props.size).toBe(48);
    expect(disclosure.props.iconName).toBe('information-circle-outline');
    expect(tree.root.findAllByProps({ children: 'Privacy' })).toHaveLength(0);
  });

  it('does not invent a disclosure action when the selected provider owns no disclosure copy', async () => {
    const { VoiceSurfaceHeader } = await import('./VoiceSurfaceHeader');
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <VoiceSurfaceHeader
          {...baseProps}
          showDataDisclosure={false}
          surfaceState="idle"
        />,
      );
    });
    expect(tree.root.findAllByProps({
      accessibilityLabel: 'How Grok handles voice data',
    })).toHaveLength(0);
  });

  it('uses the canonical 48dp Android target for barge-in after badge styles', async () => {
    const { VoiceSurfaceHeader } = await import('./VoiceSurfaceHeader');
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <VoiceSurfaceHeader
          {...baseProps}
          canBargeIn
          micBadgeStyle={{ minWidth: 44, minHeight: 44 }}
          styles={{ micBadge: { minWidth: 44, minHeight: 44 } }}
          surfaceState="speaking"
        />,
      );
    });
    const bargeIn = tree.root.findByProps({ accessibilityLabel: 'barge in' });
    expect(bargeIn.props.accessibilityValue).toEqual({ text: 'microphone inactive' });
    expect(bargeIn.props.style({ pressed: false })).toEqual(expect.arrayContaining([
      expect.objectContaining({ minWidth: 48, minHeight: 48 }),
    ]));
  });

  it('uses the localized status pulse for thinking without animating the whole surface', async () => {
    const { VoiceSurfaceHeader } = await import('./VoiceSurfaceHeader');
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<VoiceSurfaceHeader {...baseProps} surfaceState="thinking" />);
    });
    expect(tree.root.findByType('StatusDot' as any).props.isPulsing).toBe(true);
  });

  it('keeps the thinking status semantic but static when reduced motion is enabled', async () => {
    reducedMotionState.current = true;
    const { VoiceSurfaceHeader } = await import('./VoiceSurfaceHeader');
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<VoiceSurfaceHeader {...baseProps} surfaceState="thinking" />);
    });
    expect(tree.root.findByType('StatusDot' as any).props.isPulsing).toBe(false);
    reducedMotionState.current = false;
  });

  it('exposes its stable status text as a programmatically focusable web return target', async () => {
    platformState.OS = 'web';
    const statusTarget = { focus: vi.fn(), isConnected: true };
    const statusFocusRef = React.createRef<typeof statusTarget>();
    const { VoiceSurfaceHeader } = await import('./VoiceSurfaceHeader');
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <VoiceSurfaceHeader
          {...baseProps}
          statusFocusRef={statusFocusRef}
          surfaceState="idle"
        />,
        {
          createNodeMock: (element) => {
            const elementProps = element.props as Readonly<{ children?: React.ReactNode }>;
            return element.type === 'Text' && elementProps.children === baseProps.statusLabel
              ? statusTarget
              : {};
          },
        },
      );
    });

    const status = tree.root.findByProps({ children: baseProps.statusLabel });
    expect(status.props.tabIndex).toBe(-1);
    expect(statusFocusRef.current).toBe(statusTarget);
  });
});
