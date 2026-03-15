import type { RawJSONLines } from '@/backends/claude/types';

import { createClaudeTeamInboxCollector } from '@/backends/claude/utils/teamInbox/claudeTeamInboxCollector';

export function createClaudeRemoteTeamInboxBridge(params: Readonly<{
  claudeConfigDir: string | null;
  enqueue: (message: RawJSONLines) => void;
}>): {
  observe: (message: RawJSONLines) => void;
  syncAll: () => Promise<void>;
  cleanup: () => void;
} {
  const collector = createClaudeTeamInboxCollector({
    claudeConfigDir: typeof params.claudeConfigDir === 'string' && params.claudeConfigDir.trim().length > 0 ? params.claudeConfigDir.trim() : null,
    onInvalidate: () => {
      // In remote mode we don't have a shared invalidate loop; callers can also run periodic sync.
      void collector.syncAll();
    },
    emit: (message) => params.enqueue(message),
  });

  return collector;
}
