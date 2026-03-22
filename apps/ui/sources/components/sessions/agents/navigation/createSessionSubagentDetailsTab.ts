import type { DetailsTab } from '@/components/appShell/panes/model/appPaneReducer';
import type { SessionSubagent } from '@/sync/domains/session/subagents/types';
import { resolveSessionSubagentPrimaryTitle } from '@/components/sessions/agents/presentation/resolveSessionSubagentPrimaryTitle';
import { resolveSessionSubagentSecondaryTitle } from '@/components/sessions/agents/presentation/resolveSessionSubagentSecondaryTitle';

export function createSessionSubagentDetailsTab(subagent: SessionSubagent): DetailsTab {
    return {
        key: `subagent:${subagent.id}`,
        kind: 'subagent',
        title: resolveSessionSubagentPrimaryTitle(subagent),
        subtitle: resolveSessionSubagentSecondaryTitle(subagent),
        resource: {
            kind: 'subagent',
            subagentId: subagent.id,
        },
    };
}
