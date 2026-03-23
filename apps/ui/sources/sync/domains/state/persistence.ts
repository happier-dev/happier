import { MMKV } from 'react-native-mmkv';
import { z } from 'zod';
import { Settings, settingsDefaults, settingsParse, SettingsSchema } from '../settings/settings';
import { voiceSettingsParse } from '../settings/voiceSettings';
import { LocalSettings, localSettingsDefaults, localSettingsParse } from '../settings/localSettings';
import { Purchases, purchasesDefaults, purchasesParse } from '../purchases/purchases';
import { Profile, profileDefaults, profileParse } from '../profiles/profile';
import { isModelMode, isPermissionMode, type PermissionMode, type ModelMode } from '@/sync/domains/permissions/permissionTypes';
import { DEFAULT_AGENT_ID, isAgentId, type AgentId } from '@/agents/catalog/catalog';
import { SecretStringSchema, type SecretString } from '../../encryption/secretSettings';
import type { CodexBackendMode } from '@happier-dev/agents';
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
    AcpConfigOptionOverridesV1Schema,
    BackendTargetRefSchema,
    SessionMcpSelectionV1Schema,
    type AcpConfigOptionOverridesV1,
    type BackendTargetRefV1,
    type SessionMcpSelectionV1,
} from '@happier-dev/protocol';
var persistedStorage: MMKV | null = null;

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

function sessionReviewCommentsDraftsKey(): string {
    return 'session-review-comments-draft-v1';
}

function sessionActionDraftsKey(): string {
    return 'session-action-drafts-v1';
}

function isWebRuntime(): boolean {
    return typeof window !== 'undefined' && typeof document !== 'undefined';
}

function normalizeStorageScope(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;

    const sanitized = trimmed.replace(/[^a-zA-Z0-9._-]/g, '_');
    const collapsed = sanitized.replace(/_+/g, '_');
    const clamped = collapsed.slice(0, 64);
    return clamped || null;
}

function readScopedStorageScopeFromEnv(): string | null {
    return normalizeStorageScope(process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE);
}

function buildScopedStorageId(baseId: string, scope: string | null): string {
    return scope ? `${baseId}__${scope}` : baseId;
}

function getPersistenceStorage(): MMKV {
    if (persistedStorage) return persistedStorage;
    // Keep storage-scope bootstrap local here to avoid import-cycle TDZ hazards during Sync initialization.
    const storageScope = isWebRuntime() ? null : readScopedStorageScopeFromEnv();
    persistedStorage = storageScope ? new MMKV({ id: buildScopedStorageId('default', storageScope) }) : new MMKV();
    return persistedStorage;
}

export type NewSessionAgentType = AgentId;

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
    agentType: NewSessionAgentType;
    backendTarget?: BackendTargetRefV1 | null;
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
     * Provider-specific new-session option state keyed by agent id.
     * This is UI-only draft state (not sent to server).
     */
    agentNewSessionOptionStateByAgentId?: Record<string, Record<string, unknown>> | null;
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

function parseDraftAgentNewSessionOptionStateByAgentId(
    input: unknown,
): Record<string, Record<string, unknown>> | null {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    const out: Record<string, Record<string, unknown>> = {};

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

    return Object.keys(out).length > 0 ? out : null;
}

function parseDraftCodexBackendMode(value: unknown): CodexBackendMode | null {
    return value === 'mcp' || value === 'acp' || value === 'appServer' ? value : null;
}

function parseDraftEntryIntent(value: unknown): NewSessionDraft['entryIntent'] {
    return value === 'automation' || value === 'session' ? value : null;
}

