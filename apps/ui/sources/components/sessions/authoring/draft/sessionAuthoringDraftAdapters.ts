import {
    AcpConfigOptionOverridesV1Schema,
    AgentExecutionTargetV1Schema,
    SessionCreationKeyV1Schema,
    SessionServerStartSpawnDraftV1Schema,
    SessionSpawnNewInputV2Schema,
    SessionModelSelectionV1Schema,
    buildBackendTargetKeyV2,
    readBackendTargetRefV2,
    readPersistedAgentContributionIdentityV1,
    readRuntimeDescriptorV1,
    writePersistedBackendTargetRefV2,
    type AgentExecutionTargetV1,
    type BackendTargetRefV2,
    type SessionModelSelectionV1,
    type SessionCreationKeyV1,
    type SessionServerStartSpawnDraftV1,
    type SessionSpawnNewInputV2,
    type SessionSpawnSourceContextV1,
} from '@happier-dev/protocol';

import { DEFAULT_AGENT_ID, isBundledAgentId } from '@/agents/catalog/catalog';
import { resolveCatalogAgentIdForBackendTarget } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
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
import type { SpawnSessionOptions } from '@/sync/domains/session/spawn/spawnSessionPayload';

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
    if (backendTarget) {
        const persisted = writePersistedBackendTargetRefV2(stripBackendTargetSourceKind(backendTarget));
        const parsed = AgentExecutionTargetV1Schema.safeParse(persisted);
        if (parsed.success) return parsed.data;
    }
    const identity = readPersistedAgentContributionIdentityV1(fallbackAgentId);
    return identity ? AgentExecutionTargetV1Schema.parse({ kind: 'agent', identity }) : null;
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

