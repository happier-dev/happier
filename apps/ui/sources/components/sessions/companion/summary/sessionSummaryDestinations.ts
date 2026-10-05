import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { serializeSessionPaneUrlState } from '@/components/sessions/panes/url/sessionPaneUrlState';
import type { SessionSummaryDestinationHandlers } from './SessionSummaryCard';

/** Native Summary links retain the exact Session's existing route and pane owners. */
export function createSessionSummaryDestinations(input: Readonly<{
    address: SessionAddress;
    navigate: (href: string) => void;
    openPane?: (tabId: 'agents' | 'git') => void;
    approvalId?: string;
    /** The mounted Session may keep its incumbent local status popover. */
    openWorkStatus?: () => void;
}>): SessionSummaryDestinationHandlers {
    const openPane = input.openPane ?? ((tabId: 'agents' | 'git') => input.navigate(buildScopedSessionRouteHref({
        ...input.address, query: serializeSessionPaneUrlState({ rightTabId: tabId }),
    })));
    const openAgents = () => openPane('agents');
    return {
        sessionInfo: () => input.navigate(buildScopedSessionRouteHref({ ...input.address, suffix: '/info' })),
        approvals: () => {
            if (input.approvalId) input.navigate(`/inbox/approvals/${encodeURIComponent(input.approvalId)}?serverId=${encodeURIComponent(input.address.serverId)}`);
        },
        work: input.openWorkStatus ?? openAgents,
        workTab: openAgents,
        git: () => openPane('git'),
        usage: () => input.navigate(buildScopedSessionRouteHref({ ...input.address, suffix: '/usage' })),
    };
}
