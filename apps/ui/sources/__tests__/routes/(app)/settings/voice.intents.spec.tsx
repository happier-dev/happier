import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderSettingsView, standardCleanup } from '@/dev/testkit';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { installVoiceSettingsRouteModuleMocks } from './voiceSettingsRouteTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const push = vi.fn();
const replace = vi.fn();
const routeParams = vi.hoisted(() => ({
  current: {} as Record<string, string | string[] | undefined>,
}));

vi.mock('@/auth/context/AuthContext', () => ({
  useAuth: () => ({ credentials: null }),
}));

installVoiceSettingsRouteModuleMocks({
  routerModule: async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({
      params: () => routeParams.current,
      router: { push, replace },
    }).module;
  },
});

// Load the real route graph after installing boundaries, outside the mount assertions.
const VoiceSettingsScreen = (await import('@/app/(app)/settings/voice')).default;

afterEach(() => {
  push.mockClear();
  replace.mockClear();
  routeParams.current = {};
  standardCleanup();
});

describe('Voice settings intent index', () => {
  it('opens on the Voice hub: both modes and every destination', async () => {
    const screen = await renderSettingsView(<VoiceSettingsScreen />);

    // Pressing each destination is covered by VoiceSettingsIntentIndexScreen.test.tsx.
    for (const testID of [
      'settings.voice.intent.dictation',
      'settings.voice.intent.conversations',
      'settings.voice.intent.privacy',
      'settings.voice.intent.advanced',
      'settings.voice.intent.history',
    ]) {
      expect(screen.findByTestId(testID)).toBeTruthy();
    }
    expect(screen.findByTestId('settings.voice.provider.off')).toBeNull();
  });

  it.each([
    ['provider', SETTINGS_ROUTES.voiceConversations],
    ['privacy', SETTINGS_ROUTES.voicePrivacy],
  ] as const)('redirects the legacy %s focus link to its intent detail', async (focus, route) => {
    routeParams.current = { focus };
    await renderSettingsView(<VoiceSettingsScreen />);

    expect(replace).toHaveBeenCalledWith({ pathname: route, params: { focus } });
  });
});
