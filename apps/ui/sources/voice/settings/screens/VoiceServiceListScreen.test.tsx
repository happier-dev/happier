import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { AuthProvider } from '@/auth/context/AuthContext';
import { renderScreen } from '@/dev/testkit';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { getPersistenceStorage } from '@/sync/domains/state/persistenceStorage';
import { storage } from '@/sync/domains/state/storageStore';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { useVoiceConversationsReadinessModel } from '@/voice/settings/panels/VoiceProviderSection';

vi.mock('expo-router', async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
  return createExpoRouterMock({ pathname: () => '/settings/voice/service' }).module;
});

describe('VoiceServiceListScreen', () => {
  it('does not recompute service readiness for unrelated Account settings but observes its credential roots', async () => {
    getPersistenceStorage().clearAll();
    await storage.getState().activateSettingsScope({ serverId: 'voice-readiness', accountId: 'voice-account' });
    storage.getState().applySettings(settingsDefaults, 1);
    let renders = 0;
    const hook = await renderHook(() => {
      renders++;
      return useVoiceConversationsReadinessModel({ voice: settingsDefaults.voice, setVoice: () => {}, happierVoiceSupported: false });
    }, { wrapper: ({ children }) => <AuthProvider initialCredentials={{ token: 'token-1', secret: 'secret-1' }}>{children}</AuthProvider> });
    const baseline = renders;
    const model = hook.getCurrent();
    await act(async () => {
      storage.getState().applySettingsLocal({ showLineNumbers: !storage.getState().settings.showLineNumbers });
    });
    expect(renders - baseline).toBe(0);
    expect(hook.getCurrent()).toBe(model);
    await act(async () => {
      storage.getState().applySettingsLocal({ connectedServicesProfileLabelByKey: { 'openai:test': 'Updated account label' } });
    });
    expect(renders).toBeGreaterThan(baseline);
    await hook.unmount();
  });
  it('keeps contributed service identities visible in the phone picker', async () => {
    const { VoiceServiceListScreen } = await import('./VoiceServiceListScreen');
    const screen = await renderScreen(
      <AuthProvider initialCredentials={{ token: 'token-1', secret: 'secret-1' }}>
        <VoiceServiceListScreen />
      </AuthProvider>,
    );
    const identities = screen.root.findAll((node) => typeof node.props.legacyServiceId === 'string')
      .map((mark) => mark.props.legacyServiceId);
    expect(identities).toContain('openai');
    expect(screen.findByTestId('settings.voice.provider.off')).toBeTruthy();
  });
});
