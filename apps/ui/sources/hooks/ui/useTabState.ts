import * as React from 'react';

import type { TabType } from '@/components/ui/navigation/tabTypes';
import { useInboxAvailable } from '@/hooks/inbox/useInboxAvailable';
import { MAIN_APP_TAB_UI_KEY, mainAppTabState } from '@/sync/domains/state/navigationUiState';
import { usePersistentUiStateValue } from '@/sync/domains/state/persistentUiState';

/**
 * The phone's last-selected main tab, kept on this device (owner ruling 2026-11-15). A tap writes the
 * navigation state only; it never mutates preferences or wakes other clients of the Account.
 */
export function useTabState(): {
  activeTab: TabType;
  setActiveTab: (tab: TabType) => void;
} {
  const storedTab = usePersistentUiStateValue(mainAppTabState, MAIN_APP_TAB_UI_KEY) ?? 'sessions';
  // While Inbox is unavailable (or its features are still loading) the phone shows Sessions; the stored
  // choice stays, so Inbox comes back once it is available again.
  const inboxAvailable = useInboxAvailable();
  const activeTab = storedTab === 'inbox' && !inboxAvailable ? 'sessions' : storedTab;
  const setActiveTab = React.useCallback((tab: TabType) => {
    // Workflows opens its own route; restore one of the shell's retained tab bodies.
    mainAppTabState.set(MAIN_APP_TAB_UI_KEY, tab === 'workflows' ? 'sessions' : tab);
  }, []);
  return { activeTab, setActiveTab };
}
