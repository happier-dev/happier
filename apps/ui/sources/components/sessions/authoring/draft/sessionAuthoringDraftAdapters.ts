import {
    AcpConfigOptionOverridesV1Schema,
    buildBackendTargetKey,
    isBuiltInAgentTarget,
    type BackendTargetRefV1,
} from '@happier-dev/protocol';

import { DEFAULT_AGENT_ID, isAgentId } from '@/agents/catalog/catalog';
import {
    sanitizeNewSessionAutomationDraft,
    type NewSessionAutomationDraft,
} from '@/sync/domains/automations/automationDraft';
import { decodeAutomationTemplate } from '@/sync/domains/automations/automationTemplateCodec';
import { tryDecodeAutomationTemplateEnvelope } from '@/sync/domains/automations/automationTemplateTransport';
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
import type { NewSessionData } from '@/utils/sessions/tempDataStore';
import { parseCheckoutCreationDraft } from '@/sync/domains/state/newSessionCheckoutDraft';
import type { NewSessionDraft } from '@/sync/domains/state/persistence';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { SpawnSessionOptions } from '@/sync/domains/session/spawn/spawnSessionPayload';

import type { SessionAuthoringDraft } from './sessionAuthoringDraft';

type ExistingSessionAuthoringSnapshotSession = Pick<
    Session,
    'id' | 'encryptionMode' | 'metadata' | 'permissionMode' | 'permissionModeUpdatedAt' | 'modelMode' | 'modelModeUpdatedAt'
>;

export type { ExistingSessionAuthoringSnapshotSession };

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
        backendTarget: params.snapshot.backendTarget,
        transcriptStorage: params.snapshot.transcriptStorage,
        profileId: params.snapshot.profileId,
        environmentVariables: null,
        resumeSessionId: null,
        permissionMode: params.snapshot.permissionMode,
        permissionModeUpdatedAt: params.snapshot.permissionModeUpdatedAt,
        modelId: params.snapshot.modelId,
        modelUpdatedAt: params.snapshot.modelUpdatedAt,
        mcpSelection: params.snapshot.mcpSelection,
        connectedServices: params.snapshot.connectedServices,
        terminal: params.snapshot.terminal,
        windowsRemoteSessionLaunchMode: null,
        windowsRemoteSessionConsole: null,
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
        modelId: current.modelId ?? fallback.modelId,
        modelUpdatedAt: current.modelUpdatedAt ?? fallback.modelUpdatedAt,
        mcpSelection: current.mcpSelection ?? fallback.mcpSelection,
        connectedServices: current.connectedServices ?? fallback.connectedServices,
        terminal: current.terminal ?? fallback.terminal,
        windowsRemoteSessionLaunchMode: current.windowsRemoteSessionLaunchMode ?? fallback.windowsRemoteSessionLaunchMode,
        windowsRemoteSessionConsole: current.windowsRemoteSessionConsole ?? fallback.windowsRemoteSessionConsole,
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
        modelId: params.currentDraft.modelId,
        modelUpdatedAt: params.currentDraft.modelUpdatedAt,
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
            modelId: params.hydratedTemplateDraft.modelId ?? fallbackDraft.modelId,
            modelUpdatedAt: params.hydratedTemplateDraft.modelUpdatedAt ?? fallbackDraft.modelUpdatedAt,
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

function resolveDraftBackendTarget(draft: Pick<SessionAuthoringDraft, 'backendTarget' | 'agentId'>): BackendTargetRefV1 | null {
    if (draft.backendTarget) {
        return draft.backendTarget;
    }
    return normalizeOptionalString(draft.agentId)
        ? { kind: 'builtInAgent', agentId: draft.agentId!.trim() } satisfies BackendTargetRefV1
        : null;
}

function resolveNewSessionDraftAgentId(params: Readonly<{
    agentId?: unknown;
    backendTarget?: BackendTargetRefV1 | null;
}>): string | null {
    if (typeof params.agentId === 'string' && isAgentId(params.agentId)) {
        return params.agentId;
    }
    if (params.backendTarget && isBuiltInAgentTarget(params.backendTarget) && isAgentId(params.backendTarget.agentId)) {
        return params.backendTarget.agentId;
    }
    return null;
}

