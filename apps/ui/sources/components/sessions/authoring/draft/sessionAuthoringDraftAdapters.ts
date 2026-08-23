import {
    AcpConfigOptionOverridesV1Schema,
    AgentExecutionTargetV1Schema,
    SessionCreationKeyV1Schema,
    SessionServerStartSpawnDraftV1Schema,
    SessionSpawnNewInputV2Schema,
    SessionModelSelectionV1Schema,
    readBackendTargetRefV2,
    type AgentExecutionTargetV1,
    type AiLaunchProfile,
    type BackendTargetRefV2,
    type ProviderSettingsMigrationStateV1,
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
import { decodeAutomationTemplate } from '@/sync/domains/automations/automationTemplateCodec';
import { resolveAutomationTemplatePayload } from '@/sync/domains/automations/automationTemplateTransport';
import { AutomationTemplateEncryptionMaterialUnavailableError } from '@/sync/domains/automations/automationTemplateAvailability';
import { isModelMode, isPermissionMode } from '@/sync/domains/permissions/permissionTypes';
import { deriveSessionAuthoringSnapshot } from '@/sync/domains/sessionAuthoring/deriveSessionAuthoringSnapshot';
import {
    normalizeCodexBackendMode,
    normalizeOptionalNumber,
    normalizeOptionalRecord,
    normalizeSessionAuthoringConnectedServices,
    normalizeSessionAuthoringTerminal,
    normalizeOptionalString,
    normalizeRequiredString,
    resolveCanonicalCodexBackendMode,
} from '@/sync/domains/sessionAuthoring/sessionAuthoringNormalization';
import type { AutomationTemplate } from '@/sync/domains/automations/automationTypes';
import { normalizeAutomationTemplateLaunchProfileReference } from '@/sync/domains/automations/normalizeAutomationTemplateLaunchProfileReference';
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
    const draft = sanitizeNewSessionAutomationDraft(value);
    return draft.enabled ? draft : null;
}

