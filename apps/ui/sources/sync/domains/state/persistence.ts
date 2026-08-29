import { z } from 'zod';
import type { Settings } from '../settings/settings';
import { voiceSettingsParse } from '../settings/voiceSettings';
import {
    parseCurrentWriterPredecessorVoiceProjection,
} from '../settings/voiceSettingsPersistence';
import { readLegacyVoiceSettingsMigrationSource } from '@/voice/settings/migrations/legacyAdapters';
import { LocalSettings, localSettingsDefaults, localSettingsParse } from '../settings/localSettings';
import {
    migrateThemeProfileLocalStateTokenIds,
    parseThemeProfilesLocalState,
} from '@/theme/profiles/themeProfilePersistence';
import type { ThemeProfilesLocalStateV1 } from '@/theme/profiles/themeProfileTypes';
import { Purchases, purchasesDefaults, purchasesParse } from '../purchases/purchases';
import { ACCOUNT_SETTING_ARTIFACTS } from '../settings/registry/account/accountSettingArtifacts';
import { LOCAL_ACCOUNT_SETTING_ARTIFACTS } from '../settings/registry/local/localAccountSettingDefinitions';
import { isModelMode, isPermissionMode, type PermissionMode, type ModelMode } from '@/sync/domains/permissions/permissionTypes';
import { DEFAULT_AGENT_ID, isBundledAgentId, type AgentId } from '@/agents/registry/registryCore';
import { isLegacyCompatAgentType } from '@/agents/backendCatalog/legacyCompatAgents';
import { SecretStringSchema, type SecretString } from '../../encryption/secretSettings';
import {
    readPersistedNewSessionCheckoutDraft,
    type NewSessionCheckoutCreationDraft,
} from './newSessionCheckoutDraft';
import {
    sanitizeNewSessionAutomationDraft,
    type NewSessionAutomationDraft,
} from '@/sync/domains/automations/automationDraft';
import { ReviewCommentDraftSchema } from '@/sync/domains/input/reviewComments/reviewCommentMeta';
import { SessionActionDraftSchema } from '@/sync/domains/sessionActions/sessionActionDraftMeta';
import {
    normalizeBackendNewSessionOptionStateByTargetKey,
    type BackendNewSessionOptionStateByTargetKey,
} from '@/utils/sessions/backendNewSessionOptionState';
import {
    type ServerAccountScope,
} from '@/sync/domains/scope/serverAccountScope';
import {
    AcpConfigOptionOverridesV1Schema,
    AgentExecutionTargetV1Schema,
    ComposerAttachmentDraftV1Schema,
    type ComposerAttachmentAuthorValueV1,
    ExternalSessionRefreshCursorV1Schema,
    MAX_COMPOSER_ATTACHMENT_INSTANCES_V1,
    SessionModelSelectionV1Schema,
    SessionModelSelectionResolutionError,
    SessionMcpSelectionV1Schema,
    SessionExecutionTargetV1Schema,
    SessionOrganizationPlacementV1Schema,
    WindowsRemoteSessionLaunchModeSchema,
    readBackendTargetRefV2,
    readPersistedAgentContributionIdentityV1,
    normalizeCodexBackendMode,
    readRuntimeDescriptorV1,
    type ComposerAttachmentDraftV1,
    type AcpConfigOptionOverridesV1,
    type AgentExecutionTargetV1,
    type BackendTargetRefV2,
    type SessionMcpSelectionV1,
    type SessionModelSelectionV1,
    type RuntimeDescriptorV1,
    type SessionExecutionTargetV1,
    type SessionOrganizationPlacementV1,
    type WindowsRemoteSessionLaunchMode,
} from '@happier-dev/protocol';
import type { PluginUiSessionPlacementCandidateV1 } from '@happier-dev/protocol/plugins/ui';
import { getPersistenceStorage } from './persistenceStorage';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import { prepareSessionPersistenceScopeForActivation } from './sessionPersistence';
import { scopedSessionLocalStateKey, sessionDraftValuesStorageKey } from './sessionLocalStateKeys';
export { loadProfile, saveProfile } from './profilePersistence';
export { clearPersistence } from './persistenceLifecycle';
export {
    loadSessionActionDrafts,
    loadSessionDrafts,
    loadSessionLastViewed,
    loadSessionModelModeUpdatedAts,
    loadSessionModelModes,
    loadSessionPermissionModeUpdatedAts,
    loadSessionPermissionModes,
    loadSessionReviewCommentsDrafts,
    loadWorkspaceReviewCommentsDrafts,
    prepareSessionPersistenceScopeForActivation,
    saveSessionActionDrafts,
    saveSessionDrafts,
    saveSessionLastViewed,
    saveSessionModelModeUpdatedAts,
    saveSessionModelModes,
    saveSessionPermissionModeUpdatedAts,
    saveSessionPermissionModes,
    saveSessionReviewCommentsDrafts,
    saveWorkspaceReviewCommentsDrafts,
    type SessionActionDraftsBySessionId,
    type SessionReviewCommentDraftsBySessionId,
    type WorkspaceReviewCommentDraftsByWorkspaceCacheKey,
} from './sessionPersistence';
export {
    loadLocalSettings,
    loadPurchases,
    loadSettings,
    saveLocalSettings,
    savePurchases,
    saveSettings,
} from './settingsPersistence';
export {
    loadLocalPetSourcesBySourceKey,
    saveLocalPetSourcesBySourceKey,
} from './localPetSourcePersistence';

const pendingSettingsSchemaByKey: Readonly<Record<string, z.ZodTypeAny>> = Object.freeze({
    ...ACCOUNT_SETTING_ARTIFACTS.shape,
    ...LOCAL_ACCOUNT_SETTING_ARTIFACTS.shape,
});

function deviceAnalyticsIdKey(): string {
    return 'device-analytics-id-v1';
}

function newSessionDraftKey(scope?: ServerAccountScope | null): string {
    return scopedSessionLocalStateKey('new-session-draft-v1', scope);
}

function sessionMaterializedMaxSeqKey(scope?: ServerAccountScope | null): string {
    return scopedSessionLocalStateKey('session-materialized-max-seq-v1', scope);
}

function syncReliabilityEventsKey(): string {
    return 'sync-reliability-events-v1';
}

function lastChangesCursorByAccountIdKey(): string {
    return 'last-changes-cursor-by-account-id-v1';
}

function changesCursorByAccountIdPrefix(): string {
    return 'changes-cursor-by-account-id-v1:';
}

