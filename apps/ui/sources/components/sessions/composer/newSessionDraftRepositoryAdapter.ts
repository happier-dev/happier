import {
    ComposerAttachmentDraftV1Schema,
    StrictJsonValueSchema,
    type StrictJsonValue,
} from '@happier-dev/protocol';
import { isPermissionMode } from '@/sync/domains/permissions/permissionTypes';
import {
    projectPredecessorSessionDraftAuthoringFields,
    projectNewSessionDraftSyncedAuthoringFields,
    projectSyncedSessionAuthoringFields,
} from '@/sync/domains/input/drafts/sessionAuthoringDraftProjection';
import { resolveNewSessionCompatAgentType } from '@/components/sessions/new/modules/resolveNewSessionCompatAgentType';
import { resolveDraftBackendTarget } from '@/components/sessions/authoring/draft/sessionAuthoringDraftAdapters';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type {
    NewSessionComposerAttachmentSeedV1,
    NewSessionDraft,
} from '@/sync/domains/state/persistence';
import {
    flushSessionDraft,
    getSessionDraftSnapshot,
    writeNewSessionDraft,
    writeSessionDraftLocalSupplement,
    type SessionDraftConflict,
    type SessionDraftMaterializationIntent,
} from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { buildNewSessionDraftLocalState } from '@/sync/ops/sessionDrafts/newSessionDraftLocalState';
import { sanitizeNewSessionAutomationDraft } from '@/sync/domains/automations/automationDraft';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { ZenTaskSourceSchema } from '@/sync/domains/todos/todoStoredContent';

function strictJson(value: unknown): StrictJsonValue {
    return StrictJsonValueSchema.parse(value);
}

export type NewSessionDraftRepositoryProjection = Readonly<{
    draft: NewSessionDraft;
    /** Canonical repository document revision, never a wall-clock surrogate. */
    revision: number;
    /**
     * Live repository conflict for explicit Use-synced/Keep-device resolution.
     * The New Session access owner consumes only the access/context field
     * presence below; it never invents a second conflict store.
     */
    conflict: SessionDraftConflict | null;
}>;

/** Repository field id for the synchronized initial-access authoring value. */
export const NEW_SESSION_DRAFT_ACCESS_CONFLICT_FIELD_ID = 'target.authoring.access';
/** Repository field id for the synchronized Team-context authoring value. */
export const NEW_SESSION_DRAFT_PRIMARY_TEAM_CONFLICT_FIELD_ID = 'target.authoring.primaryTeamId';

export function hasNewSessionDraftAccessConflict(conflict: SessionDraftConflict | null | undefined): boolean {
    return conflict?.fields.some((field) => field.fieldId === NEW_SESSION_DRAFT_ACCESS_CONFLICT_FIELD_ID) === true;
}

export function hasNewSessionDraftPrimaryTeamConflict(conflict: SessionDraftConflict | null | undefined): boolean {
    return conflict?.fields.some((field) => field.fieldId === NEW_SESSION_DRAFT_PRIMARY_TEAM_CONFLICT_FIELD_ID) === true;
};

