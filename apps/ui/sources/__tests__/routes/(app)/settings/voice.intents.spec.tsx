import React from 'react';
import { act } from 'react-test-renderer';
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

installVoiceSettingsRouteModuleMocks({
  routerModule: async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({
      params: () => routeParams.current,
      router: { push, replace },
    }).module;
  },
});

afterEach(() => {
  push.mockClear();
  replace.mockClear();
  routeParams.current = {};
  standardCleanup();
});

describe('Voice settings intent index', () => {
  it('shows four concise, accessible drill-in rows instead of provider controls', async () => {
    const VoiceSettingsScreen = (await import('@/app/(app)/settings/voice')).default;
    const screen = await renderSettingsView(<VoiceSettingsScreen />);

    const expected = [
      ['settingsVoice.intents.dictation.title', 'settingsVoice.intents.dictation.subtitle'],
      ['settingsVoice.intents.conversations.title', 'settingsVoice.intents.conversations.subtitle'],
      ['settingsVoice.intents.privacy.title', 'settingsVoice.intents.privacy.subtitle'],
      ['settingsVoice.intents.advanced.title', 'settingsVoice.intents.advanced.subtitle'],
    ] as const;

    for (const [title, subtitle] of expected) {
      const row = screen.findRowByTitle(title);
      expect(row).toBeTruthy();
      expect(row?.props.subtitle).toBe(subtitle);
      expect(row?.props.accessibilityLabel).toBe(`${title}. ${subtitle}`);
      expect(row?.props.showChevron).toBe(true);
    }

    expect(screen.findRowByTitle('settingsVoice.mode.off')).toBeNull();
  });

  it.each([
    ['settingsVoice.intents.dictation.title', SETTINGS_ROUTES.voiceDictation],
    ['settingsVoice.intents.conversations.title', SETTINGS_ROUTES.voiceConversations],
    ['settingsVoice.intents.privacy.title', SETTINGS_ROUTES.voicePrivacy],
    ['settingsVoice.intents.advanced.title', SETTINGS_ROUTES.voiceAdvanced],
  ] as const)('drills into %s', async (title, route) => {
    const VoiceSettingsScreen = (await import('@/app/(app)/settings/voice')).default;
    const screen = await renderSettingsView(<VoiceSettingsScreen />);

    await act(async () => screen.pressRowByTitle(title));

    expect(push).toHaveBeenCalledWith(route);
  });

  it.each([
    ['provider', SETTINGS_ROUTES.voiceConversations],
    ['privacy', SETTINGS_ROUTES.voicePrivacy],
  ] as const)('redirects the legacy %s focus link to its intent detail', async (focus, route) => {
    routeParams.current = { focus };
    const VoiceSettingsScreen = (await import('@/app/(app)/settings/voice')).default;
    await renderSettingsView(<VoiceSettingsScreen />);

    expect(replace).toHaveBeenCalledWith({ pathname: route, params: { focus } });
  });
});