function changesCursorByServerScopeAndAccountIdPrefix(): string {
    return 'changes-cursor-by-server-scope-and-account-id-v1:';
}

function changesCursorByServerScopeAccountIdAndInstancePrefix(): string {
    return 'changes-cursor-by-server-scope-account-id-and-instance-v1:';
}

function externalSessionTailCursorPrefix(): string {
    return 'direct-session-tail-cursor-v1:';
}

function sessionModelModeUpdatedAtsKey(): string {
    return 'session-model-mode-updated-ats-v1';
}

/**
 * A draft-local attachment request waiting for the mounted Composer to admit
 * it against the current contribution catalog. It is intentionally distinct
 * from a canonical ComposerAttachmentDraftV1: only the mounted Composer can
 * supply the generation-bound contribution identity and presentation.
 */
export type NewSessionComposerAttachmentSeedV1 = Readonly<{
    instanceId: string;
    pluginId: string;
    attachmentLocalId: string;
    value: ComposerAttachmentAuthorValueV1;
}>;

export interface NewSessionDraft {
    input: string;
    /**
     * Host-created attachment requests waiting for the mounted Composer to
     * resolve the current contribution catalog. These remain device-local
     * draft custody and are never projected into the synchronized document.
     */
    composerAttachmentSeeds?: readonly NewSessionComposerAttachmentSeedV1[];
    /**
     * Canonical contentless plugin attachment drafts for the new-Session
     * composer. The submission owner prepares them after a Session exists.
     */
    composerAttachments?: readonly ComposerAttachmentDraftV1[];
    /** Opaque identity of the unresolved user launch intent. */
    launchUserAttemptId?: string;
    selectedMachineId: string | null;
    selectedPath: string | null;
    targetServerId?: string | null;
    /** Unresolved placement choices seeded by a host, owned by this draft. */
    placementCandidates?: readonly PluginUiSessionPlacementCandidateV1[];
    executionTarget?: SessionExecutionTargetV1 | null;
    organizationPlacement?: SessionOrganizationPlacementV1;
    windowsRemoteSessionLaunchModeOverride?: Readonly<{
        machineId: string;
        mode: WindowsRemoteSessionLaunchMode;
    }> | null;
    entryIntent?: 'session' | 'automation' | null;
    checkoutCreationDraft?: NewSessionCheckoutCreationDraft | null;
    selectedProfileId: string | null;
    selectedSecretId: string | null;
    /**
     * Per-profile per-env-var secret selection (saved secret id or '' for "use machine env").
     * Used by the New Session wizard to preserve overrides while switching profiles.
     */
    selectedSecretIdByProfileIdByEnvVarName?: Record<string, Record<string, string | null | undefined>> | null;
    /**
     * Per-profile per-env-var session-only secret values, encrypted-at-rest.
     * (These are decrypted only when needed by the wizard.)
     */
    sessionOnlySecretValueEncByProfileIdByEnvVarName?: Record<string, Record<string, SecretString | null | undefined>> | null;
    agentType: AgentId;
    agentTarget?: AgentExecutionTargetV1 | null;
    /** Released predecessor read input. New authoring writes `agentTarget`. */
    backendTarget?: BackendTargetRefV2 | null;
    transcriptStorage?: 'persisted' | 'direct';
    permissionMode: PermissionMode;
    modelSelection?: SessionModelSelectionV1 | null;
    /** Read-only compatibility input. New writes persist `modelSelection` only. */
    modelMode?: ModelMode;
    /**
     * ACP-only session mode selection (e.g. "plan") for the new-session wizard.
     * UI-only draft state (not sent to server unless supported by the selected agent).
     */
    acpSessionModeId: string | null;
    sessionConfigOptionOverrides?: AcpConfigOptionOverridesV1 | null;
    runtimeDescriptorV1?: RuntimeDescriptorV1 | null;
    mcpSelection?: SessionMcpSelectionV1 | null;
    resumeSessionId?: string;
    /**
     * Provider-specific new-session option state keyed by backend target key.
     * This is UI-only draft state (not sent to server).
     */
    backendNewSessionOptionStateByTargetKey?: BackendNewSessionOptionStateByTargetKey | null;
    /**
     * Legacy alias for older persisted drafts.
     * New code should read and write `backendNewSessionOptionStateByTargetKey`.
     */
    agentNewSessionOptionStateByAgentId?: BackendNewSessionOptionStateByTargetKey | null;
    automationDraft?: NewSessionAutomationDraft | null;
    updatedAt: number;
}

type DraftNestedRecord<T> = Record<string, Record<string, T | null>>;

/**
 * Parse a "record of records" draft field while salvaging valid entries.
 * We intentionally accept partial validity to avoid dropping all draft state
 * due to a single malformed nested entry.
 */
function parseDraftNestedRecord<T>(
    input: unknown,
    parseValue: (value: unknown) => T | null | undefined
): DraftNestedRecord<T> | null {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    const out: DraftNestedRecord<T> = {};

    for (const [rawProfileId, byEnv] of Object.entries(input as Record<string, unknown>)) {
        const profileId = typeof rawProfileId === 'string' ? rawProfileId.trim() : '';
        if (!profileId) continue;
        if (!byEnv || typeof byEnv !== 'object' || Array.isArray(byEnv)) continue;

        const inner: Record<string, T | null> = {};
        for (const [rawEnvVarName, rawValue] of Object.entries(byEnv as Record<string, unknown>)) {
            const envVarName = typeof rawEnvVarName === 'string' ? rawEnvVarName.trim().toUpperCase() : '';
            if (!envVarName) continue;

            const parsed = parseValue(rawValue);
            if (parsed !== undefined) {
                inner[envVarName] = parsed;
            }
        }

        if (Object.keys(inner).length > 0) out[profileId] = inner;
    }

    return Object.keys(out).length > 0 ? out : null;
}

function parseDraftStringOrNull(value: unknown): string | null | undefined {
    if (value === null) return null;
    if (typeof value === 'string') return value;
    return undefined;
}

function parseDraftTrimmedString(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed || undefined;
}

function parseWindowsRemoteSessionLaunchModeOverride(value: unknown): NewSessionDraft['windowsRemoteSessionLaunchModeOverride'] | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    const machineId = parseDraftTrimmedString(record.machineId);
    if (!machineId) return undefined;
    const mode = WindowsRemoteSessionLaunchModeSchema.safeParse(record.mode);
    if (!mode.success) return undefined;
    return {
        machineId,
        mode: mode.data,
    };
}

