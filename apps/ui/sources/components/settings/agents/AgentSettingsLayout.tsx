import * as React from 'react';

import { resolveCustomAcpAgentRoute } from '@/agents/catalog/agentSettingsRoutes';
import { SettingsCollectionLayout } from '@/components/settings/shell/SettingsCollectionLayout';

import { AgentCollectionRail } from './collection/AgentCollectionList';
import { AgentAdministrationCatalogBoundary } from './collection/AgentAdministrationCatalogBoundary';

/** The narrowest detail that still fits a segmented permission row beside its label. */
const AGENT_DETAIL_MIN_WIDTH_PX = 480;
const AGENTS_COLLECTION_ROUTE = '/settings/agents';

function resolveAgentsChildRoute(pathname: string): string {
    if (pathname === AGENTS_COLLECTION_ROUTE) return 'index';
    const customAcp = resolveCustomAcpAgentRoute(pathname);
    if (customAcp) return customAcp.kind === 'draft' ? 'custom/index' : 'custom/[backendId]';
    return pathname.endsWith('/models') ? '[agentId]/models' : '[agentId]';
}

/**
 * Agents as a collection beside its selected detail. Wide: the agent rail beside the nested detail
 * stack. Narrow: the detail stack alone, whose index page lists the agents and pushes their detail.
 * The detail stack stays mounted across the change, so an open agent keeps its editor state.
 */
export const AgentSettingsLayout = React.memo(function AgentSettingsLayout() {
    return (
        <AgentAdministrationCatalogBoundary>
        <SettingsCollectionLayout
            navigator="agents"
            rootPathname={AGENTS_COLLECTION_ROUTE}
            resolveChildRoute={resolveAgentsChildRoute}
            rail={<AgentCollectionRail />}
            railWidth="standard"
            detailMinWidthPx={AGENT_DETAIL_MIN_WIDTH_PX}
            testID="settings-agents"
        />
        </AgentAdministrationCatalogBoundary>
    );
});
