import * as React from 'react';

import { useAuth } from '@/auth/context/AuthContext';
import type { TabType } from '@/components/ui/navigation/TabBar';
import { kvGet, kvSet } from '@/sync/api/account/apiKv';

const TAB_STATE_KEY = 'ui:active-tab';
const DEFAULT_TAB: TabType = 'sessions';

type TabState = Readonly<{
  activeTab: TabType;
  version: number;
}>;

function normalizeStoredTab(value: unknown): TabType | null {
  if (value === 'sessions' || value === 'inbox' || value === 'settings') return value;
  // Zen is a legacy value; it is no longer rendered in the tab bar.
  if (value === 'zen') return 'sessions';
  return null;
}

export function useTabState(): {
  activeTab: TabType;
  setActiveTab: (tab: TabType) => Promise<void>;
  isLoading: boolean;
} {
  const auth = useAuth();
  const credentials = auth.credentials;

  const [state, setState] = React.useState<TabState>({ activeTab: DEFAULT_TAB, version: -1 });
  const [isLoading, setIsLoading] = React.useState(true);

  const versionRef = React.useRef(state.version);
  React.useEffect(() => {
    versionRef.current = state.version;
  }, [state.version]);

  React.useEffect(() => {
    if (!credentials) {
      setIsLoading(false);
      return;
    }

    let mounted = true;
    (async () => {
      try {
        const item = await kvGet(credentials, TAB_STATE_KEY);
        if (!mounted) return;
        if (!item) return;
        const normalized = normalizeStoredTab(item.value);
        if (!normalized) return;
        setState({ activeTab: normalized, version: item.version });
      } catch (error) {
        console.warn('[useTabState] Failed to load tab state:', error);
      } finally {
        if (mounted) setIsLoading(false);
      }
    })();

    return () => {
      mounted = false;
    };
  }, [credentials]);

  const setActiveTab = React.useCallback(
    async (tab: TabType) => {
      setState((prev) => ({ ...prev, activeTab: tab }));

      if (!credentials) return;

      try {
        const newVersion = await kvSet(credentials, TAB_STATE_KEY, tab, versionRef.current);
        setState((prev) => ({ ...prev, version: newVersion }));
      } catch (error) {
        console.warn('[useTabState] Failed to save tab state:', error);
        if (String(error).includes('version-mismatch')) {
          try {
            const item = await kvGet(credentials, TAB_STATE_KEY);
            const normalized = item ? normalizeStoredTab(item.value) : null;
            if (item && normalized) {
              setState({ activeTab: normalized, version: item.version });
            }
          } catch {
            // ignore best-effort conflict refresh
          }
        }
      }
    },
    [credentials],
  );

  return { activeTab: state.activeTab, setActiveTab, isLoading };
}