function parseDraftSecretStringOrNull(value: unknown): SecretString | null | undefined {
    if (value === null) return null;
    const parsed = SecretStringSchema.safeParse(value);
    if (parsed.success) return parsed.data;
    return undefined;
}

type DraftJsonValue = null | boolean | number | string | DraftJsonValue[] | { [key: string]: DraftJsonValue };

function parseDraftJsonValue(value: unknown): DraftJsonValue | undefined {
    if (value === null || typeof value === 'boolean' || typeof value === 'string') {
        return value;
    }
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : undefined;
    }
    if (Array.isArray(value)) {
        const items: DraftJsonValue[] = [];
        for (const item of value) {
            const parsed = parseDraftJsonValue(item);
            if (parsed !== undefined) items.push(parsed);
        }
        return items;
    }
    if (!value || typeof value !== 'object') return undefined;

    const out: Record<string, DraftJsonValue> = {};
    for (const [key, rawNestedValue] of Object.entries(value as Record<string, unknown>)) {
        const parsed = parseDraftJsonValue(rawNestedValue);
        if (parsed !== undefined) out[key] = parsed;
    }
    return out;
}

function parseDraftBackendNewSessionOptionStateByTargetKey(
    input: unknown,
): BackendNewSessionOptionStateByTargetKey | null {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    const out: BackendNewSessionOptionStateByTargetKey = {};

    for (const [rawTargetKey, rawOptions] of Object.entries(input as Record<string, unknown>)) {
        const targetKey = typeof rawTargetKey === 'string' ? rawTargetKey.trim() : '';
        if (!targetKey) continue;
        if (!rawOptions || typeof rawOptions !== 'object' || Array.isArray(rawOptions)) continue;

        const options: Record<string, unknown> = {};
        for (const [rawKey, rawValue] of Object.entries(rawOptions as Record<string, unknown>)) {
            const key = typeof rawKey === 'string' ? rawKey.trim() : '';
            if (!key) continue;

            const parsedValue = parseDraftJsonValue(rawValue);
            if (parsedValue !== undefined) options[key] = parsedValue;
        }

        if (Object.keys(options).length > 0) out[targetKey] = options;
    }

    return normalizeBackendNewSessionOptionStateByTargetKey(out);
}

function parseDraftRuntimeDescriptorV1(record: Readonly<Record<string, unknown>>): RuntimeDescriptorV1 | null {
    const canonical = readRuntimeDescriptorV1(record.runtimeDescriptorV1);
    const releasedCodexBackendMode = normalizeCodexBackendMode(record.codexBackendMode);
    if (!releasedCodexBackendMode) return canonical;

    const released = readRuntimeDescriptorV1({
        v: 1,
        agentId: 'codex',
        agent: { backendMode: releasedCodexBackendMode },
    });
    if (!canonical) return released;
    if (
        canonical.agentId !== 'codex'
        || normalizeCodexBackendMode(canonical.agent.backendMode) !== releasedCodexBackendMode
    ) {
        return null;
    }
    return canonical;
}

function parseDraftEntryIntent(value: unknown): NewSessionDraft['entryIntent'] {
    return value === 'automation' || value === 'session' ? value : null;
}

export function loadDeviceAnalyticsId(): string | null {
    const mmkv = getPersistenceStorage();
    const raw = mmkv.getString(deviceAnalyticsIdKey());
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    return trimmed || null;
}

export function saveDeviceAnalyticsId(value: string): void {
    const mmkv = getPersistenceStorage();
    const trimmed = value.trim();
    if (!trimmed) return;
    mmkv.set(deviceAnalyticsIdKey(), trimmed);
}

export function parsePendingSettings(raw: unknown): Partial<Settings> {
    // CRITICAL: Pending settings must represent ONLY user-intended deltas.
    // We must NOT apply schema defaults here (otherwise `{}` becomes a non-empty delta,
    // causing a POST on every startup and potentially overwriting server settings).
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return {};
    }
    const input = raw as Record<string, unknown>;
    const out: Partial<Settings> = {};

    for (const [rawKey, rawValue] of Object.entries(input)) {
        const key = typeof rawKey === 'string' ? rawKey.trim() : '';
        if (!key) continue;
        if (rawValue === undefined) continue;
        if (typeof rawValue === 'function') continue;

        // Voice is parsed with a tolerant parser to avoid dropping the entire object due to a
        // single invalid nested field. Pending settings must follow the same rule so we do not
        // lose unsynced voice deltas (e.g. BYO API keys) on restart.
        if (key === 'voice') {
            const currentWriterProjection = parseCurrentWriterPredecessorVoiceProjection(rawValue);
            if (currentWriterProjection) {
                (out as any).voice = currentWriterProjection;
                continue;
            }
            const parsedVoice = voiceSettingsParse(rawValue);
            if (parsedVoice) (out as any).voice = stripSynthesizedVoiceExecutionDefaults(rawValue, parsedVoice);
            continue;
        }

        const schema = pendingSettingsSchemaByKey[key];
        if (!schema) continue;

        const parsed = schema.safeParse(rawValue);
        if (!parsed.success) continue;

        (out as any)[key] = parsed.data;
    }

    return out;
}

function stripSynthesizedVoiceExecutionDefaults(rawValue: unknown, parsedVoice: Settings['voice']): Settings['voice'] {
    if (!rawValue || typeof rawValue !== 'object' || Array.isArray(rawValue)) {
        return parsedVoice;
    }

    const sanitized = JSON.parse(JSON.stringify(parsedVoice)) as Settings['voice'];
    const rawVoice = rawValue as Record<string, unknown>;
    const rawProviders = rawVoice.providers && typeof rawVoice.providers === 'object' && !Array.isArray(rawVoice.providers)
        ? rawVoice.providers as Record<string, unknown>
        : null;
    const rawLegacyAdapters = readLegacyVoiceSettingsMigrationSource(rawVoice).adapters;
    const parsedProviders = sanitized.providers && typeof sanitized.providers === 'object' && !Array.isArray(sanitized.providers)
        ? sanitized.providers as Record<string, unknown>
        : null;

    if ((!rawProviders && !rawLegacyAdapters) || !parsedProviders) {
        return sanitized;
    }

    for (const providerId of ['local_direct', 'local_conversation']) {
        const rawEnvelope = rawProviders?.[providerId] && typeof rawProviders[providerId] === 'object'
            ? rawProviders[providerId] as Record<string, unknown>
            : null;
        const rawConfig = rawEnvelope?.config && typeof rawEnvelope.config === 'object' && !Array.isArray(rawEnvelope.config)
            ? rawEnvelope.config as Record<string, unknown>
            : rawLegacyAdapters?.[providerId] && typeof rawLegacyAdapters[providerId] === 'object' && !Array.isArray(rawLegacyAdapters[providerId])
                ? rawLegacyAdapters[providerId] as Record<string, unknown>
                : null;
        const parsedEnvelope = parsedProviders[providerId] && typeof parsedProviders[providerId] === 'object'
            ? parsedProviders[providerId] as Record<string, unknown>
            : null;
        const parsedConfig = parsedEnvelope?.config && typeof parsedEnvelope.config === 'object' && !Array.isArray(parsedEnvelope.config)
            ? parsedEnvelope.config as Record<string, unknown>
            : null;
        if (!rawConfig || !parsedConfig) continue;
        stripSynthesizedLocalNeuralExecutionFromSection(rawConfig, parsedConfig, 'tts');
        stripSynthesizedLocalNeuralExecutionFromSection(rawConfig, parsedConfig, 'stt');
    }

    return sanitized;
}

