import {
    ComposerAttachmentDraftV1Schema,
    StrictJsonValueSchema,
    convertBackendTargetRefV2ToV1,
    readBackendTargetRefV2,
    type StrictJsonValue,
} from '@happier-dev/protocol';
import { isPermissionMode } from '@/sync/domains/permissions/permissionTypes';

import { projectSyncedSessionAuthoringFields } from '@/sync/domains/input/drafts/sessionAuthoringDraftProjection';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { NewSessionDraft } from '@/sync/domains/state/persistence';
import {
    flushSessionDraft,
    getSessionDraftSnapshot,
    writeNewSessionDraft,
    writeSessionDraftLocalSupplement,
} from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { buildNewSessionDraftLocalState } from '@/sync/ops/sessionDrafts/newSessionDraftLocalState';
import { fireAndForget } from '@/utils/system/fireAndForget';

function strictJson(value: unknown): StrictJsonValue {
    return StrictJsonValueSchema.parse(value);
}

export function readNewSessionDraftFromRepository(input: Readonly<{
    scope: ServerAccountScope;
    draftId: string;
}>): NewSessionDraft | null {
    const snapshot = getSessionDraftSnapshot(input.scope, { kind: 'newSession', draftId: input.draftId });
    if (!snapshot || snapshot.document.target.kind !== 'newSession') return null;
    const fields = Object.fromEntries(Object.entries(snapshot.document.target.authoring).map(([fieldId, field]) => (
        [fieldId, field.value]
    )));
    const authoring = projectSyncedSessionAuthoringFields(fields);
    const attachments = Array.isArray(snapshot.document.composer.attachments.value)
        ? snapshot.document.composer.attachments.value.flatMap((value) => {
            const parsed = ComposerAttachmentDraftV1Schema.safeParse(value);
            return parsed.success ? [parsed.data] : [];
        })
        : [];
    const machineId = authoring.machineId ?? null;
    const backendTarget = authoring.backendTarget
        ? readBackendTargetRefV2(authoring.backendTarget)
        : authoring.backendTarget;
    const localState = snapshot.localSupplement.newSessionLocalState;
    return {
        input: typeof snapshot.document.composer.text.value === 'string'
            ? snapshot.document.composer.text.value
            : '',
        ...(attachments.length > 0 ? { composerAttachments: attachments } : {}),
        ...(snapshot.localSupplement.launchUserAttemptId
            ? { launchUserAttemptId: snapshot.localSupplement.launchUserAttemptId }
            : {}),
        selectedMachineId: machineId,
        selectedPath: authoring.directory ?? null,
        targetServerId: authoring.serverId ?? null,
        ...(authoring.checkoutCreationDraft ? { checkoutCreationDraft: authoring.checkoutCreationDraft } : {}),
        ...(localState?.windowsRemoteSessionLaunchModeOverride
            ? { windowsRemoteSessionLaunchModeOverride: localState.windowsRemoteSessionLaunchModeOverride }
            : {}),
        entryIntent: localState?.entryIntent ?? (authoring.automation ? 'automation' : 'session'),
        selectedProfileId: authoring.profileId ?? null,
        selectedSecretId: localState?.selectedSecretId ?? null,
        selectedSecretIdByProfileIdByEnvVarName: localState?.selectedSecretIdByProfileIdByEnvVarName ?? null,
        sessionOnlySecretValueEncByProfileIdByEnvVarName:
            localState?.sessionOnlySecretValueEncByProfileIdByEnvVarName ?? null,
        agentType: authoring.agentId ?? 'codex',
        ...(backendTarget !== undefined
            ? { backendTarget }
            : {}),
        ...(authoring.transcriptStorage === 'direct' || authoring.transcriptStorage === 'persisted'
            ? { transcriptStorage: authoring.transcriptStorage }
            : {}),
        permissionMode: isPermissionMode(authoring.permissionMode) ? authoring.permissionMode : 'default',
        ...(authoring.modelSelection !== undefined ? { modelSelection: authoring.modelSelection } : {}),
        ...(authoring.mcpSelection !== undefined ? { mcpSelection: authoring.mcpSelection } : {}),
        acpSessionModeId: authoring.acpSessionModeId ?? null,
        sessionConfigOptionOverrides: localState?.sessionConfigOptionOverrides ?? null,
        backendNewSessionOptionStateByTargetKey: localState?.backendNewSessionOptionStateByTargetKey ?? null,
        ...(authoring.resumeSessionId ? { resumeSessionId: authoring.resumeSessionId } : {}),
        ...(authoring.automation ? { automationDraft: authoring.automation } : {}),
        updatedAt: snapshot.updatedAt,
    };
}