export function loadSettings(): { settings: Settings, version: number | null } {
    const mmkv = getPersistenceStorage();
    const settings = mmkv.getString('settings');
    if (settings) {
        try {
            const parsed = JSON.parse(settings);
            const version = typeof parsed.version === 'number' ? parsed.version : null;
            return { settings: settingsParse(parsed.settings), version };
        } catch (e) {
            console.error('Failed to parse settings', e);
            return { settings: { ...settingsDefaults }, version: null };
        }
    }
    return { settings: { ...settingsDefaults }, version: null };
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

export function saveSettings(settings: Settings, version: number) {
    const mmkv = getPersistenceStorage();
    mmkv.set('settings', JSON.stringify({ settings, version }));
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

    (Object.keys(SettingsSchema.shape) as Array<Extract<keyof typeof SettingsSchema.shape, string>>).forEach((key) => {
        if (!Object.prototype.hasOwnProperty.call(input, key)) return;

        // Voice is parsed with a tolerant parser in settingsParse to avoid dropping the entire object
        // due to a single invalid nested field. Pending settings must follow the same rule so we do
        // not lose unsynced voice deltas (e.g. BYO API keys) on restart.
        if (key === 'voice') {
            (out as any).voice = voiceSettingsParse(input[key]);
            return;
        }

        const schema = SettingsSchema.shape[key] as z.ZodTypeAny;
        const parsed = schema.safeParse(input[key]);
        if (parsed.success) {
            (out as any)[key] = parsed.data;
        }
    });

    return out;
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

export function loadLocalSettings(): LocalSettings {
    const mmkv = getPersistenceStorage();
    const localSettings = mmkv.getString('local-settings');
    if (localSettings) {
        try {
            const parsed = JSON.parse(localSettings);
            return localSettingsParse(parsed);
        } catch (e) {
            console.error('Failed to parse local settings', e);
            return { ...localSettingsDefaults };
        }
    }
    return { ...localSettingsDefaults };
}

export function saveLocalSettings(settings: LocalSettings) {
    const mmkv = getPersistenceStorage();
    mmkv.set('local-settings', JSON.stringify(settings));
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

export function loadPurchases(): Purchases {
    const mmkv = getPersistenceStorage();
    const purchases = mmkv.getString('purchases');
    if (purchases) {
        try {
            const parsed = JSON.parse(purchases);
            return purchasesParse(parsed);
        } catch (e) {
            console.error('Failed to parse purchases', e);
            return { ...purchasesDefaults };
        }
    }
    return { ...purchasesDefaults };
}

export function savePurchases(purchases: Purchases) {
    const mmkv = getPersistenceStorage();
    mmkv.set('purchases', JSON.stringify(purchases));
}

export function loadSessionDrafts(): Record<string, string> {
    const mmkv = getPersistenceStorage();
    const drafts = mmkv.getString('session-drafts');
    if (drafts) {
        try {
            return JSON.parse(drafts);
        } catch (e) {
            console.error('Failed to parse session drafts', e);
            return {};
        }
    }
    return {};
}

export function saveSessionDrafts(drafts: Record<string, string>) {
    const mmkv = getPersistenceStorage();
    mmkv.set('session-drafts', JSON.stringify(drafts));
}

export type SessionReviewCommentDraftsBySessionId = Record<string, z.infer<typeof ReviewCommentDraftSchema>[]>;

export function loadSessionReviewCommentsDrafts(): SessionReviewCommentDraftsBySessionId {
    const mmkv = getPersistenceStorage();
    const raw = mmkv.getString(sessionReviewCommentsDraftsKey());
    if (!raw) return {};
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

        const out: SessionReviewCommentDraftsBySessionId = {};
        for (const [rawSessionId, rawDrafts] of Object.entries(parsed as Record<string, unknown>)) {
            if (typeof rawSessionId !== 'string' || !rawSessionId.trim()) continue;
            if (!Array.isArray(rawDrafts)) continue;

            const drafts: z.infer<typeof ReviewCommentDraftSchema>[] = [];
            for (const entry of rawDrafts) {
                const entryParsed = ReviewCommentDraftSchema.safeParse(entry);
                if (entryParsed.success) drafts.push(entryParsed.data);
            }
            if (drafts.length > 0) out[rawSessionId] = drafts;
        }
        return out;
    } catch (e) {
        console.error('Failed to parse session review comment drafts', e);
        return {};
    }
}

export function saveSessionReviewCommentsDrafts(drafts: SessionReviewCommentDraftsBySessionId): void {
    const mmkv = getPersistenceStorage();
    if (!drafts || typeof drafts !== 'object' || Object.keys(drafts).length === 0) {
        mmkv.delete(sessionReviewCommentsDraftsKey());
        return;
    }
    mmkv.set(sessionReviewCommentsDraftsKey(), JSON.stringify(drafts));
}

export type SessionActionDraftsBySessionId = Record<string, z.infer<typeof SessionActionDraftSchema>[]>;

export function loadSessionActionDrafts(): SessionActionDraftsBySessionId {
    const mmkv = getPersistenceStorage();
    const raw = mmkv.getString(sessionActionDraftsKey());
    if (!raw) return {};
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

        const out: SessionActionDraftsBySessionId = {};
        for (const [rawSessionId, rawDrafts] of Object.entries(parsed as Record<string, unknown>)) {
            if (typeof rawSessionId !== 'string' || !rawSessionId.trim()) continue;
            if (!Array.isArray(rawDrafts)) continue;

            const drafts: z.infer<typeof SessionActionDraftSchema>[] = [];
            for (const entry of rawDrafts) {
                const entryParsed = SessionActionDraftSchema.safeParse(entry);
                if (entryParsed.success) drafts.push(entryParsed.data);
            }
            if (drafts.length > 0) out[rawSessionId] = drafts;
        }
        return out;
    } catch (e) {
        console.error('Failed to parse session action drafts', e);
        return {};
    }
}

export function saveSessionActionDrafts(drafts: SessionActionDraftsBySessionId): void {
    const mmkv = getPersistenceStorage();
    if (!drafts || typeof drafts !== 'object' || Object.keys(drafts).length === 0) {
        mmkv.delete(sessionActionDraftsKey());
        return;
    }
    mmkv.set(sessionActionDraftsKey(), JSON.stringify(drafts));
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
        const agentType: NewSessionAgentType = isAgentId(parsed.agentType) ? parsed.agentType : DEFAULT_AGENT_ID;
        const parsedBackendTarget = BackendTargetRefSchema.safeParse((parsed as any).backendTarget);
        const backendTarget = parsedBackendTarget.success ? parsedBackendTarget.data : undefined;
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
        const agentNewSessionOptionStateByAgentId = parseDraftAgentNewSessionOptionStateByAgentId(
            (parsed as any).agentNewSessionOptionStateByAgentId,
        );
        const legacyAuggieAllowIndexing = typeof (parsed as any).auggieAllowIndexing === 'boolean'
            ? (parsed as any).auggieAllowIndexing
            : undefined;
        const automationDraft = sanitizeNewSessionAutomationDraft((parsed as any).automationDraft);
        const codexBackendMode = parseDraftCodexBackendMode((parsed as any).codexBackendMode);
        const updatedAt = typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now();

        const migratedAgentOptions: Record<string, Record<string, unknown>> = {
            ...(agentNewSessionOptionStateByAgentId ?? {}),
        };
        // Legacy migration: older drafts stored `auggieAllowIndexing` at top-level.
        // Keep reading it so users don't lose their local draft state.
        if (typeof legacyAuggieAllowIndexing === 'boolean') {
            migratedAgentOptions.auggie = {
                ...(migratedAgentOptions.auggie ?? {}),
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
            ...(Object.keys(migratedAgentOptions).length > 0 ? { agentNewSessionOptionStateByAgentId: migratedAgentOptions } : {}),
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

export function loadSessionPermissionModes(): Record<string, PermissionMode> {
    const mmkv = getPersistenceStorage();
    const modes = mmkv.getString('session-permission-modes');
    if (modes) {
        try {
            return JSON.parse(modes);
        } catch (e) {
            console.error('Failed to parse session permission modes', e);
            return {};
        }
    }
    return {};
}

export function saveSessionPermissionModes(modes: Record<string, PermissionMode>) {
    const mmkv = getPersistenceStorage();
    mmkv.set('session-permission-modes', JSON.stringify(modes));
}

export function loadSessionPermissionModeUpdatedAts(): Record<string, number> {
    const mmkv = getPersistenceStorage();
    const raw = mmkv.getString('session-permission-mode-updated-ats');
    if (raw) {
        try {
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                return {};
            }

            const result: Record<string, number> = {};
            for (const [sessionId, value] of Object.entries(parsed as Record<string, unknown>)) {
                if (typeof value === 'number' && Number.isFinite(value)) {
                    result[sessionId] = value;
                }
            }
            return result;
        } catch (e) {
            console.error('Failed to parse session permission mode updated timestamps', e);
            return {};
        }
    }
    return {};
}

export function saveSessionPermissionModeUpdatedAts(updatedAts: Record<string, number>) {
    const mmkv = getPersistenceStorage();
    mmkv.set('session-permission-mode-updated-ats', JSON.stringify(updatedAts));
}

export function loadSessionLastViewed(): Record<string, number> {
    const mmkv = getPersistenceStorage();
    const raw = mmkv.getString('session-last-viewed');
    if (raw) {
        try {
            const parsed: unknown = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                return {};
            }

            const result: Record<string, number> = {};
            for (const [sessionId, value] of Object.entries(parsed as Record<string, unknown>)) {
                if (typeof value === 'number' && Number.isFinite(value)) {
                    result[sessionId] = value;
                }
            }
            return result;
        } catch (e) {
            console.error('Failed to parse session last viewed timestamps', e);
            return {};
        }
    }
    return {};
}

export function saveSessionLastViewed(data: Record<string, number>) {
    const mmkv = getPersistenceStorage();
    mmkv.set('session-last-viewed', JSON.stringify(data));
}

export function loadSessionModelModes(): Record<string, ModelMode> {
    const mmkv = getPersistenceStorage();
    const modes = mmkv.getString('session-model-modes');
    if (modes) {
        try {
            const parsed: unknown = JSON.parse(modes);
            if (!parsed || typeof parsed !== 'object') {
                return {};
            }

            const result: Record<string, ModelMode> = {};
            Object.entries(parsed as Record<string, unknown>).forEach(([sessionId, mode]) => {
                if (!isModelMode(mode)) return;
                const normalized = String(mode).trim();
                if (!normalized) return;
                result[sessionId] = normalized;
            });
            return result;
        } catch (e) {
            console.error('Failed to parse session model modes', e);
            return {};
        }
    }
    return {};
}

export function saveSessionModelModes(modes: Record<string, ModelMode>) {
    const mmkv = getPersistenceStorage();
    mmkv.set('session-model-modes', JSON.stringify(modes));
}

export function loadSessionModelModeUpdatedAts(): Record<string, number> {
    const mmkv = getPersistenceStorage();
    const raw = mmkv.getString(sessionModelModeUpdatedAtsKey());
    if (raw) {
        try {
            const parsed: unknown = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                return {};
            }

            const result: Record<string, number> = {};
            for (const [sessionId, value] of Object.entries(parsed as Record<string, unknown>)) {
                if (typeof value === 'number' && Number.isFinite(value)) {
                    result[sessionId] = value;
                }
            }
            return result;
        } catch (e) {
            console.error('Failed to parse session model mode updatedAts', e);
            return {};
        }
    }
    return {};
}

export function saveSessionModelModeUpdatedAts(data: Record<string, number>) {
    const mmkv = getPersistenceStorage();
    mmkv.set(sessionModelModeUpdatedAtsKey(), JSON.stringify(data));
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

function readPersistedProfileId(mmkv: MMKV): string | null {
    const rawProfile = mmkv.getString('profile');
    if (!rawProfile) return null;

    try {
        const parsed = JSON.parse(rawProfile) as { id?: unknown } | null;
        return typeof parsed?.id === 'string' && parsed.id.trim().length > 0 ? parsed.id : null;
    } catch {
        return null;
    }
}

export function loadProfile(): Profile {
    const mmkv = getPersistenceStorage();
    const profile = mmkv.getString('profile');
    if (profile) {
        try {
            const parsed = JSON.parse(profile);
            return profileParse(parsed);
        } catch (e) {
            console.error('Failed to parse profile', e);
            return { ...profileDefaults };
        }
    }
    return { ...profileDefaults };
}

export function saveProfile(profile: Profile) {
    const mmkv = getPersistenceStorage();
    mmkv.set('profile', JSON.stringify(profile));
}

export function clearPersistence() {
    const mmkv = getPersistenceStorage();
    mmkv.clearAll();
}