export function mergeExistingSessionAutomationTemplateDraft(params: Readonly<{
    hydratedTemplateDraft: SessionAuthoringDraft;
    targetSession: ExistingSessionAuthoringSnapshotSession | null;
    currentDraft: SessionAuthoringDraft | null;
    sessionDekBase64?: string | null;
    seededAutomationDraft: SessionAuthoringDraft['automation'];
}>): SessionAuthoringDraft {
    const fallbackDraft = buildExistingSessionAutomationFallbackDraft({
        targetSession: params.targetSession,
        message: params.hydratedTemplateDraft.prompt || params.hydratedTemplateDraft.displayText,
        sessionDekBase64: params.sessionDekBase64,
    });

    const baseDraft = fallbackDraft
        ? mergeExistingSessionAuthoringDraftInheritedFields({
            ...fallbackDraft,
            prompt: params.hydratedTemplateDraft.prompt,
            displayText: params.hydratedTemplateDraft.displayText,
            permissionMode: params.hydratedTemplateDraft.permissionMode ?? fallbackDraft.permissionMode,
            permissionModeUpdatedAt: params.hydratedTemplateDraft.permissionModeUpdatedAt ?? fallbackDraft.permissionModeUpdatedAt,
            modelSelection: params.hydratedTemplateDraft.modelSelection !== undefined
                ? params.hydratedTemplateDraft.modelSelection
                : fallbackDraft.modelSelection,
            automation: params.currentDraft?.automation ?? params.seededAutomationDraft,
        }, fallbackDraft)
        : params.hydratedTemplateDraft;

    return mergeExistingSessionAuthoringDraftEditableFields({
        baseDraft,
        currentDraft: params.currentDraft,
        sessionId: baseDraft.existingSessionId ?? params.targetSession?.id ?? '',
        fallbackAutomationDraft: fallbackDraft ? params.seededAutomationDraft : undefined,
    });
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

function resolveDraftBackendTarget(draft: Pick<SessionAuthoringDraft, 'agentTarget'>): BackendTargetRefV2 | null {
    if (!draft.agentTarget) return null;
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

function rekeyCompatibilityModelSelection(
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

function resolveDraftSpawnBackendTarget(draft: Pick<SessionAuthoringDraft, 'agentTarget'>): SpawnSessionOptions['backendTarget'] | null {
    const backendTarget = resolveDraftBackendTarget(draft);
    return backendTarget ? readBackendTargetRefV2(backendTarget) : null;
}

function resolveNewSessionDraftAgentId(params: Readonly<{
    agentId?: unknown;
    backendTarget?: BackendTargetRefV2 | null;
}>): string | null {
    if (params.backendTarget) {
        const candidateAgentId = params.backendTarget.configuredBackendId ? null : params.backendTarget.backendId;
        if (candidateAgentId && isBundledAgentId(candidateAgentId)) return candidateAgentId;
        return resolveCatalogAgentIdForBackendTarget(readBackendTargetRefV2(params.backendTarget));
    }
    if (typeof params.agentId === 'string' && isBundledAgentId(params.agentId)) {
        return params.agentId;
    }
    return null;
}

function resolveConnectedServicesFromAgentOptionState(params: Readonly<{
    backendTarget: BackendTargetRefV2 | null;
    backendNewSessionOptionStateByTargetKey?: Record<string, Record<string, unknown>> | null;
}>): unknown {
    if (!params.backendTarget || !params.backendNewSessionOptionStateByTargetKey) {
        return null;
    }
    const targetKey = resolveBackendTargetKeyV2(params.backendTarget);
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
        executionTarget: params.executionTarget
            ? {
                serverId: params.executionTarget.serverId.trim(),
                machineId: params.executionTarget.machineId.trim(),
            }
            : null,
        directory: normalizeRequiredString(params.directory),
        checkoutCreationDraft: params.checkoutCreationDraft,
        organizationPlacement: normalizeOrganizationPlacement(params.organizationPlacement),
        prompt: params.prompt.trim(),
        displayText: params.displayText.trim(),
        agentTarget: params.agentTarget ? AgentExecutionTargetV1Schema.parse(params.agentTarget) : null,
        transcriptStorage: params.transcriptStorage ?? null,
        profileId: params.profileId === '' ? '' : normalizeOptionalString(params.profileId),
        environmentVariables: params.environmentVariables ?? null,
        resumeSessionId: normalizeOptionalString(params.resumeSessionId),
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
    executionTarget?: SessionAuthoringDraft['executionTarget'];
    directory: string;
    checkoutCreationDraft?: SessionAuthoringDraft['checkoutCreationDraft'];
    organizationPlacement?: SessionAuthoringDraft['organizationPlacement'];
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
        executionTarget: params.executionTarget ?? null,
        directory: params.directory,
        checkoutCreationDraft: params.checkoutCreationDraft ?? null,
        organizationPlacement: params.organizationPlacement ?? { folderId: null, tagIds: [] },
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
        executionTarget: source.source.executionTarget ?? (
            source.kind === 'persistedDraft'
            && source.source.targetServerId
            && source.source.selectedMachineId
                ? { serverId: source.source.targetServerId, machineId: source.source.selectedMachineId }
                : null
        ),
        directory: resolveNewSessionSourceDirectory(source) ?? '/',
        checkoutCreationDraft: source.source.checkoutCreationDraft ?? null,
        organizationPlacement: source.source.organizationPlacement ?? { folderId: null, tagIds: [] },
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
            backendTarget,
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

export function buildExistingSessionAutomationFallbackDraft(params: Readonly<{
    targetSession: ExistingSessionAuthoringSnapshotSession | null;
    message: string;
    sessionDekBase64?: string | null;
}>): SessionAuthoringDraft | null {
    if (!params.targetSession) {
        return null;
    }
    return buildExistingSessionAuthoringDraftFromSessionSnapshot({
        session: params.targetSession,
        message: params.message,
        sessionDekBase64: params.sessionDekBase64,
    });
}

export function refreshExistingSessionAuthoringDraftFromSessionSnapshot(params: Readonly<{
    session: ExistingSessionAuthoringSnapshotSession;
    currentDraft: SessionAuthoringDraft | null;
    sessionDekBase64?: string | null;
    fallbackAutomationDraft?: SessionAuthoringDraft['automation'];
}>): SessionAuthoringDraft {
    const baseDraft = buildExistingSessionAuthoringDraftFromSessionSnapshot({
        session: params.session,
        message: params.currentDraft?.prompt ?? '',
        sessionDekBase64: params.sessionDekBase64,
    });

    return mergeExistingSessionAuthoringDraftEditableFields({
        baseDraft,
        currentDraft: params.currentDraft,
        sessionId: params.session.id,
        fallbackAutomationDraft: params.fallbackAutomationDraft,
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
        executionTarget: params.template.executionTarget ?? null,
        directory: normalizeRequiredString(params.template.directory),
        checkoutCreationDraft: parseCheckoutCreationDraft(params.template.checkoutCreationDraft),
        organizationPlacement: normalizeOrganizationPlacement(params.template.organizationPlacement),
        prompt: params.template.prompt ?? '',
        displayText: params.template.displayText ?? '',
        agentTarget,
        transcriptStorage: params.template.transcriptStorage ?? null,
        profileId: normalizeOptionalString(params.template.profileId),
        environmentVariables: params.template.environmentVariables ?? null,
        resumeSessionId: normalizeOptionalString(params.template.resume),
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
        ...(draft.executionTarget ? { executionTarget: draft.executionTarget } : {}),
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
        ...(normalizeOptionalString(draft.resumeSessionId) ? { resume: draft.resumeSessionId!.trim() } : {}),
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
 * Shared normalization for both creation boundaries. The private compatibility
 * payload remains only for its existing callers, but it must not reinterpret
 * model/config/connected-service facts differently from strict V2.
 */
function resolveSharedSessionAuthoringSpawnFields(draft: SessionAuthoringDraft) {
    return {
        directory: normalizeRequiredString(draft.directory),
        profileId: typeof draft.profileId === 'string' ? draft.profileId.trim() : '',
        resumeSessionId: normalizeOptionalString(draft.resumeSessionId),
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
        && left.identity.localId === right.identity.localId;
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
        // Configured backend instances cannot be recovered from an Agent
        // contribution identity: the strict target intentionally contains no
        // instance identity, and the forward mapper fails closed for them too.
        if (backendTarget.configuredBackendId) continue;

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

function buildSessionConfigOptionOverridesFromServerStart(
    configuration: NonNullable<SessionServerStartSpawnDraftV1['configuration']>,
): SessionAuthoringDraft['sessionConfigOptionOverrides'] {
    const entries = Object.entries(configuration.options);
    if (entries.length === 0) return null;

    const updatedAt = Math.max(...entries.map(([, option]) => option.updatedAtMs));
    return AcpConfigOptionOverridesV1Schema.parse({
        v: 1,
        updatedAt,
        overrides: Object.fromEntries(entries.map(([key, option]) => [key, {
            value: option.value,
            updatedAt: option.updatedAtMs,
        }])),
    });
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
                executionTarget: spawn.executionTarget,
                directory: spawn.directory,
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

    if (!params.draft.executionTarget || !params.draft.agentTarget) {
        throw new Error('New Session authoring draft requires executionTarget and agentTarget');
    }
    return SessionServerStartSpawnDraftV1Schema.parse({
        executionTarget: params.draft.executionTarget,
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
        checkoutCreationDraft: params.draft.checkoutCreationDraft,
    });
}

/**
 * Converts the canonical authored draft into the one strict ordinary-session
 * Action vocabulary. The Action owner, rather than this UI caller, prepares
 * checkout state and admits the first input atomically with Session creation.
 */
export function buildSessionSpawnNewInputV2FromAuthoringDraft(params: Readonly<
    SessionServerStartSpawnDraftFromAuthoringParams & {
        creationKey: string;
        initialMessage?: string | null;
        /**
         * Continuation recipe for a Replay-seeded child. Required semantics, not
         * a hint: the target daemon resolves the source transcript before any
         * child row is created, and a daemon that predates the field rejects the
         * whole request rather than silently creating an unseeded Session.
         */
        sourceContext?: SessionSpawnSourceContextV1 | null;
    }
>): StrictSessionSpawnNewInputV2 {
    const creationKey = SessionCreationKeyV1Schema.parse(params.creationKey);
    const normalizedInitialMessage = normalizeOptionalString(params.initialMessage);
    const spawnDraft = buildSessionServerStartSpawnDraftV1FromAuthoringDraft(params);

    return {
        ...SessionSpawnNewInputV2Schema.parse({
            ...spawnDraft,
            creationKey,
            ...(normalizedInitialMessage ? { initialInput: { text: normalizedInitialMessage } } : {}),
            ...(params.sourceContext ? { sourceContext: params.sourceContext } : {}),
        }),
        creationKey,
    };
}

export function buildSpawnSessionOptionsFromAuthoringDraft(params: Readonly<{
    draft: SessionAuthoringDraft;
    machineId: string;
    serverId?: string | null;
    approvedNewDirectoryCreation?: boolean;
    agentModeUpdatedAt?: number | null;
    spawnBackendTarget?: SpawnSessionOptions['backendTarget'];
}>): SpawnSessionOptions {
    const backendTarget = params.spawnBackendTarget ?? resolveDraftSpawnBackendTarget(params.draft);
    const fields = resolveSharedSessionAuthoringSpawnFields(params.draft);
    if (!backendTarget) {
        throw new Error('Session authoring draft requires backendTarget to spawn a session');
    }

    return {
        machineId: params.machineId,
        ...(typeof params.serverId === 'string' || params.serverId === null ? { serverId: params.serverId } : {}),
        directory: fields.directory,
        ...(fields.transcriptStorage ? { transcriptStorage: fields.transcriptStorage } : {}),
        ...(typeof params.approvedNewDirectoryCreation === 'boolean'
            ? { approvedNewDirectoryCreation: params.approvedNewDirectoryCreation }
            : {}),
        backendTarget,
        ...(fields.profileId.length > 0 ? { profileId: fields.profileId } : {}),
        ...(params.draft.environmentVariables ? { environmentVariables: params.draft.environmentVariables } : {}),
        ...(fields.resumeSessionId ? { resume: fields.resumeSessionId } : {}),
        ...(normalizeOptionalString(params.draft.permissionMode) ? { permissionMode: params.draft.permissionMode!.trim() as SpawnSessionOptions['permissionMode'] } : {}),
        ...(typeof params.draft.permissionModeUpdatedAt === 'number'
            ? { permissionModeUpdatedAt: params.draft.permissionModeUpdatedAt }
            : {}),
        ...(fields.agentModeId
            ? {
                agentModeId: fields.agentModeId,
                ...(typeof params.agentModeUpdatedAt === 'number' && Number.isFinite(params.agentModeUpdatedAt)
                    ? { agentModeUpdatedAt: params.agentModeUpdatedAt }
                    : {}),
            }
            : {}),
        ...(fields.modelSelection ? { modelSelection: fields.modelSelection } : {}),
        ...(fields.sessionConfigOptionOverrides ? { sessionConfigOptionOverrides: fields.sessionConfigOptionOverrides } : {}),
        ...(params.draft.runtimeDescriptorV1 ? { runtimeDescriptorV1: params.draft.runtimeDescriptorV1 } : {}),
        ...(params.draft.terminal ? { terminal: params.draft.terminal as SpawnSessionOptions['terminal'] } : {}),
        ...(params.draft.windowsRemoteSessionLaunchMode
            ? { windowsRemoteSessionLaunchMode: params.draft.windowsRemoteSessionLaunchMode }
            : {}),
        ...(params.draft.windowsRemoteSessionConsole
            ? { windowsRemoteSessionConsole: params.draft.windowsRemoteSessionConsole }
            : {}),
        ...(normalizeOptionalString(params.draft.windowsTerminalWindowName)
            ? { windowsTerminalWindowName: params.draft.windowsTerminalWindowName!.trim() }
            : {}),
        ...(fields.connectedServices !== undefined && fields.connectedServices !== null
            ? { connectedServices: fields.connectedServices }
            : {}),
        ...(fields.mcpSelection ? { mcpSelection: fields.mcpSelection } : {}),
    };
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
        : normalizedAgentId;
    const targetKey = backendTarget ? resolveBackendTargetKeyV2(backendTarget) : null;
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
        ...(params.machineId ? { machineId: params.machineId } : {}),
        ...(params.draft.executionTarget ? { executionTarget: params.draft.executionTarget } : {}),
        directory: params.draft.directory,
        organizationPlacement: params.draft.organizationPlacement,
        checkoutCreationDraft: params.draft.checkoutCreationDraft,
        ...(canonicalAgentId ? { agentType: canonicalAgentId } : {}),
        ...(params.draft.agentTarget ? { agentTarget: params.draft.agentTarget } : {}),
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
    entryIntent?: NewSessionDraft['entryIntent'];
    selectedSecretId: string | null;
    selectedSecretIdByProfileIdByEnvVarName: NewSessionDraft['selectedSecretIdByProfileIdByEnvVarName'];
    sessionOnlySecretValueEncByProfileIdByEnvVarName: NewSessionDraft['sessionOnlySecretValueEncByProfileIdByEnvVarName'];
    backendNewSessionOptionStateByTargetKey: NewSessionDraft['backendNewSessionOptionStateByTargetKey'];
    composerAttachments?: NewSessionDraft['composerAttachments'];
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
    const normalizedBackendNewSessionOptionStateByTargetKey = normalizeBackendNewSessionOptionStateByTargetKey(
        params.backendNewSessionOptionStateByTargetKey,
    );
    const targetServerId = normalizeOptionalString(params.targetServerId);
    const windowsOverrideMachineId = normalizeOptionalString(params.windowsRemoteSessionLaunchModeOverride?.machineId);
    const windowsRemoteSessionLaunchModeOverride = windowsOverrideMachineId && params.windowsRemoteSessionLaunchModeOverride?.mode
        ? {
            machineId: windowsOverrideMachineId,
            mode: params.windowsRemoteSessionLaunchModeOverride.mode,
        }
        : null;

    return {
        input: params.draft.displayText || params.draft.prompt,
        ...(params.composerAttachments && params.composerAttachments.length > 0
            ? { composerAttachments: params.composerAttachments }
            : {}),
        selectedMachineId: params.machineId,
        executionTarget: params.draft.executionTarget,
        selectedPath: params.draft.directory,
        organizationPlacement: params.draft.organizationPlacement,
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
        agentTarget: params.draft.agentTarget,
        ...(params.draft.transcriptStorage ? { transcriptStorage: params.draft.transcriptStorage } : {}),
        permissionMode: isPermissionMode(params.draft.permissionMode) ? params.draft.permissionMode : 'default',
        modelSelection: params.draft.modelSelection,
        acpSessionModeId: normalizeOptionalString(params.draft.acpSessionModeId),
        ...(params.draft.sessionConfigOptionOverrides ? { sessionConfigOptionOverrides: params.draft.sessionConfigOptionOverrides } : {}),
        ...(params.draft.runtimeDescriptorV1 ? { runtimeDescriptorV1: params.draft.runtimeDescriptorV1 } : {}),
        ...(params.draft.mcpSelection ? { mcpSelection: params.draft.mcpSelection } : {}),
        ...(normalizeOptionalString(params.draft.resumeSessionId) ? { resumeSessionId: normalizeOptionalString(params.draft.resumeSessionId)! } : {}),
        ...(normalizedBackendNewSessionOptionStateByTargetKey ? {
            backendNewSessionOptionStateByTargetKey: normalizedBackendNewSessionOptionStateByTargetKey,
        } : {}),
        ...(params.draft.automation ? { automationDraft: params.draft.automation } : {}),
        updatedAt: params.updatedAt,
    };
}
