import * as React from 'react';

import { AGENT_IDS } from '@/agents/registry/registryCore';
import { resolveAgentUiBehavior, resolveAgentUiBehaviorFromSessionMetadata } from '@/agents/registry/registryUiBehavior';
import type { DetailsTab } from '@/components/appShell/panes/model/appPaneReducer';
import type { SessionSubagent } from '@/sync/domains/session/subagents/types';
import type { Session } from '@/sync/domains/state/storageTypes';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';

function resolveAgentUiBehaviorFromSession(session: Session) {
    return resolveAgentUiBehaviorFromSessionMetadata(readSessionOwnerMetadataView(session));
}

export function getSessionSubagentLaunchCards(params: Readonly<{
    sessionId: string;
    scopeId: string;
    session: Session | null;
    subagents: readonly SessionSubagent[];
}>): readonly React.ReactNode[] {
    if (!params.session) return [];
    const behavior = resolveAgentUiBehaviorFromSession(params.session);
    const renderLaunchCards = behavior?.sessionSubagents?.renderLaunchCards;
    if (!renderLaunchCards) return [];
    return renderLaunchCards({
        sessionId: params.sessionId,
        scopeId: params.scopeId,
        session: params.session,
        subagents: params.subagents,
    });
}

export function hasSessionSubagentLaunchCards(session: Session | null): boolean {
    if (!session) return false;
    const behavior = resolveAgentUiBehaviorFromSession(session);
    return typeof behavior?.sessionSubagents?.renderLaunchCards === 'function';
}

export function createSessionTeammateLauncherDetailsTab(params: Readonly<{
    session: Session | null;
    teamId: string;
}>): DetailsTab | null {
    if (!params.session) return null;
    const behavior = resolveAgentUiBehaviorFromSession(params.session);
    const createTab = behavior?.sessionSubagents?.createTeammateLauncherDetailsTab;
    if (!createTab) return null;
    return createTab({
        session: params.session,
        teamId: params.teamId,
    });
}

export function hasSessionTeammateLauncher(session: Session | null): boolean {
    if (!session) return false;
    const behavior = resolveAgentUiBehaviorFromSession(session);
    return typeof behavior?.sessionSubagents?.createTeammateLauncherDetailsTab === 'function';
}

export function renderProviderSessionDetailsTab(params: Readonly<{
    sessionId: string;
    scopeId: string;
    tab: DetailsTab;
}>): React.ReactNode | null {
    for (const agentId of AGENT_IDS) {
        const renderDetailsTab = resolveAgentUiBehavior(agentId).sessionSubagents?.renderDetailsTab;
        if (!renderDetailsTab) continue;
        const rendered = renderDetailsTab(params);
        if (rendered) return rendered;
    }
    return null;
}

export function resolveProviderSessionDetailsTabIconName(tab: DetailsTab): string | null {
    for (const agentId of AGENT_IDS) {
        const getIconName = resolveAgentUiBehavior(agentId).sessionSubagents?.getDetailsTabIconName;
        if (!getIconName) continue;
        const iconName = getIconName({ tab });
        if (iconName) return iconName;
    }
    return null;
}
