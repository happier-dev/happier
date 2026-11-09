import { require as requireTypeScript } from 'tsx/cjs/api';
import type { SessionListOccurrenceRole } from '../../../../../apps/ui/sources/sync/domains/sessionList/sessionListIndexIdentity';

// The UI package is CommonJS; load its TypeScript graph with the same loader in both test runners.
const { buildSessionListIndexNodeId } = requireTypeScript(
  '../../../../../apps/ui/sources/sync/domains/sessionList/sessionListIndexIdentity.ts',
  import.meta.url,
) as typeof import('../../../../../apps/ui/sources/sync/domains/sessionList/sessionListIndexIdentity');

/** Select a concrete rendered occurrence; entity ids alone do not identify mirrored rows. */
export function sessionListOccurrenceId(serverId: string, sessionId: string, occurrenceRole: SessionListOccurrenceRole = 'base'): string {
  return buildSessionListIndexNodeId({ type: 'session', serverId, sessionId, occurrenceRole });
}

export function sessionListRowTestId(serverId: string, sessionId: string, occurrenceRole: SessionListOccurrenceRole = 'base'): string {
  return `session-list-item-${sessionListOccurrenceId(serverId, sessionId, occurrenceRole)}`;
}
