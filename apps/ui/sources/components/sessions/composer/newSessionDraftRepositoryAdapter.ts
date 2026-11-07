import { ComposerAttachmentDraftV1Schema } from '@happier-dev/protocol/runtime/input/composerAttachmentV1';
import { SessionSpaceMembershipTargetV1Schema } from '@happier-dev/protocol/actions';
import { StrictJsonValueSchema } from '@happier-dev/protocol/json/strictJsonValue';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { nullable } from 'zod/mini';
import type { StrictJsonValue } from '@happier-dev/protocol/drafts/sessionDrafts';
import type { SessionBotFaceV1 } from '@happier-dev/protocol/sessions/identity/sessionBotV1';
import { isPermissionMode } from '@/sync/domains/permissions/permissionTypes';
import {
    projectPredecessorSessionDraftAuthoringFields,
    projectNewSessionDraftSyncedAuthoringFields,
    readSyncedSessionAuthoringFields,
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
    getSessionComposerDraftSnapshot,
    writeNewSessionDraft,
    writeSessionDraftLocalSupplement,
    type SessionDraftConflict,
    type SessionDraftMaterializationIntent,
} from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { buildNewSessionDraftLocalState } from '@/sync/ops/sessionDrafts/newSessionDraftLocalState';
import { sanitizeNewSessionAutomationDraft } from '@/sync/domains/automations/automationDraft';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { StoredPluginUiNewSessionSeedOriginV1Schema } from '@happier-dev/protocol/plugins/ui';
import { readSessionInstructionsAuthoringDraft } from '@/sync/domains/state/sessionInstructionsDraft';
import { ManagedMachineAcquisitionDraftReadSchema, ManagedMachineSelectionDraftReadSchema } from '@/sync/domains/state/newSessionManagedMachineDraft';
import { getSessionDraftAuthoringFieldValues } from '@/sync/ops/sessionDrafts/sessionDraftDocumentFields';

function strictJson(value: unknown): StrictJsonValue {
    return StrictJsonValueSchema.parse(value);
}

export type NewSessionDraftRepositoryProjection = Readonly<{
    draft: Readonly<NewSessionDraft>;
    /** Canonical repository document revision, never a wall-clock surrogate. */
    revision: number;
    /**
     * Live repository conflict for explicit Use-synced/Keep-device resolution.
     * The New Session access owner consumes only the access/context field
     * presence below; it never invents a second conflict store.
     */
    conflict: SessionDraftConflict | null;
}>;

