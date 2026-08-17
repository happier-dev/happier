import { RETIRED_ACCOUNT_SETTINGS_SESSION_ORGANIZATION_KEYS } from '@happier-dev/protocol';

import { areAccountSettingsJsonValuesEqual } from './accountSettingsStructuralEquality';

type RetiredSessionOrganizationSettingKey =
    typeof RETIRED_ACCOUNT_SETTINGS_SESSION_ORGANIZATION_KEYS[number];
type MigratableRetiredSessionOrganizationSettingKey = Exclude<
    RetiredSessionOrganizationSettingKey,
    'collapsedGroupKeysV1'
>;

// Account migration accepts this compatibility-only raw subset. Collapsed group
// state has no server-identity rewrite contract and deliberately does not participate.
const MIGRATABLE_RETIRED_SESSION_ORGANIZATION_KEYS = [
    'pinnedSessionKeysV1',
    'workspaceLabelsV1',
    'sessionTagsV1',
    'sessionListGroupOrderV1',
    'sessionWorkspaceOrderV1',
    'sessionFoldersV1',
] as const satisfies readonly MigratableRetiredSessionOrganizationSettingKey[];

const SESSION_PRESENTATION_KEYS = [
    ...MIGRATABLE_RETIRED_SESSION_ORGANIZATION_KEYS,
    'serverSelectionGroups',
    'serverSelectionActiveTargetId',
] as const;

type MigratableSettingsKey = typeof SESSION_PRESENTATION_KEYS[number];
type ServerIdRewritePolicy = Readonly<{
    currentServerId: string;
    legacyServerIds: ReadonlySet<string>;
    rewriteUnknownServerIds: boolean;
}>;

const RESERVED_NON_SERVER_KEY_PREFIXES = new Set(['folder', 'workspace', 'server', 'pinned-v1']);

export type AccountSettingsServerIdentityKeyMigrationResult<T extends Record<string, unknown>> = Readonly<{
    settings: T;
    changed: boolean;
    changedKeys: readonly MigratableSettingsKey[];
}>;

function normalizeServerId(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
}

function createLegacyServerIdSet(currentServerId: string, legacyServerIds: readonly string[]): Set<string> {
    const legacySet = new Set<string>();
    for (const legacyServerId of legacyServerIds) {
        const normalized = normalizeServerId(legacyServerId);
        if (!normalized || normalized === currentServerId) continue;
        legacySet.add(normalized);
    }
    return legacySet;
}

export function isServerIssuedIdentityId(value: unknown): boolean {
    const normalized = normalizeServerId(value);
    return Boolean(normalized && /^srv_[A-Za-z0-9._-]+$/.test(normalized));
}

function shouldRewriteServerId(serverId: string, policy: ServerIdRewritePolicy): boolean {
    if (serverId === policy.currentServerId) return false;
    if (policy.legacyServerIds.has(serverId)) return true;
    if (!policy.rewriteUnknownServerIds) return false;
    return !RESERVED_NON_SERVER_KEY_PREFIXES.has(serverId);
}

function rewriteProvenServerId(value: unknown, policy: ServerIdRewritePolicy): unknown {
    const serverId = normalizeServerId(value);
    if (!serverId || serverId === policy.currentServerId) return value;
    if (!policy.legacyServerIds.has(serverId)) return value;
    return policy.currentServerId;
}

function rewriteSessionKey(value: unknown, policy: ServerIdRewritePolicy): unknown {
    if (typeof value !== 'string') return value;
    const separatorIndex = value.indexOf(':');
    if (separatorIndex <= 0) return value;
    const serverId = value.slice(0, separatorIndex);
    if (!shouldRewriteServerId(serverId, policy)) return value;
    return `${policy.currentServerId}${value.slice(separatorIndex)}`;
}

