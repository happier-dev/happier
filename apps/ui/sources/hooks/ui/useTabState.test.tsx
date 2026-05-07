import React from 'react';
import { describe, expect, it, vi, afterEach } from 'vitest';

import { renderScreen } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  useAuth: vi.fn(),
  kvBulkGet: vi.fn(),
  kvSet: vi.fn(),
}));

vi.mock('@/auth/context/AuthContext', () => ({
  useAuth: () => mocks.useAuth(),
}));

vi.mock('@/sync/api/account/apiKv', () => ({
  kvBulkGet: (...args: any[]) => mocks.kvBulkGet(...args),
  kvSet: (...args: any[]) => mocks.kvSet(...args),
}));

describe('useTabState', () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env.HAPPIER_SCM_INCLUDE_CO_AUTHORED_BY;
  });

  it('loads the active tab from account KV on mount', async () => {
    mocks.useAuth.mockReturnValue({ credentials: { token: 't' } });
    mocks.kvBulkGet.mockResolvedValue({ values: [{ key: 'ui:active-tab', value: 'inbox', version: 3 }] });

    const { useTabState } = await import('./useTabState');
    const seen: Array<{ tab: string; loading: boolean }> = [];

    function Test() {
      const { activeTab, isLoading } = useTabState();
      React.useEffect(() => {
        seen.push({ tab: activeTab, loading: isLoading });
      }, [activeTab, isLoading]);
      return null;
    }

    await renderScreen(<Test />);

    expect(seen.at(-1)).toEqual({ tab: 'inbox', loading: false });
  });

  it('normalizes stale route-owned settings tab state back to sessions', async () => {
    mocks.useAuth.mockReturnValue({ credentials: { token: 't' } });
    mocks.kvBulkGet.mockResolvedValue({ values: [{ key: 'ui:active-tab', value: 'settings', version: 3 }] });

    const { useTabState } = await import('./useTabState');
    const seen: Array<{ tab: string; loading: boolean }> = [];

    function Test() {
      const { activeTab, isLoading } = useTabState();
      React.useEffect(() => {
        seen.push({ tab: activeTab, loading: isLoading });
      }, [activeTab, isLoading]);
      return null;
    }

    await renderScreen(<Test />);

    expect(seen.at(-1)).toEqual({ tab: 'sessions', loading: false });
  });

  it('persists changes back to KV with optimistic UI update', async () => {
    mocks.useAuth.mockReturnValue({ credentials: { token: 't' } });
    mocks.kvBulkGet.mockResolvedValue({ values: [] });
    mocks.kvSet.mockResolvedValue(1);

    const { useTabState } = await import('./useTabState');
    const seen: string[] = [];

    function Test() {
      const { activeTab, setActiveTab } = useTabState();
      React.useEffect(() => {
        seen.push(activeTab);
      }, [activeTab]);
      React.useEffect(() => {
        void setActiveTab('inbox');
      }, [setActiveTab]);
      return null;
    }

    await renderScreen(<Test />);

    expect(seen).toContain('inbox');
    expect(mocks.kvSet).toHaveBeenCalledWith({ token: 't' }, 'ui:active-tab', 'inbox', -1);
  });

  it('does not persist route-owned settings as the main tab state', async () => {
    mocks.useAuth.mockReturnValue({ credentials: { token: 't' } });
    mocks.kvBulkGet.mockResolvedValue({ values: [] });
    mocks.kvSet.mockResolvedValue(1);

    const { useTabState } = await import('./useTabState');
    const seen: string[] = [];

    function Test() {
      const { activeTab, setActiveTab } = useTabState();
      React.useEffect(() => {
        seen.push(activeTab);
      }, [activeTab]);
      React.useEffect(() => {
        void setActiveTab('settings');
      }, [setActiveTab]);
      return null;
    }

    await renderScreen(<Test />);

    expect(seen.at(-1)).toBe('sessions');
    expect(mocks.kvSet).toHaveBeenCalledWith({ token: 't' }, 'ui:active-tab', 'sessions', -1);
  });
});
