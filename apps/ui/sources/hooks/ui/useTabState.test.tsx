import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
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

const kv = createAccountKvHttpFixture();
const serverUrl = 'https://tab-state.example.test';
const tabKey = 'ui:active-tab';
let serverId: string;
let beforeMutation: (() => Promise<void>) | null = null;

beforeEach(async () => {
  await home.reset();
  kv.reset();
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
  it('loads the active tab from account KV on mount', async () => {
    await seedTab('inbox');
    const hook = await renderTabState();

    expect(hook.getCurrent()).toMatchObject({ activeTab: 'inbox', isLoading: false });
    expect(kv.read(tabKey)).toEqual({ key: tabKey, value: 'inbox', version: 3 });
  });

  it('keeps the dev projects tab as a first-class stored tab', async () => {
    await seedTab('projects');
    const hook = await renderTabState();

    expect(hook.getCurrent()).toMatchObject({ activeTab: 'projects', isLoading: false });
  });

  it('normalizes stale route-owned settings tab state back to sessions', async () => {
    await seedTab('settings');
    const hook = await renderTabState();

    expect(hook.getCurrent()).toMatchObject({ activeTab: 'sessions', isLoading: false });
  });

  it('persists changes back to KV with optimistic UI update', async () => {
    const hook = await renderTabState();
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    beforeMutation = async () => { entered.resolve(); await release.promise; };
    let pending: Promise<void> | undefined;
    try {
      await act(async () => {
        pending = hook.getCurrent().setActiveTab('inbox');
        await entered.promise;
      });
      expect(hook.getCurrent().activeTab).toBe('inbox');
      expect(kv.read(tabKey)).toBeUndefined();
    } finally {
      release.resolve();
      await act(async () => { await pending; });
    }

    expect(kv.read(tabKey)).toEqual({ key: tabKey, value: 'inbox', version: 0 });
    expect(hook.getCurrent().activeTab).toBe('inbox');
  });

  it('does not persist route-owned settings as the main tab state', async () => {
    const hook = await renderTabState();
    await act(async () => { await hook.getCurrent().setActiveTab('settings'); });

    expect(hook.getCurrent().activeTab).toBe('sessions');
    expect(kv.read(tabKey)).toEqual({ key: tabKey, value: 'sessions', version: 0 });
  });

  it('retries the requested tab after a recoverable version mismatch', async () => {
    const hook = await renderTabState();
    // Another HTTP writer advances the row after this reader saw no key.
    await seedTab('sessions');
    const requestsBefore = kv.readRequests().length;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await act(async () => { await hook.getCurrent().setActiveTab('inbox'); });

    expect(hook.getCurrent().activeTab).toBe('inbox');
    expect(kv.read(tabKey)).toEqual({ key: tabKey, value: 'inbox', version: 4 });
    expect(kv.readRequests().slice(requestsBefore)).toEqual([
      { method: 'POST', path: '/v1/kv' },
      { method: 'POST', path: '/v1/kv/bulk' },
      { method: 'POST', path: '/v1/kv' },
    ]);
    expect(warn).not.toHaveBeenCalled();
  });
});