function stripSynthesizedLocalNeuralExecutionFromSection(
    rawAdapter: Record<string, unknown>,
    parsedAdapter: Record<string, unknown>,
    sectionKey: 'tts' | 'stt',
): void {
    const rawSection =
        rawAdapter[sectionKey] && typeof rawAdapter[sectionKey] === 'object' && !Array.isArray(rawAdapter[sectionKey])
            ? (rawAdapter[sectionKey] as Record<string, unknown>)
            : null;
    const parsedSection =
        parsedAdapter[sectionKey] && typeof parsedAdapter[sectionKey] === 'object' && !Array.isArray(parsedAdapter[sectionKey])
            ? (parsedAdapter[sectionKey] as Record<string, unknown>)
            : null;
    if (!rawSection || !parsedSection) return;

    const rawLocalNeural =
        rawSection.localNeural && typeof rawSection.localNeural === 'object' && !Array.isArray(rawSection.localNeural)
            ? (rawSection.localNeural as Record<string, unknown>)
            : null;
    const parsedLocalNeural =
        parsedSection.localNeural && typeof parsedSection.localNeural === 'object' && !Array.isArray(parsedSection.localNeural)
            ? (parsedSection.localNeural as Record<string, unknown>)
            : null;
    if (!rawLocalNeural || !parsedLocalNeural) return;

    if (!Object.prototype.hasOwnProperty.call(rawLocalNeural, 'execution')) {
        delete parsedLocalNeural.execution;
    }
}

export function loadPendingSettings(): Partial<Settings> {
    const mmkv = getPersistenceStorage();
    const pending = mmkv.getString('pending-settings');
    if (pending) {
        try {
            const parsed = JSON.parse(pending);
            const validated = parsePendingSettings(parsed);
            return validated;
        } catch (e) {
            console.error('Failed to parse pending settings', e);
            return {};
        }
    }
    return {};
}

export function savePendingSettings(settings: Partial<Settings>) {
    const mmkv = getPersistenceStorage();
    // Recommended: delete key when empty to reduce churn/ambiguity.
    if (Object.keys(settings).length === 0) {
        mmkv.delete('pending-settings');
    } else {
        mmkv.set('pending-settings', JSON.stringify(settings));
    }
}

export function loadThemePreference(): 'light' | 'dark' | 'adaptive' {
    return loadThemeRuntimeLocalState().themePreference;
}

export type ThemeRuntimeLocalState = Readonly<{
    themePreference: LocalSettings['themePreference'];
    themeProfiles: ThemeProfilesLocalStateV1;
}>;

