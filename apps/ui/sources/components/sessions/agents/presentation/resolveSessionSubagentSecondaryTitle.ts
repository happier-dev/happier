import { t } from '@/text';
import type { SessionSubagent } from '@/sync/domains/session/subagents/types';
import { resolveSessionSubagentKindLabelKey } from './resolveSessionSubagentKindLabelKey';

export function resolveSessionSubagentSecondaryTitle(subagent: SessionSubagent): string | null {
    const teamLabel = subagent.kind === 'agent_team_member'
        ? subagent.display.groupLabel?.trim()
            || subagent.display.groupKey?.trim()
            || (subagent.recipient?.kind === 'agent_team_member' ? subagent.recipient.teamId.trim() : null)
        : null;

    const values = [
        t(resolveSessionSubagentKindLabelKey(subagent.kind)),
        subagent.display.providerLabel?.trim() || subagent.runRef?.backendId?.trim() || null,
        teamLabel,
    ].filter((value, index, all): value is string => typeof value === 'string' && value.length > 0 && all.indexOf(value) === index);

    return values.length > 0 ? values.join(' · ') : null;
}