function projectNewSessionDraftAuthoring(draft: NewSessionDraft) {
    return projectSyncedSessionAuthoringFields({
        targetType: 'new_session',
        ...(draft.selectedMachineId ? { machineId: draft.selectedMachineId } : {}),
        ...(draft.targetServerId ? { serverId: draft.targetServerId } : {}),
        ...(draft.selectedPath ? { directory: draft.selectedPath } : {}),
        ...(draft.checkoutCreationDraft ? { checkoutCreationDraft: draft.checkoutCreationDraft } : {}),
        agentId: draft.agentType,
        ...(draft.backendTarget !== undefined && draft.backendTarget !== null
            ? { backendTarget: convertBackendTargetRefV2ToV1(draft.backendTarget) }
            : {}),
        ...(draft.transcriptStorage !== undefined ? { transcriptStorage: draft.transcriptStorage } : {}),
        profileId: draft.selectedProfileId,
        ...(draft.resumeSessionId ? { resumeSessionId: draft.resumeSessionId } : {}),
        permissionMode: draft.permissionMode,
        ...(draft.modelSelection !== undefined ? { modelSelection: draft.modelSelection } : {}),
        ...(draft.mcpSelection !== undefined ? { mcpSelection: draft.mcpSelection } : {}),
        acpSessionModeId: draft.acpSessionModeId,
        ...(draft.automationDraft ? { automation: draft.automationDraft } : {}),
    });
}

export function writeNewSessionDraftToRepository(input: Readonly<{
    scope: ServerAccountScope;
    draftId: string;
    draft: NewSessionDraft;
}>): void {
    const draft = input.draft;
    writeNewSessionDraft({
        scope: input.scope,
        draftId: input.draftId,
        patch: {
            text: draft.input,
            attachments: (draft.composerAttachments ?? []).map(strictJson),
            authoring: projectNewSessionDraftAuthoring(draft),
        },
        materializationIntent: 'userEdit',
    });
    writeSessionDraftLocalSupplement({
        scope: input.scope,
        address: { kind: 'newSession', draftId: input.draftId },
        patch: { newSessionLocalState: buildNewSessionDraftLocalState(draft) },
    });
    fireAndForget(
        flushSessionDraft({ scope: input.scope, address: { kind: 'newSession', draftId: input.draftId } }),
        { tag: 'newSessionDraftRepository.flush' },
    );
}

/**
 * Delayed New Session autosave owns authoring/routing fields only. Live composer text,
 * mentions, and attachments commit immediately through the repository Composer owner;
 * including them here would let a stale debounced snapshot overwrite newer input.
 */
export function writeNewSessionAuthoringDraftToRepository(input: Readonly<{
    scope: ServerAccountScope;
    draftId: string;
    draft: NewSessionDraft;
}>): void {
    const draft = input.draft;
    writeNewSessionDraft({
        scope: input.scope,
        draftId: input.draftId,
        patch: { authoring: projectNewSessionDraftAuthoring(draft) },
        materializationIntent: 'userEdit',
    });
    writeSessionDraftLocalSupplement({
        scope: input.scope,
        address: { kind: 'newSession', draftId: input.draftId },
        patch: { newSessionLocalState: buildNewSessionDraftLocalState(draft) },
    });
    fireAndForget(
        flushSessionDraft({ scope: input.scope, address: { kind: 'newSession', draftId: input.draftId } }),
        { tag: 'newSessionDraftRepository.flush' },
    );
}