function readLocalSettingsJsonForThemeRuntime(raw: string): unknown | null {
    try {
        return JSON.parse(raw);
    } catch (e) {
        console.error('Failed to parse local settings for theme runtime', e);
        return null;
    }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function loadThemeRuntimeLocalState(): ThemeRuntimeLocalState {
    const mmkv = getPersistenceStorage();
    const localSettingsRaw = mmkv.getString('local-settings');
    if (!localSettingsRaw) {
        return {
            themePreference: localSettingsDefaults.themePreference,
            themeProfiles: localSettingsDefaults.themeProfiles,
        };
    }

    const parsed = readLocalSettingsJsonForThemeRuntime(localSettingsRaw);
    if (parsed === null) {
        return {
            themePreference: localSettingsDefaults.themePreference,
            themeProfiles: localSettingsDefaults.themeProfiles,
        };
    }

    const settings = localSettingsParse(parsed);
    const parsedProfiles = parseThemeProfilesLocalState(isRecord(parsed) ? parsed.themeProfiles : undefined);
    const migratedProfiles = migrateThemeProfileLocalStateTokenIds(parsedProfiles.state);
    const themeProfiles = migratedProfiles.state;

    if (parsedProfiles.changed || migratedProfiles.changed) {
        const healedSettings = localSettingsParse({
            ...(isRecord(parsed) ? parsed : {}),
            themeProfiles,
        });
        mmkv.set('local-settings', JSON.stringify(healedSettings));
    }

    return {
        themePreference: settings.themePreference,
        themeProfiles,
    };
}

export function loadNewSessionDraft(scope?: ServerAccountScope | null): NewSessionDraft | null {
    const mmkv = getPersistenceStorage();
    const raw = mmkv.getString(newSessionDraftKey(scope));
    if (!raw) {
        return null;
    }
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') {
            return null;
        }

        const input = typeof parsed.input === 'string' ? parsed.input : '';
        const parsedComposerAttachments = z.array(ComposerAttachmentDraftV1Schema)
            .max(MAX_COMPOSER_ATTACHMENT_INSTANCES_V1)
            .safeParse((parsed as Record<string, unknown>).composerAttachments);
        const composerAttachments = parsedComposerAttachments.success
            ? parsedComposerAttachments.data
            : undefined;
        const launchUserAttemptId = parseDraftTrimmedString((parsed as any).launchUserAttemptId);
        const selectedMachineId = typeof parsed.selectedMachineId === 'string' ? parsed.selectedMachineId : null;
        const selectedPath = typeof parsed.selectedPath === 'string' ? parsed.selectedPath : null;
        const targetServerId = parseDraftTrimmedString((parsed as any).targetServerId);
        const parsedExecutionTarget = SessionExecutionTargetV1Schema.safeParse((parsed as any).executionTarget);
        const executionTarget = parsedExecutionTarget.success
            ? parsedExecutionTarget.data
            : targetServerId && selectedMachineId
                ? SessionExecutionTargetV1Schema.parse({ serverId: targetServerId, machineId: selectedMachineId })
                : null;
        const parsedOrganizationPlacement = SessionOrganizationPlacementV1Schema.safeParse((parsed as any).organizationPlacement);
        const organizationPlacement = parsedOrganizationPlacement.success
            ? parsedOrganizationPlacement.data
            : { folderId: null, tagIds: [] };
        const parsedAgentTarget = AgentExecutionTargetV1Schema.safeParse((parsed as any).agentTarget);
        const agentTarget = parsedAgentTarget.success ? parsedAgentTarget.data : null;
        const windowsRemoteSessionLaunchModeOverride = parseWindowsRemoteSessionLaunchModeOverride(
            (parsed as any).windowsRemoteSessionLaunchModeOverride,
        );
        const entryIntent = parseDraftEntryIntent((parsed as any).entryIntent);
        const checkoutDraft = readPersistedNewSessionCheckoutDraft(parsed);
        const selectedProfileId = typeof parsed.selectedProfileId === 'string' ? parsed.selectedProfileId : null;
        const selectedSecretId = typeof parsed.selectedSecretId === 'string' ? parsed.selectedSecretId : null;
        const selectedSecretIdByProfileIdByEnvVarName = parseDraftNestedRecord(
            parsed.selectedSecretIdByProfileIdByEnvVarName,
            parseDraftStringOrNull,
        );
        const sessionOnlySecretValueEncByProfileIdByEnvVarName = parseDraftNestedRecord(
            parsed.sessionOnlySecretValueEncByProfileIdByEnvVarName,
            parseDraftSecretStringOrNull,
        );
        const backendTarget = (() => {
            try {
                if (agentTarget) {
                    return readBackendTargetRefV2(agentTarget);
                }
                if ((parsed as any).backendTarget !== undefined) {
                    return readBackendTargetRefV2((parsed as any).backendTarget);
                }
                const importedAgentIdentity = readPersistedAgentContributionIdentityV1(
                    (parsed as any).agentType,
                );
                if (importedAgentIdentity) {
                    return readBackendTargetRefV2({
                        kind: 'agent',
                        identity: importedAgentIdentity,
                    });
                }
                return undefined;
            } catch {
                return undefined;
            }
        })();
        const agentTypeCandidate = backendTarget && isBundledAgentId(backendTarget.backendId)
            ? backendTarget.backendId
            : parsed.agentType;
        const agentType: AgentId = isBundledAgentId(agentTypeCandidate) && !isLegacyCompatAgentType(agentTypeCandidate)
            ? agentTypeCandidate
            : DEFAULT_AGENT_ID;
        const permissionMode: PermissionMode = isPermissionMode(parsed.permissionMode)
            ? parsed.permissionMode
            : 'default';
        const modelSelection = (() => {
            const targetKey = resolveBackendTargetKeyV2(
                backendTarget ?? { kind: 'backend', backendId: agentType },
            );
            const rawCanonicalSelection = (parsed as any).modelSelection;
            if (rawCanonicalSelection === null) return null;
            const canonical = SessionModelSelectionV1Schema.safeParse(rawCanonicalSelection);
            if (canonical.success) {
                const canonicalSelectionTargetKey = (() => {
                    if (canonical.data.ref.agentTargetKey === targetKey) return targetKey;
                    try {
                        return resolveBackendTargetKeyV2(
                            readBackendTargetRefV2(canonical.data.ref.agentTargetKey as any),
                        );
                    } catch {
                        return canonical.data.ref.agentTargetKey;
                    }
                })();
                if (canonicalSelectionTargetKey !== targetKey) {
                    throw new SessionModelSelectionResolutionError('model_selection_agent_target_mismatch');
                }
                return {
                    ...canonical.data,
                    ref: {
                        ...canonical.data.ref,
                        agentTargetKey: targetKey,
                    },
                };
            }
            if (rawCanonicalSelection !== undefined) {
                throw new Error('Invalid persisted new-session model selection');
            }
            const legacyModelMode: ModelMode = isModelMode(parsed.modelMode)
                ? String(parsed.modelMode).trim()
                : 'default';
            if (legacyModelMode === 'default') return null;
            return SessionModelSelectionV1Schema.parse({
                v: 1,
                updatedAt: typeof parsed.updatedAt === 'number' && Number.isFinite(parsed.updatedAt)
                    ? Math.max(0, parsed.updatedAt)
                    : 0,
                ref: {
                    agentTargetKey: targetKey,
                    providerConnectionId: null,
                    modelId: legacyModelMode,
                },
            });
        })();
        const rawAcpSessionModeId = (parsed as any).acpSessionModeId;
        const acpSessionModeId = rawAcpSessionModeId === null
            ? null
            : typeof rawAcpSessionModeId === 'string'
                ? (rawAcpSessionModeId.trim() || null)
                : null;
        const parsedMcpSelection = SessionMcpSelectionV1Schema.safeParse((parsed as any).mcpSelection);
        const mcpSelection = parsedMcpSelection.success ? parsedMcpSelection.data : undefined;
        const parsedSessionConfigOptionOverrides = AcpConfigOptionOverridesV1Schema.safeParse((parsed as any).sessionConfigOptionOverrides);
        const sessionConfigOptionOverrides = parsedSessionConfigOptionOverrides.success
            ? parsedSessionConfigOptionOverrides.data
            : null;
        const transcriptStorage = (parsed as any).transcriptStorage === 'direct' ? 'direct' : (parsed as any).transcriptStorage === 'persisted' ? 'persisted' : undefined;
        const resumeSessionId = typeof parsed.resumeSessionId === 'string' ? parsed.resumeSessionId : undefined;
        const backendNewSessionOptionStateByTargetKey = parseDraftBackendNewSessionOptionStateByTargetKey(
            (parsed as any).backendNewSessionOptionStateByTargetKey
            ?? (parsed as any).agentNewSessionOptionStateByAgentId,
        );
        const legacyAuggieAllowIndexing = typeof (parsed as any).auggieAllowIndexing === 'boolean'
            ? (parsed as any).auggieAllowIndexing
            : undefined;
        const automationDraft = sanitizeNewSessionAutomationDraft((parsed as any).automationDraft);
        // Released remote-dev local `new-session-draft-v1` records stored Codex
        // selection at top level. Normalize it once at this named persistence
        // ingress; current writers carry only the Agent-owned descriptor. Remove
        // when those device-local predecessor drafts are no longer supported.
        const runtimeDescriptorV1 = parseDraftRuntimeDescriptorV1(parsed as Record<string, unknown>);
        const updatedAt = typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now();

        const migratedAgentOptions: BackendNewSessionOptionStateByTargetKey = {
            ...(backendNewSessionOptionStateByTargetKey ?? {}),
        };
        // Legacy migration: older drafts stored `auggieAllowIndexing` at top-level.
        // Keep reading it so users don't lose their local draft state.
        if (typeof legacyAuggieAllowIndexing === 'boolean') {
            const auggieTargetKey = resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'auggie' });
            migratedAgentOptions[auggieTargetKey] = {
                ...(migratedAgentOptions[auggieTargetKey] ?? {}),
                allowIndexing: legacyAuggieAllowIndexing,
            };
        }

        return {
            input,
            ...(composerAttachments !== undefined ? { composerAttachments } : {}),
            ...(launchUserAttemptId ? { launchUserAttemptId } : {}),
            selectedMachineId,
            selectedPath,
            ...(targetServerId ? { targetServerId } : {}),
            executionTarget,
            organizationPlacement,
            ...(windowsRemoteSessionLaunchModeOverride ? { windowsRemoteSessionLaunchModeOverride } : {}),
            ...(entryIntent ? { entryIntent } : {}),
            ...(checkoutDraft.checkoutCreationDraft ? { checkoutCreationDraft: checkoutDraft.checkoutCreationDraft } : {}),
            selectedProfileId,
            selectedSecretId,
            selectedSecretIdByProfileIdByEnvVarName,
            sessionOnlySecretValueEncByProfileIdByEnvVarName,
            agentType,
            ...(agentTarget ? { agentTarget } : {}),
            ...(backendTarget ? { backendTarget } : {}),
            ...(transcriptStorage ? { transcriptStorage } : {}),
            permissionMode,
            modelSelection,
            acpSessionModeId,
            ...(sessionConfigOptionOverrides ? { sessionConfigOptionOverrides } : {}),
            ...(runtimeDescriptorV1 ? { runtimeDescriptorV1 } : {}),
            ...(mcpSelection ? { mcpSelection } : {}),
            ...(resumeSessionId ? { resumeSessionId } : {}),
            ...(Object.keys(migratedAgentOptions).length > 0 ? { backendNewSessionOptionStateByTargetKey: migratedAgentOptions } : {}),
            ...(automationDraft.enabled ? { automationDraft } : {}),
            updatedAt,
        };
    } catch (e) {
        console.error('Failed to parse new session draft', e);
        return null;
    }
}

