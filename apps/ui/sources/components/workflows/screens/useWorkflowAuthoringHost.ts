import * as React from 'react';

import type { WorkflowAuthoringTarget } from '@/sync/domains/workflows/workflowProjectTarget';

import type { AuthoringComposerScope } from '@/components/sessions/authoring/ScopedAuthoringComposer';
import type { SessionAuthoringControlFacts } from '@/components/sessions/authoring/controls/sessionAuthoringFieldControls';
import { useSessionAuthoringControlFacts } from '@/components/sessions/authoring/controls/useSessionAuthoringControlFacts';
import { useActiveServerAccountScope, useAllMachines } from '@/sync/domains/state/storage';
import type { EntityDragScopeV1 } from '@happier-dev/protocol/plugins/ui';
import type { WorkflowExistingSessionOption } from '@/sync/domains/workflows/workflowAuthoring';
import { useWorkflowExistingSessionOptions } from './useWorkflowExistingSessionOptions';

export type WorkflowAuthoringHostContext = Readonly<{
    /** Option sources for the shared Session-authoring controls. */
    authoringFacts: SessionAuthoringControlFacts;
    /** Where every step prompt resolves references, files and attachments. */
    composerScope: AuthoringComposerScope;
    /**
     * Existing Sessions a step may continue: the canonical Automation Session
     * candidacy, each with the exact Machine the canonical target owner reads
     * for it. Once this workflow's Machine is known, only Sessions on that
     * Machine are offered, because the coordinator refuses any other.
     */
    existingSessions: readonly WorkflowExistingSessionOption[];
    /** Every continuable Session on any Machine: what the Session drop target resolves against. */
    sessionDropCandidates: readonly WorkflowExistingSessionOption[];
    sessionBindingScope: EntityDragScopeV1 | null;
}>;

/**
 * The one adapter every Workflow editor host uses to supply the controlled
 * editor with its host-owned context.
 *
 * The editor body is deliberately controlled: it reads no store and resolves no
 * catalog, so a host that contributes nothing leaves the Agent picker with no
 * options while the strict Workflow schema still requires an effective Agent,
 * and leaves every step prompt without reference or attachment scope. Both
 * facts come from the same place — the exact Machine this workflow runs on —
 * so one adapter resolves them together and all three hosts consume it rather
 * than each assembling its own.
 *
 * A captured Session keeps its own exact Session scope: it is a genuine live
 * context, not a Machine substitute.
 */
export function useWorkflowAuthoringHost(params: Readonly<{
    /** Present only for a Session-origin draft that captured its Session. */
    capturedSession?: Readonly<{ sessionId: string; serverId?: string | null }> | undefined;
    projectTarget: WorkflowAuthoringTarget | null | undefined;
    serverId: string | null;
}>): WorkflowAuthoringHostContext {
    const { capturedSession, serverId } = params;
    const machineId = params.projectTarget?.machineId ?? null;
    const activeScope = useActiveServerAccountScope();
    const sessionBindingScope = activeScope?.serverId === serverId ? activeScope : null;
    const directory = typeof params.projectTarget?.directory === 'string' ? params.projectTarget.directory : null;
    const machines = useAllMachines();
    const machineHomeDir = React.useMemo(() => (
        machineId === null
            ? null
            : machines.find((machine) => machine.id === machineId)?.metadata?.homeDir ?? null
    ), [machineId, machines]);

    const authoringFacts = useSessionAuthoringControlFacts({ machineId, serverId, directory });

    const { existingSessions, sessionDropCandidates } = useWorkflowExistingSessionOptions({ serverId, machineId });

    const capturedSessionId = capturedSession?.sessionId ?? null;
    const capturedServerId = capturedSession?.serverId ?? null;
    const composerScope = React.useMemo<AuthoringComposerScope>(() => (
        capturedSessionId === null
            ? { kind: 'machine', machineId, serverId, directory, machineHomeDir }
            : { kind: 'session', sessionId: capturedSessionId, serverId: capturedServerId }
    ), [capturedServerId, capturedSessionId, directory, machineHomeDir, machineId, serverId]);

    return React.useMemo(
        () => ({ authoringFacts, composerScope, existingSessions, sessionDropCandidates, sessionBindingScope }),
        [authoringFacts, composerScope, existingSessions, sessionDropCandidates, sessionBindingScope],
    );
}
