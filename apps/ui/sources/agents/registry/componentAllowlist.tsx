import * as React from 'react';

import {
    createUiProjectionDiagnostic,
    readString,
    readStringArray,
    type UiProjectionDiagnostic,
} from './uiDescriptorDiagnostics';

export type FirstPartyUiComponentRenderer = (props: Readonly<Record<string, unknown>>) => React.ReactNode;
export type FirstPartyUiComponentResolution = Readonly<{
    render: FirstPartyUiComponentRenderer | null;
    diagnostic?: UiProjectionDiagnostic;
}>;

const LazyClaudeAgentLaunchActionsCard = React.lazy(async () => {
    const module = await import('./components/sessionSubagents/claude/ClaudeAgentLaunchActionsCard');
    return { default: module.ClaudeAgentLaunchActionsCard };
});

const LazySessionClaudeSubagentLauncherView = React.lazy(async () => {
    const module = await import('./components/sessionSubagents/claude/SessionClaudeSubagentLauncherView');
    return { default: module.SessionClaudeSubagentLauncherView };
});

function renderClaudeLaunchActions(props: Readonly<Record<string, unknown>>): React.ReactNode {
    return (
        <React.Suspense fallback={null}>
            <LazyClaudeAgentLaunchActionsCard
                scopeId={readString(props.scopeId) ?? ''}
                teamIds={readStringArray(props.teamIds)}
            />
        </React.Suspense>
    );
}

function renderClaudeLauncherPanel(props: Readonly<Record<string, unknown>>): React.ReactNode {
    return (
        <React.Suspense fallback={null}>
            <LazySessionClaudeSubagentLauncherView
                sessionId={readString(props.sessionId) ?? ''}
                mode={readString(props.mode) === 'team' ? 'team' : 'member'}
                initialTeamId={readString(props.initialTeamId)}
                presentation="panel"
            />
        </React.Suspense>
    );
}

const FIRST_PARTY_COMPONENTS: Readonly<Record<string, FirstPartyUiComponentRenderer>> = Object.freeze({
    'firstParty.claude.subagentLaunchCards': renderClaudeLaunchActions,
    'firstParty.claude.teammateDetailsTab': renderClaudeLauncherPanel,
});

export function resolveFirstPartyUiComponent(componentId: string | null | undefined): FirstPartyUiComponentResolution {
    const normalizedId = readString(componentId);
    const render = normalizedId ? FIRST_PARTY_COMPONENTS[normalizedId] : undefined;
    if (render) return { render };
    return {
        render: null,
        diagnostic: createUiProjectionDiagnostic(
            'A16X1_UNKNOWN_COMPONENT_ID',
            'componentId',
            `Unknown first-party UI component id '${normalizedId ?? ''}'.`,
        ),
    };
}
