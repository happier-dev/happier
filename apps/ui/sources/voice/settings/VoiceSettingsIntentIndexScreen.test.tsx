import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { AuthProvider } from '@/auth/context/AuthContext';

const routerMock = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));

vi.mock('expo-router', async () => {
  // The page header (SettingsPageHeader) reads the navigation chrome, so the full router boundary is needed.
  const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
  const mock = createExpoRouterMock({ pathname: () => '/settings/voice' });
  return { ...mock.module, useRouter: () => routerMock };
});

vi.mock('@/utils/navigation/useNavigationFocusReturn', () => ({
  useNavigationFocusReturn: () => (navigate: () => void) => navigate(),
}));

describe('VoiceSettingsIntentIndexScreen', () => {
  it('shows both modes as pipelines and opens every Voice destination', async () => {
    const { VoiceSettingsIntentIndexScreen } = await import('./VoiceSettingsIntentIndexScreen');
    // Signed-in credentials are the real auth boundary the hub's passive readiness reads.
    const screen = await renderScreen(
      <AuthProvider initialCredentials={{ token: 'token-1', secret: 'secret-1' }}>
        <VoiceSettingsIntentIndexScreen />
      </AuthProvider>,
    );

    expect(screen.findByTestId('settings.voice.intent.dictation')).toBeTruthy();
    expect(screen.findByTestId('settings.voice.intent.conversations')).toBeTruthy();

    const destinations = [
      ['settings.voice.intent.privacy', SETTINGS_ROUTES.voicePrivacy],
      ['settings.voice.intent.advanced', SETTINGS_ROUTES.voiceAdvanced],
      ['settings.voice.intent.history', SETTINGS_ROUTES.voiceHistory],
    ] as const;
    for (const [testID, route] of destinations) {
      routerMock.push.mockClear();
      screen.pressByTestId(testID);
      expect(routerMock.push).toHaveBeenCalledWith(route);
    }
  });
});