export function saveNewSessionDraft(draft: NewSessionDraft, scope?: ServerAccountScope | null) {
    const mmkv = getPersistenceStorage();
    const { modelMode: _legacyModelMode, ...canonicalDraft } = draft;
    const {
        agentType: _runtimeAgentType,
        backendTarget: _runtimeBackendTarget,
        ...persistedDraft
    } = canonicalDraft;
    const modelSelection = canonicalDraft.modelSelection && canonicalDraft.agentTarget
        ? {
            ...canonicalDraft.modelSelection,
            ref: {
                ...canonicalDraft.modelSelection.ref,
                agentTargetKey: resolveBackendTargetKeyV2(canonicalDraft.agentTarget),
            },
        }
        : canonicalDraft.modelSelection ?? null;
    mmkv.set(newSessionDraftKey(scope), JSON.stringify({
        ...persistedDraft,
        ...(canonicalDraft.agentTarget ? { agentTarget: canonicalDraft.agentTarget } : {}),
        ...(!canonicalDraft.agentTarget ? { agentType: canonicalDraft.agentType } : {}),
        modelSelection,
    }));
}

export function clearNewSessionDraft(scope?: ServerAccountScope | null) {
    const mmkv = getPersistenceStorage();
    mmkv.delete(newSessionDraftKey(scope));
}

export function loadSessionMaterializedMaxSeqById(scope?: ServerAccountScope | null): Record<string, number> {
    const mmkv = getPersistenceStorage();
    const raw = mmkv.getString(sessionMaterializedMaxSeqKey(scope));
    if (raw) {
        try {
            const parsed: unknown = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                return {};
            }

            const result: Record<string, number> = {};
            for (const [sessionId, value] of Object.entries(parsed as Record<string, unknown>)) {
                if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
                    result[sessionId] = value;
                }
            }
            return result;
        } catch (e) {
            console.error('Failed to parse session materialized max seq', e);
            return {};
        }
    }
    return {};
}

export function saveSessionMaterializedMaxSeqById(data: Record<string, number>, scope?: ServerAccountScope | null) {
    const mmkv = getPersistenceStorage();
    mmkv.set(sessionMaterializedMaxSeqKey(scope), JSON.stringify(data));
}

export function prepareSessionLocalStateScopeForActivation(scope: ServerAccountScope): void {
    const mmkv = getPersistenceStorage();
    // Drafts are recoverable user intent. Preserve the released unscoped
    // singleton long enough for the canonical repository migration to project
    // only its explicitly synchronized, non-secret fields.
    prepareSessionPersistenceScopeForActivation(scope);

    const scopedDraftValuesKey = sessionDraftValuesStorageKey(scope);
    const legacyDraftValuesKey = sessionDraftValuesStorageKey();
    if (typeof mmkv.getString(scopedDraftValuesKey) !== 'string') {
        const legacyDraftValues = mmkv.getString(legacyDraftValuesKey);
        if (typeof legacyDraftValues === 'string') mmkv.set(scopedDraftValuesKey, legacyDraftValues);
    }
    mmkv.delete(legacyDraftValuesKey);

    if (typeof mmkv.getString(newSessionDraftKey(scope)) !== 'string') {
        const legacyNewSessionDraft = loadNewSessionDraft();
        if (legacyNewSessionDraft) saveNewSessionDraft(legacyNewSessionDraft, scope);
    }

    mmkv.delete(newSessionDraftKey());
    mmkv.delete(sessionMaterializedMaxSeqKey());
}

export type SyncReliabilityEventFieldValue = string | number | boolean | null;

export type PersistedSyncReliabilityEvent = Readonly<{
    id: string;
    name: string;
    atMs: number;
    fields: Readonly<Record<string, SyncReliabilityEventFieldValue>>;
}>;

