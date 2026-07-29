import * as React from 'react';

import { useAuth } from '@/auth/context/AuthContext';
import type { TabType } from '@/components/ui/navigation/tabTypes';
import { kvBulkGet, kvSet } from '@/sync/api/account/apiKv';

const TAB_STATE_KEY = 'ui:active-tab';
const DEFAULT_TAB: TabType = 'sessions';

type TabState = Readonly<{
  activeTab: TabType;
  version: number;
}>;

type StoredTabState = Readonly<{
  activeTab: TabType;
  version: number;
}>;

function normalizeStoredTab(value: unknown): TabType | null {
  if (value === 'sessions' || value === 'projects' || value === 'inbox' || value === 'friends') return value;
  if (value === 'settings') return 'sessions';
  // Zen is a legacy value; it is no longer rendered in the tab bar.
  if (value === 'zen') return 'sessions';
  return null;
}

function isVersionMismatchError(error: unknown): boolean {
  return String(error).includes('version-mismatch');
}

async function loadStoredTabState(credentials: NonNullable<ReturnType<typeof useAuth>['credentials']>): Promise<StoredTabState | null> {
  const res = await kvBulkGet(credentials, [TAB_STATE_KEY]);
  const item = res.values.find((row) => row.key === TAB_STATE_KEY) ?? null;
  if (!item) return null;
  const normalized = normalizeStoredTab(item.value);
  if (!normalized) return null;
  return { activeTab: normalized, version: item.version };
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
  const saveGenerationRef = React.useRef(0);
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
        const item = await loadStoredTabState(credentials);
        if (!mounted) return;
        if (!item) return;
        setState({ activeTab: item.activeTab, version: item.version });
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
      const normalizedTab = normalizeStoredTab(tab) ?? DEFAULT_TAB;
      const saveGeneration = ++saveGenerationRef.current;
      setState((prev) => ({ ...prev, activeTab: normalizedTab }));

      if (!credentials) return;

      try {
        const newVersion = await kvSet(credentials, TAB_STATE_KEY, normalizedTab, versionRef.current);
        if (saveGenerationRef.current === saveGeneration) {
          setState((prev) => ({ ...prev, version: newVersion }));
        }
      } catch (error) {
        if (!isVersionMismatchError(error)) {
          if (saveGenerationRef.current === saveGeneration) {
            console.warn('[useTabState] Failed to save tab state:', error);
          }
          return;
        }

        try {
          const latest = await loadStoredTabState(credentials);
          if (saveGenerationRef.current !== saveGeneration) return;
          const newVersion = await kvSet(credentials, TAB_STATE_KEY, normalizedTab, latest?.version ?? -1);
          if (saveGenerationRef.current === saveGeneration) {
            setState((prev) => ({ ...prev, activeTab: normalizedTab, version: newVersion }));
          }
        } catch (retryError) {
          if (saveGenerationRef.current !== saveGeneration) return;
          console.warn('[useTabState] Failed to save tab state:', retryError);
          try {
            const latest = await loadStoredTabState(credentials);
            if (latest && saveGenerationRef.current === saveGeneration) {
              setState({ activeTab: latest.activeTab, version: latest.version });
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
