import * as React from 'react';
import type { DetailsSurfaceRenderInputV1 } from '@/components/appShell/panes/details/surfaces';
import { useSessionMachineTarget } from '@/components/sessions/model/useSessionMachineTarget';
import { useSessionViewerSourceAccountLifetime } from '@/components/sessions/viewer/SessionViewerSourceAccountScope';
import { getSessionComposerDraftSnapshot } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { WorkflowStartDetailsBody } from '@/components/workflows/run/WorkflowStartDetails';
import { isWorkflowStartResource } from '@/components/workflows/run/workflowStartDetailsModel';
import { createWorkflowRunPeekDetailsTab } from '@/components/sessions/work/createWorkflowRunPeekDetailsTab';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { useServerScopedMachine } from '@/sync/domains/state/storage';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { useExecutionRunMachineName } from '@/components/sessions/runs/details/useExecutionRunMachineName';
import { useSessionViewShellSession } from '@/components/sessions/shell/sessionViewStableSession';
import { WorkflowProjectTargetControl } from '@/components/workflows/editor/WorkflowProjectTargetControl';

const readMachineHomeDir = (machine: Machine | null) => machine?.metadata?.homeDir ?? null;

export function SessionWorkflowStartDetails(props: Readonly<{
    input: DetailsSurfaceRenderInputV1;
    sessionId: string;
    serverId?: string | null;
}>) {
    const lifetime = useSessionViewerSourceAccountLifetime();
    return <SessionWorkflowStartDetailsForAccount {...props} lifetime={lifetime}
        key={JSON.stringify([lifetime?.scope.serverId, lifetime?.scope.accountId, props.sessionId])} />;
}

function SessionWorkflowStartDetailsForAccount(props: Readonly<{
    input: DetailsSurfaceRenderInputV1;
    sessionId: string;
    serverId?: string | null;
    lifetime: ServerAccountScopeLifetime | null;
}>) {
    const { input, sessionId, serverId } = props;
    const { lifetime } = props;
    const target = useSessionMachineTarget(sessionId, serverId);
    const project = React.useMemo(() => target ? { machineId: target.machineId, directory: target.basePath } : null,
        [target?.machineId, target?.basePath]);
    const originSession = React.useMemo(() => ({ sessionId, ...(serverId ? { serverId } : {}) }), [serverId, sessionId]);
    const homeId = serverId ?? lifetime?.scope.serverId ?? null;
    // The Session's Machine is named by the same owner as the Run form's, so both Starts say it the same way.
    const machineName = useExecutionRunMachineName(useSessionViewShellSession(sessionId, serverId), homeId, project?.machineId).name;
    const machineHomeDir = useServerScopedMachine(homeId, project?.machineId, readMachineHomeDir);
    const [retainedDraft] = React.useState(() => lifetime
        ? getSessionComposerDraftSnapshot(lifetime.scope, { kind: 'session', sessionId })?.composer.text.value ?? '' : '');
    if (!isWorkflowStartResource(input.tab.resource)) return null;
    return <WorkflowStartDetailsBody source={input.tab.resource.source} accountLifetime={lifetime}
        project={project} originSession={originSession} retainedDraft={retainedDraft}
        onStarted={(result, homeId) => input.callbacks.replaceTab?.(input.tab.key,
            createWorkflowRunPeekDetailsTab({ runId: result.run.id, serverId: homeId, title: input.tab.title }),
            { intent: input.tab.isPreview ? 'preview' : 'pinned' })}>
        {/* A Session's workflow runs where the Session does: said once, read-only, as the Run form says it (A2). */}
        <WorkflowProjectTargetControl target={project} machineName={machineName} machineHomeDir={machineHomeDir}
            testIDPrefix="session-workflow-start" />
    </WorkflowStartDetailsBody>;
}
