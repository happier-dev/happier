import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';

import { renderScreen, type RenderScreenResult } from '@/dev/testkit';
import { installPopoverCommonModuleMocks } from '@/components/ui/popover/popoverTestHelpers';

// The device platform is the boundary (a native Popover mounts in-tree); the shell mount, attempt
// projection, glance presentation and the glance itself stay real.
installPopoverCommonModuleMocks({
  reactNative: async () => {
    const { createReactNativeNativeMock } =
      await import('@/dev/testkit/mocks/reactNative');
    const viewport = { width: 1024, height: 768 };
    return createReactNativeNativeMock(
      { platformOS: 'ios' },
      {
        useWindowDimensions: () => viewport,
        Dimensions: { get: () => ({ ...viewport, scale: 1, fontScale: 1 }) },
      },
    );
  },
});

const { getStorage } = await import('@/sync/domains/state/storage');
const { voiceSettingsParse } =
  await import('@/sync/domains/settings/voiceSettings');
const { primeServerFeaturesSnapshot, resetServerFeaturesClientForTests } =
  await import('@/sync/api/capabilities/serverFeaturesClient');
const { registerVoiceAdapters } =
  await import('@/voice/session/voiceAdapterRegistry');
const { createLocalConversationVoiceAdapter } =
  await import('@/voice/adapters/localConversation/localConversationAdapter');
const { resetVoiceSessionStoreForTests, setVoiceSessionSnapshot } =
  await import('@/voice/session/voiceSessionStore');
const { SessionCockpitChromeRegistryProvider } =
  await import('@/components/workspaceCockpit/session/SessionCockpitChromeRegistry');
const { setVoiceGlanceOpen } = await import('./voiceCompanionSectionReveal');
const { VoicePresenceAppShellMount } =
  await import('./VoicePresenceAppShellMount');

const initialStorage = getStorage().getState();
let screen: RenderScreenResult | null = null;

describe('the open glance and its container', () => {
  beforeEach(() => {
    resetVoiceSessionStoreForTests();
    resetServerFeaturesClientForTests();
    primeServerFeaturesSnapshot({
      snapshot: {
        status: 'ready',
        features: FeaturesResponseSchema.parse({
          features: { voice: { enabled: true } },
          capabilities: {},
        }),
      },
    });
    registerVoiceAdapters([createLocalConversationVoiceAdapter()]);
    setVoiceSessionSnapshot({
      adapterId: 'local_conversation',
      sessionId: 'voice-shell',
      status: 'connected',
      mode: 'listening',
      canStop: true,
    });
  });
  afterEach(async () => {
    await screen?.unmount();
    screen = null;
    getStorage().setState(initialStorage, true);
    registerVoiceAdapters([]);
    resetVoiceSessionStoreForTests();
    resetServerFeaturesClientForTests();
  });

  it.each(['island', 'orb'] as const)(
    "lets the open glance take the %s's place, so the call's state and requests show once",
    async (container) => {
      getStorage().setState((state) => ({
        settings: {
          ...state.settings,
          experiments: true,
          featureToggles: {
            ...state.settings.featureToggles,
            voice: true,
            'voice.agent': true,
          },
          voice: voiceSettingsParse({
            providerId: 'local_conversation',
            providers: {
              local_conversation: {
                schemaVersion: 1,
                config: { conversationMode: 'agent' },
              },
            },
          }),
        },
        localSettings: {
          ...state.localSettings,
          voicePresenceContainer: container,
        },
      }));
      screen = await renderScreen(
        <SessionCockpitChromeRegistryProvider>
          <VoicePresenceAppShellMount />
        </SessionCockpitChromeRegistryProvider>,
      );
      // The float places its container once the host and the container report their measured size.
      await act(async () => {
        screen!.findByTestId('voice-presence-float-host')!.props.onLayout({ nativeEvent: { layout: { width: 1024, height: 768 } } });
      });
      const frame = screen.findByTestId('voice-presence-float-body')!.props.style[0];
      await act(async () => {
        screen!.findByTestId('voice-presence-float-body')!.props.onLayout({ nativeEvent: { layout: { width: frame.width, height: frame.height } } });
      });
      const capsule = () => screen!.findHostByTestId('voice-presence-capsule')!;
      const yielded = () => {
        const style = [capsule().props.style]
          .flat(Infinity)
          .filter(Boolean) as Array<{ opacity?: number }>;
        return (
          style.some((entry) => entry.opacity === 0) &&
          capsule().props['aria-hidden'] === true
        );
      };
      expect(yielded()).toBe(false);
      await act(async () => {
        setVoiceGlanceOpen(true);
      });
      // The container stays mounted (the glance anchors to it and returns focus there) but is not drawn twice.
      expect(screen.findByTestId('voice-glance-popover')).not.toBeNull();
      expect(yielded()).toBe(true);
      await act(async () => {
        setVoiceGlanceOpen(false);
      });
      expect(yielded()).toBe(false);
    },
  );
});