function buildExistingSessionAuthoringDraftFromSnapshotData(params: Readonly<{
    snapshot: ReturnType<typeof deriveSessionAuthoringSnapshot>;
    message: string;
}>): SessionAuthoringDraft {
    return {
        targetType: 'existing_session',
        directory: params.snapshot.directory,
        checkoutCreationDraft: null,
        prompt: params.message,
        displayText: params.message,
        agentId: params.snapshot.agentId,
        backendTarget: params.snapshot.backendTarget ? stripBackendTargetSourceKind(params.snapshot.backendTarget) : null,
        transcriptStorage: params.snapshot.transcriptStorage,
        profileId: params.snapshot.profileId,
        environmentVariables: null,
        resumeSessionId: null,
        permissionMode: params.snapshot.permissionMode,
        permissionModeUpdatedAt: params.snapshot.permissionModeUpdatedAt,
        modelSelection: buildCanonicalDraftModelSelection({
            backendTarget: params.snapshot.backendTarget,
            agentId: params.snapshot.agentId,
            modelSelection: params.snapshot.modelSelection,
        }),
        mcpSelection: params.snapshot.mcpSelection,
        connectedServices: params.snapshot.connectedServices,
        terminal: params.snapshot.terminal,
        windowsRemoteSessionLaunchMode: null,
        windowsRemoteSessionConsole: null,
        windowsTerminalWindowName: null,
        experimentalCodexAcp: null,
        codexBackendMode: params.snapshot.codexBackendMode,
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
        agentId: current.agentId ?? fallback.agentId,
        backendTarget: current.backendTarget ?? fallback.backendTarget,
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
        experimentalCodexAcp: null,
        codexBackendMode: current.codexBackendMode ?? fallback.codexBackendMode,
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

function resolveDraftBackendTarget(draft: Pick<SessionAuthoringDraft, 'backendTarget' | 'agentId'>): BackendTargetRefV2 | null {
    if (draft.backendTarget) {
        return stripBackendTargetSourceKind(draft.backendTarget);
    }
    return normalizeOptionalString(draft.agentId)
        ? { kind: 'backend', backendId: draft.agentId!.trim() } satisfies BackendTargetRefV2
        : null;
}

function buildCanonicalDraftModelSelection(params: Readonly<{
    backendTarget: BackendTargetRefV2 | null | undefined;
    agentId: string | null | undefined;
    modelSelection?: SessionModelSelectionV1 | null;
    legacyModelId?: string | null;
    legacyUpdatedAt?: number | null;
}>): SessionModelSelectionV1 | null {
    const target = resolveDraftBackendTarget({
        backendTarget: params.backendTarget ?? null,
        agentId: params.agentId ?? null,
    });
    if (params.modelSelection) {
        const selection = SessionModelSelectionV1Schema.parse(params.modelSelection);
        if (!target || selection.ref.agentTargetKey !== resolveBackendTargetKeyV2(target)) {
            throw new Error('Session authoring model selection target mismatch');
        }
        return selection;
    }

    const modelId = normalizeOptionalString(params.legacyModelId);
    if (!modelId || modelId === 'default') return null;
    if (!target) {
        throw new Error('Session authoring model selection requires backend target');
    }
    return SessionModelSelectionV1Schema.parse({
        v: 1,
        updatedAt: normalizeOptionalNumber(params.legacyUpdatedAt) ?? 0,
        ref: {
            agentTargetKey: resolveBackendTargetKeyV2(target),
            providerConnectionId: null,
            modelId,
        },
    });
}

function resolveDraftSpawnBackendTarget(draft: Pick<SessionAuthoringDraft, 'backendTarget' | 'agentId'>): SpawnSessionOptions['backendTarget'] | null {
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
    'targetType' | 'existingSessionId' | 'sessionEncryptionMode' | 'sessionEncryptionKeyBase64' | 'sessionEncryptionVariant' | 'experimentalCodexAcp' | 'windowsTerminalWindowName' | 'modelSelection' | 'modelId' | 'modelUpdatedAt'
> & Readonly<{
    experimentalCodexAcp?: boolean | null;
    windowsTerminalWindowName?: SessionAuthoringDraft['windowsTerminalWindowName'];
    modelSelection?: SessionModelSelectionV1 | null;
    modelId?: string | null;
    modelUpdatedAt?: number | null;
}>;

export function buildNewSessionAuthoringDraft(params: NewSessionAuthoringDraftParams): SessionAuthoringDraft {
    const codexBackendMode = resolveCanonicalCodexBackendMode({
        codexBackendMode: params.codexBackendMode,
        experimentalCodexAcp: params.experimentalCodexAcp,
    });

    const hasModelSelectionInput = params.modelSelection !== undefined || params.modelId !== undefined;
    const normalizedModelSelection = hasModelSelectionInput
        ? buildCanonicalDraftModelSelection({
            backendTarget: params.backendTarget,
            agentId: params.agentId,
            modelSelection: params.modelSelection,
            legacyModelId: params.modelId,
            legacyUpdatedAt: params.modelUpdatedAt,
        })
        : undefined;

    return {
        targetType: 'new_session',
        directory: normalizeRequiredString(params.directory),
        checkoutCreationDraft: params.checkoutCreationDraft,
        prompt: params.prompt.trim(),
        displayText: params.displayText.trim(),
        agentId: normalizeOptionalString(params.agentId),
        backendTarget: params.backendTarget ?? null,
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
        experimentalCodexAcp: null,
        codexBackendMode,
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
    directory: string;
    checkoutCreationDraft?: SessionAuthoringDraft['checkoutCreationDraft'];
    prompt: string;
    displayText?: string | null;
    agentId?: SessionAuthoringDraft['agentId'];
    backendTarget?: SessionAuthoringDraft['backendTarget'];
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
    experimentalCodexAcp?: boolean | null;
    codexBackendMode?: SessionAuthoringDraft['codexBackendMode'];
    acpSessionModeId?: SessionAuthoringDraft['acpSessionModeId'];
    sessionConfigOptionOverrides?: SessionAuthoringDraft['sessionConfigOptionOverrides'];
    automation?: SessionAuthoringDraft['automation'];
}>;

export function buildNewSessionAuthoringDraftFromResolvedInputs(
    params: ResolvedNewSessionAuthoringDraftInputs,
): SessionAuthoringDraft {
    return buildNewSessionAuthoringDraft({
        directory: params.directory,
        checkoutCreationDraft: params.checkoutCreationDraft ?? null,
        prompt: params.prompt,
        displayText: params.displayText ?? params.prompt,
        agentId: params.agentId ?? null,
        backendTarget: params.backendTarget ?? null,
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
        experimentalCodexAcp: params.experimentalCodexAcp ?? null,
        codexBackendMode: params.codexBackendMode ?? null,
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
    const agentId = resolveNewSessionDraftAgentId({
        agentId: source.source.agentType,
        backendTarget,
    });
    const backendNewSessionOptionStateByTargetKey = readBackendNewSessionOptionStateByTargetKey(source.source);

    return buildNewSessionAuthoringDraft({
        directory: resolveNewSessionSourceDirectory(source) ?? '/',
        checkoutCreationDraft: source.source.checkoutCreationDraft ?? null,
        prompt: resolveNewSessionSourcePrompt(source) ?? '',
        displayText: resolveNewSessionSourcePrompt(source) ?? '',
        agentId,
        backendTarget,
        transcriptStorage: source.source.transcriptStorage ?? null,
        profileId: resolveNewSessionSourceProfileId(source) ?? null,
        environmentVariables: null,
        resumeSessionId: source.source.resumeSessionId ?? null,
        permissionMode: source.source.permissionMode ?? null,
        permissionModeUpdatedAt: null,
        modelSelection: source.source.modelSelection,
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
        experimentalCodexAcp: null,
        codexBackendMode: normalizeCodexBackendMode(source.source.codexBackendMode),
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
    const codexBackendMode = resolveCanonicalCodexBackendMode({
        codexBackendMode: params.template.codexBackendMode,
        experimentalCodexAcp: params.template.experimentalCodexAcp,
    });
    const backendTarget = params.template.backendTarget
        ?? (normalizeOptionalString(params.template.agent)
            ? { kind: 'backend', backendId: normalizeOptionalString(params.template.agent)! } satisfies BackendTargetRefV2
            : null);
    const sanitizedBackendTarget = backendTarget ? stripBackendTargetSourceKind(backendTarget) : null;
    const hasModelSelectionInput = params.template.modelSelection !== undefined
        || params.template.modelId !== undefined;
    const modelSelection = hasModelSelectionInput
        ? buildCanonicalDraftModelSelection({
            backendTarget: sanitizedBackendTarget,
            agentId: sanitizedBackendTarget && !sanitizedBackendTarget.configuredBackendId
                ? sanitizedBackendTarget.backendId
                : params.template.agent,
            modelSelection: params.template.modelSelection,
            legacyModelId: params.template.modelId,
            legacyUpdatedAt: params.template.modelUpdatedAt,
        })
        : undefined;

    return {
        targetType: params.targetType,
        directory: normalizeRequiredString(params.template.directory),
        checkoutCreationDraft: parseCheckoutCreationDraft(params.template.checkoutCreationDraft),
        prompt: params.template.prompt ?? '',
        displayText: params.template.displayText ?? '',
        agentId: sanitizedBackendTarget && !sanitizedBackendTarget.configuredBackendId && isBundledAgentId(sanitizedBackendTarget.backendId)
            ? normalizeOptionalString(sanitizedBackendTarget.backendId)
            : normalizeOptionalString(params.template.agent),
        backendTarget: sanitizedBackendTarget,
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
        experimentalCodexAcp: null,
        codexBackendMode,
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

export async function buildAutomationEditTemplateSeed(params: Readonly<{
    automation: Readonly<{
        targetType: SessionAuthoringDraft['targetType'];
        templateCiphertext: string;
        enabled: boolean;
        name: string;
        description?: string | null;
        schedule: Readonly<{
            kind: 'interval' | 'cron';
            everyMs?: number | null;
            scheduleExpr?: string | null;
            timezone?: string | null;
        }>;
    }>;
    decryptAutomationTemplateRaw?: (payloadCiphertext: string) => Promise<unknown | null>;
    launchProfileContext?: Readonly<{
        profiles: readonly AiLaunchProfile[];
        migration: ProviderSettingsMigrationStateV1 | undefined;
    }>;
}>): Promise<Readonly<{
    hydratedDraft: SessionAuthoringDraft;
    seededAutomationDraft: NewSessionAutomationDraft;
}>> {
    const payload = await resolveAutomationTemplatePayload({
        templateCiphertext: params.automation.templateCiphertext,
        decryptRaw: params.decryptAutomationTemplateRaw,
    });
    if (payload.kind === 'invalid') {
        throw new Error('Invalid automation template envelope payload');
    }
    if (payload.kind === 'locked') {
        throw new AutomationTemplateEncryptionMaterialUnavailableError();
    }
    const decoded = decodeAutomationTemplate(JSON.stringify(payload.payload));
    if (!decoded) {
        throw new Error('Invalid decrypted automation template payload');
    }
    const normalizedTemplate = params.launchProfileContext
        ? normalizeAutomationTemplateLaunchProfileReference({
            template: decoded,
            ...params.launchProfileContext,
        })
        : decoded;

    return {
        hydratedDraft: hydrateSessionAuthoringDraftFromAutomationTemplate({
            targetType: params.automation.targetType,
            template: normalizedTemplate,
        }),
        seededAutomationDraft: sanitizeNewSessionAutomationDraft({
            enabled: params.automation.enabled,
            name: params.automation.name,
            description: params.automation.description ?? '',
            scheduleKind: params.automation.schedule.kind,
            everyMinutes: params.automation.schedule.kind === 'interval' && typeof params.automation.schedule.everyMs === 'number'
                ? Math.max(1, Math.round(params.automation.schedule.everyMs / 60_000))
                : 60,
            cronExpr: params.automation.schedule.kind === 'cron' && typeof params.automation.schedule.scheduleExpr === 'string'
                ? params.automation.schedule.scheduleExpr
                : '0 * * * *',
            timezone: params.automation.schedule.timezone ?? null,
        }),
    };
}

export function buildAutomationTemplateFromSessionAuthoringDraft(draft: SessionAuthoringDraft): AutomationTemplate {
    const normalizedBackendTarget = resolveDraftBackendTarget(draft);
    const codexBackendMode = resolveCanonicalCodexBackendMode({
        codexBackendMode: draft.codexBackendMode,
        experimentalCodexAcp: draft.experimentalCodexAcp,
    });

    return {
        directory: normalizeRequiredString(draft.directory),
        ...(draft.checkoutCreationDraft
            ? {
                checkoutCreationDraft: {
                    kind: 'git_worktree',
                    displayName: draft.checkoutCreationDraft.displayName.trim(),
                    baseRef: normalizeOptionalString(draft.checkoutCreationDraft.baseRef) ?? null,
                },
            }
            : {}),
        ...(normalizeOptionalString(draft.prompt) ? { prompt: draft.prompt.trim() } : {}),
        ...(normalizeOptionalString(draft.displayText) ? { displayText: draft.displayText.trim() } : {}),
        ...(normalizedBackendTarget ? { backendTarget: normalizedBackendTarget } : {}),
        ...(normalizedBackendTarget && !normalizedBackendTarget.configuredBackendId && isBundledAgentId(normalizedBackendTarget.backendId)
            ? { agent: normalizedBackendTarget.backendId.trim() }
            : normalizeOptionalString(draft.agentId)
                ? { agent: draft.agentId!.trim() }
                : {}),
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
        ...(codexBackendMode ? { codexBackendMode } : {}),
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
    executionTarget: Readonly<{ serverId: string; machineId: string }>;
    organizationPlacement?: Readonly<{ folderId: string | null; tagIds: readonly string[] }>;
    agentTarget: AgentExecutionTargetV1;
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
        agentId: string;
        backendTarget: BackendTargetRefV2;
    }>;
}> | Readonly<{
    kind: 'unavailable';
    reason: 'agent_target_unavailable' | 'agent_target_ambiguous';
}> {
    const matches: Array<Readonly<{
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

        matches.push({ agentId, backendTarget });
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
        && spawn.modelSelection.ref.agentTargetKey !== resolveBackendTargetKeyV2(resolvedAgentTarget.entry.backendTarget)
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
                directory: spawn.directory,
                checkoutCreationDraft: spawn.checkoutCreationDraft ?? null,
                prompt: params.prompt,
                displayText: params.displayText ?? params.prompt,
                agentId: resolvedAgentTarget.entry.agentId,
                backendTarget: resolvedAgentTarget.entry.backendTarget,
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
                experimentalCodexAcp: null,
                codexBackendMode: null,
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

    return SessionServerStartSpawnDraftV1Schema.parse({
        executionTarget: params.executionTarget,
        directory: fields.directory,
        ...(params.organizationPlacement
            ? {
                organizationPlacement: {
                    folderId: params.organizationPlacement.folderId,
                    tagIds: [...params.organizationPlacement.tagIds],
                },
            }
            : {}),
        agentTarget: params.agentTarget,
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
            ...(normalizedInitialMessage ? { initialMessage: normalizedInitialMessage } : {}),
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
    const codexBackendMode = resolveCanonicalCodexBackendMode({
        codexBackendMode: params.draft.codexBackendMode,
        experimentalCodexAcp: params.draft.experimentalCodexAcp,
    });
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
        ...(codexBackendMode ? { codexBackendMode, experimentalCodexAcp: codexBackendMode === 'acp' } : {}),
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
    const codexBackendMode = resolveCanonicalCodexBackendMode({
        codexBackendMode: params.draft.codexBackendMode,
        experimentalCodexAcp: params.draft.experimentalCodexAcp,
    });
    const normalizedAgentId = isBundledAgentId(params.draft.agentId) ? params.draft.agentId : null;
    const backendTarget = params.draft.backendTarget
        ?? (normalizedAgentId
        ? { kind: 'backend', backendId: normalizedAgentId } satisfies BackendTargetRefV2
            : null);
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
        machineId: params.machineId ?? undefined,
        directory: params.draft.directory,
        checkoutCreationDraft: params.draft.checkoutCreationDraft,
        agentType: canonicalAgentId ?? undefined,
        backendTarget: backendTarget ?? undefined,
        selectedProfileId: params.draft.profileId,
        transcriptStorage: params.draft.transcriptStorage ?? undefined,
        permissionMode: isPermissionMode(params.draft.permissionMode) ? params.draft.permissionMode : undefined,
        modelSelection: params.draft.modelSelection,
        acpSessionModeId: params.draft.acpSessionModeId ?? null,
        sessionConfigOptionOverrides: params.draft.sessionConfigOptionOverrides ?? null,
        codexBackendMode,
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
    const normalizedAgentId = isBundledAgentId(params.draft.agentId) ? params.draft.agentId : null;
    const builtInBackendAgentId = params.draft.backendTarget && !params.draft.backendTarget.configuredBackendId && isBundledAgentId(params.draft.backendTarget.backendId)
        ? params.draft.backendTarget.backendId
        : null;
    const canonicalSelectedBuiltInAgentId = params.draft.backendTarget
        ? (!params.draft.backendTarget.configuredBackendId && isBundledAgentId(params.draft.backendTarget.backendId)
            ? params.draft.backendTarget.backendId
            : (normalizedAgentId ?? builtInBackendAgentId ?? DEFAULT_AGENT_ID))
        : normalizedAgentId ?? builtInBackendAgentId ?? DEFAULT_AGENT_ID;
    const agentType = resolvePersistedAgentIdForBackendTarget({
        backendTarget: params.draft.backendTarget ?? null,
        persistedAgentId: params.preferredPersistedAgentId,
        selectedBuiltInAgentId: canonicalSelectedBuiltInAgentId,
    });
    const codexBackendMode = resolveCanonicalCodexBackendMode({
        codexBackendMode: params.draft.codexBackendMode,
        experimentalCodexAcp: params.draft.experimentalCodexAcp,
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
        selectedPath: params.draft.directory,
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
        ...(params.draft.backendTarget ? { backendTarget: params.draft.backendTarget } : {}),
        ...(params.draft.transcriptStorage ? { transcriptStorage: params.draft.transcriptStorage } : {}),
        permissionMode: isPermissionMode(params.draft.permissionMode) ? params.draft.permissionMode : 'default',
        modelSelection: params.draft.modelSelection,
        acpSessionModeId: normalizeOptionalString(params.draft.acpSessionModeId),
        ...(params.draft.sessionConfigOptionOverrides ? { sessionConfigOptionOverrides: params.draft.sessionConfigOptionOverrides } : {}),
        ...(codexBackendMode ? { codexBackendMode } : {}),
        ...(params.draft.mcpSelection ? { mcpSelection: params.draft.mcpSelection } : {}),
        ...(normalizeOptionalString(params.draft.resumeSessionId) ? { resumeSessionId: normalizeOptionalString(params.draft.resumeSessionId)! } : {}),
        ...(normalizedBackendNewSessionOptionStateByTargetKey ? {
            backendNewSessionOptionStateByTargetKey: normalizedBackendNewSessionOptionStateByTargetKey,
        } : {}),
        ...(params.draft.automation ? { automationDraft: params.draft.automation } : {}),
        updatedAt: params.updatedAt,
    };
}
