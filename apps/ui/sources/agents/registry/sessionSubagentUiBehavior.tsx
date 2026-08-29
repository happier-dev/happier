import * as React from 'react';

import { resolveAgentUiBehaviorFromSessionMetadata } from '@/agents/registry/registryUiBehavior';
import type { DetailsTab } from '@/components/appShell/panes/model/appPaneReducer';
import type { SessionSubagent } from '@/sync/domains/session/subagents/types';
import type { Session } from '@/sync/domains/state/storageTypes';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { AgentInlineSurface } from './agentUiBehavior/AgentInlineSurface';

function readInlineDetailsResource(tab: DetailsTab): Readonly<{
    pluginId: string;
    agentId: string;
    surfaceId: string;
    iconName: string | null;
    mode: string | null;
    initialTeamId: string | null;
}> | null {
    const resource = tab.resource;
    if (!resource || typeof resource !== 'object' || Array.isArray(resource)) return null;
    const marker = (resource as Record<string, unknown>).pluginInlineSurface;
    if (!marker || typeof marker !== 'object' || Array.isArray(marker)) return null;
    const value = marker as Record<string, unknown>;
    const read = (entry: unknown) => typeof entry === 'string' && entry.trim() ? entry.trim() : null;
    const pluginId = read(value.pluginId);
    const agentId = read(value.agentId);
    const surfaceId = read(value.surfaceId);
    if (!pluginId || !agentId || !surfaceId) return null;
    return {
        pluginId,
        agentId,
        surfaceId,
        iconName: read(value.iconName),
        mode: read((resource as Record<string, unknown>).mode),
        initialTeamId: read((resource as Record<string, unknown>).initialTeamId),
    };
}

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
        renderInlineSurface: (surface) => (
            <AgentInlineSurface
                key={surface.slotId}
                pluginId={surface.pluginId}
                surfaceId={surface.surfaceId}
                sessionId={surface.sessionId}
                agentId={surface.agentId}
                inlineMount={{ role: 'sessionSubagentLaunch', presentation: 'content' }}
                launchInput={surface.launchInput}
            />
        ),
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
    serverId?: string | null;
    tab: DetailsTab;
}>): React.ReactNode | null {
    const inline = readInlineDetailsResource(params.tab);
    if (inline) {
        return (
            <AgentInlineSurface
                pluginId={inline.pluginId}
                surfaceId={inline.surfaceId}
                sessionId={params.sessionId}
                serverId={params.serverId}
                agentId={inline.agentId}
                inlineMount={{ role: 'sessionSubagentDetails', presentation: 'fill' }}
                launchInput={{ mode: inline.mode, initialTeamId: inline.initialTeamId }}
            />
        );
    }
    return null;
}

export function resolveProviderSessionDetailsTabIconName(tab: DetailsTab): string | null {
    const inline = readInlineDetailsResource(tab);
    if (inline) return inline.iconName;
    return null;
}
