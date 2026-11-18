import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contributionKey';
import type { ActionSessionAddressV1 } from '@happier-dev/protocol/actions/sessionAddressV1';
import type { ExistingSessionPlanningTarget } from '@happier-dev/protocol/sessions/authoring/existingSessionPlanner';
import type { WorkflowSessionAuthoringSelection } from '@happier-dev/protocol/workflows/workflowV1';
import { type ResumeCapabilityOptions } from '@/agents/runtime/resumeCapabilities';
import { createSessionActionTarget } from '@/components/sessions/actions/sessionActionContext';
import { resolveSessionOwnerMetadataViewRead } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { deriveSessionAuthoringSnapshot } from '@/sync/domains/sessionAuthoring/deriveSessionAuthoringSnapshot';
import { readSessionConfigOptionsState, readSessionModelsState, readSessionModesState } from '@/sync/domains/sessionControl/readSessionControlMetadata';
import { resolveSessionConfigOptionOverridesFromMetadata } from '@/sync/domains/sessionControl/configOptionsControl';
import { parseSessionConfigOptionOverridesState } from '@/sync/domains/sessionControl/schema';
import { computeSessionModePickerControl } from '@/sync/domains/sessionControl/sessionModeControl';
import { resolveSessionMachineId } from '@/sync/domains/session/external/resolveSessionMachineId';
import type { Session } from '@/sync/domains/state/storageTypes';

export type BulkSessionAuthoringHydration = Readonly<{ session: Session | null; errorCode: string | null }>;

export function projectBulkSessionAuthoringFact(address: ActionSessionAddressV1, session: Session | null,
    resumeOptions?: ResumeCapabilityOptions, hydrationErrorCode: string | null = null) {
    const metadataRead = session ? resolveSessionOwnerMetadataViewRead(session) : null;
    const metadata = metadataRead?.kind === 'available' ? metadataRead.metadata : null;
    const snapshot = session ? deriveSessionAuthoringSnapshot({ session }) : null;
    const configOptions = readSessionConfigOptionsState(metadata);
    const { updatedAt: _configUpdatedAt, ...configOptionsState } = configOptions ?? {};
    const modes = readSessionModesState(metadata);
    const modeControl = snapshot?.agentId ? computeSessionModePickerControl({ agentId: snapshot.agentId, metadata }) : null;
    const { updatedAt: _modesUpdatedAt, ...modeState } = modes ?? {};
    const models = readSessionModelsState(metadata);
    const { updatedAt: _modelsUpdatedAt, ...modelState } = models ?? {};
    const actionTarget = session ? createSessionActionTarget({ session, serverId: address.serverId, resumeCapabilityOptions: resumeOptions }) : null;
    const machineId = resolveSessionMachineId(metadata);
    // The folder the Session runs in: a Skills/MCP preview is scoped to one Machine and folder.
    const directory = typeof metadata?.path === 'string' && metadata.path.trim().length > 0 ? metadata.path : null;
    const agentId = snapshot?.agentTarget ? buildQualifiedPluginContributionKey(snapshot.agentTarget.identity) : null;
    // These are semantic current values, not new write observations. Omit read clocks from chip identity.
    const sessionConfigOptionOverrides = metadata ? parseSessionConfigOptionOverridesState({ v: 1, updatedAt: 0,
        overrides: Object.fromEntries(Object.entries(resolveSessionConfigOptionOverridesFromMetadata({ metadata,
            configOptions: configOptions?.configOptions })).map(([id, override]) => [id, { value: override.value, updatedAt: 0 }])) }) : null;
    const reason = !session ? 'session_not_hydrated' as const
        : actionTarget?.isArchived ? 'archived' as const
        : !session.access ? 'access_not_hydrated' as const
        : session.access?.capabilities.submitAgentInput !== true ? 'read_only' as const
        : metadataRead?.kind !== 'available' ? metadataRead?.kind ?? 'not_projected'
        : !session.active && !actionTarget?.canResume ? 'cannot_resume' as const
        : !snapshot?.agentTarget ? 'agent_unavailable' as const
        : !machineId ? 'machine_unavailable' as const
        : null;
    const values: WorkflowSessionAuthoringSelection = {
        agentTarget: snapshot?.agentTarget ?? null,
        modelSelection: snapshot?.modelSelection ? { ...snapshot.modelSelection, updatedAt: 0 } : null,
        permissionMode: snapshot?.permissionMode ?? null,
        connectedServices: snapshot?.connectedServices ?? null,
        capabilitySelection: snapshot?.capabilitySelection ?? null,
        sessionConfigOptionOverrides,
        acpSessionModeId: modeControl?.effectiveModeId ?? null,
    };
    const planningTarget: ExistingSessionPlanningTarget | null = reason === null && agentId && snapshot?.agentTarget && machineId ? {
        address, agentId, agentTarget: snapshot.agentTarget, machineId,
        ...(modeControl ? { availableModeIds: modeControl.options.map(mode => mode.id) } : {}),
        ...(snapshot?.capabilitySelection ? { capabilitySelection: snapshot.capabilitySelection } : {}),
        ...(sessionConfigOptionOverrides ? { sessionConfigOptionOverrides } : {}),
    } : null;
    return {
        address,
        status: reason === null ? 'ready' as const : reason === 'archived' || reason === 'cannot_resume' || reason === 'read_only'
            ? 'skipped' as const : 'unavailable' as const,
        reason,
        hydrationErrorCode,
        agentId,
        agentTarget: snapshot?.agentTarget ?? null,
        machineId,
        directory,
        modelId: snapshot?.modelId ?? null,
        modelSelectionRef: snapshot?.modelSelection?.ref ?? null,
        permissionMode: snapshot?.permissionMode ?? null,
        connectedServices: snapshot?.connectedServices ?? null,
        capabilitySelection: snapshot?.capabilitySelection ?? null,
        sessionConfigOptionOverrides,
        values,
        planningTarget,
        modeState: modes ? modeState : null,
        configOptionsState: configOptions ? configOptionsState : null,
        modelState: models ? modelState : null,
    };
}

export type BulkSessionAuthoringFact = ReturnType<typeof projectBulkSessionAuthoringFact>;
