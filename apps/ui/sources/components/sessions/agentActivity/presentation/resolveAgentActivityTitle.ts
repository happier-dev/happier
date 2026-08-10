import { t } from '@/text';

import type { AgentActivityRowEntry } from '../agentActivityRowEntry';
import { collapseToSingleLine } from './collapseToSingleLine';

/**
 * The row's title, always non-empty and always one line.
 *
 * Producers derive titles from provider payloads — a tool input `name`, a run label, a team member
 * label — and any of those can arrive blank or multi-line. A blank title would leave a row that is
 * visibly present, tappable, and unnamed, which is worse than a generic name.
 */
export function resolveAgentActivityTitle(entry: AgentActivityRowEntry): string {
    return collapseToSingleLine(entry.title) ?? t('session.agentActivity.untitled');
}
