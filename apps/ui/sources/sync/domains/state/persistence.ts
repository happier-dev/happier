import { z } from 'zod';
import type { Settings } from '../settings/settings';
import { voiceSettingsParse } from '../settings/voiceSettings';
import { LocalSettings, localSettingsDefaults, localSettingsParse } from '../settings/localSettings';
import { Purchases, purchasesDefaults, purchasesParse } from '../purchases/purchases';
import { ACCOUNT_SETTING_ARTIFACTS } from '../settings/registry/account/accountSettingArtifacts';
import { isModelMode, isPermissionMode, type PermissionMode, type ModelMode } from '@/sync/domains/permissions/permissionTypes';
import { DEFAULT_AGENT_ID, isAgentId, type AgentId } from '@/agents/registry/registryCore';
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
import { PROVIDER_SETTINGS_SHAPE } from '@/agents/providers/registry/providerSettingArtifacts';
import {
    normalizeBackendNewSessionOptionStateByTargetKey,
    type BackendNewSessionOptionStateByTargetKey,
} from '@/utils/sessions/backendNewSessionOptionState';
import {
    AcpConfigOptionOverridesV1Schema,
    SessionMcpSelectionV1Schema,
    readBackendTargetRefV2,
    normalizeCodexBackendMode,
    type CodexBackendMode,
    type AcpConfigOptionOverridesV1,
    type BackendTargetRefV2,
    type SessionMcpSelectionV1,
} from '@happier-dev/protocol';
import { getPersistenceStorage } from './persistenceStorage';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
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

const pendingSettingsSchemaByKey: Readonly<Record<string, z.ZodTypeAny>> = Object.freeze({
    ...ACCOUNT_SETTING_ARTIFACTS.shape,
    ...PROVIDER_SETTINGS_SHAPE,
});

function deviceAnalyticsIdKey(): string {
    return 'device-analytics-id-v1';
}

function newSessionDraftKey(): string {
    return 'new-session-draft-v1';
}

function sessionMaterializedMaxSeqKey(): string {
    return 'session-materialized-max-seq-v1';
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

function sessionModelModeUpdatedAtsKey(): string {
    return 'session-model-mode-updated-ats-v1';
}

export interface NewSessionDraft {
    input: string;
    selectedMachineId: string | null;
    selectedPath: string | null;
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
    backendTarget?: BackendTargetRefV2 | null;
    transcriptStorage?: 'persisted' | 'direct';
    permissionMode: PermissionMode;
    modelMode: ModelMode;
    /**
     * ACP-only session mode selection (e.g. "plan") for the new-session wizard.
     * UI-only draft state (not sent to server unless supported by the selected agent).
     */
    acpSessionModeId: string | null;
    sessionConfigOptionOverrides?: AcpConfigOptionOverridesV1 | null;
    codexBackendMode?: CodexBackendMode | null;
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

function parseDraftSecretStringOrNull(value: unknown): SecretString | null | undefined {
    if (value === null) return null;
    const parsed = SecretStringSchema.safeParse(value);
    if (parsed.success) return parsed.data;
    return undefined;
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

            // Only salvage JSON-safe primitives; objects can be added later if needed.
            if (rawValue === null || typeof rawValue === 'boolean' || typeof rawValue === 'number' || typeof rawValue === 'string') {
                options[key] = rawValue;
            }
        }

        if (Object.keys(options).length > 0) out[targetKey] = options;
    }

    return normalizeBackendNewSessionOptionStateByTargetKey(out);
}

