import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { installLocalStorageMock } from '@/auth/storage/tokenStorage.web.testHelpers';

vi.mock('react-native', () => ({
  Platform: { OS: 'web' },
}));

vi.mock('expo-secure-store', () => ({}));

vi.mock('@/text', () => ({
  t: (key: string) => key,
}));

vi.mock('@/modal', () => ({
  Modal: {
    alert: vi.fn(),
    confirm: vi.fn(),
    prompt: vi.fn(),
    show: vi.fn(),
  },
}));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function randomScope(): string {
  return `test_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

async function renderHook<T>(useValue: () => T): Promise<T> {
  let current: T | null = null;

  function Test() {
    current = useValue();
    return null;
  }

  await act(async () => {
    renderer.create(React.createElement(Test));
    await Promise.resolve();
  });

  if (!current) throw new Error('Hook did not render');
  return current;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.resetModules();
});

describe('useServerSettingsServerProfileActions (remove server)', () => {
  it('clears server-scoped credentials so re-adding the server does not resurrect auth', async () => {
    process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
    const localStorageHandle = installLocalStorageMock();

    const { Modal } = await import('@/modal');
    // Current behavior prompts twice: "remove" then optionally "also sign out".
    // This test asserts we clear credentials even if the second prompt is declined.
    (Modal.confirm as any)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    const profiles = await import('@/sync/domains/server/serverProfiles');
    const profile = profiles.upsertServerProfile({
      serverUrl: 'https://server-a.example.test',
      name: 'Server A',
    });
    profiles.setActiveServerId(profile.id, { scope: 'device' });

    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    await expect(TokenStorage.setCredentials({ token: 'token-a', secret: 'secret-a' })).resolves.toBe(true);
    await expect(TokenStorage.getCredentialsForServerUrl(profile.serverUrl)).resolves.toEqual({
      token: 'token-a',
      secret: 'secret-a',
    });

    let revision = 0;
    const setRevision = (next: any) => {
      revision = typeof next === 'function' ? next(revision) : next;
    };

    const { useServerSettingsServerProfileActions } = await import('./useServerSettingsServerProfileActions');
    const actions = await renderHook(() =>
      useServerSettingsServerProfileActions({
        authStatusByServerId: {},
        onSwitchServerById: vi.fn(async () => {}),
        onAfterSignedOutSwitch: vi.fn(),
        setRevision: setRevision as any,
        setServerSelectionActiveTargetKind: vi.fn(),
        setServerSelectionActiveTargetId: vi.fn(),
      }),
    );

    await actions.onRemoveServer(profile);
    expect(revision).toBeGreaterThan(0);

    const readded = profiles.upsertServerProfile({ serverUrl: profile.serverUrl, name: 'Server A (again)' });
    expect(readded.id).toBe(profile.id);
    await expect(TokenStorage.getCredentialsForServerUrl(profile.serverUrl)).resolves.toBeNull();

    localStorageHandle.restore();
  });
});

