import * as React from 'react';

import {
    createUiProjectionDiagnostic,
    readString,
    readStringArray,
    type UiProjectionDiagnostic,
} from './uiDescriptorDiagnostics';
import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import { createAuggieAllowIndexingChip } from './agentUiBehavior/auggie';

export type FirstPartyUiComponentRenderer = (props: Readonly<Record<string, unknown>>) => React.ReactNode;
export type FirstPartyUiActionChipRenderer = (
    props: Readonly<Record<string, unknown>>,
) => AgentInputExtraActionChip | null;

export type FirstPartyUiComponentResolution = Readonly<{
    render: FirstPartyUiComponentRenderer | null;
    diagnostic?: UiProjectionDiagnostic;
}>;

export type FirstPartyUiActionChipResolution = Readonly<{
    render: FirstPartyUiActionChipRenderer | null;
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

function renderAuggieAllowIndexingChip(props: Readonly<Record<string, unknown>>): AgentInputExtraActionChip | null {
    const optionStateKey = readString(props.optionStateKey);
    const setAgentOptionState = props.setAgentOptionState;
    if (!optionStateKey || typeof setAgentOptionState !== 'function') return null;
    const agentOptionState = props.agentOptionState && typeof props.agentOptionState === 'object' && !Array.isArray(props.agentOptionState)
        ? props.agentOptionState as Record<string, unknown>
        : null;
    const allowIndexing = agentOptionState?.[optionStateKey] === true;
    return createAuggieAllowIndexingChip({
        allowIndexing,
        setAllowIndexing: (value) => setAgentOptionState(optionStateKey, value),
    });
}

const FIRST_PARTY_COMPONENTS: Readonly<Record<string, FirstPartyUiComponentRenderer>> = Object.freeze({
    'firstParty.claude.subagentLaunchCards': renderClaudeLaunchActions,
    'firstParty.claude.teammateDetailsTab': renderClaudeLauncherPanel,
});

const FIRST_PARTY_ACTION_CHIPS: Readonly<Record<string, FirstPartyUiActionChipRenderer>> = Object.freeze({
    'firstParty.auggie.allowIndexingChip': renderAuggieAllowIndexingChip,
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

export function resolveFirstPartyUiActionChip(componentId: string | null | undefined): FirstPartyUiActionChipResolution {
    const normalizedId = readString(componentId);
    const render = normalizedId ? FIRST_PARTY_ACTION_CHIPS[normalizedId] : undefined;
    if (render) return { render };
    return {
        render: null,
        diagnostic: createUiProjectionDiagnostic(
            'A16X1_UNKNOWN_COMPONENT_ID',
            'componentId',
            `Unknown first-party UI action chip id '${normalizedId ?? ''}'.`,
        ),
    };
}