function parseDraftCodexBackendMode(value: unknown): CodexBackendMode | null {
    return normalizeCodexBackendMode(value);
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

function parsePendingSettings(raw: unknown): Partial<Settings> {
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
    const rawAdapters =
        rawVoice.adapters && typeof rawVoice.adapters === 'object' && !Array.isArray(rawVoice.adapters)
            ? (rawVoice.adapters as Record<string, unknown>)
            : null;
    const parsedAdapters =
        sanitized.adapters && typeof sanitized.adapters === 'object' && !Array.isArray(sanitized.adapters)
            ? (sanitized.adapters as Record<string, unknown>)
            : null;

    if (!rawAdapters || !parsedAdapters) {
        return sanitized;
    }

    for (const adapterId of ['local_direct', 'local_conversation']) {
        const rawAdapter =
            rawAdapters[adapterId] && typeof rawAdapters[adapterId] === 'object' && !Array.isArray(rawAdapters[adapterId])
                ? (rawAdapters[adapterId] as Record<string, unknown>)
                : null;
        const parsedAdapter =
            parsedAdapters[adapterId] && typeof parsedAdapters[adapterId] === 'object' && !Array.isArray(parsedAdapters[adapterId])
                ? (parsedAdapters[adapterId] as Record<string, unknown>)
                : null;
        if (!rawAdapter || !parsedAdapter) continue;
        stripSynthesizedLocalNeuralExecutionFromSection(rawAdapter, parsedAdapter, 'tts');
        stripSynthesizedLocalNeuralExecutionFromSection(rawAdapter, parsedAdapter, 'stt');
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
    const mmkv = getPersistenceStorage();
    const localSettings = mmkv.getString('local-settings');
    if (localSettings) {
        try {
            const parsed = JSON.parse(localSettings);
            const settings = localSettingsParse(parsed);
            return settings.themePreference;
        } catch (e) {
            console.error('Failed to parse local settings for theme preference', e);
            return localSettingsDefaults.themePreference;
        }
    }
    return localSettingsDefaults.themePreference;
}

export function loadNewSessionDraft(): NewSessionDraft | null {
    const mmkv = getPersistenceStorage();
    const raw = mmkv.getString(newSessionDraftKey());
    if (!raw) {
        return null;
    }
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') {
            return null;
        }

        const input = typeof parsed.input === 'string' ? parsed.input : '';
        const selectedMachineId = typeof parsed.selectedMachineId === 'string' ? parsed.selectedMachineId : null;
        const selectedPath = typeof parsed.selectedPath === 'string' ? parsed.selectedPath : null;
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
        const agentType: AgentId = isAgentId(parsed.agentType) && !isLegacyCompatAgentType(parsed.agentType)
            ? parsed.agentType
            : DEFAULT_AGENT_ID;
        const backendTarget = (() => {
            try {
                return readBackendTargetRefV2((parsed as any).backendTarget);
            } catch {
                return undefined;
            }
        })();
        const permissionMode: PermissionMode = isPermissionMode(parsed.permissionMode)
            ? parsed.permissionMode
            : 'default';
        const modelMode: ModelMode = isModelMode(parsed.modelMode)
            ? String(parsed.modelMode).trim()
            : 'default';
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
        const codexBackendMode = parseDraftCodexBackendMode((parsed as any).codexBackendMode);
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
            selectedMachineId,
            selectedPath,
            ...(entryIntent ? { entryIntent } : {}),
            ...(checkoutDraft.checkoutCreationDraft ? { checkoutCreationDraft: checkoutDraft.checkoutCreationDraft } : {}),
            selectedProfileId,
            selectedSecretId,
            selectedSecretIdByProfileIdByEnvVarName,
            sessionOnlySecretValueEncByProfileIdByEnvVarName,
            agentType,
            ...(backendTarget ? { backendTarget } : {}),
            ...(transcriptStorage ? { transcriptStorage } : {}),
            permissionMode,
            modelMode,
            acpSessionModeId,
            ...(sessionConfigOptionOverrides ? { sessionConfigOptionOverrides } : {}),
            ...(codexBackendMode ? { codexBackendMode } : {}),
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

export function saveNewSessionDraft(draft: NewSessionDraft) {
    const mmkv = getPersistenceStorage();
    mmkv.set(newSessionDraftKey(), JSON.stringify(draft));
}

export function clearNewSessionDraft() {
    const mmkv = getPersistenceStorage();
    mmkv.delete(newSessionDraftKey());
}

export function loadSessionMaterializedMaxSeqById(): Record<string, number> {
    const mmkv = getPersistenceStorage();
    const raw = mmkv.getString(sessionMaterializedMaxSeqKey());
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

export function saveSessionMaterializedMaxSeqById(data: Record<string, number>) {
    const mmkv = getPersistenceStorage();
    mmkv.set(sessionMaterializedMaxSeqKey(), JSON.stringify(data));
}

function normalizeChangesCursorScope(scopeRaw?: string | null): string | null {
    const scope = String(scopeRaw ?? '').trim();
    if (!scope) return null;
    return scope.toLowerCase();
}

function scopedChangesCursorKey(accountId: string, scope: string): string {
    return `${changesCursorByServerScopeAndAccountIdPrefix()}${scope}:${accountId}`;
}

function unscopedChangesCursorKey(accountId: string): string {
    return `${changesCursorByAccountIdPrefix()}${accountId}`;
}

export function loadChangesCursor(scopeRaw?: string | null): string | null {
    const mmkv = getPersistenceStorage();
    const accountId = readPersistedProfileId(mmkv);
    if (!accountId) return null;

    const scope = normalizeChangesCursorScope(scopeRaw);
    if (scope) {
        const scoped = mmkv.getString(scopedChangesCursorKey(accountId, scope));
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

export function saveChangesCursor(cursor: string, scopeRaw?: string | null): void {
    const mmkv = getPersistenceStorage();
    const accountId = readPersistedProfileId(mmkv);
    if (!accountId) return;

    const scope = normalizeChangesCursorScope(scopeRaw);
    const key = scope ? scopedChangesCursorKey(accountId, scope) : unscopedChangesCursorKey(accountId);
    const trimmed = typeof cursor === 'string' ? cursor.trim() : '';
    if (!trimmed) {
        mmkv.delete(key);
        if (!scope) {
            const legacy = loadLastChangesCursorByAccountId();
            if (Object.prototype.hasOwnProperty.call(legacy, accountId)) {
                delete legacy[accountId];
                saveLastChangesCursorByAccountId(legacy);
            }
        }
        return;
    }

    // Store cursor as-is to support future BigInt/string cursors.
    mmkv.set(key, trimmed);

    // Best-effort: keep legacy numeric map in sync for older code paths.
    if (!scope) {
        const asNumber = Number(trimmed);
        if (Number.isFinite(asNumber) && asNumber >= 0) {
            const legacy = loadLastChangesCursorByAccountId();
            legacy[accountId] = Math.floor(asNumber);
            saveLastChangesCursorByAccountId(legacy);
        }
    }
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

type PersistenceStringReader = Readonly<{
    getString: (key: string) => string | undefined | null;
}>;

function readPersistedProfileId(mmkv: PersistenceStringReader): string | null {
    const rawProfile = mmkv.getString('profile');
    if (!rawProfile) return null;

    try {
        const parsed = JSON.parse(rawProfile) as { id?: unknown } | null;
        return typeof parsed?.id === 'string' && parsed.id.trim().length > 0 ? parsed.id : null;
    } catch {
        return null;
    }
}