function sanitizeSyncReliabilityEventFields(value: unknown): Record<string, SyncReliabilityEventFieldValue> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return {};
    }
    const fields: Record<string, SyncReliabilityEventFieldValue> = {};
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
        const fieldKey = key.trim();
        if (!fieldKey) continue;
        if (typeof raw === 'string') {
            fields[fieldKey] = raw.slice(0, 500);
            continue;
        }
        if (typeof raw === 'number' && Number.isFinite(raw)) {
            fields[fieldKey] = raw;
            continue;
        }
        if (typeof raw === 'boolean' || raw === null) {
            fields[fieldKey] = raw;
        }
    }
    return fields;
}

function sanitizeSyncReliabilityEvent(value: unknown): PersistedSyncReliabilityEvent | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }
    const record = value as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    const name = typeof record.name === 'string' ? record.name.trim() : '';
    const atMs = typeof record.atMs === 'number' && Number.isFinite(record.atMs)
        ? Math.max(0, Math.trunc(record.atMs))
        : null;
    if (!id || !name || atMs === null) {
        return null;
    }
    return {
        id,
        name,
        atMs,
        fields: sanitizeSyncReliabilityEventFields(record.fields),
    };
}

export function loadSyncReliabilityEvents(): PersistedSyncReliabilityEvent[] {
    const mmkv = getPersistenceStorage();
    const raw = mmkv.getString(syncReliabilityEventsKey());
    if (!raw) return [];
    try {
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.flatMap((entry) => {
            const event = sanitizeSyncReliabilityEvent(entry);
            return event ? [event] : [];
        });
    } catch {
        return [];
    }
}

export function appendSyncReliabilityEvent(
    event: PersistedSyncReliabilityEvent,
    opts?: { maxEvents?: number },
): void {
    const maxEvents = typeof opts?.maxEvents === 'number' && Number.isFinite(opts.maxEvents)
        ? Math.max(1, Math.trunc(opts.maxEvents))
        : 100;
    const sanitized = sanitizeSyncReliabilityEvent(event);
    if (!sanitized) return;
    const mmkv = getPersistenceStorage();
    const next = [...loadSyncReliabilityEvents(), sanitized].slice(-maxEvents);
    mmkv.set(syncReliabilityEventsKey(), JSON.stringify(next));
}

export function clearSyncReliabilityEvents(): void {
    const mmkv = getPersistenceStorage();
    mmkv.delete(syncReliabilityEventsKey());
}

export type ChangesCursorScope =
    | string
    | Readonly<{
        accountId?: string | null;
        serverScope?: string | null;
        instanceId?: string | null;
        nowMs?: number;
    }>;

type NormalizedChangesCursorScope = Readonly<{
    accountId: string | null;
    serverScope: string | null;
    instanceId: string | null;
    nowMs: number | null;
}>;

function normalizeChangesCursorScope(scopeRaw?: ChangesCursorScope | null): NormalizedChangesCursorScope {
    if (typeof scopeRaw === 'string' || scopeRaw == null) {
        const scope = String(scopeRaw ?? '').trim();
        return {
            accountId: null,
            serverScope: scope ? scope.toLowerCase() : null,
            instanceId: null,
            nowMs: null,
        };
    }

    const accountId = String(scopeRaw.accountId ?? '').trim();
    const serverScope = String(scopeRaw.serverScope ?? '').trim();
    const instanceId = String(scopeRaw.instanceId ?? '').trim();
    const nowMs = typeof scopeRaw.nowMs === 'number' && Number.isFinite(scopeRaw.nowMs)
        ? Math.max(0, Math.trunc(scopeRaw.nowMs))
        : null;

    return {
        accountId: accountId || null,
        serverScope: serverScope ? serverScope.toLowerCase() : null,
        instanceId: instanceId || null,
        nowMs,
    };
}

function encodeChangesCursorKeyPart(value: string): string {
    return encodeURIComponent(value);
}

function scopedChangesCursorKey(accountId: string, scope: string): string {
    return `${changesCursorByServerScopeAndAccountIdPrefix()}${encodeChangesCursorKeyPart(scope)}:${encodeChangesCursorKeyPart(accountId)}`;
}

function instanceScopedChangesCursorKey(accountId: string, scope: string, instanceId: string): string {
    return `${changesCursorByServerScopeAccountIdAndInstancePrefix()}${encodeChangesCursorKeyPart(scope)}:${encodeChangesCursorKeyPart(accountId)}:${encodeChangesCursorKeyPart(instanceId)}`;
}

function unscopedChangesCursorKey(accountId: string): string {
    return `${changesCursorByAccountIdPrefix()}${encodeChangesCursorKeyPart(accountId)}`;
}

function externalSessionTailCursorKey(accountId: string, sessionId: string, scope: string, instanceId: string | null): string {
    const instancePart = instanceId ? `:${encodeChangesCursorKeyPart(instanceId)}` : ':no-instance';
    return `${externalSessionTailCursorPrefix()}${encodeChangesCursorKeyPart(scope)}:${encodeChangesCursorKeyPart(accountId)}:${encodeChangesCursorKeyPart(sessionId)}${instancePart}`;
}

function parseInstanceChangesCursorRecord(raw: string | undefined | null): string | null {
    if (typeof raw !== 'string' || raw.length === 0) return null;
    try {
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return null;
        }
        const cursor = (parsed as { cursor?: unknown }).cursor;
        return typeof cursor === 'string' && cursor.trim().length > 0 ? cursor.trim() : null;
    } catch {
        return raw;
    }
}

function parseInstanceChangesCursorLastWriteMs(raw: string | undefined | null): number | null {
    if (typeof raw !== 'string' || raw.length === 0) return null;
    try {
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return null;
        }
        const lastWriteMs = (parsed as { lastWriteMs?: unknown }).lastWriteMs;
        return typeof lastWriteMs === 'number' && Number.isFinite(lastWriteMs) && lastWriteMs >= 0
            ? Math.trunc(lastWriteMs)
            : null;
    } catch {
        return null;
    }
}

