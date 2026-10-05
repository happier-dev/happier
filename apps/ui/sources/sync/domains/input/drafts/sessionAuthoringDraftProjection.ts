import {
    buildBackendTargetKeyV2,
    readBackendTargetRefV2,
    SYNCED_SESSION_AUTHORING_FIELD_IDS_V2,
    SyncedSessionAuthoringValueV1Schema,
    SyncedSessionAuthoringValueV2Schema,
    type SyncedSessionAuthoringFieldIdV2,
    type SyncedSessionAuthoringValueV2,
} from '@happier-dev/protocol';

import { resolveAgentExecutionTargetForPersistedSelection } from '@/agents/backendCatalog/resolveAgentExecutionTargetForBackendTarget';
import type { NewSessionDraft } from '@/sync/domains/state/persistence';

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Projects the safe synchronized subset through the protocol field catalog.
 * Fields are parsed independently so one malformed optional selection cannot
 * discard otherwise recoverable authoring intent.
 */
export function projectSyncedSessionAuthoringFields(value: unknown): Partial<SyncedSessionAuthoringValueV2> {
    if (!isRecord(value)) return {};

    const projected: Partial<Record<SyncedSessionAuthoringFieldIdV2, unknown>> = {};
    for (const fieldId of SYNCED_SESSION_AUTHORING_FIELD_IDS_V2) {
        if (!Object.prototype.hasOwnProperty.call(value, fieldId)) continue;
        const parsed = SyncedSessionAuthoringValueV2Schema.shape[fieldId].safeParse(value[fieldId]);
        if (parsed.success) {
            projected[fieldId] = parsed.data;
        }
    }
    return projected as Partial<SyncedSessionAuthoringValueV2>;
}

/**
 * Projects the published 0.2 draft vocabulary into the safe canonical subset.
 * This is a reader bridge only: 0.3 writers still emit catalogued 0.3 fields.
 */
export function projectPredecessorSessionDraftAuthoringFields(
    value: unknown,
    updatedAt: number,
): Partial<SyncedSessionAuthoringValueV2> {
    if (!isRecord(value)) return {};

    const machineId = SyncedSessionAuthoringValueV1Schema.shape.machineId.safeParse(value.machineId);
    const serverId = SyncedSessionAuthoringValueV1Schema.shape.serverId.safeParse(value.serverId);
    const agentId = SyncedSessionAuthoringValueV1Schema.shape.agentId.safeParse(value.agentId);
    const backendTarget = SyncedSessionAuthoringValueV1Schema.shape.backendTarget.safeParse(value.backendTarget);
    const modelId = SyncedSessionAuthoringValueV1Schema.shape.modelId.safeParse(value.modelId);

    let canonicalBackendTarget = null;
    if (backendTarget.success && backendTarget.data) {
        try {
            canonicalBackendTarget = readBackendTargetRefV2(backendTarget.data);
        } catch {
            canonicalBackendTarget = null;
        }
    }
    const agentTarget = resolveAgentExecutionTargetForPersistedSelection({
        backendTarget: canonicalBackendTarget,
        fallbackAgentId: agentId.success ? agentId.data : null,
    });
    const executionTarget = machineId.success && machineId.data && serverId.success && serverId.data
        ? {
            kind: 'machine' as const,
            target: { machineId: machineId.data, serverId: serverId.data },
        }
        : undefined;
    const modelSelection = modelId.success && modelId.data && agentTarget
        ? {
            v: 1 as const,
            ref: {
                agentTargetKey: buildBackendTargetKeyV2(agentTarget),
                providerConnectionId: null,
                modelId: modelId.data,
            },
            updatedAt,
        }
        : undefined;

    return {
        ...(executionTarget ? { executionTarget } : {}),
        ...(agentTarget ? { agentTarget } : {}),
        ...(modelSelection ? { modelSelection } : {}),
    };
}

/**
 * Projects the UI New Session draft (canonical plus retired compatibility
 * selections) onto the catalogued synchronized authoring fields. The canonical
 * `executionTarget`/`agentTarget` selections win; the retired flat vocabulary
 * only feeds their derivation and is never projected itself.
 */
export function projectNewSessionDraftSyncedAuthoringFields(params: Readonly<{
    draft: NewSessionDraft;
    scopeServerId: string;
}>): Partial<SyncedSessionAuthoringValueV2> {
    const draft = params.draft;
    const executionTarget = draft.executionTarget !== undefined ? draft.executionTarget : (draft.selectedMachineId
        ? {
            kind: 'machine' as const,
            target: {
                serverId: draft.targetServerId?.trim() || params.scopeServerId,
                machineId: draft.selectedMachineId,
            },
        }
        : null);
    return projectSyncedSessionAuthoringFields({
        targetType: 'new_session',
        executionTarget,
        ...(draft.temporaryComputerActivationRef !== undefined
            ? { temporaryComputerActivationRef: draft.temporaryComputerActivationRef }
            : {}),
        ...(draft.selectedPath ? { directory: draft.selectedPath } : {}),
        ...(draft.directoryKind === 'managed' ? { directoryKind: 'managed' as const } : {}),
        ...(draft.checkoutCreationDraft ? { checkoutCreationDraft: draft.checkoutCreationDraft } : {}),
        ...(draft.access !== undefined ? { access: draft.access } : {}),
        ...(draft.initialTriggers !== undefined ? { initialTriggers: draft.initialTriggers } : {}),
        ...(draft.primaryTeamId !== undefined ? { primaryTeamId: draft.primaryTeamId } : {}),
        ...(draft.organizationPlacement ? { organizationPlacement: draft.organizationPlacement } : {}),
        agentTarget: draft.agentTarget
            ?? resolveAgentExecutionTargetForPersistedSelection({
                backendTarget: draft.backendTarget ?? null,
                fallbackAgentId: draft.agentType,
            }),
        ...(draft.transcriptStorage !== undefined ? { transcriptStorage: draft.transcriptStorage } : {}),
        profileId: draft.selectedProfileId,
        ...(draft.resumeSessionId ? { resumeSessionId: draft.resumeSessionId } : {}),
        permissionMode: draft.permissionMode,
        ...(draft.modelSelection !== undefined ? { modelSelection: draft.modelSelection } : {}),
        ...(draft.mcpSelection !== undefined ? { mcpSelection: draft.mcpSelection } : {}),
        ...(draft.runtimeDescriptorV1 !== undefined ? { runtimeDescriptorV1: draft.runtimeDescriptorV1 } : {}),
        acpSessionModeId: draft.acpSessionModeId,
        ...(draft.automationDraft ? { automation: draft.automationDraft } : {}),
    });
}
