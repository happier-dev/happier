import {
    resolveClaudeBrowseSourceOptions,
    type ClaudeBrowseSourceTranslationKey,
    type ClaudeExternalSessionBrowseSourceOption,
} from './externalSessions/browseSources.js';
import {
    buildClaudeSessionHandoffProviderPatch,
    type ClaudeSessionHandoffProviderPatch,
} from './sessionHandoff.js';

export type ClaudeSubagentLaunchCardInput = Readonly<{
    scopeId: string;
    subagents: readonly Readonly<{
        kind: string;
        display: Readonly<{
            groupKey?: string;
        }>;
    }>[];
}>;

export type ClaudeTeammateLauncherTabInput = Readonly<{
    teamId: string;
}>;

export type ClaudeDetailsTabInput<TDetailsTab> = Readonly<{
    sessionId: string;
    tab: TDetailsTab;
}>;

export type ClaudeUiBehaviorDependencies<TNode, TDetailsTab> = Readonly<{
    translate: (key: ClaudeBrowseSourceTranslationKey) => string;
    renderLaunchActionsCard: (ctx: Readonly<{
        scopeId: string;
        teamIds: readonly string[];
    }>) => TNode;
    createTeammateLauncherDetailsTab: (ctx: ClaudeTeammateLauncherTabInput) => TDetailsTab;
    renderLauncherDetailsTab: (ctx: Readonly<{
        sessionId: string;
        tab: TDetailsTab;
    }>) => TNode | null;
    getLauncherDetailsTabIconName: (ctx: Readonly<{
        tab: TDetailsTab;
    }>) => string | null;
}>;

export type ClaudeUiBehaviorOverride<TNode, TDetailsTab> = Readonly<{
    mcpServers: Readonly<{
        supportsDetectedConfigScan: true;
    }>;
    externalSessions: Readonly<{
        supportsBackgroundFollow: true;
        browse: Readonly<{
            order: 20;
            getSourceOptions: () => readonly ClaudeExternalSessionBrowseSourceOption[];
        }>;
    }>;
    sessionHandoff: Readonly<{
        buildProviderPatch: () => ClaudeSessionHandoffProviderPatch;
    }>;
    sessionSubagents: Readonly<{
        renderLaunchCards: (ctx: ClaudeSubagentLaunchCardInput) => readonly TNode[];
        createTeammateLauncherDetailsTab: (ctx: ClaudeTeammateLauncherTabInput) => TDetailsTab;
        renderDetailsTab: (ctx: ClaudeDetailsTabInput<TDetailsTab>) => TNode | null;
        getDetailsTabIconName: (ctx: Readonly<{ tab: TDetailsTab }>) => string | null;
    }>;
}>;

function collectClaudeTeamIds(subagents: ClaudeSubagentLaunchCardInput['subagents']): readonly string[] {
    const teamIds = new Set<string>();
    for (const subagent of subagents) {
        if (subagent.kind !== 'agent_team_member') continue;
        const groupKey = subagent.display.groupKey?.trim();
        if (groupKey) teamIds.add(groupKey);
    }
    return [...teamIds];
}

export function createClaudeUiBehaviorOverride<TNode, TDetailsTab>(
    deps: ClaudeUiBehaviorDependencies<TNode, TDetailsTab>,
): ClaudeUiBehaviorOverride<TNode, TDetailsTab> {
    return {
        mcpServers: {
            supportsDetectedConfigScan: true,
        },
        externalSessions: {
            supportsBackgroundFollow: true,
            browse: {
                order: 20,
                getSourceOptions: () => resolveClaudeBrowseSourceOptions({ translate: deps.translate }),
            },
        },
        sessionHandoff: {
            buildProviderPatch: () => buildClaudeSessionHandoffProviderPatch(),
        },
        sessionSubagents: {
            renderLaunchCards: ({ scopeId, subagents }) => [
                deps.renderLaunchActionsCard({
                    scopeId,
                    teamIds: collectClaudeTeamIds(subagents),
                }),
            ],
            createTeammateLauncherDetailsTab: deps.createTeammateLauncherDetailsTab,
            renderDetailsTab: deps.renderLauncherDetailsTab,
            getDetailsTabIconName: deps.getLauncherDetailsTabIconName,
        },
    };
}
