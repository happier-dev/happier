import { MMKV } from 'react-native-mmkv';
import { z } from 'zod';
import { ACCOUNT_SETTING_ARTIFACTS } from '../settings/settings';
import type { Settings } from '../settings/settings';
import { voiceSettingsParse } from '../settings/voiceSettings';
import { LocalSettings, localSettingsDefaults, localSettingsParse } from '../settings/localSettings';
import { Purchases, purchasesDefaults, purchasesParse } from '../purchases/purchases';
import { Profile, profileDefaults, profileParse } from '../profiles/profile';
import { isModelMode, isPermissionMode, type PermissionMode, type ModelMode } from '@/sync/domains/permissions/permissionTypes';
import { DEFAULT_AGENT_ID, isAgentId, type AgentId } from '@/agents/registry/registryCore';
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
    AcpConfigOptionOverridesV1Schema,
    BackendTargetRefSchema,
    SessionMcpSelectionV1Schema,
    normalizeCodexBackendMode,
    type CodexBackendMode,
    type AcpConfigOptionOverridesV1,
    type BackendTargetRefV1,
    type SessionMcpSelectionV1,
} from '@happier-dev/protocol';
import {
    serverAccountScopeKeySuffix,
    type ServerAccountScope,
} from '../scope/serverAccountScope';
import type { LocalPetSourceMetadata } from '../pets/localPetSourceMetadata';
var persistedStorage: MMKV | null = null;

