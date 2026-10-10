import { AcpConfigOptionOverridesV1Schema } from '@happier-dev/protocol/sessions/metadata/overrides';
import { AgentExecutionTargetV1Schema, type AgentExecutionTargetV1 } from '@happier-dev/protocol/agents/executionTargetV1';
import { SessionAuthoringValueV1Schema } from '@happier-dev/protocol/sessions/authoring/index';
import { SessionIdentityAdditionsV1Schema } from '@happier-dev/protocol/sessions/identity/sessionBotV1';
import { SessionPromptStackV1Schema } from '@happier-dev/protocol/sessions/context/sessionContextV1';
import { readSessionInstructionsAuthoringDraft } from '@/sync/ops/promptLibrary/sessionInstructions';
import { SessionCreationKeyV1Schema, type SessionCreationKeyV1 } from '@happier-dev/protocol/sessions/creation/sessionCreationIdentityV1';
import { SessionServerStartSpawnDraftV1Schema, SessionSpawnNewInputV2Schema, type SessionServerStartSpawnDraftV1, type SessionSpawnNewInputV2 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { ManagedAcquireAgentStartV1Schema, type ManagedAcquireAgentStartV1 } from '@happier-dev/protocol/machines/managed/agentStartV1';
import { RawIngressStructuredInputV1Schema, type RawIngressStructuredInputV1 } from '@happier-dev/protocol/runtime/input/structuredInputV1';
import { buildSessionConfigOptionOverridesFromServerStart } from '@happier-dev/protocol/workflows/workflowSessionAuthoringV1';
import type { SecretReferenceOverlayV1 } from '@happier-dev/protocol/profiles/secretReferenceOverlayV1';
import { SessionModelSelectionV1Schema, type SessionModelSelectionV1 } from '@happier-dev/protocol/providers/model-selection';
import { buildBackendTargetKeyV2, readBackendTargetRefV2, type BackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { readNonBlankOpaqueIdentifier } from '@happier-dev/protocol/strings/opaqueIdentifier';
import { readRuntimeDescriptorV1 } from '@happier-dev/protocol/sessions/metadata/runtime-descriptor';
import type { SessionSpawnSourceContextV1 } from '@happier-dev/protocol/sessions/creation/sessionSpawnSourceContextV1';
import type { SessionExecutionTargetV1 } from '@happier-dev/protocol/sessions/creation/sessionExecutionTargetV1';
import type { MachinePoolSelectionOriginV1 } from '@happier-dev/protocol/machines/pools/v1';
import type { SessionDirectoryIntentV1 } from '@happier-dev/protocol/sessions/creation/sessionDirectoryIntentV1';
import type { SessionSpawnNewInitialInputV1 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import type { PluginUiSessionPlacementCandidateV1 } from '@happier-dev/protocol/plugins/ui';
import {
    ConnectedServiceBindingsV2IngressSchema,
    type ConnectedServiceBindingsV2,
} from '@happier-dev/protocol/connect/connected-service-bindings';
import type { WorkflowSessionAuthoringSelection } from '@happier-dev/protocol/workflows/workflowV1';

import {
    DEFAULT_AGENT_ID,
    isBundledAgentId,
    resolveBundledAgentIdFromContributionIdentity,
} from '@/agents/catalog/catalog';
import { resolveCatalogAgentIdForBackendTarget } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { resolveAgentExecutionTargetForPersistedSelection } from '@/agents/backendCatalog/resolveAgentExecutionTargetForBackendTarget';
import { resolvePersistedAgentIdForBackendTarget } from '@/agents/backendCatalog/resolvePersistedAgentIdForBackendTarget';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import {
    sanitizeNewSessionAutomationDraft,
    type NewSessionAutomationDraft,
} from '@/sync/domains/automations/automationDraft';
import { isModelMode, isPermissionMode } from '@/sync/domains/permissions/permissionTypes';
import { deriveSessionAuthoringSnapshot } from '@/sync/domains/sessionAuthoring/deriveSessionAuthoringSnapshot';
import {
    normalizeOptionalNumber,
    normalizeOptionalRecord,
    normalizeSessionAuthoringConnectedServices,
    normalizeSessionAuthoringTerminal,
    normalizeOptionalString,
    normalizeRequiredString,
} from '@/sync/domains/sessionAuthoring/sessionAuthoringNormalization';
import type { AutomationTemplate } from '@/sync/domains/automations/automationTypes';
import type { NewSessionData } from '@/utils/sessions/tempDataStore';
import {
    normalizeBackendNewSessionOptionStateByTargetKey,
    readBackendNewSessionOptionStateByTargetKey,
} from '@/utils/sessions/backendNewSessionOptionState';
import { parseCheckoutCreationDraft } from '@/sync/domains/state/newSessionCheckoutDraft';
import type { NewSessionDraft } from '@/sync/domains/state/persistence';
import type { Session } from '@/sync/domains/state/storageTypes';

import type { SessionAuthoringDraft } from './sessionAuthoringDraft';

type ExistingSessionAuthoringSnapshotSession = Pick<
    Session,
    | 'id'
    | 'encryptionMode'
    | 'metadataLayoutVersion'
    | 'metadata'
    | 'ownerMetadataView'
    | 'permissionMode'
    | 'permissionModeUpdatedAt'
    | 'modelMode'
    | 'modelModeUpdatedAt'
>;

export type { ExistingSessionAuthoringSnapshotSession };

type StrictSessionSpawnNewInputV2 = SessionSpawnNewInputV2 & Readonly<{
    creationKey: SessionCreationKeyV1;
}>;

// Execution APIs retain exact-Machine shapes; authoring and reentry retain
// the canonical field-catalog union without flattening it.
function fromExactMachineTarget(
    target: (SessionExecutionTargetV1 & { selectionOrigin?: MachinePoolSelectionOriginV1 }) | null | undefined,
): SessionAuthoringDraft['executionTarget'] {
    if (!target) return null;
    return {
        kind: 'machine',
        target: { serverId: target.serverId, machineId: target.machineId },
        ...(target.selectionOrigin ? { selectionOrigin: target.selectionOrigin } : {}),
    };
}

class InteractiveSessionConsentRequiredError extends Error {
    readonly code = 'interactive_consent_required' as const;

    constructor() {
        super('Temporary computer requires interactive endpoint consent');
        this.name = 'InteractiveSessionConsentRequiredError';
    }
}

function requireMachineAuthoringTarget(
    target: NonNullable<SessionAuthoringDraft['executionTarget']>,
): Extract<SessionAuthoringDraft['executionTarget'], { kind: 'machine' }> {
    if (target.kind === 'temporary_computer') throw new InteractiveSessionConsentRequiredError();
    return target;
}

function toExactMachineTarget(
    authoringTarget: NonNullable<SessionAuthoringDraft['executionTarget']>,
): SessionExecutionTargetV1 & { selectionOrigin?: MachinePoolSelectionOriginV1 } {
    const target = requireMachineAuthoringTarget(authoringTarget);
    return {
        ...target.target,
        ...(target.selectionOrigin ? { selectionOrigin: target.selectionOrigin } : {}),
    };
}

function normalizeSessionConfigOptionOverrides(value: unknown): SessionAuthoringDraft['sessionConfigOptionOverrides'] {
    const parsed = AcpConfigOptionOverridesV1Schema.safeParse(value);
    return parsed.success ? parsed.data : null;
}

function normalizeAutomationDraft(value: unknown): SessionAuthoringDraft['automation'] {
    if (value === null || value === undefined) return null;
    return sanitizeNewSessionAutomationDraft(value);
}

function normalizeOrganizationPlacement(
    value: SessionAuthoringDraft['organizationPlacement'] | null | undefined,
): SessionAuthoringDraft['organizationPlacement'] {
    const folderId = normalizeOptionalString(value?.folderId) ?? null;
    const tagIds = [...new Set((value?.tagIds ?? []).map((tagId) => tagId.trim()).filter(Boolean))];
    return { folderId, tagIds };
}

function resolveCompatibilityAgentTarget(
    backendTarget: BackendTargetRefV2 | null | undefined,
    fallbackAgentId?: unknown,
): AgentExecutionTargetV1 | null {
    return resolveAgentExecutionTargetForPersistedSelection({ backendTarget, fallbackAgentId });
}

function buildExistingSessionAuthoringDraftFromSnapshotData(params: Readonly<{
    snapshot: ReturnType<typeof deriveSessionAuthoringSnapshot>;
    message: string;
}>): SessionAuthoringDraft {
    return {
        targetType: 'existing_session',
        executionTarget: null,
        directory: params.snapshot.directory,
        checkoutCreationDraft: null,
        organizationPlacement: { folderId: null, tagIds: [] },
        prompt: params.message,
        displayText: params.message,
        agentTarget: params.snapshot.agentTarget,
        transcriptStorage: params.snapshot.transcriptStorage,
        profileId: params.snapshot.profileId,
        environmentVariables: null,
        resumeSessionId: null,
        permissionMode: params.snapshot.permissionMode,
        permissionModeUpdatedAt: params.snapshot.permissionModeUpdatedAt,
        // Current Agent-backed Sessions move the released backend-keyed snapshot
        // onto the canonical qualified Agent key. A released configured-ACP
        // Session has no Agent identity to project, so retain its exact
        // compatibility selection instead of inventing one or rejecting the
        // otherwise valid existing-Session draft.
        modelSelection: params.snapshot.agentTarget
            ? buildCanonicalDraftModelSelection({
                agentTarget: params.snapshot.agentTarget,
                modelSelection: rekeyCompatibilityModelSelection(
                    params.snapshot.modelSelection,
                    params.snapshot.agentTarget,
                ),
            })
            : params.snapshot.modelSelection,
        mcpSelection: params.snapshot.mcpSelection,
        connectedServices: params.snapshot.connectedServices,
        terminal: params.snapshot.terminal,
        windowsRemoteSessionLaunchMode: null,
        windowsRemoteSessionConsole: null,
        windowsTerminalWindowName: null,
        runtimeDescriptorV1: params.snapshot.runtimeDescriptorV1,
        acpSessionModeId: null,
        sessionConfigOptionOverrides: null,
        existingSessionId: params.snapshot.existingSessionId,
        sessionEncryptionMode: params.snapshot.sessionEncryptionMode,
        sessionEncryptionKeyBase64: params.snapshot.sessionEncryptionKeyBase64,
        sessionEncryptionVariant: params.snapshot.sessionEncryptionVariant,
        automation: null,
    };
}

export function mergeExistingSessionAuthoringDraftInheritedFields(
    current: SessionAuthoringDraft,
    fallback: SessionAuthoringDraft | undefined,
): SessionAuthoringDraft {
    if (!fallback) {
        return current;
    }

    return {
        ...current,
        executionTarget: current.executionTarget ?? fallback.executionTarget,
        organizationPlacement: current.organizationPlacement ?? fallback.organizationPlacement,
        agentTarget: current.agentTarget ?? fallback.agentTarget,
        transcriptStorage: current.transcriptStorage ?? fallback.transcriptStorage,
        profileId: current.profileId ?? fallback.profileId,
        environmentVariables: current.environmentVariables ?? fallback.environmentVariables,
        resumeSessionId: current.resumeSessionId ?? fallback.resumeSessionId,
        permissionMode: current.permissionMode ?? fallback.permissionMode,
        permissionModeUpdatedAt: current.permissionModeUpdatedAt ?? fallback.permissionModeUpdatedAt,
        modelSelection: current.modelSelection !== undefined
            ? current.modelSelection
            : fallback.modelSelection,
        mcpSelection: current.mcpSelection ?? fallback.mcpSelection,
        connectedServices: current.connectedServices ?? fallback.connectedServices,
        terminal: current.terminal ?? fallback.terminal,
        windowsRemoteSessionLaunchMode: current.windowsRemoteSessionLaunchMode ?? fallback.windowsRemoteSessionLaunchMode,
        windowsRemoteSessionConsole: current.windowsRemoteSessionConsole ?? fallback.windowsRemoteSessionConsole,
        windowsTerminalWindowName: current.windowsTerminalWindowName ?? fallback.windowsTerminalWindowName,
        runtimeDescriptorV1: current.runtimeDescriptorV1 ?? fallback.runtimeDescriptorV1,
        acpSessionModeId: current.acpSessionModeId ?? fallback.acpSessionModeId,
        sessionEncryptionMode: current.sessionEncryptionMode ?? fallback.sessionEncryptionMode,
        sessionEncryptionKeyBase64: current.sessionEncryptionKeyBase64 ?? fallback.sessionEncryptionKeyBase64,
        sessionEncryptionVariant: current.sessionEncryptionVariant ?? fallback.sessionEncryptionVariant,
    };
}

function mergeExistingSessionAuthoringDraftEditableFields(params: Readonly<{
    baseDraft: SessionAuthoringDraft;
    currentDraft: SessionAuthoringDraft | null;
    sessionId: string;
    fallbackAutomationDraft?: SessionAuthoringDraft['automation'];
}>): SessionAuthoringDraft {
    if (!params.currentDraft || params.currentDraft.existingSessionId !== params.sessionId) {
        return {
            ...params.baseDraft,
            automation: params.fallbackAutomationDraft ?? null,
        };
    }

    return {
        ...params.baseDraft,
        prompt: params.currentDraft.prompt,
        displayText: params.currentDraft.displayText,
        permissionMode: params.currentDraft.permissionMode,
        permissionModeUpdatedAt: params.currentDraft.permissionModeUpdatedAt,
        modelSelection: params.currentDraft.modelSelection,
        automation: params.currentDraft.automation ?? params.fallbackAutomationDraft ?? null,
    };
}

function stripBackendTargetSourceKind(target: BackendTargetRefV2): BackendTargetRefV2 {
    // `sourceKind` is legacy split-brain vocabulary (built-in vs plugin vs configured) and should
    // not leak into session authoring or automation templates. `configuredBackendId` is the only
    // carrier we need for configured targets.
    if (!('sourceKind' in target)) {
        return target;
    }

    const { sourceKind: _ignored, ...rest } = target as BackendTargetRefV2 & {
        sourceKind?: unknown;
    };
    return rest;
}

export function resolveDraftBackendTarget(draft: Pick<SessionAuthoringDraft, 'agentTarget'>): BackendTargetRefV2 | null {
    if (!draft.agentTarget) return null;
    if (draft.agentTarget.definitionId) {
        return stripBackendTargetSourceKind(readBackendTargetRefV2(draft.agentTarget));
    }
    const bundledAgentId = resolveBundledAgentIdFromContributionIdentity(draft.agentTarget.identity);
    if (bundledAgentId) {
        return { kind: 'backend', backendId: bundledAgentId, sourceKind: 'built_in' };
    }
    try {
        return stripBackendTargetSourceKind(readBackendTargetRefV2(draft.agentTarget));
    } catch {
        return null;
    }
}

function buildCanonicalDraftModelSelection(params: Readonly<{
    agentTarget: AgentExecutionTargetV1 | null | undefined;
    modelSelection?: SessionModelSelectionV1 | null;
    legacyModelId?: string | null;
    legacyUpdatedAt?: number | null;
}>): SessionModelSelectionV1 | null {
    const targetKey = params.agentTarget ? buildBackendTargetKeyV2(params.agentTarget) : null;
    if (params.modelSelection) {
        const selection = SessionModelSelectionV1Schema.parse(params.modelSelection);
        if (!targetKey || selection.ref.agentTargetKey !== targetKey) {
            throw new Error('Session authoring model selection target mismatch');
        }
        return selection;
    }

    const modelId = normalizeOptionalString(params.legacyModelId);
    if (!modelId || modelId === 'default') return null;
    if (!targetKey) {
        throw new Error('Session authoring model selection requires backend target');
    }
    return SessionModelSelectionV1Schema.parse({
        v: 1,
        updatedAt: normalizeOptionalNumber(params.legacyUpdatedAt) ?? 0,
        ref: {
            agentTargetKey: targetKey,
            providerConnectionId: null,
            modelId,
        },
    });
}

export function rekeyCompatibilityModelSelection(
    selection: SessionModelSelectionV1 | null | undefined,
    agentTarget: AgentExecutionTargetV1 | null,
): SessionModelSelectionV1 | null | undefined {
    if (!selection || !agentTarget) return selection;
    return SessionModelSelectionV1Schema.parse({
        ...selection,
        ref: {
            ...selection.ref,
            agentTargetKey: buildBackendTargetKeyV2(agentTarget),
        },
    });
}

function resolveConnectedServicesFromAgentOptionState(params: Readonly<{
    target: BackendTargetRefV2 | AgentExecutionTargetV1 | null;
    backendNewSessionOptionStateByTargetKey?: Record<string, Record<string, unknown>> | null;
}>): unknown {
    if (!params.target || !params.backendNewSessionOptionStateByTargetKey) {
        return null;
    }
    const targetKey = buildBackendTargetKeyV2(params.target);
    const targetOptions = params.backendNewSessionOptionStateByTargetKey[targetKey];
    if (!targetOptions || typeof targetOptions !== 'object' || Array.isArray(targetOptions)) {
        return null;
    }
    return Object.prototype.hasOwnProperty.call(targetOptions, 'connectedServices')
        ? (targetOptions as Record<string, unknown>).connectedServices ?? null
        : null;
}

type NewSessionAuthoringDraftParams = Omit<
    SessionAuthoringDraft,
    'targetType' | 'existingSessionId' | 'sessionEncryptionMode' | 'sessionEncryptionKeyBase64' | 'sessionEncryptionVariant' | 'windowsTerminalWindowName' | 'modelSelection' | 'modelId' | 'modelUpdatedAt'
> & Readonly<{
    windowsTerminalWindowName?: SessionAuthoringDraft['windowsTerminalWindowName'];
    modelSelection?: SessionModelSelectionV1 | null;
    modelId?: string | null;
    modelUpdatedAt?: number | null;
}>;

export function buildNewSessionAuthoringDraft(params: NewSessionAuthoringDraftParams): SessionAuthoringDraft {
    const runtimeDescriptorV1 = readRuntimeDescriptorV1(params.runtimeDescriptorV1) ?? null;

    const hasModelSelectionInput = params.modelSelection !== undefined || params.modelId !== undefined;
    const normalizedModelSelection = hasModelSelectionInput
        ? buildCanonicalDraftModelSelection({
            agentTarget: params.agentTarget,
            modelSelection: params.modelSelection,
            legacyModelId: params.modelId,
            legacyUpdatedAt: params.modelUpdatedAt,
        })
        : undefined;

    return {
        targetType: 'new_session',
        ...(params.sessionName === undefined ? {} : { sessionName: params.sessionName }),
        ...(params.initialSessionFacts === undefined ? {} : {
            initialSessionFacts: SessionIdentityAdditionsV1Schema.parse(params.initialSessionFacts),
        }),
        ...(params.memoryEnabled === undefined ? {} : { memoryEnabled: params.memoryEnabled }),
        ...(params.promptStack === undefined ? {} : { promptStack: SessionPromptStackV1Schema.parse(params.promptStack) }),
        ...(params.instructionsDraft === undefined ? {} : { instructionsDraft: readSessionInstructionsAuthoringDraft(params.instructionsDraft) }),
        executionTarget: SessionAuthoringValueV1Schema.shape.executionTarget.parse(params.executionTarget ?? null),
        ...(params.temporaryComputerActivationRef !== undefined
            ? { temporaryComputerActivationRef: params.temporaryComputerActivationRef }
            : {}),
        directory: normalizeRequiredString(params.directory),
        ...(params.directoryKind === 'managed' ? { directoryKind: 'managed' as const } : {}),
        checkoutCreationDraft: params.checkoutCreationDraft,
        organizationPlacement: normalizeOrganizationPlacement(params.organizationPlacement),
        ...(params.access !== undefined ? { access: params.access } : {}),
        ...(params.primaryTeamId !== undefined ? { primaryTeamId: params.primaryTeamId } : {}),
        ...(params.teamCredentialBindings !== undefined ? { teamCredentialBindings: params.teamCredentialBindings } : {}),
        ...(params.initialTriggers !== undefined ? { initialTriggers: params.initialTriggers } : {}),
        prompt: params.prompt.trim(),
        displayText: params.displayText.trim(),
        agentTarget: params.agentTarget ? AgentExecutionTargetV1Schema.parse(params.agentTarget) : null,
        transcriptStorage: params.transcriptStorage ?? null,
        profileId: params.profileId === '' ? '' : normalizeOptionalString(params.profileId),
        environmentVariables: params.environmentVariables ?? null,
        // Agent-issued and opaque: presence only, bytes preserved.
        resumeSessionId: readNonBlankOpaqueIdentifier(params.resumeSessionId),
        permissionMode: normalizeOptionalString(params.permissionMode),
        permissionModeUpdatedAt: normalizeOptionalNumber(params.permissionModeUpdatedAt),
        ...(hasModelSelectionInput ? { modelSelection: normalizedModelSelection } : {}),
        mcpSelection: params.mcpSelection ?? null,
        connectedServices: params.connectedServices,
        terminal: params.terminal ?? null,
        windowsRemoteSessionLaunchMode: params.windowsRemoteSessionLaunchMode ?? null,
        windowsRemoteSessionConsole: params.windowsRemoteSessionConsole ?? null,
        windowsTerminalWindowName: normalizeOptionalString(params.windowsTerminalWindowName),
        runtimeDescriptorV1,
        acpSessionModeId: normalizeOptionalString(params.acpSessionModeId),
        sessionConfigOptionOverrides: normalizeSessionConfigOptionOverrides(params.sessionConfigOptionOverrides),
        existingSessionId: null,
        sessionEncryptionMode: null,
        sessionEncryptionKeyBase64: null,
        sessionEncryptionVariant: null,
        automation: normalizeAutomationDraft(params.automation),
    };
}

type ResolvedNewSessionAuthoringDraftInputs = Readonly<{
    sessionName?: SessionAuthoringDraft['sessionName'];
    initialSessionFacts?: SessionAuthoringDraft['initialSessionFacts'];
    memoryEnabled?: SessionAuthoringDraft['memoryEnabled'];
    promptStack?: SessionAuthoringDraft['promptStack'];
    instructionsDraft?: SessionAuthoringDraft['instructionsDraft'];
    executionTarget?: SessionAuthoringDraft['executionTarget'];
    temporaryComputerActivationRef?: SessionAuthoringDraft['temporaryComputerActivationRef'];
    directory: string;
    directoryKind?: SessionAuthoringDraft['directoryKind'];
    checkoutCreationDraft?: SessionAuthoringDraft['checkoutCreationDraft'];
    organizationPlacement?: SessionAuthoringDraft['organizationPlacement'];
    access?: SessionAuthoringDraft['access'];
    primaryTeamId?: SessionAuthoringDraft['primaryTeamId'];
    teamCredentialBindings?: SessionAuthoringDraft['teamCredentialBindings'];
    initialTriggers?: SessionAuthoringDraft['initialTriggers'];
    prompt: string;
    displayText?: string | null;
    agentTarget?: SessionAuthoringDraft['agentTarget'];
    transcriptStorage?: SessionAuthoringDraft['transcriptStorage'];
    profileId?: SessionAuthoringDraft['profileId'];
    environmentVariables?: SessionAuthoringDraft['environmentVariables'];
    resumeSessionId?: SessionAuthoringDraft['resumeSessionId'];
    permissionMode?: SessionAuthoringDraft['permissionMode'];
    permissionModeUpdatedAt?: SessionAuthoringDraft['permissionModeUpdatedAt'];
    modelSelection?: SessionModelSelectionV1 | null;
    modelId?: SessionAuthoringDraft['modelId'];
    modelUpdatedAt?: SessionAuthoringDraft['modelUpdatedAt'];
    mcpSelection?: SessionAuthoringDraft['mcpSelection'];
    connectedServices: SessionAuthoringDraft['connectedServices'];
    terminal?: SessionAuthoringDraft['terminal'];
    windowsRemoteSessionLaunchMode?: SessionAuthoringDraft['windowsRemoteSessionLaunchMode'];
    windowsRemoteSessionConsole?: SessionAuthoringDraft['windowsRemoteSessionConsole'];
    windowsTerminalWindowName?: SessionAuthoringDraft['windowsTerminalWindowName'];
    runtimeDescriptorV1?: SessionAuthoringDraft['runtimeDescriptorV1'];
    acpSessionModeId?: SessionAuthoringDraft['acpSessionModeId'];
    sessionConfigOptionOverrides?: SessionAuthoringDraft['sessionConfigOptionOverrides'];
    automation?: SessionAuthoringDraft['automation'];
}>;

export function buildNewSessionAuthoringDraftFromResolvedInputs(
    params: ResolvedNewSessionAuthoringDraftInputs,
): SessionAuthoringDraft {
    return buildNewSessionAuthoringDraft({
        sessionName: params.sessionName,
        initialSessionFacts: params.initialSessionFacts,
        memoryEnabled: params.memoryEnabled,
        promptStack: params.promptStack,
        instructionsDraft: params.instructionsDraft,
        executionTarget: params.executionTarget ?? null,
        temporaryComputerActivationRef: params.temporaryComputerActivationRef,
        directory: params.directory,
        directoryKind: params.directoryKind,
        checkoutCreationDraft: params.checkoutCreationDraft ?? null,
        organizationPlacement: params.organizationPlacement ?? { folderId: null, tagIds: [] },
        ...(params.access !== undefined ? { access: params.access } : {}),
        ...(params.primaryTeamId !== undefined ? { primaryTeamId: params.primaryTeamId } : {}),
        ...(params.teamCredentialBindings !== undefined ? { teamCredentialBindings: params.teamCredentialBindings } : {}),
        ...(params.initialTriggers !== undefined ? { initialTriggers: params.initialTriggers } : {}),
        prompt: params.prompt,
        displayText: params.displayText ?? params.prompt,
        agentTarget: params.agentTarget ?? null,
        transcriptStorage: params.transcriptStorage ?? null,
        profileId: params.profileId ?? null,
        environmentVariables: params.environmentVariables ?? null,
        resumeSessionId: params.resumeSessionId ?? null,
        permissionMode: params.permissionMode ?? null,
        permissionModeUpdatedAt: params.permissionModeUpdatedAt ?? null,
        modelSelection: params.modelSelection,
        modelId: params.modelSelection === undefined ? params.modelId : undefined,
        modelUpdatedAt: params.modelUpdatedAt,
        mcpSelection: params.mcpSelection ?? null,
        connectedServices: params.connectedServices,
        terminal: params.terminal ?? null,
        windowsRemoteSessionLaunchMode: params.windowsRemoteSessionLaunchMode ?? null,
        windowsRemoteSessionConsole: params.windowsRemoteSessionConsole ?? null,
        windowsTerminalWindowName: params.windowsTerminalWindowName ?? null,
        runtimeDescriptorV1: params.runtimeDescriptorV1 ?? null,
        acpSessionModeId: params.acpSessionModeId ?? null,
        sessionConfigOptionOverrides: params.sessionConfigOptionOverrides ?? null,
        automation: params.automation ?? null,
    });
}

type NewSessionAuthoringDraftSource =
    | Readonly<{ kind: 'tempData'; source: NewSessionData }>
    | Readonly<{ kind: 'persistedDraft'; source: NewSessionDraft }>;

function resolveNewSessionSourceDirectory(source: NewSessionAuthoringDraftSource): string | null | undefined {
    return source.kind === 'tempData'
        ? source.source.directory ?? source.source.path
        : source.source.selectedPath;
}

function resolveNewSessionSourcePrompt(source: NewSessionAuthoringDraftSource): string | null | undefined {
    return source.kind === 'tempData'
        ? source.source.prompt
        : source.source.input;
}

function resolveNewSessionSourceProfileId(source: NewSessionAuthoringDraftSource): string | null | undefined {
    return source.kind === 'tempData'
        ? source.source.selectedProfileId
        : source.source.selectedProfileId;
}

function resolveNewSessionSourceModelId(source: NewSessionAuthoringDraftSource): string | null {
    if (source.kind === 'persistedDraft') {
        return source.source.modelSelection?.ref.modelId ?? null;
    }
    const rawModelMode = source.source.modelMode;
    if (!isModelMode(rawModelMode)) {
        return null;
    }
    return rawModelMode !== 'default' ? rawModelMode : null;
}

function buildNewSessionAuthoringDraftFromSource(source: NewSessionAuthoringDraftSource): SessionAuthoringDraft {
    const backendTarget = source.source.backendTarget ?? null;
    const agentTarget = source.source.agentTarget ?? resolveCompatibilityAgentTarget(
        backendTarget,
        source.source.agentType,
    );
    const backendNewSessionOptionStateByTargetKey = readBackendNewSessionOptionStateByTargetKey(source.source);

    return buildNewSessionAuthoringDraft({
        sessionName: source.source.sessionName,
        initialSessionFacts: source.source.initialSessionFacts,
        memoryEnabled: source.source.memoryEnabled,
        promptStack: source.source.promptStack,
        instructionsDraft: source.source.instructionsDraft,
        executionTarget: source.source.executionTarget !== undefined ? source.source.executionTarget : fromExactMachineTarget(
            source.kind === 'persistedDraft'
            && source.source.targetServerId
            && source.source.selectedMachineId
                ? { serverId: source.source.targetServerId, machineId: source.source.selectedMachineId }
                : null
        ),
        temporaryComputerActivationRef: source.source.temporaryComputerActivationRef,
        // A no-folder seed has no folder to remember; any other seed without one keeps the old fallback.
        directory: resolveNewSessionSourceDirectory(source) ?? (source.source.directoryKind === 'managed' ? '' : '/'),
        ...(source.source.directoryKind === 'managed' ? { directoryKind: 'managed' as const } : {}),
        checkoutCreationDraft: source.source.checkoutCreationDraft ?? null,
        organizationPlacement: source.source.organizationPlacement ?? { folderId: null, tagIds: [] },
        ...(source.source.access !== undefined ? { access: source.source.access } : {}),
        ...(source.source.primaryTeamId !== undefined ? { primaryTeamId: source.source.primaryTeamId } : {}),
        ...(source.source.initialTriggers !== undefined ? { initialTriggers: source.source.initialTriggers } : {}),
        // Only the persisted draft carries device-local Team credential slot
        // intents; the temp-data handoff has no such field to project.
        ...(source.kind === 'persistedDraft' && source.source.teamCredentialBindings !== undefined
            ? { teamCredentialBindings: source.source.teamCredentialBindings }
            : {}),
        prompt: resolveNewSessionSourcePrompt(source) ?? '',
        displayText: resolveNewSessionSourcePrompt(source) ?? '',
        agentTarget,
        transcriptStorage: source.source.transcriptStorage ?? null,
        profileId: resolveNewSessionSourceProfileId(source) ?? null,
        environmentVariables: null,
        resumeSessionId: source.source.resumeSessionId ?? null,
        permissionMode: source.source.permissionMode ?? null,
        permissionModeUpdatedAt: null,
        modelSelection: source.source.agentTarget
            ? source.source.modelSelection
            : rekeyCompatibilityModelSelection(source.source.modelSelection, agentTarget),
        modelId: source.source.modelSelection === undefined
            && (source.kind === 'tempData' && Object.prototype.hasOwnProperty.call(source.source, 'modelMode'))
            ? resolveNewSessionSourceModelId(source)
            : undefined,
        modelUpdatedAt: source.source.modelSelection?.updatedAt,
        mcpSelection: source.source.mcpSelection ?? null,
        connectedServices: normalizeSessionAuthoringConnectedServices(resolveConnectedServicesFromAgentOptionState({
            target: source.source.agentTarget ?? backendTarget,
            backendNewSessionOptionStateByTargetKey,
        })),
        terminal: null,
        windowsRemoteSessionLaunchMode: null,
        windowsRemoteSessionConsole: null,
        windowsTerminalWindowName: null,
        runtimeDescriptorV1: source.source.runtimeDescriptorV1 ?? null,
        acpSessionModeId: source.source.acpSessionModeId ?? null,
        sessionConfigOptionOverrides: source.source.sessionConfigOptionOverrides ?? null,
        automation: source.source.automationDraft ?? null,
    });
}

export function buildNewSessionAuthoringDraftFromTempData(data: NewSessionData): SessionAuthoringDraft {
    return buildNewSessionAuthoringDraftFromSource({
        kind: 'tempData',
        source: data,
    });
}

export function buildNewSessionAuthoringDraftFromPersistedDraft(draft: NewSessionDraft): SessionAuthoringDraft {
    return buildNewSessionAuthoringDraftFromSource({
        kind: 'persistedDraft',
        source: draft,
    });
}

export function buildExistingSessionAuthoringDraftFromSessionSnapshot(params: Readonly<{
    session: ExistingSessionAuthoringSnapshotSession;
    message: string;
    sessionDekBase64?: string | null;
}>): SessionAuthoringDraft {
    const snapshot = buildExistingSessionAuthoringSnapshot({
        session: params.session,
        sessionDekBase64: params.sessionDekBase64,
    });
    const message = params.message.trim();

    return buildExistingSessionAuthoringDraftFromSnapshotData({
        snapshot,
        message,
    });
}

export function buildExistingSessionAuthoringSnapshot(params: Readonly<{
    session: ExistingSessionAuthoringSnapshotSession;
    sessionDekBase64?: string | null;
}>): ReturnType<typeof deriveSessionAuthoringSnapshot> {
    return deriveSessionAuthoringSnapshot({
        session: params.session,
        sessionDekBase64: params.sessionDekBase64,
    });
}

export function hydrateSessionAuthoringDraftFromAutomationTemplate(params: Readonly<{
    targetType: SessionAuthoringDraft['targetType'];
    template: AutomationTemplate;
}>): SessionAuthoringDraft {
    const backendTarget = params.template.backendTarget
        ?? (normalizeOptionalString(params.template.agent)
            ? { kind: 'backend', backendId: normalizeOptionalString(params.template.agent)! } satisfies BackendTargetRefV2
            : null);
    const sanitizedBackendTarget = backendTarget ? stripBackendTargetSourceKind(backendTarget) : null;
    const agentTarget = params.template.agentTarget ?? resolveCompatibilityAgentTarget(
        sanitizedBackendTarget,
        params.template.agent,
    );
    const hasModelSelectionInput = params.template.modelSelection !== undefined
        || params.template.modelId !== undefined;
    const modelSelection = hasModelSelectionInput
        ? buildCanonicalDraftModelSelection({
            agentTarget,
            modelSelection: params.template.agentTarget
                ? params.template.modelSelection
                : rekeyCompatibilityModelSelection(params.template.modelSelection, agentTarget),
            legacyModelId: params.template.modelId,
            legacyUpdatedAt: params.template.modelUpdatedAt,
        })
        : undefined;

    return {
        targetType: params.targetType,
        executionTarget: fromExactMachineTarget(params.template.executionTarget),
        directory: normalizeRequiredString(params.template.directory),
        checkoutCreationDraft: parseCheckoutCreationDraft(params.template.checkoutCreationDraft),
        organizationPlacement: normalizeOrganizationPlacement(params.template.organizationPlacement),
        prompt: params.template.prompt ?? '',
        displayText: params.template.displayText ?? '',
        agentTarget,
        transcriptStorage: params.template.transcriptStorage ?? null,
        profileId: normalizeOptionalString(params.template.profileId),
        environmentVariables: params.template.environmentVariables ?? null,
        resumeSessionId: readNonBlankOpaqueIdentifier(params.template.resume),
        permissionMode: normalizeOptionalString(params.template.permissionMode),
        permissionModeUpdatedAt: normalizeOptionalNumber(params.template.permissionModeUpdatedAt),
        ...(hasModelSelectionInput ? { modelSelection } : {}),
        sessionConfigOptionOverrides: normalizeSessionConfigOptionOverrides(params.template.sessionConfigOptionOverrides),
        mcpSelection: params.template.mcpSelection ?? null,
        connectedServices: normalizeSessionAuthoringConnectedServices(params.template.connectedServices),
        terminal: normalizeSessionAuthoringTerminal(params.template.terminal),
        windowsRemoteSessionLaunchMode: params.template.windowsRemoteSessionLaunchMode ?? null,
        windowsRemoteSessionConsole: params.template.windowsRemoteSessionConsole ?? null,
        windowsTerminalWindowName: normalizeOptionalString(params.template.windowsTerminalWindowName),
        runtimeDescriptorV1: params.template.runtimeDescriptorV1 ?? null,
        acpSessionModeId: normalizeOptionalString(params.template.agentModeId),
        existingSessionId: params.targetType === 'existing_session'
            ? normalizeOptionalString(params.template.existingSessionId)
            : null,
        sessionEncryptionMode: params.targetType === 'existing_session'
            ? params.template.sessionEncryptionMode ?? null
            : null,
        sessionEncryptionKeyBase64: params.targetType === 'existing_session'
            ? normalizeOptionalString(params.template.sessionEncryptionKeyBase64)
            : null,
        sessionEncryptionVariant: params.targetType === 'existing_session'
            ? params.template.sessionEncryptionVariant ?? null
            : null,
        automation: null,
    };
}

export function buildAutomationTemplateFromSessionAuthoringDraft(draft: SessionAuthoringDraft): AutomationTemplate {
    return {
        ...(draft.executionTarget ? { executionTarget: toExactMachineTarget(draft.executionTarget) } : {}),
        directory: normalizeRequiredString(draft.directory),
        ...(draft.checkoutCreationDraft
            ? {
                checkoutCreationDraft: {
                    kind: 'git_worktree',
                    displayName: draft.checkoutCreationDraft.displayName.trim(),
                    baseRef: normalizeOptionalString(draft.checkoutCreationDraft.baseRef) ?? null,
                    ...(draft.checkoutCreationDraft.branchMode
                        ? { branchMode: draft.checkoutCreationDraft.branchMode }
                        : {}),
                },
            }
            : {}),
        organizationPlacement: normalizeOrganizationPlacement(draft.organizationPlacement),
        ...(normalizeOptionalString(draft.prompt) ? { prompt: draft.prompt.trim() } : {}),
        ...(normalizeOptionalString(draft.displayText) ? { displayText: draft.displayText.trim() } : {}),
        ...(draft.agentTarget ? { agentTarget: draft.agentTarget } : {}),
        ...(draft.transcriptStorage ? { transcriptStorage: draft.transcriptStorage } : {}),
        ...(normalizeOptionalString(draft.profileId) ? { profileId: draft.profileId!.trim() } : {}),
        ...(draft.environmentVariables ? { environmentVariables: draft.environmentVariables } : {}),
        ...(readNonBlankOpaqueIdentifier(draft.resumeSessionId)
            ? { resume: readNonBlankOpaqueIdentifier(draft.resumeSessionId)! }
            : {}),
        ...(normalizeOptionalString(draft.permissionMode) ? { permissionMode: draft.permissionMode!.trim() } : {}),
        ...(typeof draft.permissionModeUpdatedAt === 'number' ? { permissionModeUpdatedAt: draft.permissionModeUpdatedAt } : {}),
        ...(draft.modelSelection ? { modelSelection: draft.modelSelection } : {}),
        ...(draft.sessionConfigOptionOverrides ? { sessionConfigOptionOverrides: draft.sessionConfigOptionOverrides } : {}),
        ...(draft.mcpSelection ? { mcpSelection: draft.mcpSelection } : {}),
        ...(draft.connectedServices !== undefined && draft.connectedServices !== null ? { connectedServices: draft.connectedServices } : {}),
        ...(draft.terminal !== undefined && draft.terminal !== null ? { terminal: draft.terminal } : {}),
        ...(draft.windowsRemoteSessionLaunchMode ? { windowsRemoteSessionLaunchMode: draft.windowsRemoteSessionLaunchMode } : {}),
        ...(draft.windowsRemoteSessionConsole ? { windowsRemoteSessionConsole: draft.windowsRemoteSessionConsole } : {}),
        ...(normalizeOptionalString(draft.windowsTerminalWindowName) ? { windowsTerminalWindowName: draft.windowsTerminalWindowName!.trim() } : {}),
        ...(draft.runtimeDescriptorV1 ? { runtimeDescriptorV1: draft.runtimeDescriptorV1 } : {}),
        ...(normalizeOptionalString(draft.acpSessionModeId) ? { agentModeId: draft.acpSessionModeId!.trim() } : {}),
        ...(draft.targetType === 'existing_session' && normalizeOptionalString(draft.existingSessionId)
            ? { existingSessionId: draft.existingSessionId!.trim() }
            : {}),
        ...(draft.targetType === 'existing_session' && draft.sessionEncryptionMode
            ? { sessionEncryptionMode: draft.sessionEncryptionMode }
            : {}),
        ...(draft.targetType === 'existing_session' && normalizeOptionalString(draft.sessionEncryptionKeyBase64)
            ? { sessionEncryptionKeyBase64: draft.sessionEncryptionKeyBase64!.trim() }
            : {}),
        ...(draft.targetType === 'existing_session' && draft.sessionEncryptionVariant
            ? { sessionEncryptionVariant: draft.sessionEncryptionVariant }
            : {}),
    };
}

/**
 * The one mapping from authored directory fields to the spawn contract's directory intent.
 * `directory` is the remembered folder; `directoryKind: 'managed'` means no folder (the target
 * daemon keeps a private one). A draft without the kind predates folder-less sessions: a folder.
 */
export function resolveSessionAuthoringDirectoryIntent(
    draft: Readonly<Pick<SessionAuthoringDraft, 'directory' | 'directoryKind'>>,
): SessionDirectoryIntentV1 {
    return draft.directoryKind === 'managed'
        ? { kind: 'managed' }
        : { kind: 'path', path: normalizeRequiredString(draft.directory) };
}

function authoringDirectoryFieldsFromIntent(
    intent: SessionDirectoryIntentV1,
): Readonly<{ directory: string; directoryKind?: 'managed' }> {
    return intent.kind === 'managed'
        ? { directory: '', directoryKind: 'managed' }
        : { directory: intent.path };
}

/**
 * Shared normalization for both creation boundaries. The private compatibility
 * payload remains only for its existing callers, but it must not reinterpret
 * model/config/connected-service facts differently from strict V2.
 */
function resolveSharedSessionAuthoringSpawnFields(draft: SessionAuthoringDraft) {
    return {
        directory: resolveSessionAuthoringDirectoryIntent(draft),
        sessionName: normalizeOptionalString(draft.sessionName),
        initialSessionFacts: draft.initialSessionFacts,
        memoryEnabled: draft.memoryEnabled,
        promptStack: draft.promptStack,
        profileId: typeof draft.profileId === 'string' ? draft.profileId.trim() : '',
        resumeSessionId: readNonBlankOpaqueIdentifier(draft.resumeSessionId),
        agentModeId: normalizeOptionalString(draft.acpSessionModeId),
        modelSelection: draft.modelSelection ?? null,
        sessionConfigOptionOverrides: draft.sessionConfigOptionOverrides ?? null,
        connectedServices: draft.connectedServices,
        mcpSelection: draft.mcpSelection,
        transcriptStorage: draft.transcriptStorage,
    };
}

function buildStrictV2TerminalFromAuthoringDraft(
    draft: SessionAuthoringDraft,
): SessionAuthoringDraft['terminal'] | undefined {
    const windows = {
        ...(draft.windowsRemoteSessionLaunchMode
            ? { launchMode: draft.windowsRemoteSessionLaunchMode }
            : {}),
        ...(draft.windowsRemoteSessionConsole
            ? { console: draft.windowsRemoteSessionConsole }
            : {}),
        ...(normalizeOptionalString(draft.windowsTerminalWindowName)
            ? { windowName: normalizeOptionalString(draft.windowsTerminalWindowName)! }
            : {}),
    };
    if (!draft.terminal && Object.keys(windows).length === 0) {
        return undefined;
    }
    if (Object.keys(windows).length === 0) {
        return draft.terminal ?? undefined;
    }
    return {
        ...(draft.terminal ?? {}),
        windows: {
            ...(draft.terminal?.windows ?? {}),
            ...windows,
        },
    };
}

type SessionServerStartSpawnDraftFromAuthoringParams = Readonly<{
    draft: SessionAuthoringDraft;
    permissionMode: string;
    configurationUpdatedAtMs: number;
}>;

/**
 * One current catalog projection entry that can represent an Agent contribution
 * in the session authoring vocabulary. The caller must derive this list from
 * the current catalog; this adapter deliberately has no selected-Agent default.
 */
export type SessionAuthoringAgentTargetCatalogEntry = Readonly<{
    agentTarget: AgentExecutionTargetV1;
    agentId: string;
    backendTarget: BackendTargetRefV2;
}>;

export type SessionAuthoringDraftFromServerStartSpawnDraftV1UnavailableReason =
    | 'invalid_spawn'
    | 'agent_target_unavailable'
    | 'agent_target_ambiguous'
    | 'configuration_missing'
    | 'configuration_permission_mismatch'
    | 'configuration_mode_mismatch'
    | 'configuration_model_mismatch'
    | 'model_selection_target_mismatch'
    | 'authoring_draft_unrepresentable';

export type SessionAuthoringDraftFromServerStartSpawnDraftV1Result =
    | Readonly<{
        kind: 'available';
        draft: SessionAuthoringDraft;
    }>
    | Readonly<{
        kind: 'unavailable';
        reason: SessionAuthoringDraftFromServerStartSpawnDraftV1UnavailableReason;
    }>;

function agentExecutionTargetsMatch(
    left: AgentExecutionTargetV1,
    right: AgentExecutionTargetV1,
): boolean {
    return left.kind === right.kind
        && left.identity.pluginId === right.identity.pluginId
        && left.identity.localId === right.identity.localId
        && left.definitionId === right.definitionId;
}

function resolveSessionAuthoringAgentTargetCatalogEntry(params: Readonly<{
    agentTarget: AgentExecutionTargetV1;
    catalog: readonly SessionAuthoringAgentTargetCatalogEntry[];
}>): Readonly<{
    kind: 'available';
    entry: Readonly<{
        agentTarget: AgentExecutionTargetV1;
        agentId: string;
        backendTarget: BackendTargetRefV2;
    }>;
}> | Readonly<{
    kind: 'unavailable';
    reason: 'agent_target_unavailable' | 'agent_target_ambiguous';
}> {
    const matches: Array<Readonly<{
        agentTarget: AgentExecutionTargetV1;
        agentId: string;
        backendTarget: BackendTargetRefV2;
    }>> = [];

    for (const candidate of params.catalog) {
        const candidateAgentTarget = AgentExecutionTargetV1Schema.safeParse(candidate.agentTarget);
        if (!candidateAgentTarget.success || !agentExecutionTargetsMatch(candidateAgentTarget.data, params.agentTarget)) {
            continue;
        }

        const agentId = normalizeOptionalString(candidate.agentId);
        if (!agentId) continue;

        let backendTarget: BackendTargetRefV2;
        try {
            backendTarget = stripBackendTargetSourceKind(readBackendTargetRefV2(candidate.backendTarget));
        } catch {
            continue;
        }
        if (backendTarget.configuredBackendId !== candidateAgentTarget.data.definitionId) continue;

        matches.push({ agentTarget: candidateAgentTarget.data, agentId, backendTarget });
    }

    if (matches.length === 0) {
        return { kind: 'unavailable', reason: 'agent_target_unavailable' };
    }
    if (matches.length !== 1) {
        return { kind: 'unavailable', reason: 'agent_target_ambiguous' };
    }
    return { kind: 'available', entry: matches[0]! };
}

/**
 * Projects the Session-owned server-start shape into the generic authoring
 * draft used by the new-session editor. Prompt/display text are separate
 * because server-start deliberately excludes the initial input. Session
 * execution and organization facts remain with the caller's source seed;
 * they are not authoring-draft fields.
 *
 * An Event edit must not choose a replacement Agent or silently reinterpret a
 * divergent nested configuration, so every raw Agent target must have exactly
 * one current-catalog candidate and the duplicated strict configuration facts
 * must agree before this projection is available.
 */
export function buildSessionAuthoringDraftFromServerStartSpawnDraftV1(params: Readonly<{
    spawn: SessionServerStartSpawnDraftV1;
    prompt: string;
    displayText?: string | null;
    agentTargetCatalog: readonly SessionAuthoringAgentTargetCatalogEntry[];
}>): SessionAuthoringDraftFromServerStartSpawnDraftV1Result {
    const parsedSpawn = SessionServerStartSpawnDraftV1Schema.safeParse(params.spawn);
    if (!parsedSpawn.success) {
        return { kind: 'unavailable', reason: 'invalid_spawn' };
    }
    const spawn = parsedSpawn.data;
    if (!spawn.configuration) {
        return { kind: 'unavailable', reason: 'configuration_missing' };
    }
    const configuration = spawn.configuration;
    if (
        !spawn.permissionMode
        || configuration.permissionIntent.value !== spawn.permissionMode
    ) {
        return { kind: 'unavailable', reason: 'configuration_permission_mismatch' };
    }
    if ((spawn.agentModeId ?? null) !== configuration.mode.value) {
        return { kind: 'unavailable', reason: 'configuration_mode_mismatch' };
    }
    if ((spawn.modelSelection?.ref.modelId ?? null) !== configuration.model.value) {
        return { kind: 'unavailable', reason: 'configuration_model_mismatch' };
    }

    const resolvedAgentTarget = resolveSessionAuthoringAgentTargetCatalogEntry({
        agentTarget: spawn.agentTarget,
        catalog: params.agentTargetCatalog,
    });
    if (resolvedAgentTarget.kind === 'unavailable') {
        return resolvedAgentTarget;
    }

    if (
        spawn.modelSelection
        && spawn.modelSelection.ref.agentTargetKey !== buildBackendTargetKeyV2(resolvedAgentTarget.entry.agentTarget)
    ) {
        return { kind: 'unavailable', reason: 'model_selection_target_mismatch' };
    }

    const rawConnectedServices = spawn.connectedServices ?? null;
    const connectedServices = normalizeSessionAuthoringConnectedServices(rawConnectedServices);
    if (rawConnectedServices !== null && connectedServices === null) {
        return { kind: 'unavailable', reason: 'authoring_draft_unrepresentable' };
    }

    const windows = spawn.terminal?.windows;
    try {
        return {
            kind: 'available',
            draft: buildNewSessionAuthoringDraft({
                sessionName: spawn.title,
                initialSessionFacts: spawn.identity,
                memoryEnabled: spawn.memoryEnabled,
                promptStack: spawn.promptStack,
                executionTarget: fromExactMachineTarget({
                    ...spawn.executionTarget,
                    ...(spawn.placementOrigin ? { selectionOrigin: spawn.placementOrigin } : {}),
                }),
                ...authoringDirectoryFieldsFromIntent(spawn.directory),
                checkoutCreationDraft: spawn.checkoutCreationDraft ?? null,
                organizationPlacement: spawn.organizationPlacement ?? { folderId: null, tagIds: [] },
                prompt: params.prompt,
                displayText: params.displayText ?? params.prompt,
                agentTarget: resolvedAgentTarget.entry.agentTarget,
                transcriptStorage: spawn.transcriptStorage ?? null,
                profileId: spawn.profileId ?? null,
                environmentVariables: null,
                resumeSessionId: spawn.configuration.providerSessionResume?.providerSessionId ?? null,
                permissionMode: spawn.permissionMode,
                permissionModeUpdatedAt: configuration.permissionIntent.updatedAtMs,
                modelSelection: spawn.modelSelection ?? null,
                mcpSelection: spawn.mcpSelection ?? null,
                connectedServices,
                terminal: spawn.terminal ?? null,
                windowsRemoteSessionLaunchMode: windows?.launchMode ?? null,
                windowsRemoteSessionConsole: windows?.console ?? null,
                windowsTerminalWindowName: windows?.windowName ?? null,
                runtimeDescriptorV1: null,
                acpSessionModeId: spawn.agentModeId ?? null,
                sessionConfigOptionOverrides: buildSessionConfigOptionOverridesFromServerStart(configuration),
                automation: null,
            }),
        };
    } catch {
        return { kind: 'unavailable', reason: 'authoring_draft_unrepresentable' };
    }
}

/**
 * Converts the canonical authored draft into the strict Session-owned
 * server-start vocabulary. Reserved origins provide creation identity and
 * initial input later; this adapter deliberately cannot manufacture either.
 */
export function buildSessionServerStartSpawnDraftV1FromAuthoringDraft(
    params: SessionServerStartSpawnDraftFromAuthoringParams,
): SessionServerStartSpawnDraftV1 {
    if (!params.draft.executionTarget) {
        throw new Error('New Session authoring draft requires executionTarget');
    }
    const executionTarget = requireMachineAuthoringTarget(params.draft.executionTarget);
    return SessionServerStartSpawnDraftV1Schema.parse({
        ...resolveSessionAuthoringSpawnInput(params),
        executionTarget: executionTarget.target,
        ...(executionTarget.selectionOrigin ? { placementOrigin: executionTarget.selectionOrigin } : {}),
    });
}

/** The ordinary start and managed continuation share every target-independent authored field. */
function resolveSessionAuthoringSpawnInput(params: SessionServerStartSpawnDraftFromAuthoringParams) {
    const fields = resolveSharedSessionAuthoringSpawnFields(params.draft);
    const updatedAtMs = Math.max(0, Math.floor(params.configurationUpdatedAtMs));
    const optionOverrides = fields.sessionConfigOptionOverrides?.overrides ?? {};
    const terminal = buildStrictV2TerminalFromAuthoringDraft(params.draft);
    const options = Object.fromEntries(Object.entries(optionOverrides).map(([key, override]) => [
        key,
        {
            value: override.value,
            updatedAtMs: Math.max(0, Math.floor(override.updatedAt)),
        },
    ]));

    if (!params.draft.agentTarget) {
        throw new Error('New Session authoring draft requires agentTarget');
    }
    return {
        ...(fields.sessionName ? { title: fields.sessionName } : {}),
        ...(fields.initialSessionFacts === undefined ? {} : { identity: fields.initialSessionFacts }),
        ...(fields.memoryEnabled === undefined ? {} : { memoryEnabled: fields.memoryEnabled }),
        ...(fields.promptStack === undefined ? {} : { promptStack: fields.promptStack }),
        directory: fields.directory,
        organizationPlacement: normalizeOrganizationPlacement(params.draft.organizationPlacement),
        agentTarget: params.draft.agentTarget,
        ...(fields.modelSelection ? { modelSelection: fields.modelSelection } : {}),
        ...(fields.profileId ? { profileId: fields.profileId } : {}),
        permissionMode: params.permissionMode,
        ...(fields.agentModeId ? { agentModeId: fields.agentModeId } : {}),
        configuration: {
            mode: { value: fields.agentModeId, updatedAtMs },
            model: {
                value: fields.modelSelection?.ref.modelId ?? null,
                updatedAtMs: fields.modelSelection?.updatedAt ?? updatedAtMs,
            },
            permissionIntent: { value: params.permissionMode, updatedAtMs },
            options,
            ...(fields.resumeSessionId
                ? {
                    providerSessionResume: {
                        kind: 'provider_session.v1',
                        providerSessionId: fields.resumeSessionId,
                    },
                }
                : {}),
        },
        ...(fields.connectedServices != null ? { connectedServices: fields.connectedServices } : {}),
        ...(fields.mcpSelection ? { mcpSelection: fields.mcpSelection } : {}),
        ...(fields.transcriptStorage ? { transcriptStorage: fields.transcriptStorage } : {}),
        ...(terminal ? { terminal } : {}),
        // A checkout needs a folder. The draft keeps it while there is none, so choosing a folder
        // again restores it; only the spawn leaves it out.
        checkoutCreationDraft: fields.directory.kind === 'managed' ? null : params.draft.checkoutCreationDraft,
    };
}

export type WorkflowSelectionSpawnWriteBackUnavailableReason =
    | 'agent_target_required'
    | 'permission_mode_required'
    | 'runtime_descriptor_unsupported'
    | 'spawn_unrepresentable';

export type WorkflowSelectionSpawnWriteBackResult =
    | Readonly<{ kind: 'available'; spawn: SessionServerStartSpawnDraftV1 }>
    | Readonly<{ kind: 'unavailable'; reason: WorkflowSelectionSpawnWriteBackUnavailableReason }>;

/**
 * Writes an edited workflow selection back onto the retained one-shot spawn.
 *
 * A saved one-step Automation keeps its released one-shot recipe when the
 * author only edits what that recipe can express, so this reuses the canonical
 * spawn writer above instead of hand-assembling a second spawn — including its
 * duplicated configuration snapshot, which would otherwise disagree with the
 * edited permission/mode/model facts. A selection the spawn cannot express
 * fails closed so the caller can require an explicit workflow conversion rather
 * than silently dropping the author's choice.
 */
export function applyWorkflowSelectionToServerStartSpawnDraftV1(params: Readonly<{
    spawn: SessionServerStartSpawnDraftV1;
    selection: WorkflowSessionAuthoringSelection;
    directory?: string | null;
    configurationUpdatedAtMs: number;
}>): WorkflowSelectionSpawnWriteBackResult {
    const selection = params.selection;
    const agentTarget = selection.agentTarget ?? params.spawn.agentTarget;
    if (!agentTarget) return { kind: 'unavailable', reason: 'agent_target_required' };
    if (selection.runtimeDescriptorV1 != null) {
        // A one-shot spawn has no runtime-descriptor field, so persisting the
        // selection here would silently drop it at dispatch.
        return { kind: 'unavailable', reason: 'runtime_descriptor_unsupported' };
    }
    const permissionMode = normalizeOptionalString(
        selection.permissionMode ?? params.spawn.permissionMode ?? null,
    );
    if (!permissionMode) return { kind: 'unavailable', reason: 'permission_mode_required' };

    const spawnWindows = params.spawn.terminal?.windows;
    const draft = buildNewSessionAuthoringDraftFromResolvedInputs({
        executionTarget: fromExactMachineTarget({
            ...params.spawn.executionTarget,
            ...(params.spawn.placementOrigin ? { selectionOrigin: params.spawn.placementOrigin } : {}),
        }),
        ...(normalizeOptionalString(params.directory)
            ? { directory: normalizeOptionalString(params.directory)! }
            : authoringDirectoryFieldsFromIntent(params.spawn.directory)),
        checkoutCreationDraft: params.spawn.checkoutCreationDraft ?? null,
        organizationPlacement: params.spawn.organizationPlacement ?? { folderId: null, tagIds: [] },
        prompt: '',
        displayText: '',
        agentTarget,
        transcriptStorage: selection.transcriptStorage ?? params.spawn.transcriptStorage ?? null,
        profileId: selection.profileId ?? params.spawn.profileId ?? null,
        environmentVariables: null,
        resumeSessionId: params.spawn.configuration?.providerSessionResume?.providerSessionId ?? null,
        permissionMode,
        permissionModeUpdatedAt: params.configurationUpdatedAtMs,
        modelSelection: selection.modelSelection === undefined
            ? params.spawn.modelSelection ?? null
            : selection.modelSelection,
        mcpSelection: selection.mcpSelection ?? params.spawn.mcpSelection ?? null,
        connectedServices: normalizeSessionAuthoringConnectedServices(
            selection.connectedServices === undefined
                ? params.spawn.connectedServices ?? null
                : selection.connectedServices,
        ),
        terminal: normalizeSessionAuthoringTerminal(selection.terminal ?? params.spawn.terminal ?? null),
        windowsRemoteSessionLaunchMode: selection.windowsRemoteSessionLaunchMode
            ?? spawnWindows?.launchMode
            ?? null,
        windowsRemoteSessionConsole: selection.windowsRemoteSessionConsole
            ?? spawnWindows?.console
            ?? null,
        windowsTerminalWindowName: selection.windowsTerminalWindowName
            ?? spawnWindows?.windowName
            ?? null,
        runtimeDescriptorV1: null,
        acpSessionModeId: selection.acpSessionModeId ?? params.spawn.agentModeId ?? null,
        sessionConfigOptionOverrides: selection.sessionConfigOptionOverrides
            ?? (params.spawn.configuration
                ? buildSessionConfigOptionOverridesFromServerStart(params.spawn.configuration)
                : null),
        automation: null,
    });

    try {
        return {
            kind: 'available',
            spawn: buildSessionServerStartSpawnDraftV1FromAuthoringDraft({
                draft,
                permissionMode,
                configurationUpdatedAtMs: params.configurationUpdatedAtMs,
            }),
        };
    } catch {
        return { kind: 'unavailable', reason: 'spawn_unrepresentable' };
    }
}

/**
 * Converts the canonical authored draft into the one strict ordinary-session
 * Action vocabulary. The Action owner, rather than this UI caller, prepares
 * checkout state and admits the first input atomically with Session creation.
 */
type SessionSpawnNewInputFromAuthoringParams = Readonly<
    SessionServerStartSpawnDraftFromAuthoringParams & {
        creationKey: string;
        initialMessage?: string | null;
        initialStructuredInput?: RawIngressStructuredInputV1 | null;
        initialReviewComments?: SessionSpawnNewInitialInputV1['reviewComments'] | null;
        /**
         * Continuation recipe for a Replay-seeded child. Required semantics, not
         * a hint: the target daemon resolves the source transcript before any
         * child row is created, and a daemon that predates the field rejects the
         * whole request rather than silently creating an unseeded Session.
         */
        sourceContext?: SessionSpawnSourceContextV1 | null;
        secretReferenceOverlay?: SecretReferenceOverlayV1;
    }
>;

function resolveSessionAuthoringCreationInput(params: SessionSpawnNewInputFromAuthoringParams) {
    const creationKey = SessionCreationKeyV1Schema.parse(params.creationKey);
    const normalizedInitialMessage = normalizeOptionalString(params.initialMessage);
    const structuredInput = params.initialStructuredInput
        ? RawIngressStructuredInputV1Schema.parse(params.initialStructuredInput)
        : null;
    return {
        creationKey,
        ...(normalizedInitialMessage || structuredInput?.composerAttachments?.length || params.initialReviewComments
            ? { initialInput: {
                ...(normalizedInitialMessage ? { text: normalizedInitialMessage } : {}),
                ...(structuredInput ? { structuredInput } : {}),
                ...(params.initialReviewComments ? { reviewComments: params.initialReviewComments } : {}),
            } }
            : {}),
        ...(params.sourceContext ? { sourceContext: params.sourceContext } : {}),
        ...(params.secretReferenceOverlay ? { secretReferenceOverlay: params.secretReferenceOverlay } : {}),
        ...(params.draft.access?.grants.length ? { initialAccess: params.draft.access } : {}),
        ...(params.draft.primaryTeamId ? { primaryTeamId: params.draft.primaryTeamId } : {}),
        ...(params.draft.teamCredentialBindings !== undefined ? { teamCredentialBindings: params.draft.teamCredentialBindings } : {}),
        ...(params.draft.initialTriggers?.length ? { initialTriggers: params.draft.initialTriggers } : {}),
    };
}

/** Ordinary creation binds the real enrolled execution target. */
export function buildSessionSpawnNewInputV2FromAuthoringDraft(
    params: SessionSpawnNewInputFromAuthoringParams,
): StrictSessionSpawnNewInputV2 {
    return { ...SessionSpawnNewInputV2Schema.parse({
        ...buildSessionServerStartSpawnDraftV1FromAuthoringDraft(params),
        ...resolveSessionAuthoringCreationInput(params),
    }), creationKey: SessionCreationKeyV1Schema.parse(params.creationKey) };
}

/** Managed acquire admits submitted Session authoring before a Machine exists. */
export function buildManagedAcquireAgentStartV1FromAuthoringDraft(
    params: SessionSpawnNewInputFromAuthoringParams,
): ManagedAcquireAgentStartV1 {
    return ManagedAcquireAgentStartV1Schema.parse({
        ...resolveSessionAuthoringSpawnInput(params),
        ...resolveSessionAuthoringCreationInput(params),
    });
}

export function buildNewSessionTempDataFromAuthoringDraft(params: Readonly<{
    draft: SessionAuthoringDraft;
    machineId: string | null;
}>): NewSessionData {
    const backendTarget = resolveDraftBackendTarget(params.draft);
    const normalizedAgentId = backendTarget ? resolveCatalogAgentIdForBackendTarget(backendTarget) : null;
    const canonicalAgentId = backendTarget
        ? backendTarget.configuredBackendId
            ? normalizedAgentId
            : (isBundledAgentId(backendTarget.backendId) ? backendTarget.backendId : normalizedAgentId)
        : params.draft.agentTarget
            ? resolveBundledAgentIdFromContributionIdentity(params.draft.agentTarget.identity)
            : DEFAULT_AGENT_ID;
    const persistedAgentTarget = params.draft.agentTarget ?? resolveCompatibilityAgentTarget(null, canonicalAgentId);
    const targetKey = params.draft.agentTarget
        ? buildBackendTargetKeyV2(params.draft.agentTarget)
        : backendTarget
            ? resolveBackendTargetKeyV2(backendTarget)
            : null;
    const backendOptionStateByTargetKey = targetKey && (
        params.draft.connectedServices != null
    )
        ? {
            [targetKey]: {
                connectedServices: params.draft.connectedServices,
            },
        }
        : undefined;

    return {
        prompt: params.draft.displayText || params.draft.prompt,
        ...(params.draft.sessionName === undefined ? {} : { sessionName: params.draft.sessionName }),
        ...(params.draft.initialSessionFacts === undefined ? {} : { initialSessionFacts: params.draft.initialSessionFacts }),
        ...(params.draft.memoryEnabled === undefined ? {} : { memoryEnabled: params.draft.memoryEnabled }),
        ...(params.draft.promptStack === undefined ? {} : { promptStack: params.draft.promptStack }),
        ...(params.draft.instructionsDraft === undefined ? {} : { instructionsDraft: params.draft.instructionsDraft }),
        ...(params.draft.executionTarget?.kind === 'machine'
            ? { machineId: params.draft.executionTarget.target.machineId }
            : !params.draft.executionTarget && params.machineId ? { machineId: params.machineId } : {}),
        executionTarget: params.draft.executionTarget,
        ...(params.draft.temporaryComputerActivationRef !== undefined
            ? { temporaryComputerActivationRef: params.draft.temporaryComputerActivationRef }
            : {}),
        directory: params.draft.directory,
        ...(params.draft.directoryKind === 'managed' ? { directoryKind: 'managed' as const } : {}),
        organizationPlacement: params.draft.organizationPlacement,
        ...(params.draft.access !== undefined ? { access: params.draft.access } : {}),
        ...(params.draft.primaryTeamId !== undefined ? { primaryTeamId: params.draft.primaryTeamId } : {}),
        ...(params.draft.teamCredentialBindings !== undefined ? { teamCredentialBindings: params.draft.teamCredentialBindings } : {}),
        ...(params.draft.initialTriggers !== undefined ? { initialTriggers: params.draft.initialTriggers } : {}),
        checkoutCreationDraft: params.draft.checkoutCreationDraft,
        ...(canonicalAgentId ? { agentType: canonicalAgentId } : {}),
        ...(persistedAgentTarget ? { agentTarget: persistedAgentTarget } : {}),
        ...(backendTarget ? { backendTarget } : {}),
        selectedProfileId: params.draft.profileId,
        transcriptStorage: params.draft.transcriptStorage ?? undefined,
        permissionMode: isPermissionMode(params.draft.permissionMode) ? params.draft.permissionMode : undefined,
        modelSelection: params.draft.modelSelection,
        acpSessionModeId: params.draft.acpSessionModeId ?? null,
        sessionConfigOptionOverrides: params.draft.sessionConfigOptionOverrides ?? null,
        runtimeDescriptorV1: params.draft.runtimeDescriptorV1 ?? null,
        mcpSelection: params.draft.mcpSelection,
        ...(params.draft.automation ? { automationDraft: params.draft.automation } : {}),
        backendNewSessionOptionStateByTargetKey: backendOptionStateByTargetKey,
        resumeSessionId: params.draft.resumeSessionId ?? undefined,
    };
}

export function buildPersistedNewSessionDraftFromAuthoringDraft(params: Readonly<{
    draft: SessionAuthoringDraft;
    machineId: string | null;
    targetServerId?: string | null;
    windowsRemoteSessionLaunchModeOverride?: NewSessionDraft['windowsRemoteSessionLaunchModeOverride'];
    managedMachineSelection?: NewSessionDraft['managedMachineSelection'];
    managedMachineAcquisition?: NewSessionDraft['managedMachineAcquisition'];
    entryIntent?: NewSessionDraft['entryIntent'];
    selectedSecretId: string | null;
    selectedSecretIdByProfileIdByEnvVarName: NewSessionDraft['selectedSecretIdByProfileIdByEnvVarName'];
    sessionOnlySecretValueEncByProfileIdByEnvVarName: NewSessionDraft['sessionOnlySecretValueEncByProfileIdByEnvVarName'];
    backendNewSessionOptionStateByTargetKey: NewSessionDraft['backendNewSessionOptionStateByTargetKey'];
    composerAttachments?: NewSessionDraft['composerAttachments'];
    placementCandidates?: readonly PluginUiSessionPlacementCandidateV1[];
    preferredPersistedAgentId?: unknown;
    updatedAt: number;
}>): NewSessionDraft {
    const backendTarget = resolveDraftBackendTarget(params.draft);
    const normalizedAgentId = backendTarget ? resolveCatalogAgentIdForBackendTarget(backendTarget) : null;
    const builtInBackendAgentId = backendTarget && !backendTarget.configuredBackendId && isBundledAgentId(backendTarget.backendId)
        ? backendTarget.backendId
        : null;
    const canonicalSelectedBuiltInAgentId = backendTarget
        ? (!backendTarget.configuredBackendId && isBundledAgentId(backendTarget.backendId)
            ? backendTarget.backendId
            : (normalizedAgentId ?? builtInBackendAgentId ?? DEFAULT_AGENT_ID))
        : normalizedAgentId ?? builtInBackendAgentId ?? DEFAULT_AGENT_ID;
    const agentType = resolvePersistedAgentIdForBackendTarget({
        backendTarget,
        persistedAgentId: params.preferredPersistedAgentId,
        selectedBuiltInAgentId: canonicalSelectedBuiltInAgentId,
    });
    const persistedAgentTarget = params.draft.agentTarget ?? resolveCompatibilityAgentTarget(null, agentType);
    const normalizedBackendNewSessionOptionStateByTargetKey = normalizeBackendNewSessionOptionStateByTargetKey(
        params.backendNewSessionOptionStateByTargetKey,
    );
    const targetServerId = params.draft.executionTarget?.kind === 'machine'
        ? params.draft.executionTarget.target.serverId
        : params.draft.executionTarget?.serverId ?? normalizeOptionalString(params.targetServerId);
    const windowsOverrideMachineId = normalizeOptionalString(params.windowsRemoteSessionLaunchModeOverride?.machineId);
    const windowsRemoteSessionLaunchModeOverride = windowsOverrideMachineId && params.windowsRemoteSessionLaunchModeOverride?.mode
        ? {
            machineId: windowsOverrideMachineId,
            mode: params.windowsRemoteSessionLaunchModeOverride.mode,
        }
        : null;

    return {
        input: params.draft.displayText || params.draft.prompt,
        ...(params.draft.sessionName === undefined ? {} : { sessionName: params.draft.sessionName }),
        ...(params.draft.initialSessionFacts === undefined ? {} : { initialSessionFacts: params.draft.initialSessionFacts }),
        ...(params.draft.memoryEnabled === undefined ? {} : { memoryEnabled: params.draft.memoryEnabled }),
        ...(params.draft.promptStack === undefined ? {} : { promptStack: params.draft.promptStack }),
        ...(params.draft.instructionsDraft === undefined ? {} : { instructionsDraft: params.draft.instructionsDraft }),
        ...(params.composerAttachments && params.composerAttachments.length > 0
            ? { composerAttachments: params.composerAttachments }
            : {}),
        ...(params.placementCandidates !== undefined
            ? { placementCandidates: params.placementCandidates }
            : {}),
        ...(params.managedMachineSelection !== undefined
            ? { managedMachineSelection: params.managedMachineSelection }
            : {}),
        ...(params.managedMachineAcquisition !== undefined
            ? { managedMachineAcquisition: params.managedMachineAcquisition }
            : {}),
        selectedMachineId: params.draft.executionTarget?.kind === 'machine'
            ? params.draft.executionTarget.target.machineId
            : params.draft.executionTarget ? null : params.machineId,
        executionTarget: params.draft.executionTarget,
        ...(params.draft.temporaryComputerActivationRef !== undefined
            ? { temporaryComputerActivationRef: params.draft.temporaryComputerActivationRef }
            : {}),
        selectedPath: params.draft.directory,
        ...(params.draft.directoryKind === 'managed' ? { directoryKind: 'managed' as const } : {}),
        organizationPlacement: params.draft.organizationPlacement,
        ...(params.draft.access !== undefined ? { access: params.draft.access } : {}),
        ...(params.draft.initialTriggers !== undefined ? { initialTriggers: params.draft.initialTriggers } : {}),
        ...(targetServerId ? { targetServerId } : {}),
        ...(windowsRemoteSessionLaunchModeOverride ? { windowsRemoteSessionLaunchModeOverride } : {}),
        ...(params.entryIntent ? { entryIntent: params.entryIntent } : {}),
        ...(params.draft.checkoutCreationDraft ? { checkoutCreationDraft: params.draft.checkoutCreationDraft } : {}),
        selectedProfileId: params.draft.profileId ?? null,
        selectedSecretId: params.selectedSecretId,
        ...(params.selectedSecretIdByProfileIdByEnvVarName ? {
            selectedSecretIdByProfileIdByEnvVarName: params.selectedSecretIdByProfileIdByEnvVarName,
        } : {}),
        ...(params.sessionOnlySecretValueEncByProfileIdByEnvVarName ? {
            sessionOnlySecretValueEncByProfileIdByEnvVarName: params.sessionOnlySecretValueEncByProfileIdByEnvVarName,
        } : {}),
        agentType,
        agentTarget: persistedAgentTarget,
        ...(params.draft.transcriptStorage ? { transcriptStorage: params.draft.transcriptStorage } : {}),
        permissionMode: isPermissionMode(params.draft.permissionMode) ? params.draft.permissionMode : 'default',
        modelSelection: params.draft.modelSelection,
        acpSessionModeId: normalizeOptionalString(params.draft.acpSessionModeId),
        ...(params.draft.sessionConfigOptionOverrides ? { sessionConfigOptionOverrides: params.draft.sessionConfigOptionOverrides } : {}),
        ...(params.draft.runtimeDescriptorV1 ? { runtimeDescriptorV1: params.draft.runtimeDescriptorV1 } : {}),
        ...(params.draft.mcpSelection ? { mcpSelection: params.draft.mcpSelection } : {}),
        ...(readNonBlankOpaqueIdentifier(params.draft.resumeSessionId)
            ? { resumeSessionId: readNonBlankOpaqueIdentifier(params.draft.resumeSessionId)! }
            : {}),
        ...(normalizedBackendNewSessionOptionStateByTargetKey ? {
            backendNewSessionOptionStateByTargetKey: normalizedBackendNewSessionOptionStateByTargetKey,
        } : {}),
        ...(params.draft.automation ? { automationDraft: params.draft.automation } : {}),
        updatedAt: params.updatedAt,
    };
}