function rewriteServerGroupKey(value: string, policy: ServerIdRewritePolicy): string {
    const prefix = 'server:';
    if (!value.startsWith(prefix)) return value;
    const serverIdStart = prefix.length;
    const separatorIndex = value.indexOf(':', serverIdStart);
    if (separatorIndex <= serverIdStart) return value;
    const serverId = value.slice(serverIdStart, separatorIndex);
    if (!shouldRewriteServerId(serverId, policy)) return value;
    return `${prefix}${policy.currentServerId}${value.slice(separatorIndex)}`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function dedupeUnknownArray(values: readonly unknown[]): unknown[] {
    const next: unknown[] = [];
    const seen = new Set<string>();
    for (const value of values) {
        const key = JSON.stringify(value);
        if (seen.has(key)) continue;
        seen.add(key);
        next.push(value);
    }
    return next;
}

function mergeUnknownArrays(existing: unknown, incoming: unknown): unknown {
    if (!Array.isArray(existing)) return incoming;
    if (!Array.isArray(incoming)) return incoming;
    return dedupeUnknownArray([...existing, ...incoming]);
}

function rewriteStringArray(
    value: unknown,
    rewriteValue: (item: unknown) => unknown,
): unknown {
    if (!Array.isArray(value)) return value;
    return dedupeUnknownArray(value.map(rewriteValue));
}

function rewriteRecordKeys(
    value: unknown,
    rewriteKey: (key: string) => string,
    rewriteValue: (value: unknown) => unknown,
    mergeValue: (existing: unknown, incoming: unknown) => unknown,
): unknown {
    if (!isPlainRecord(value)) return value;
    const next: Record<string, unknown> = {};
    for (const [key, rawEntryValue] of Object.entries(value)) {
        const nextKey = rewriteKey(key);
        const nextValue = rewriteValue(rawEntryValue);
        next[nextKey] = Object.prototype.hasOwnProperty.call(next, nextKey)
            ? mergeValue(next[nextKey], nextValue)
            : nextValue;
    }
    return next;
}

function rewriteSessionFolderWorkspace(value: unknown, policy: ServerIdRewritePolicy): unknown {
    if (!isPlainRecord(value)) return value;
    const serverId = normalizeServerId(value.serverId);
    if (!serverId || !shouldRewriteServerId(serverId, policy)) return value;
    return { ...value, serverId: policy.currentServerId };
}

function rewriteSessionFolders(value: unknown, policy: ServerIdRewritePolicy): unknown {
    if (!isPlainRecord(value) || !Array.isArray(value.folders)) return value;
    return {
        ...value,
        folders: value.folders.map((folder) => {
            if (!isPlainRecord(folder)) return folder;
            return {
                ...folder,
                workspace: rewriteSessionFolderWorkspace(folder.workspace, policy),
            };
        }),
    };
}

function rewriteServerSelectionGroups(value: unknown, policy: ServerIdRewritePolicy): unknown {
    if (!Array.isArray(value)) return value;
    return value.map((group) => {
        if (!isPlainRecord(group) || !Array.isArray(group.serverIds)) return group;
        return {
            ...group,
            serverIds: dedupeUnknownArray(group.serverIds.map((serverId) => rewriteProvenServerId(serverId, policy))),
        };
    });
}

function migrateSettingValue(
    key: MigratableSettingsKey,
    value: unknown,
    policy: ServerIdRewritePolicy,
    settings: Record<string, unknown>,
): unknown {
    switch (key) {
        case 'pinnedSessionKeysV1':
            return rewriteStringArray(value, (item) => rewriteSessionKey(item, policy));
        case 'sessionTagsV1':
            return rewriteRecordKeys(
                value,
                (entryKey) => String(rewriteSessionKey(entryKey, policy)),
                (entryValue) => rewriteStringArray(entryValue, (tag) => tag),
                mergeUnknownArrays,
            );
        case 'sessionListGroupOrderV1':
            return rewriteRecordKeys(
                value,
                (entryKey) => rewriteServerGroupKey(entryKey, policy),
                (entryValue) => rewriteStringArray(entryValue, (item) => rewriteSessionKey(item, policy)),
                mergeUnknownArrays,
            );
        case 'sessionWorkspaceOrderV1':
            return rewriteRecordKeys(
                value,
                (entryKey) => rewriteServerGroupKey(entryKey, policy),
                (entryValue) => rewriteStringArray(entryValue, (item) => item),
                mergeUnknownArrays,
            );
        case 'sessionFoldersV1':
            return rewriteSessionFolders(value, policy);
        case 'workspaceLabelsV1':
            return value;
        case 'serverSelectionGroups':
            return rewriteServerSelectionGroups(value, policy);
        case 'serverSelectionActiveTargetId':
            return settings.serverSelectionActiveTargetKind === 'server'
                ? rewriteProvenServerId(value, policy)
                : value;
    }
}

export function migrateAccountSettingsServerIdentityKeys<T extends Record<string, unknown>>(params: {
    settings: T;
    currentServerId: string;
    legacyServerIds: readonly string[];
    rewriteUnknownServerIds?: boolean;
}): AccountSettingsServerIdentityKeyMigrationResult<T> {
    const currentServerId = normalizeServerId(params.currentServerId);
    if (!currentServerId) return { settings: params.settings, changed: false, changedKeys: [] };

    const legacyServerIds = createLegacyServerIdSet(currentServerId, params.legacyServerIds);
    const policy: ServerIdRewritePolicy = {
        currentServerId,
        legacyServerIds,
        rewriteUnknownServerIds: params.rewriteUnknownServerIds === true,
    };
    if (legacyServerIds.size === 0 && !policy.rewriteUnknownServerIds) {
        return { settings: params.settings, changed: false, changedKeys: [] };
    }

    let next: Record<string, unknown> | null = null;
    const changedKeys: MigratableSettingsKey[] = [];
    for (const key of SESSION_PRESENTATION_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(params.settings, key)) continue;
        const currentValue = params.settings[key];
        const migratedValue = migrateSettingValue(key, currentValue, policy, params.settings);
        if (areAccountSettingsJsonValuesEqual(currentValue, migratedValue)) continue;
        if (!next) next = { ...params.settings };
        next[key] = migratedValue;
        changedKeys.push(key);
    }

    if (!next) return { settings: params.settings, changed: false, changedKeys: [] };
    return {
        settings: next as T,
        changed: true,
        changedKeys,
    };
}