export function readNewSessionDraftProjectionFromRepository(input: Readonly<{
    scope: ServerAccountScope;
    draftId: string;
}>): NewSessionDraftRepositoryProjection | null {
    const snapshot = getSessionDraftSnapshot(input.scope, { kind: 'newSession', draftId: input.draftId });
    if (!snapshot || snapshot.document.target.kind !== 'newSession') return null;
    const fields = Object.fromEntries(Object.entries(snapshot.document.target.authoring).map(([fieldId, field]) => (
        [fieldId, field.value]
    )));
    const authoring = projectSyncedSessionAuthoringFields(fields);
    const predecessorAuthoring = projectPredecessorSessionDraftAuthoringFields(fields, snapshot.updatedAt);
    const attachments = Array.isArray(snapshot.document.composer.attachments.value)
        ? snapshot.document.composer.attachments.value.flatMap((value) => {
            const parsed = ComposerAttachmentDraftV1Schema.safeParse(value);
            return parsed.success ? [parsed.data] : [];
        })
        : [];
    const hasCanonicalExecutionTarget = Object.prototype.hasOwnProperty.call(authoring, 'executionTarget');
    const hasCanonicalAgentTarget = Object.prototype.hasOwnProperty.call(authoring, 'agentTarget');
    const canonicalExecutionTarget = hasCanonicalExecutionTarget
        ? authoring.executionTarget
        : predecessorAuthoring.executionTarget;
    const executionTarget = canonicalExecutionTarget ?? null;
    const agentTarget = hasCanonicalAgentTarget
        ? authoring.agentTarget ?? null
        : predecessorAuthoring.agentTarget ?? null;
    const modelSelection = Object.prototype.hasOwnProperty.call(authoring, 'modelSelection')
        ? authoring.modelSelection
        : hasCanonicalAgentTarget
            ? undefined
            : predecessorAuthoring.modelSelection;
    const backendTarget = resolveDraftBackendTarget({ agentTarget }) ?? undefined;
    const localState = snapshot.localSupplement.newSessionLocalState;
    const zenTaskSource = ZenTaskSourceSchema.safeParse(localState?.zenTaskSource);
    const draft: NewSessionDraft = {
        input: typeof snapshot.document.composer.text.value === 'string'
            ? snapshot.document.composer.text.value
            : '',
        ...(zenTaskSource.success ? { zenTaskSource: zenTaskSource.data } : {}),
        ...(attachments.length > 0 ? { composerAttachments: attachments } : {}),
        ...(Array.isArray(localState?.composerAttachmentSeeds) && localState.composerAttachmentSeeds.length > 0
            ? { composerAttachmentSeeds: localState.composerAttachmentSeeds }
            : {}),
        ...(snapshot.localSupplement.launchUserAttemptId
            ? { launchUserAttemptId: snapshot.localSupplement.launchUserAttemptId }
            : {}),
        selectedMachineId: executionTarget?.kind === 'machine' ? executionTarget.target.machineId : null,
        selectedPath: authoring.directory ?? null,
        ...(authoring.directoryKind === 'managed' ? { directoryKind: 'managed' as const } : {}),
        targetServerId: executionTarget?.kind === 'machine' ? executionTarget.target.serverId : executionTarget?.serverId ?? null,
        executionTarget,
        ...(authoring.temporaryComputerActivationRef !== undefined
            ? { temporaryComputerActivationRef: authoring.temporaryComputerActivationRef }
            : {}),
        ...(Array.isArray(localState?.placementCandidates) && localState.placementCandidates.length > 0
            ? { placementCandidates: localState.placementCandidates }
            : {}),
        agentTarget,
        agentType: resolveNewSessionCompatAgentType({
            backendTarget,
            persistedAgentId: null,
            selectedBuiltInAgentId: 'codex',
        }),
        ...(backendTarget !== undefined
            ? { backendTarget }
            : {}),
        ...(authoring.access !== undefined ? { access: authoring.access } : {}),
        ...(authoring.initialTriggers !== undefined ? { initialTriggers: authoring.initialTriggers } : {}),
        ...(authoring.primaryTeamId !== undefined ? { primaryTeamId: authoring.primaryTeamId } : {}),
        ...(authoring.organizationPlacement !== undefined
            ? { organizationPlacement: authoring.organizationPlacement }
            : {}),
        ...(localState?.teamCredentialBindings !== undefined
            ? { teamCredentialBindings: localState.teamCredentialBindings }
            : {}),
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
        ...(authoring.transcriptStorage === 'direct' || authoring.transcriptStorage === 'persisted'
            ? { transcriptStorage: authoring.transcriptStorage }
            : {}),
        permissionMode: isPermissionMode(authoring.permissionMode) ? authoring.permissionMode : 'default',
        ...(modelSelection !== undefined ? { modelSelection } : {}),
        ...(authoring.mcpSelection !== undefined ? { mcpSelection: authoring.mcpSelection } : {}),
        ...(authoring.runtimeDescriptorV1 !== undefined
            ? { runtimeDescriptorV1: authoring.runtimeDescriptorV1 }
            : {}),
        acpSessionModeId: authoring.acpSessionModeId ?? null,
        sessionConfigOptionOverrides: localState?.sessionConfigOptionOverrides ?? null,
        backendNewSessionOptionStateByTargetKey: localState?.backendNewSessionOptionStateByTargetKey ?? null,
        ...(authoring.resumeSessionId ? { resumeSessionId: authoring.resumeSessionId } : {}),
        ...(authoring.automation
            ? { automationDraft: sanitizeNewSessionAutomationDraft(authoring.automation) }
            : {}),
        updatedAt: snapshot.updatedAt,
    };
    return { draft, revision: snapshot.revision, conflict: snapshot.conflict };
}