function resolveConnectedServicesFromAgentOptionState(params: Readonly<{
    backendTarget: BackendTargetRefV1 | null;
    agentOptionStateByAgentId?: Record<string, Record<string, unknown>> | null;
}>): unknown {
    if (!params.backendTarget || !params.agentOptionStateByAgentId) {
        return null;
    }
    const targetKey = buildBackendTargetKey(params.backendTarget);
    const targetOptions = params.agentOptionStateByAgentId[targetKey];
    if (!targetOptions || typeof targetOptions !== 'object' || Array.isArray(targetOptions)) {
        return null;
    }
    return Object.prototype.hasOwnProperty.call(targetOptions, 'connectedServices')
        ? (targetOptions as Record<string, unknown>).connectedServices ?? null
        : null;
}

type NewSessionAuthoringDraftParams = Omit<
    SessionAuthoringDraft,
    'targetType' | 'existingSessionId' | 'sessionEncryptionMode' | 'sessionEncryptionKeyBase64' | 'sessionEncryptionVariant' | 'experimentalCodexAcp'
> & Readonly<{
    experimentalCodexAcp?: boolean | null;
}>;

export function buildNewSessionAuthoringDraft(params: NewSessionAuthoringDraftParams): SessionAuthoringDraft {
    const codexBackendMode = resolveCanonicalCodexBackendMode({
        codexBackendMode: params.codexBackendMode,
        experimentalCodexAcp: params.experimentalCodexAcp,
    });

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
        modelId: normalizeOptionalString(params.modelId),
        modelUpdatedAt: normalizeOptionalNumber(params.modelUpdatedAt),
        mcpSelection: params.mcpSelection ?? null,
        connectedServices: params.connectedServices,
        terminal: params.terminal ?? null,
        windowsRemoteSessionLaunchMode: params.windowsRemoteSessionLaunchMode ?? null,
        windowsRemoteSessionConsole: params.windowsRemoteSessionConsole ?? null,
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
    modelId?: SessionAuthoringDraft['modelId'];
    modelUpdatedAt?: SessionAuthoringDraft['modelUpdatedAt'];
    mcpSelection?: SessionAuthoringDraft['mcpSelection'];
    connectedServices: SessionAuthoringDraft['connectedServices'];
    terminal?: SessionAuthoringDraft['terminal'];
    windowsRemoteSessionLaunchMode?: SessionAuthoringDraft['windowsRemoteSessionLaunchMode'];
    windowsRemoteSessionConsole?: SessionAuthoringDraft['windowsRemoteSessionConsole'];
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
        modelId: params.modelId ?? null,
        modelUpdatedAt: params.modelUpdatedAt ?? null,
        mcpSelection: params.mcpSelection ?? null,
        connectedServices: params.connectedServices,
        terminal: params.terminal ?? null,
        windowsRemoteSessionLaunchMode: params.windowsRemoteSessionLaunchMode ?? null,
        windowsRemoteSessionConsole: params.windowsRemoteSessionConsole ?? null,
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
        modelId: resolveNewSessionSourceModelId(source),
        modelUpdatedAt: null,
        mcpSelection: source.source.mcpSelection ?? null,
        connectedServices: normalizeSessionAuthoringConnectedServices(resolveConnectedServicesFromAgentOptionState({
            backendTarget,
            agentOptionStateByAgentId: source.source.agentNewSessionOptionStateByAgentId ?? null,
        })),
        terminal: null,
        windowsRemoteSessionLaunchMode: null,
        windowsRemoteSessionConsole: null,
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
            ? { kind: 'builtInAgent', agentId: normalizeOptionalString(params.template.agent)! } satisfies BackendTargetRefV1
            : null);

    return {
        targetType: params.targetType,
        directory: normalizeRequiredString(params.template.directory),
        checkoutCreationDraft: parseCheckoutCreationDraft(params.template.checkoutCreationDraft),
        prompt: params.template.prompt ?? '',
        displayText: params.template.displayText ?? '',
        agentId: backendTarget && isBuiltInAgentTarget(backendTarget)
            ? normalizeOptionalString(backendTarget.agentId)
            : normalizeOptionalString(params.template.agent),
        backendTarget,
        transcriptStorage: params.template.transcriptStorage ?? null,
        profileId: normalizeOptionalString(params.template.profileId),
        environmentVariables: params.template.environmentVariables ?? null,
        resumeSessionId: normalizeOptionalString(params.template.resume),
        permissionMode: normalizeOptionalString(params.template.permissionMode),
        permissionModeUpdatedAt: normalizeOptionalNumber(params.template.permissionModeUpdatedAt),
        modelId: normalizeOptionalString(params.template.modelId),
        modelUpdatedAt: normalizeOptionalNumber(params.template.modelUpdatedAt),
        mcpSelection: params.template.mcpSelection ?? null,
        connectedServices: normalizeSessionAuthoringConnectedServices(params.template.connectedServices),
        terminal: normalizeSessionAuthoringTerminal(params.template.terminal),
        windowsRemoteSessionLaunchMode: params.template.windowsRemoteSessionLaunchMode ?? null,
        windowsRemoteSessionConsole: params.template.windowsRemoteSessionConsole ?? null,
        experimentalCodexAcp: null,
        codexBackendMode,
        acpSessionModeId: normalizeOptionalString(params.template.agentModeId),
        sessionConfigOptionOverrides: null,
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
    decryptAutomationTemplateRaw: (payloadCiphertext: string) => Promise<unknown>;
}>): Promise<Readonly<{
    hydratedDraft: SessionAuthoringDraft;
    seededAutomationDraft: NewSessionAutomationDraft;
}>> {
    const envelope = tryDecodeAutomationTemplateEnvelope(params.automation.templateCiphertext);
    if (!envelope) {
        throw new Error('Invalid automation template envelope payload');
    }
    const raw = envelope.kind === 'happier_automation_template_plain_v1'
        ? envelope.payload
        : await params.decryptAutomationTemplateRaw(envelope.payloadCiphertext);
    const decoded = decodeAutomationTemplate(JSON.stringify(raw));
    if (!decoded) {
        throw new Error('Invalid decrypted automation template payload');
    }

    return {
        hydratedDraft: hydrateSessionAuthoringDraftFromAutomationTemplate({
            targetType: params.automation.targetType,
            template: decoded,
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
        ...(normalizedBackendTarget && isBuiltInAgentTarget(normalizedBackendTarget)
            ? { agent: normalizedBackendTarget.agentId.trim() }
            : normalizeOptionalString(draft.agentId)
                ? { agent: draft.agentId!.trim() }
                : {}),
        ...(draft.transcriptStorage ? { transcriptStorage: draft.transcriptStorage } : {}),
        ...(normalizeOptionalString(draft.profileId) ? { profileId: draft.profileId!.trim() } : {}),
        ...(draft.environmentVariables ? { environmentVariables: draft.environmentVariables } : {}),
        ...(normalizeOptionalString(draft.resumeSessionId) ? { resume: draft.resumeSessionId!.trim() } : {}),
        ...(normalizeOptionalString(draft.permissionMode) ? { permissionMode: draft.permissionMode!.trim() } : {}),
        ...(typeof draft.permissionModeUpdatedAt === 'number' ? { permissionModeUpdatedAt: draft.permissionModeUpdatedAt } : {}),
        ...(normalizeOptionalString(draft.modelId) ? { modelId: draft.modelId!.trim() } : {}),
        ...(typeof draft.modelUpdatedAt === 'number' ? { modelUpdatedAt: draft.modelUpdatedAt } : {}),
        ...(draft.mcpSelection ? { mcpSelection: draft.mcpSelection } : {}),
        ...(draft.connectedServices !== undefined && draft.connectedServices !== null ? { connectedServices: draft.connectedServices } : {}),
        ...(draft.terminal !== undefined && draft.terminal !== null ? { terminal: draft.terminal } : {}),
        ...(draft.windowsRemoteSessionLaunchMode ? { windowsRemoteSessionLaunchMode: draft.windowsRemoteSessionLaunchMode } : {}),
        ...(draft.windowsRemoteSessionConsole ? { windowsRemoteSessionConsole: draft.windowsRemoteSessionConsole } : {}),
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

export function buildSpawnSessionOptionsFromAuthoringDraft(params: Readonly<{
    draft: SessionAuthoringDraft;
    machineId: string;
    serverId?: string | null;
    approvedNewDirectoryCreation?: boolean;
    agentModeUpdatedAt?: number | null;
}>): SpawnSessionOptions {
    const backendTarget = resolveDraftBackendTarget(params.draft);
    const codexBackendMode = resolveCanonicalCodexBackendMode({
        codexBackendMode: params.draft.codexBackendMode,
        experimentalCodexAcp: params.draft.experimentalCodexAcp,
    });
    if (!backendTarget) {
        throw new Error('Session authoring draft requires backendTarget to spawn a session');
    }

    const normalizedProfileId = typeof params.draft.profileId === 'string'
        ? params.draft.profileId.trim()
        : '';

    return {
        machineId: params.machineId,
        ...(typeof params.serverId === 'string' || params.serverId === null ? { serverId: params.serverId } : {}),
        directory: normalizeRequiredString(params.draft.directory),
        ...(params.draft.transcriptStorage ? { transcriptStorage: params.draft.transcriptStorage } : {}),
        ...(typeof params.approvedNewDirectoryCreation === 'boolean'
            ? { approvedNewDirectoryCreation: params.approvedNewDirectoryCreation }
            : {}),
        backendTarget,
        ...(normalizedProfileId.length > 0 || params.draft.profileId === '' ? { profileId: normalizedProfileId } : {}),
        ...(params.draft.environmentVariables ? { environmentVariables: params.draft.environmentVariables } : {}),
        ...(normalizeOptionalString(params.draft.resumeSessionId) ? { resume: params.draft.resumeSessionId!.trim() } : {}),
        ...(normalizeOptionalString(params.draft.permissionMode) ? { permissionMode: params.draft.permissionMode!.trim() as SpawnSessionOptions['permissionMode'] } : {}),
        ...(typeof params.draft.permissionModeUpdatedAt === 'number'
            ? { permissionModeUpdatedAt: params.draft.permissionModeUpdatedAt }
            : {}),
        ...(normalizeOptionalString(params.draft.acpSessionModeId)
            ? {
                agentModeId: params.draft.acpSessionModeId!.trim(),
                ...(typeof params.agentModeUpdatedAt === 'number' && Number.isFinite(params.agentModeUpdatedAt)
                    ? { agentModeUpdatedAt: params.agentModeUpdatedAt }
                    : {}),
            }
            : {}),
        ...(normalizeOptionalString(params.draft.modelId) ? { modelId: params.draft.modelId!.trim() } : {}),
        ...(typeof params.draft.modelUpdatedAt === 'number' ? { modelUpdatedAt: params.draft.modelUpdatedAt } : {}),
        ...(params.draft.sessionConfigOptionOverrides ? { sessionConfigOptionOverrides: params.draft.sessionConfigOptionOverrides } : {}),
        ...(codexBackendMode ? { codexBackendMode, experimentalCodexAcp: codexBackendMode === 'acp' } : {}),
        ...(params.draft.terminal ? { terminal: params.draft.terminal as SpawnSessionOptions['terminal'] } : {}),
        ...(params.draft.windowsRemoteSessionLaunchMode
            ? { windowsRemoteSessionLaunchMode: params.draft.windowsRemoteSessionLaunchMode }
            : {}),
        ...(params.draft.windowsRemoteSessionConsole
            ? { windowsRemoteSessionConsole: params.draft.windowsRemoteSessionConsole }
            : {}),
        ...(params.draft.connectedServices !== undefined && params.draft.connectedServices !== null
            ? { connectedServices: params.draft.connectedServices }
            : {}),
        ...(params.draft.mcpSelection ? { mcpSelection: params.draft.mcpSelection } : {}),
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
    const normalizedAgentId = isAgentId(params.draft.agentId) ? params.draft.agentId : null;
    const backendTarget = params.draft.backendTarget
        ?? (normalizedAgentId
            ? { kind: 'builtInAgent', agentId: normalizedAgentId } satisfies BackendTargetRefV1
            : null);
    const targetKey = backendTarget ? buildBackendTargetKey(backendTarget) : null;
    const agentOptionStateByAgentId = targetKey && (
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
        agentType: normalizedAgentId
            ?? (backendTarget && isBuiltInAgentTarget(backendTarget) && isAgentId(backendTarget.agentId)
                ? backendTarget.agentId
                : undefined),
        backendTarget: backendTarget ?? undefined,
        selectedProfileId: params.draft.profileId,
        transcriptStorage: params.draft.transcriptStorage ?? undefined,
        permissionMode: isPermissionMode(params.draft.permissionMode) ? params.draft.permissionMode : undefined,
        modelMode: params.draft.modelId ?? undefined,
        acpSessionModeId: params.draft.acpSessionModeId ?? null,
        sessionConfigOptionOverrides: params.draft.sessionConfigOptionOverrides ?? null,
        codexBackendMode,
        mcpSelection: params.draft.mcpSelection,
        ...(params.draft.automation ? { automationDraft: params.draft.automation } : {}),
        agentNewSessionOptionStateByAgentId: agentOptionStateByAgentId,
        resumeSessionId: params.draft.resumeSessionId ?? undefined,
    };
}

export function buildPersistedNewSessionDraftFromAuthoringDraft(params: Readonly<{
    draft: SessionAuthoringDraft;
    machineId: string | null;
    entryIntent?: NewSessionDraft['entryIntent'];
    selectedSecretId: string | null;
    selectedSecretIdByProfileIdByEnvVarName: NewSessionDraft['selectedSecretIdByProfileIdByEnvVarName'];
    sessionOnlySecretValueEncByProfileIdByEnvVarName: NewSessionDraft['sessionOnlySecretValueEncByProfileIdByEnvVarName'];
    agentNewSessionOptionStateByAgentId: NewSessionDraft['agentNewSessionOptionStateByAgentId'];
    updatedAt: number;
}>): NewSessionDraft {
    const normalizedAgentId = isAgentId(params.draft.agentId) ? params.draft.agentId : null;
    const builtInBackendAgentId = params.draft.backendTarget && isBuiltInAgentTarget(params.draft.backendTarget) && isAgentId(params.draft.backendTarget.agentId)
        ? params.draft.backendTarget.agentId
        : null;
    const agentType = normalizedAgentId ?? builtInBackendAgentId ?? DEFAULT_AGENT_ID;
    const codexBackendMode = resolveCanonicalCodexBackendMode({
        codexBackendMode: params.draft.codexBackendMode,
        experimentalCodexAcp: params.draft.experimentalCodexAcp,
    });

    return {
        input: params.draft.displayText || params.draft.prompt,
        selectedMachineId: params.machineId,
        selectedPath: params.draft.directory,
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
        modelMode: isModelMode(params.draft.modelId) ? params.draft.modelId : 'default',
        acpSessionModeId: normalizeOptionalString(params.draft.acpSessionModeId),
        ...(params.draft.sessionConfigOptionOverrides ? { sessionConfigOptionOverrides: params.draft.sessionConfigOptionOverrides } : {}),
        ...(codexBackendMode ? { codexBackendMode } : {}),
        ...(params.draft.mcpSelection ? { mcpSelection: params.draft.mcpSelection } : {}),
        ...(normalizeOptionalString(params.draft.resumeSessionId) ? { resumeSessionId: normalizeOptionalString(params.draft.resumeSessionId)! } : {}),
        ...(params.agentNewSessionOptionStateByAgentId ? {
            agentNewSessionOptionStateByAgentId: params.agentNewSessionOptionStateByAgentId,
        } : {}),
        ...(params.draft.automation ? { automationDraft: params.draft.automation } : {}),
        updatedAt: params.updatedAt,
    };
}
