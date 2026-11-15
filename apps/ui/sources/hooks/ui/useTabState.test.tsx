import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createAccountKvHttpFixture } from '@/dev/testkit/fixtures/accountKvHttpFixture';
import {
  createHomeGovernanceHarness,
  installHomeGovernanceBoundaries,
} from '@/dev/testkit/harness/homeGovernanceHarness';

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
const { useTabState } = await import('./useTabState');
const { getStorage } = await import('@/sync/domains/state/storage');
const { clearPersistenceStorage, getPersistenceStorage } = await import('@/sync/domains/state/persistenceStorage');

const kv = createAccountKvHttpFixture();
const serverUrl = 'https://tab-state.example.test';
const tabKey = 'ui:active-tab';
let serverId: string;
let beforeMutation: (() => Promise<void>) | null = null;

beforeEach(async () => {
  await home.reset();
  kv.reset();
  clearPersistenceStorage();
  beforeMutation = null;
  serverId = await home.addHome({ name: 'Tab state', serverUrl, accountId: 'tab-account', currentAccount: true });
  const credentials = await TokenStorage.getCredentialsForServerUrl(serverUrl, { serverId });
  if (!credentials) throw new Error('Expected stored Account credentials');
  setRuntimeFetch(async (input, init) => {
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
    if (path === '/v1/kv' || path.startsWith('/v1/kv/')) {
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      if (headers.get('Authorization') !== `Bearer ${credentials.token}`) {
        return Response.json({ error: 'invalid_token' }, { status: 401 });
      }
    }
    if (path === '/v1/kv' && init?.method === 'POST') {
      const wait = beforeMutation;
      beforeMutation = null;
      await wait?.();
    }
    return await kv.handleFetch(input, init) ?? await home.request(input, init);
  });
});

afterEach(async () => {
  standardCleanup();
  beforeMutation = null;
  await home.reset();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function seedTab(value: string, version = 3) {
  for (let previousVersion = -1; previousVersion < version; previousVersion += 1) {
    const response = await kv.handleFetch(`${serverUrl}/v1/kv`, {
      method: 'POST',
      body: JSON.stringify({ mutations: [{ key: tabKey, value, version: previousVersion }] }),
    });
    expect(response?.status).toBe(200);
  }
}

async function renderTabState() {
  const credentials = await TokenStorage.getCredentialsForServerUrl(serverUrl, { serverId });
  if (!credentials) throw new Error('Expected stored Account credentials');
  return await renderHook(() => useTabState(), {
    wrapper: ({ children }) => <InjectedAuthProvider credentials={credentials}>{children}</InjectedAuthProvider>,
  });
}

describe('useTabState', () => {
  // Owner ruling 2026-11-15: the phone's last-selected tab is device-local. A tab tap wrote
  // `ui:active-tab` to Account KV and woke the app, the daemon and the session host.
  it('keeps a tab tap on this device: zero server requests, restored on the next mount', async () => {
    const hook = await renderTabState();
    const requestsBefore = kv.readRequests().length;
    const writes = vi.spyOn(getPersistenceStorage(), 'set');
    const settingsMutation = vi.spyOn(getStorage().getState(), 'applyLocalSettings');

    await act(async () => { await hook.getCurrent().setActiveTab('inbox'); });
    await act(async () => { await hook.getCurrent().setActiveTab('projects'); });

    expect(hook.getCurrent()).toMatchObject({ activeTab: 'projects' });
    expect(kv.readRequests().slice(requestsBefore)).toEqual([]);
    expect(kv.read(tabKey)).toBeUndefined();
    expect(writes.mock.calls.filter(([key]) => key === 'settings' || key === 'local-settings')).toEqual([]);
    expect(settingsMutation).not.toHaveBeenCalled();
    expect(getPersistenceStorage().getString('ui-state:main-app-tab-v1:active')).toBe('"projects"');

    await hook.unmount();
    const remounted = await renderTabState();
    expect(remounted.getCurrent()).toMatchObject({ activeTab: 'projects' });
    expect(kv.readRequests().slice(requestsBefore)).toEqual([]);
  });

  it('leaves a 0.2 Account value in place and never reads it', async () => {
    await seedTab('inbox');
    const requestsBefore = kv.readRequests().length;
    const hook = await renderTabState();

    expect(hook.getCurrent()).toMatchObject({ activeTab: 'sessions' });
    expect(kv.readRequests().slice(requestsBefore)).toEqual([]);
    expect(kv.read(tabKey)).toEqual({ key: tabKey, value: 'inbox', version: 3 });
  });

  it('keeps Inbox selected while unavailable and restores it when its feature becomes available', async () => {
    vi.stubEnv('EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY', 'inbox.global');
    const hook = await renderTabState();
    await act(async () => { hook.getCurrent().setActiveTab('inbox'); });
    expect(hook.getCurrent().activeTab).toBe('sessions');
    const writes = vi.spyOn(getPersistenceStorage(), 'set');
    vi.stubEnv('EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY', '');
    await act(async () => {
      // Policy is normally fixed for the loaded build. Refresh its real decision
      // through a consumed settings change when this environment boundary changes.
      getStorage().getState().applySettings({ experiments: !getStorage().getState().settings.experiments });
    });
    expect(hook.getCurrent().activeTab).toBe('inbox');
    expect(writes.mock.calls.filter(([key]) => key.startsWith('ui-state:main-app-tab-v1:'))).toEqual([]);
  });

  it('restores Sessions and Projects while Workflows stays route-backed', async () => {
    const hook = await renderTabState();
    await act(async () => { hook.getCurrent().setActiveTab('projects'); });
    expect(hook.getCurrent().activeTab).toBe('projects');
    await act(async () => { hook.getCurrent().setActiveTab('sessions'); });
    expect(hook.getCurrent().activeTab).toBe('sessions');
    await act(async () => { hook.getCurrent().setActiveTab('workflows'); });
    expect(hook.getCurrent().activeTab).toBe('sessions');
  });
});
