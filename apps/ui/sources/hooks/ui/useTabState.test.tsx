import React from 'react';
import { describe, expect, it, vi, afterEach } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  useAuth: vi.fn(),
  kvGet: vi.fn(),
  kvSet: vi.fn(),
}));

vi.mock('@/auth/context/AuthContext', () => ({
  useAuth: () => mocks.useAuth(),
}));

vi.mock('@/sync/api/account/apiKv', () => ({
  kvGet: (...args: any[]) => mocks.kvGet(...args),
  kvSet: (...args: any[]) => mocks.kvSet(...args),
}));

async function flushEffects(turns = 3) {
  for (let i = 0; i < turns; i += 1) {
    await Promise.resolve();
  }
}

describe('useTabState', () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env.HAPPIER_SCM_INCLUDE_CO_AUTHORED_BY;
  });

  it('loads the active tab from account KV on mount', async () => {
    mocks.useAuth.mockReturnValue({ credentials: { token: 't' } });
    mocks.kvGet.mockResolvedValue({ key: 'ui:active-tab', value: 'settings', version: 3 });

    const { useTabState } = await import('./useTabState');
    const seen: Array<{ tab: string; loading: boolean }> = [];

    function Test() {
      const { activeTab, isLoading } = useTabState();
      React.useEffect(() => {
        seen.push({ tab: activeTab, loading: isLoading });
      }, [activeTab, isLoading]);
      return null;
    }

    await act(async () => {
      renderer.create(<Test />);
      await flushEffects();
    });

    expect(seen.at(-1)).toEqual({ tab: 'settings', loading: false });
  });

  it('persists changes back to KV with optimistic UI update', async () => {
    mocks.useAuth.mockReturnValue({ credentials: { token: 't' } });
    mocks.kvGet.mockResolvedValue(null);
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

    await act(async () => {
      renderer.create(<Test />);
      await flushEffects(6);
    });

    expect(seen).toContain('inbox');
    expect(mocks.kvSet).toHaveBeenCalledWith({ token: 't' }, 'ui:active-tab', 'inbox', -1);
  });
});