export function loadChangesCursor(scopeRaw?: ChangesCursorScope | null): string | null {
    const mmkv = getPersistenceStorage();
    const scope = normalizeChangesCursorScope(scopeRaw);
    const accountId = scope.accountId;
    if (!accountId) return null;

    if (scope.serverScope) {
        if (scope.instanceId) {
            const instanceScoped = parseInstanceChangesCursorRecord(
                mmkv.getString(instanceScopedChangesCursorKey(accountId, scope.serverScope, scope.instanceId)),
            );
            if (instanceScoped) {
                return instanceScoped;
            }
        }

        const scoped = mmkv.getString(scopedChangesCursorKey(accountId, scope.serverScope));
        if (typeof scoped === 'string' && scoped.length > 0) {
            return scoped;
        }
        // Scope-aware callers intentionally do not fall back to the legacy unscoped key,
        // which could carry a cursor from a different server.
        return null;
    }

    const unscoped = mmkv.getString(unscopedChangesCursorKey(accountId));
    if (typeof unscoped === 'string' && unscoped.length > 0) {
        return unscoped;
    }

    // Legacy fallback: salvage from the old per-account numeric map.
    const legacy = loadLastChangesCursorByAccountId()[accountId];
    if (typeof legacy === 'number' && Number.isFinite(legacy) && legacy >= 0) {
        return String(Math.floor(legacy));
    }

    return null;
}

export function pruneStaleInstanceChangesCursors(params: {
    nowMs: number;
    retentionMs: number;
    maxKeys?: number;
}): number {
    const mmkv = getPersistenceStorage();
    const getAllKeys = (mmkv as unknown as { getAllKeys?: () => string[] }).getAllKeys;
    if (typeof getAllKeys !== 'function') return 0;

    const nowMs = typeof params.nowMs === 'number' && Number.isFinite(params.nowMs)
        ? Math.max(0, Math.trunc(params.nowMs))
        : Date.now();
    const retentionMs = typeof params.retentionMs === 'number' && Number.isFinite(params.retentionMs)
        ? Math.max(0, Math.trunc(params.retentionMs))
        : 7 * 24 * 60 * 60 * 1000;
    const maxKeys = typeof params.maxKeys === 'number' && Number.isFinite(params.maxKeys)
        ? Math.max(1, Math.trunc(params.maxKeys))
        : 500;
    const cutoffMs = nowMs - retentionMs;
    let pruned = 0;

    for (const key of getAllKeys.call(mmkv).slice(0, maxKeys)) {
        if (!key.startsWith(changesCursorByServerScopeAccountIdAndInstancePrefix())) continue;
        const lastWriteMs = parseInstanceChangesCursorLastWriteMs(mmkv.getString(key));
        if (lastWriteMs === null || lastWriteMs >= cutoffMs) continue;
        mmkv.delete(key);
        pruned += 1;
    }

    return pruned;
}

export function saveChangesCursor(cursor: string, scopeRaw?: ChangesCursorScope | null): void {
    const mmkv = getPersistenceStorage();
    const scope = normalizeChangesCursorScope(scopeRaw);
    const accountId = scope.accountId;
    if (!accountId) return;

    const key = scope.serverScope && scope.instanceId
        ? instanceScopedChangesCursorKey(accountId, scope.serverScope, scope.instanceId)
        : scope.serverScope
            ? scopedChangesCursorKey(accountId, scope.serverScope)
            : unscopedChangesCursorKey(accountId);
    const trimmed = typeof cursor === 'string' ? cursor.trim() : '';
    if (!trimmed) {
        mmkv.delete(key);
        if (!scope.serverScope && !scope.instanceId) {
            const legacy = loadLastChangesCursorByAccountId();
            if (Object.prototype.hasOwnProperty.call(legacy, accountId)) {
                delete legacy[accountId];
                saveLastChangesCursorByAccountId(legacy);
            }
        }
        return;
    }

    // Store cursor as-is to support future BigInt/string cursors.
    if (scope.serverScope && scope.instanceId) {
        mmkv.set(key, JSON.stringify({ cursor: trimmed, lastWriteMs: scope.nowMs ?? Date.now() }));
    } else {
        mmkv.set(key, trimmed);
    }

    // Best-effort: keep legacy numeric map in sync for older code paths.
    if (!scope.serverScope && !scope.instanceId) {
        const asNumber = Number(trimmed);
        if (Number.isFinite(asNumber) && asNumber >= 0) {
            const legacy = loadLastChangesCursorByAccountId();
            legacy[accountId] = Math.floor(asNumber);
            saveLastChangesCursorByAccountId(legacy);
        }
    }
}

export function loadExternalSessionTailCursor(sessionIdRaw: string, scopeRaw?: ChangesCursorScope | null): string | null {
    const mmkv = getPersistenceStorage();
    const scope = normalizeChangesCursorScope(scopeRaw);
    const accountId = scope.accountId;
    const sessionId = String(sessionIdRaw ?? '').trim();
    if (!accountId || !sessionId) return null;

    if (!scope.serverScope) return null;

    const key = externalSessionTailCursorKey(accountId, sessionId, scope.serverScope, scope.instanceId);
    const parsed = ExternalSessionRefreshCursorV1Schema.safeParse(mmkv.getString(key));
    if (!parsed.success) {
        mmkv.delete(key);
        return null;
    }
    return parsed.data;
}

export function saveExternalSessionTailCursor(
    sessionIdRaw: string,
    cursorRaw: string | null | undefined,
    scopeRaw?: ChangesCursorScope | null,
): void {
    const mmkv = getPersistenceStorage();
    const scope = normalizeChangesCursorScope(scopeRaw);
    const accountId = scope.accountId;
    const sessionId = String(sessionIdRaw ?? '').trim();
    if (!accountId || !sessionId) return;

    if (!scope.serverScope) return;

    const key = externalSessionTailCursorKey(accountId, sessionId, scope.serverScope, scope.instanceId);
    const cursor = ExternalSessionRefreshCursorV1Schema.safeParse(cursorRaw);
    if (!cursor.success) {
        mmkv.delete(key);
        return;
    }
    mmkv.set(key, cursor.data);
}

export function loadLastChangesCursorByAccountId(): Record<string, number> {
    const mmkv = getPersistenceStorage();
    const raw = mmkv.getString(lastChangesCursorByAccountIdKey());
    if (raw) {
        try {
            const parsed: unknown = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                return {};
            }

            const result: Record<string, number> = {};
            for (const [accountId, value] of Object.entries(parsed as Record<string, unknown>)) {
                if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
                    result[accountId] = value;
                }
            }
            return result;
        } catch (e) {
            console.error('Failed to parse last changes cursor', e);
            return {};
        }
    }
    return {};
}

export function saveLastChangesCursorByAccountId(data: Record<string, number>) {
    const mmkv = getPersistenceStorage();
    mmkv.set(lastChangesCursorByAccountIdKey(), JSON.stringify(data));
}