export function readNewSessionDraftFromRepository(input: Readonly<{
    scope: ServerAccountScope;
    draftId: string;
}>): NewSessionDraft | null {
    return readNewSessionDraftProjectionFromRepository(input)?.draft ?? null;
}

function projectNewSessionDraftAuthoring(draft: NewSessionDraft, scopeServerId: string) {
    return projectNewSessionDraftSyncedAuthoringFields({ draft, scopeServerId });
}

export function writeNewSessionDraftToRepository(input: Readonly<{
    scope: ServerAccountScope;
    draftId: string;
    draft: NewSessionDraft;
    materializationIntent?: SessionDraftMaterializationIntent;
}>): void {
    const draft = input.draft;
    writeNewSessionDraft({
        scope: input.scope,
        draftId: input.draftId,
        patch: {
            text: draft.input,
            attachments: (draft.composerAttachments ?? []).map(strictJson),
            authoring: projectNewSessionDraftAuthoring(draft, input.scope.serverId),
        },
        materializationIntent: input.materializationIntent ?? 'userEdit',
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
        patch: { authoring: projectNewSessionDraftAuthoring(draft, input.scope.serverId) },
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
 * Narrow Temporary-computer activation-reference writer. It patches only the
 * synchronized `temporaryComputerActivationRef` field so an explicit set/clear
 * never overwrites concurrent authoring (prompt, target, agent, access, ...).
 * `null` is the explicit synchronized clear for this nullable field; the
 * repository treats an absent key as "no write". Flush is fire-and-forget
 * like the other New Session writers; offline failure keeps the local waiting
 * item visible through the repository status owner.
 */
export function writeTemporaryComputerActivationRefToRepository(input: Readonly<{
    scope: ServerAccountScope;
    draftId: string;
    activationRef: NonNullable<NewSessionDraft['temporaryComputerActivationRef']> | null;
}>): void {
    writeNewSessionDraft({
        scope: input.scope,
        draftId: input.draftId,
        patch: { authoring: { temporaryComputerActivationRef: input.activationRef } },
        materializationIntent: 'userEdit',
    });
    fireAndForget(
        flushSessionDraft({ scope: input.scope, address: { kind: 'newSession', draftId: input.draftId } }),
        { tag: 'newSessionDraftRepository.flush' },
    );
}

/** Clear only the host-created pending Composer requests that were admitted. */
export function clearNewSessionComposerAttachmentSeedsFromRepository(input: Readonly<{
    scope: ServerAccountScope;
    draftId: string;
    seeds: readonly NewSessionComposerAttachmentSeedV1[];
}>): void {
    if (input.seeds.length === 0) return;
    const address = { kind: 'newSession' as const, draftId: input.draftId };
    const snapshot = getSessionDraftSnapshot(input.scope, address);
    const localState = snapshot?.localSupplement.newSessionLocalState;
    const pending = localState?.composerAttachmentSeeds;
    if (!snapshot || !pending || pending.length === 0) return;
    const admittedIds = new Set(input.seeds.map((seed) => seed.instanceId));
    const remaining = pending.filter((seed) => !admittedIds.has(seed.instanceId));
    const { composerAttachmentSeeds: _removed, ...rest } = localState;
    writeSessionDraftLocalSupplement({
        scope: input.scope,
        address,
        patch: {
            newSessionLocalState: remaining.length > 0
                ? { ...rest, composerAttachmentSeeds: remaining }
                : rest,
        },
    });
}