// The repository replaces snapshots when document, local custody, conflict or
// status changes. Reuse this boundary's validated projection across readers;
// a list publication must not re-parse every unchanged retained draft.
const draftProjectionSnapshots = new WeakMap<NonNullable<ReturnType<typeof getSessionComposerDraftSnapshot>>, NewSessionDraftRepositoryProjection>();

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
    const snapshot = getSessionComposerDraftSnapshot(input.scope, { kind: 'newSession', draftId: input.draftId });
    if (!snapshot || snapshot.targetKind !== 'newSession') return null;
    const cached = draftProjectionSnapshots.get(snapshot);
    if (cached) return cached;
    const fields = getSessionDraftAuthoringFieldValues(getSessionDraftSnapshot(input.scope, { kind: 'newSession', draftId: input.draftId })?.document);
    const authoring = readSyncedSessionAuthoringFields(fields);
    const predecessorAuthoring = projectPredecessorSessionDraftAuthoringFields(fields, snapshot.updatedAt);
    const attachments = Array.isArray(snapshot.composer.attachments.value)
        ? snapshot.composer.attachments.value.flatMap((value) => {
            const parsed = createStoredReadSchema(ComposerAttachmentDraftV1Schema).safeParse(value);
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
    // Retained 0.3 Bot drafts wrote these sole-copy values locally. A canonical
    // field, including an explicit clear or invalid value, always supersedes it.
    // The next authoring write migrates them and removes the local copies.
    const retainedAuthoring = readSyncedSessionAuthoringFields(localState);
    const sessionName = Object.prototype.hasOwnProperty.call(fields, 'sessionName') ? authoring.sessionName : retainedAuthoring.sessionName;
    const initialSessionFacts = Object.prototype.hasOwnProperty.call(fields, 'initialSessionFacts') ? authoring.initialSessionFacts : retainedAuthoring.initialSessionFacts;
    const memoryEnabled = Object.prototype.hasOwnProperty.call(fields, 'memoryEnabled') ? authoring.memoryEnabled : retainedAuthoring.memoryEnabled;
    const promptStack = Object.prototype.hasOwnProperty.call(fields, 'promptStack') ? authoring.promptStack : retainedAuthoring.promptStack;
    const instructionsDraft = readSessionInstructionsAuthoringDraft(localState?.instructionsDraft);
    const authoringOrigin = StoredPluginUiNewSessionSeedOriginV1Schema.safeParse(localState?.authoringOrigin);
    const spaceMembership = nullable(SessionSpaceMembershipTargetV1Schema).safeParse(localState?.spaceMembership);
    const managedMachineSelection = nullable(ManagedMachineSelectionDraftReadSchema).safeParse(localState?.managedMachineSelection);
    const managedMachineAcquisition = nullable(ManagedMachineAcquisitionDraftReadSchema).safeParse(localState?.managedMachineAcquisition);
    const hasManagedTarget = (managedMachineSelection.success && managedMachineSelection.data !== null)
        || (managedMachineAcquisition.success && managedMachineAcquisition.data !== null);
    const managedTargetServerId = hasManagedTarget
        && typeof localState?.targetServerId === 'string'
        ? localState.targetServerId
        : null;
    const draft: NewSessionDraft = {
        ...(typeof sessionName === 'string' ? { sessionName } : {}),
        ...(initialSessionFacts ? { initialSessionFacts } : {}),
        ...(typeof memoryEnabled === 'boolean' ? { memoryEnabled } : {}),
        ...(promptStack ? { promptStack } : {}),
        ...(instructionsDraft === undefined ? {} : { instructionsDraft }),
        input: typeof snapshot.composer.text.value === 'string'
            ? snapshot.composer.text.value
            : '',
        ...(authoringOrigin.success ? { authoringOrigin: authoringOrigin.data } : {}),
        ...(spaceMembership.success ? { spaceMembership: spaceMembership.data } : {}),
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
        targetServerId: executionTarget?.kind === 'machine' ? executionTarget.target.serverId : executionTarget?.serverId ?? managedTargetServerId,
        executionTarget,
        ...(managedMachineSelection.success ? { managedMachineSelection: managedMachineSelection.data } : {}),
        ...(managedMachineAcquisition.success ? { managedMachineAcquisition: managedMachineAcquisition.data } : {}),
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
        ...(authoring.capabilitySelection !== undefined ? { capabilitySelection: authoring.capabilitySelection } : {}),
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
    const projection = { draft, revision: snapshot.revision, conflict: snapshot.conflict };
    draftProjectionSnapshots.set(snapshot, projection);
    return projection;
}

export function readNewSessionDraftFromRepository(input: Readonly<{
    scope: ServerAccountScope;
    draftId: string;
}>): Readonly<NewSessionDraft> | null {
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
 * New Session authoring writes own authoring/routing fields only. Live composer text,
 * mentions, and attachments commit immediately through the repository Composer owner;
 * including them here would let a stale debounced snapshot overwrite newer input.
 * Delayed callers also preserve the immediately committed title; explicit authored
 * writes retain their supplied title.
 */
export function writeNewSessionAuthoringDraftToRepository(input: Readonly<{
    scope: ServerAccountScope;
    draftId: string;
    draft: NewSessionDraft;
    /** A delayed render snapshot must not replace an immediately committed title edit. */
    preserveLiveSessionName?: boolean;
}>): void {
    const live = readNewSessionDraftFromRepository(input);
    // Unreadable retained custody is not a missing draft for resolved-default autosave.
    if (!live && getSessionDraftSnapshot(input.scope, { kind: 'newSession', draftId: input.draftId })) return;
    const draft = {
        ...input.draft,
        // Pending attachment custody belongs to Composer. Authoring snapshots
        // neither drop waiting requests nor resurrect requests already settled.
        composerAttachmentSeeds: live?.composerAttachmentSeeds,
        ...(input.preserveLiveSessionName && live ? {
            sessionName: live.sessionName,
            instructionsDraft: live.instructionsDraft,
            promptStack: live.promptStack,
        } : {}),
    };
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

/** Title edits use the current authoring snapshot without rewriting Composer input. */
export function writeNewSessionNameToRepository(input: Readonly<{
    scope: ServerAccountScope;
    draftId: string;
    sessionName: string;
}>): void {
    const draft = readNewSessionDraftFromRepository(input);
    if (!draft) return;
    writeNewSessionAuthoringDraftToRepository({ ...input, draft: { ...draft, sessionName: input.sessionName } });
}

/**
 * A New Bot draft's face choice rides in its creation identity, so Session birth carries it in the same metadata.
 * `null` removes the choice (the draft's own seed and the Account's default style draw it again).
 */
export function writeNewSessionBotFaceToRepository(input: Readonly<{
    scope: ServerAccountScope;
    draftId: string;
    botFace: SessionBotFaceV1 | null;
}>): void {
    const draft = readNewSessionDraftFromRepository(input);
    if (!draft?.initialSessionFacts) return;
    const { botFace: _previous, ...facts } = draft.initialSessionFacts;
    writeNewSessionAuthoringDraftToRepository({ ...input, draft: { ...draft,
        initialSessionFacts: input.botFace ? { ...facts, botFace: input.botFace } : facts } });
}

/** Lazy authoring shares the existing local draft; no Artifact write happens here. */
export function writeNewSessionInstructionsToRepository(input: Readonly<{
    scope: ServerAccountScope;
    draftId: string;
    instructionsDraft: NewSessionDraft['instructionsDraft'];
    promptStack?: NewSessionDraft['promptStack'];
}>): void {
    const address = { kind: 'newSession' as const, draftId: input.draftId };
    if (!getSessionDraftSnapshot(input.scope, address)) {
        // Explicit Instructions authoring materializes the ordinary draft;
        // passive configuration autosaves retain their existing userEdit rule.
        writeNewSessionDraft({ scope: input.scope, draftId: input.draftId,
            patch: {}, materializationIntent: 'seeded' });
    }
    const draft = readNewSessionDraftFromRepository(input);
    if (!draft) return;
    writeNewSessionAuthoringDraftToRepository({ ...input, draft: { ...draft,
            instructionsDraft: input.instructionsDraft,
            ...(input.promptStack !== undefined ? { promptStack: input.promptStack } : {}),
        } });
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
