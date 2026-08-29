import {
    SYNCED_SESSION_AUTHORING_FIELD_IDS_V1,
    SyncedSessionAuthoringValueV1Schema,
    type SyncedSessionAuthoringFieldIdV1,
    type SyncedSessionAuthoringValueV1,
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
export function projectSyncedSessionAuthoringFields(value: unknown): Partial<SyncedSessionAuthoringValueV1> {
    if (!isRecord(value)) return {};

    const projected: Partial<Record<SyncedSessionAuthoringFieldIdV1, unknown>> = {};
    for (const fieldId of SYNCED_SESSION_AUTHORING_FIELD_IDS_V1) {
        if (!Object.prototype.hasOwnProperty.call(value, fieldId)) continue;
        const parsed = SyncedSessionAuthoringValueV1Schema.shape[fieldId].safeParse(value[fieldId]);
        if (parsed.success) {
            projected[fieldId] = parsed.data;
        }
    }
    return projected as Partial<SyncedSessionAuthoringValueV1>;
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
}>): Partial<SyncedSessionAuthoringValueV1> {
    const draft = params.draft;
    const executionTarget = draft.executionTarget ?? (draft.selectedMachineId
        ? {
            serverId: draft.targetServerId?.trim() || params.scopeServerId,
            machineId: draft.selectedMachineId,
        }
        : null);
    return projectSyncedSessionAuthoringFields({
        targetType: 'new_session',
        executionTarget,
        ...(draft.selectedPath ? { directory: draft.selectedPath } : {}),
        ...(draft.checkoutCreationDraft ? { checkoutCreationDraft: draft.checkoutCreationDraft } : {}),
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
