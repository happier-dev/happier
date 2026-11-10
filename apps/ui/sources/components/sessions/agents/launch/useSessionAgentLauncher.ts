import { prepareExecutionRunLauncherDraft, type ExecutionRunLauncherDraftSeed } from '@/components/sessions/runs/launcher/prepareExecutionRunLauncherDraft';
import * as React from 'react';
import type { WorkflowPluginSourceV1 } from '@happier-dev/protocol/workflows/workflowPluginSourceContractV1';

import { useSessionAgentStartOpener } from './useSessionAgentStartOpener';
import {
    createExecutionRunLauncherDetailsTab,
    createInteractiveExecutionRunDraftDetailsTab,
    type ExecutionRunStartPreset,
    resolveExecutionRunLauncherIntents,
    EXECUTION_RUN_LAUNCH_INTENTS,
    type ExecutionRunIntent,
} from '@/components/sessions/runs/launcher/executionRunLauncherModel';
import { createSessionSubagentLaunchDetailsTab } from '@/agents/registry/sessionSubagentUiBehavior';
import {
    useSessionExecutionRunLaunchability,
    type SessionExecutionRunLaunchUnavailableReason,
} from '@/hooks/session/useSessionExecutionRunLaunchability';
import { resolveExecutionRunAvailableBackends } from '@/sync/domains/executionRuns/resolveExecutionRunAvailableBackends';
import type { SessionSubagent } from '@/sync/domains/session/subagents/types';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { DetailsTab } from '@/components/appShell/panes/model/appPaneReducer';
import type { WorkflowStartSource } from '@/components/workflows/run/workflowStartDetailsModel';
import type { WorkflowStartPlacement, WorkflowStartReference } from '@/components/workflows/run/WorkflowStartPicker';

import { useSessionBuiltinWorkflowStart } from './useSessionBuiltinWorkflowStart';

export type SessionAgentLauncher = Readonly<{
    /** `null` when agents can start here; otherwise why they cannot (said, never silently hidden). */
    unavailableReason: SessionExecutionRunLaunchUnavailableReason | null;
    /** The asks this Session's backends can take (all three while they are still loading). */
    intents: readonly ExecutionRunIntent[];
    /** The Agents that can take work here, for their marks (empty while backends load). */
    agentIds: readonly string[];
    openConversation: () => void;
    /**
     * The composer-first start for an ask; no intent is "Advanced…" (a review with every choice). A
     * preset starts it with a role (Second opinion: a review run by `second_opinion`).
     */
    openRun: (intent?: ExecutionRunIntent, preset?: ExecutionRunStartPreset, seed?: ExecutionRunLauncherDraftSeed) => void;
    /** Starts one of FIN's built-in workflows from this Session (its machine and folder). */
    startBuiltinWorkflow: (workflowId: string) => void;
    /** Starts a read-only plugin catalog source through that same Session start owner. */
    startPluginWorkflow: (source: WorkflowPluginSourceV1) => void;
    /** Opens the chosen saved or catalog reference in the shared contextual Start body, named after it. */
    startWorkflow: (reference: WorkflowStartReference | WorkflowStartSource, placement?: WorkflowStartPlacement) => void;
    /** Shows a Details tab where the person will see it (beside the Session, or the phone's Details). */
    openDetails: (tab: DetailsTab) => void;
    /** Brings an unsent start back in the same contextual Details destination. */
    openStartDraft: (tab: DetailsTab) => void;
    /** The Agent's own launch surface (a team, a teammate), when it contributes one. */
    providerLaunch: Readonly<{ title: string; subtitle: string | null; open: () => void }> | null;
}>;

/** One command for Agents starts; the Details owner chooses their responsive placement. */
export function useSessionAgentLauncher(params: Readonly<{
    sessionId: string;
    serverId?: string | null;
    scopeId: string;
    session: Session | null;
    subagents: readonly SessionSubagent[];
}>): SessionAgentLauncher {
    const openStart = useSessionAgentStartOpener();
    const { launchUnavailableReason, executionRunsBackends } = useSessionExecutionRunLaunchability(
        params.sessionId,
        params.session,
        params.serverId,
    );
    const { sessionId, serverId } = params;

    const intents = React.useMemo(() => {
        const available = executionRunsBackends ? resolveExecutionRunLauncherIntents(executionRunsBackends) : [];
        // While the backends are still being read, offer every ask rather than none; the launcher
        // itself says which backend can take it.
        return available.length > 0 ? available : EXECUTION_RUN_LAUNCH_INTENTS;
    }, [executionRunsBackends]);

    const agentIds = React.useMemo(
        () => resolveExecutionRunAvailableBackends(executionRunsBackends, ''),
        [executionRunsBackends],
    );

    const openDetails = React.useCallback((tab: DetailsTab) => {
        openStart(params.scopeId, tab);
    }, [openStart, params.scopeId]);

    const openConversation = React.useCallback(() => {
        openDetails(createInteractiveExecutionRunDraftDetailsTab());
    }, [openDetails]);

    const openRun = React.useCallback((intent?: ExecutionRunIntent, preset?: ExecutionRunStartPreset, seed?: ExecutionRunLauncherDraftSeed) => {
        openDetails(seed ? prepareExecutionRunLauncherDraft(seed) : createExecutionRunLauncherDetailsTab(intent, preset));
    }, [openDetails]);

    const openStartDraft = openDetails;

    const startCatalogWorkflow = useSessionBuiltinWorkflowStart({ sessionId, serverId, scopeId: params.scopeId });

    const providerTab = React.useMemo(
        () => createSessionSubagentLaunchDetailsTab({ session: params.session, subagents: params.subagents }),
        [params.session, params.subagents],
    );
    const providerLaunch = React.useMemo(() => (providerTab
        ? { title: providerTab.title, subtitle: providerTab.subtitle ?? null, open: () => openDetails(providerTab) }
        : null), [openDetails, providerTab]);

    return React.useMemo(() => ({
        unavailableReason: launchUnavailableReason,
        intents,
        agentIds,
        openConversation,
        openRun,
        openDetails,
        openStartDraft,
        providerLaunch,
        startBuiltinWorkflow: startCatalogWorkflow,
        startPluginWorkflow: startCatalogWorkflow,
        startWorkflow: startCatalogWorkflow,
    }), [openDetails, openStartDraft, agentIds, intents, launchUnavailableReason, openConversation, openRun, providerLaunch, startCatalogWorkflow]);
}