const pendingSettingsSchemaByKey: Readonly<Record<string, z.ZodTypeAny>> = Object.freeze({
    ...ACCOUNT_SETTING_ARTIFACTS.shape,
    ...PROVIDER_SETTINGS_SHAPE,
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

function sessionModelModesKey(scope?: ServerAccountScope | null): string {
    return scopedSessionLocalStateKey('session-model-modes', scope);
}

function syncReliabilityEventsKey(): string {
    return 'sync-reliability-events-v1';
}

function localPetSourcesKey(): string {
    return 'local-pet-sources-v1';
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

function directSessionTailCursorPrefix(): string {
    return 'direct-session-tail-cursor-v1:';
}

function sessionModelModeUpdatedAtsKey(scope?: ServerAccountScope | null): string {
    return scopedSessionLocalStateKey('session-model-mode-updated-ats-v1', scope);
}

function sessionReviewCommentsDraftsKey(scope?: ServerAccountScope | null): string {
    return scopedSessionLocalStateKey('session-review-comments-draft-v1', scope);
}

function workspaceReviewCommentsDraftsKey(scope?: ServerAccountScope | null): string {
    return scopedSessionLocalStateKey('workspace-review-comments-draft-v1', scope);
}

function sessionActionDraftsKey(scope?: ServerAccountScope | null): string {
    return scopedSessionLocalStateKey('session-action-drafts-v1', scope);
}

function sessionDraftsKey(scope?: ServerAccountScope | null): string {
    return scopedSessionLocalStateKey('session-drafts', scope);
}

function sessionPermissionModesKey(scope?: ServerAccountScope | null): string {
    return scopedSessionLocalStateKey('session-permission-modes', scope);
}

function sessionPermissionModeUpdatedAtsKey(scope?: ServerAccountScope | null): string {
    return scopedSessionLocalStateKey('session-permission-mode-updated-ats', scope);
}

function sessionLastViewedKey(scope?: ServerAccountScope | null): string {
    return scopedSessionLocalStateKey('session-last-viewed', scope);
}

function scopedSessionLocalStateKey(baseKey: string, scope?: ServerAccountScope | null): string {
    if (!scope) return baseKey;
    return `${baseKey}:scope:v2:${serverAccountScopeKeySuffix(scope)}`;
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

export function getPersistenceStorage(): MMKV {
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
    return normalizeCodexBackendMode(value);
}

function parseDraftEntryIntent(value: unknown): NewSessionDraft['entryIntent'] {
    return value === 'automation' || value === 'session' ? value : null;
}

export function loadSettings(): { settings: unknown; version: number | null } {
    const mmkv = getPersistenceStorage();
    const settings = mmkv.getString('settings');
    if (settings) {
        try {
            const parsed = JSON.parse(settings);
            const version = typeof parsed.version === 'number' ? parsed.version : null;
            return { settings: parsed.settings, version };
        } catch (e) {
            console.error('Failed to parse settings', e);
            return { settings: {}, version: null };
        }
    }
    return { settings: {}, version: null };
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
            const parsedVoice = voiceSettingsParse(rawValue);
            if (parsedVoice) (out as any).voice = parsedVoice;
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

const LocalPetSourceMetadataSchema = z
    .object({
        kind: z.enum(['detectedCodexHome', 'happierManagedLocal']),
        sourceKey: z.string().min(1).max(500),
        petId: z.string().min(1).max(200),
        displayName: z.string().min(1).max(200),
        mediaType: z.enum(['image/png', 'image/webp']).optional(),
        digest: z.string().min(1).max(500).optional(),
        sizeBytes: z.number().int().min(0).optional(),
        daemonTarget: z.object({
            machineId: z.string().min(1).max(500),
            serverId: z.string().min(1).max(500),
        }),
    })
    .strip();

export function loadLocalPetSourcesBySourceKey(): Record<string, LocalPetSourceMetadata> {
    const mmkv = getPersistenceStorage();
    const key = localPetSourcesKey();
    const raw = mmkv.getString(key);
    if (!raw) return {};
    try {
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            mmkv.delete(key);
            return {};
        }

        const out: Record<string, LocalPetSourceMetadata> = {};
        for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
            const result = LocalPetSourceMetadataSchema.safeParse(value);
            if (!result.success) continue;
            if (result.data.sourceKey !== key) continue;
            out[key] = result.data;
        }
        const nextRaw = JSON.stringify(out);
        if (Object.keys(out).length === 0) {
            mmkv.delete(key);
        } else if (nextRaw !== raw) {
            mmkv.set(key, nextRaw);
        }
        return out;
    } catch (e) {
        console.error('Failed to parse local pet sources', e);
        mmkv.delete(key);
        return {};
    }
}

export function saveLocalPetSourcesBySourceKey(sources: Record<string, LocalPetSourceMetadata>): void {
    const mmkv = getPersistenceStorage();
    const safeSources: Record<string, LocalPetSourceMetadata> = {};
    for (const [key, source] of Object.entries(sources)) {
        const result = LocalPetSourceMetadataSchema.safeParse(source);
        if (!result.success) continue;
        if (result.data.sourceKey !== key) continue;
        safeSources[key] = result.data;
    }
    if (Object.keys(safeSources).length === 0) {
        mmkv.delete(localPetSourcesKey());
        return;
    }
    mmkv.set(localPetSourcesKey(), JSON.stringify(safeSources));
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

export function loadSessionDrafts(scope?: ServerAccountScope | null): Record<string, string> {
    const mmkv = getPersistenceStorage();
    const drafts = mmkv.getString(sessionDraftsKey(scope));
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

export function saveSessionDrafts(drafts: Record<string, string>, scope?: ServerAccountScope | null) {
    const mmkv = getPersistenceStorage();
    mmkv.set(sessionDraftsKey(scope), JSON.stringify(drafts));
}

export type SessionReviewCommentDraftsBySessionId = Record<string, z.infer<typeof ReviewCommentDraftSchema>[]>;

export type WorkspaceReviewCommentDraftsByWorkspaceCacheKey = Record<string, z.infer<typeof ReviewCommentDraftSchema>[]>;

export function loadSessionReviewCommentsDrafts(scope?: ServerAccountScope | null): SessionReviewCommentDraftsBySessionId {
    const mmkv = getPersistenceStorage();
    const raw = mmkv.getString(sessionReviewCommentsDraftsKey(scope));
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

export function saveSessionReviewCommentsDrafts(
    drafts: SessionReviewCommentDraftsBySessionId,
    scope?: ServerAccountScope | null,
): void {
    const mmkv = getPersistenceStorage();
    const key = sessionReviewCommentsDraftsKey(scope);
    if (!drafts || typeof drafts !== 'object' || Object.keys(drafts).length === 0) {
        mmkv.delete(key);
        return;
    }
    mmkv.set(key, JSON.stringify(drafts));
}

export function loadWorkspaceReviewCommentsDrafts(scope?: ServerAccountScope | null): WorkspaceReviewCommentDraftsByWorkspaceCacheKey {
    const mmkv = getPersistenceStorage();
    const raw = mmkv.getString(workspaceReviewCommentsDraftsKey(scope));
    if (!raw) return {};
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

        const out: WorkspaceReviewCommentDraftsByWorkspaceCacheKey = {};
        for (const [rawWorkspaceCacheKey, rawDrafts] of Object.entries(parsed as Record<string, unknown>)) {
            const workspaceCacheKey = typeof rawWorkspaceCacheKey === 'string' ? rawWorkspaceCacheKey.trim() : '';
            if (!workspaceCacheKey) continue;
            if (!Array.isArray(rawDrafts)) continue;

            const drafts: z.infer<typeof ReviewCommentDraftSchema>[] = [];
            for (const entry of rawDrafts) {
                const entryParsed = ReviewCommentDraftSchema.safeParse(entry);
                if (entryParsed.success) drafts.push(entryParsed.data);
            }
            if (drafts.length > 0) out[workspaceCacheKey] = drafts;
        }
        return out;
    } catch (e) {
        console.error('Failed to parse workspace review comment drafts', e);
        return {};
    }
}

export function saveWorkspaceReviewCommentsDrafts(
    drafts: WorkspaceReviewCommentDraftsByWorkspaceCacheKey,
    scope?: ServerAccountScope | null,
): void {
    const mmkv = getPersistenceStorage();
    const key = workspaceReviewCommentsDraftsKey(scope);
    if (!drafts || typeof drafts !== 'object' || Object.keys(drafts).length === 0) {
        mmkv.delete(key);
        return;
    }
    mmkv.set(key, JSON.stringify(drafts));
}

export type SessionActionDraftsBySessionId = Record<string, z.infer<typeof SessionActionDraftSchema>[]>;

export function loadSessionActionDrafts(scope?: ServerAccountScope | null): SessionActionDraftsBySessionId {
    const mmkv = getPersistenceStorage();
    const raw = mmkv.getString(sessionActionDraftsKey(scope));
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

export function saveSessionActionDrafts(
    drafts: SessionActionDraftsBySessionId,
    scope?: ServerAccountScope | null,
): void {
    const mmkv = getPersistenceStorage();
    const key = sessionActionDraftsKey(scope);
    if (!drafts || typeof drafts !== 'object' || Object.keys(drafts).length === 0) {
        mmkv.delete(key);
        return;
    }
    mmkv.set(key, JSON.stringify(drafts));
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

export function saveNewSessionDraft(draft: NewSessionDraft, scope?: ServerAccountScope | null) {
    const mmkv = getPersistenceStorage();
    mmkv.set(newSessionDraftKey(scope), JSON.stringify(draft));
}

export function clearNewSessionDraft(scope?: ServerAccountScope | null) {
    const mmkv = getPersistenceStorage();
    mmkv.delete(newSessionDraftKey(scope));
}

export function loadSessionPermissionModes(scope?: ServerAccountScope | null): Record<string, PermissionMode> {
    const mmkv = getPersistenceStorage();
    const modes = mmkv.getString(sessionPermissionModesKey(scope));
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

export function saveSessionPermissionModes(modes: Record<string, PermissionMode>, scope?: ServerAccountScope | null) {
    const mmkv = getPersistenceStorage();
    mmkv.set(sessionPermissionModesKey(scope), JSON.stringify(modes));
}

export function loadSessionPermissionModeUpdatedAts(scope?: ServerAccountScope | null): Record<string, number> {
    const mmkv = getPersistenceStorage();
    const raw = mmkv.getString(sessionPermissionModeUpdatedAtsKey(scope));
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

export function saveSessionPermissionModeUpdatedAts(
    updatedAts: Record<string, number>,
    scope?: ServerAccountScope | null,
) {
    const mmkv = getPersistenceStorage();
    mmkv.set(sessionPermissionModeUpdatedAtsKey(scope), JSON.stringify(updatedAts));
}

export function loadSessionLastViewed(scope?: ServerAccountScope | null): Record<string, number> {
    const mmkv = getPersistenceStorage();
    const raw = mmkv.getString(sessionLastViewedKey(scope));
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

export function saveSessionLastViewed(data: Record<string, number>, scope?: ServerAccountScope | null) {
    const mmkv = getPersistenceStorage();
    mmkv.set(sessionLastViewedKey(scope), JSON.stringify(data));
}

export function loadSessionModelModes(scope?: ServerAccountScope | null): Record<string, ModelMode> {
    const mmkv = getPersistenceStorage();
    const modes = mmkv.getString(sessionModelModesKey(scope));
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

export function saveSessionModelModes(modes: Record<string, ModelMode>, scope?: ServerAccountScope | null) {
    const mmkv = getPersistenceStorage();
    mmkv.set(sessionModelModesKey(scope), JSON.stringify(modes));
}

export function loadSessionModelModeUpdatedAts(scope?: ServerAccountScope | null): Record<string, number> {
    const mmkv = getPersistenceStorage();
    const raw = mmkv.getString(sessionModelModeUpdatedAtsKey(scope));
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

export function saveSessionModelModeUpdatedAts(data: Record<string, number>, scope?: ServerAccountScope | null) {
    const mmkv = getPersistenceStorage();
    mmkv.set(sessionModelModeUpdatedAtsKey(scope), JSON.stringify(data));
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
    const migrateLegacyMapIfNeeded = <T>(
        scopedKey: string,
        loadLegacy: () => Record<string, T>,
        saveScoped: (data: Record<string, T>, scope: ServerAccountScope) => void,
    ): void => {
        if (typeof mmkv.getString(scopedKey) === 'string') {
            return;
        }

        const legacyData = loadLegacy();
        if (Object.keys(legacyData).length > 0) {
            saveScoped(legacyData, scope);
        }
    };

    // Active-session drafts are recoverable user text, so legacy values migrate once.
    // Launch drafts include machine/profile/secret intent and are dropped below instead.
    if (typeof mmkv.getString(sessionDraftsKey(scope)) !== 'string') {
        const legacyDrafts = loadSessionDrafts();
        if (Object.keys(legacyDrafts).length > 0) {
            saveSessionDrafts(legacyDrafts, scope);
        }
    }

    if (typeof mmkv.getString(sessionReviewCommentsDraftsKey(scope)) !== 'string') {
        const legacyReviewDrafts = loadSessionReviewCommentsDrafts();
        if (Object.keys(legacyReviewDrafts).length > 0) {
            saveSessionReviewCommentsDrafts(legacyReviewDrafts, scope);
        }
    }

    if (typeof mmkv.getString(workspaceReviewCommentsDraftsKey(scope)) !== 'string') {
        const legacyWorkspaceReviewDrafts = loadWorkspaceReviewCommentsDrafts();
        if (Object.keys(legacyWorkspaceReviewDrafts).length > 0) {
            saveWorkspaceReviewCommentsDrafts(legacyWorkspaceReviewDrafts, scope);
        }
    }

    if (typeof mmkv.getString(sessionActionDraftsKey(scope)) !== 'string') {
        const legacyActionDrafts = loadSessionActionDrafts();
        if (Object.keys(legacyActionDrafts).length > 0) {
            saveSessionActionDrafts(legacyActionDrafts, scope);
        }
    }

    migrateLegacyMapIfNeeded(sessionPermissionModesKey(scope), loadSessionPermissionModes, saveSessionPermissionModes);
    migrateLegacyMapIfNeeded(sessionPermissionModeUpdatedAtsKey(scope), loadSessionPermissionModeUpdatedAts, saveSessionPermissionModeUpdatedAts);
    migrateLegacyMapIfNeeded(sessionModelModesKey(scope), loadSessionModelModes, saveSessionModelModes);
    migrateLegacyMapIfNeeded(sessionModelModeUpdatedAtsKey(scope), loadSessionModelModeUpdatedAts, saveSessionModelModeUpdatedAts);
    migrateLegacyMapIfNeeded(sessionLastViewedKey(scope), loadSessionLastViewed, saveSessionLastViewed);
    migrateLegacyMapIfNeeded(sessionMaterializedMaxSeqKey(scope), loadSessionMaterializedMaxSeqById, saveSessionMaterializedMaxSeqById);

    mmkv.delete(sessionDraftsKey());
    mmkv.delete(sessionReviewCommentsDraftsKey());
    mmkv.delete(workspaceReviewCommentsDraftsKey());
    mmkv.delete(sessionActionDraftsKey());
    mmkv.delete(newSessionDraftKey());
    mmkv.delete(sessionPermissionModesKey());
    mmkv.delete(sessionPermissionModeUpdatedAtsKey());
    mmkv.delete(sessionModelModesKey());
    mmkv.delete(sessionModelModeUpdatedAtsKey());
    mmkv.delete(sessionLastViewedKey());
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

function directSessionTailCursorKey(accountId: string, sessionId: string, scope: string, instanceId: string | null): string {
    const instancePart = instanceId ? `:${encodeChangesCursorKeyPart(instanceId)}` : ':no-instance';
    return `${directSessionTailCursorPrefix()}${encodeChangesCursorKeyPart(scope)}:${encodeChangesCursorKeyPart(accountId)}:${encodeChangesCursorKeyPart(sessionId)}${instancePart}`;
}

function parseInstanceChangesCursorRecord(raw: string | undefined): string | null {
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

function parseInstanceChangesCursorLastWriteMs(raw: string | undefined): number | null {
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

export function loadDirectSessionTailCursor(sessionIdRaw: string, scopeRaw?: ChangesCursorScope | null): string | null {
    const mmkv = getPersistenceStorage();
    const scope = normalizeChangesCursorScope(scopeRaw);
    const accountId = scope.accountId;
    const sessionId = String(sessionIdRaw ?? '').trim();
    if (!accountId || !sessionId) return null;

    if (!scope.serverScope) return null;

    const raw = mmkv.getString(directSessionTailCursorKey(accountId, sessionId, scope.serverScope, scope.instanceId));
    return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null;
}

export function saveDirectSessionTailCursor(
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

    const key = directSessionTailCursorKey(accountId, sessionId, scope.serverScope, scope.instanceId);
    const cursor = typeof cursorRaw === 'string' ? cursorRaw.trim() : '';
    if (!cursor) {
        mmkv.delete(key);
        return;
    }
    mmkv.set(key, cursor);
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
