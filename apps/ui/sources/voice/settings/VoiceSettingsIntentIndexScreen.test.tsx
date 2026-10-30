import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { AuthProvider } from '@/auth/context/AuthContext';
import { DestinationInstanceHost } from '@/components/appShell/workspace/DestinationInstanceHost';
import type { DestinationNavigation } from '@/components/appShell/workspace/DestinationInstanceHost';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

const routerMock = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));

vi.mock('expo-router', async () => {
  // The page header (SettingsPageHeader) reads the navigation chrome, so the full router boundary is needed.
  const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
  const mock = createExpoRouterMock({ pathname: () => '/settings/voice' });
  return { ...mock.module, useRouter: () => routerMock };
});
// The hub reads permission passively; Node has no native Expo permission API.
vi.mock('expo-audio', async original => ({
  ...await original<typeof import('expo-audio')>(),
  AudioModule: { getRecordingPermissionsAsync: async () => ({
    granted: false, status: 'undetermined', canAskAgain: true, expires: 'never',
  }) },
}));

describe('VoiceSettingsIntentIndexScreen', () => {
  it('opens intent cards in the workspace that hosts the hub', async () => {
    const { VoiceSettingsIntentIndexScreen } = await import('./VoiceSettingsIntentIndexScreen');
    for (const [testID, route] of [
      ['settings.voice.intent.dictation', SETTINGS_ROUTES.voiceDictation],
      ['settings.voice.intent.conversations', SETTINGS_ROUTES.voiceConversations],
      ['settings.voice.intent.privacy', SETTINGS_ROUTES.voicePrivacy],
      ['settings.voice.intent.advanced', SETTINGS_ROUTES.voiceAdvanced],
      ['settings.voice.intent.history', SETTINGS_ROUTES.voiceHistory],
    ] as const) {
      function HostedHub() {
        const [destination, setDestination] = React.useState('/settings/voice');
        const navigation = React.useMemo<DestinationNavigation>(() => ({
          push: (href) => setDestination(String(href)),
          replace: (href) => setDestination(String(href)),
          back: () => setDestination('/settings/voice'),
        }), []);
        return <DestinationInstanceHost tabId="voice-qa-tab" ref={{ kind: 'voice', params: {} }}
          pathname={destination} focused visible navigation={navigation}>
          {destination === '/settings/voice' ? <VoiceSettingsIntentIndexScreen />
            : <Text testID="voice-qa-open-destination">{destination}</Text>}
        </DestinationInstanceHost>;
      }
      const screen = await renderScreen(<AuthProvider initialCredentials={{ token: 'token-1', secret: 'secret-1' }}>
        <HostedHub />
      </AuthProvider>);
      await screen.pressByTestIdAsync(testID);
      expect(screen.findByTestId('voice-qa-open-destination')?.props.children).toBe(route);
      await screen.unmount();
    }
  });

  it('shows both modes as pipelines and opens every Voice destination', async () => {
    const { settingsDefaults } = await import('@/sync/domains/settings/settings');
    const { readLocalConversationVoiceSettings, writeLocalConversationVoiceSettings } = await import('@/sync/domains/settings/voiceSettings');
    const { createVoiceSettingsAccountTestHarness } = await import('./panels/voiceSettingsAccountTestHarness');
    const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
    const local = readLocalConversationVoiceSettings(settingsDefaults.voice);
    const voice = writeLocalConversationVoiceSettings({ ...settingsDefaults.voice, providerId: 'local_conversation',
      dictation: { ...settingsDefaults.voice.dictation, sttBinding: 'explicit',
        stt: { ...settingsDefaults.voice.dictation.stt, provider: 'device' } },
    }, { ...local, conversationMode: 'direct_session',
      stt: { ...local.stt, provider: 'device' }, tts: { ...local.tts, provider: 'device' } });
    const account = await createVoiceSettingsAccountTestHarness(settingsDefaults);
    const { VoiceSettingsIntentIndexScreen } = await import('./VoiceSettingsIntentIndexScreen');
    let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
    try {
      // The fixture's existing writer updates persisted Voice roots together
      // with their runtime projection, at a newer acknowledged revision.
      account.replaceVoice(voice);
      expect(account.settings.voice.providerId).toBe('local_conversation');
      screen = await renderScreen(
        <InjectedAuthProvider credentials={account.credentials}>
          <VoiceSettingsIntentIndexScreen />
        </InjectedAuthProvider>,
      );
      for (const [testID, roles, placement] of [
        ['settings.voice.intent.dictation', [
          `${t('settingsVoice.pages.pipeline.hear')}: ${t('settingsVoice.local.deviceStt')}`,
          `${t('settingsVoice.pages.pipeline.write')}: ${t('settingsVoice.pages.pipeline.intoYourMessageTitle')}`,
        ], t('settingsVoice.pages.pipeline.onThisDevice')],
        ['settings.voice.intent.conversations', [
          `${t('settingsVoice.pages.pipeline.hear')}: ${t('settingsVoice.local.deviceStt')}`,
          `${t('settingsVoice.pages.pipeline.think')}: ${t('settingsVoice.pages.pipeline.theSessionYoureIn')}`,
          `${t('settingsVoice.pages.pipeline.speak')}: ${t('settingsVoice.local.deviceTts')}`,
        ], t('settingsVoice.pages.pipeline.inTheSession')],
      ] as const) {
        const pipeline = screen.findByTestId(testID);
        expect(pipeline).not.toBeNull();
        const labels = pipeline!.findAll((node) => typeof node.type === 'string'
          && typeof node.props.accessibilityLabel === 'string').map((node) => node.props.accessibilityLabel);
        expect(labels).toEqual(expect.arrayContaining([...roles]));
        const text = pipeline!.findAll((node) => typeof node.type === 'string'
          && typeof node.props.children === 'string').map((node) => node.props.children).join(' ');
        expect(text).toContain(placement);
      }

      const destinations = [
        ['settings.voice.intent.dictation', SETTINGS_ROUTES.voiceDictation],
        ['settings.voice.intent.conversations', SETTINGS_ROUTES.voiceConversations],
        ['settings.voice.intent.privacy', SETTINGS_ROUTES.voicePrivacy],
        ['settings.voice.intent.advanced', SETTINGS_ROUTES.voiceAdvanced],
        ['settings.voice.intent.history', SETTINGS_ROUTES.voiceHistory],
      ] as const;
      for (const [testID, route] of destinations) {
        routerMock.push.mockClear();
        await screen.pressByTestIdAsync(testID);
        expect(routerMock.push).toHaveBeenCalledExactlyOnceWith(route);
      }
    } finally {
      await screen?.unmount();
      await account.dispose();
    }
  });
});
