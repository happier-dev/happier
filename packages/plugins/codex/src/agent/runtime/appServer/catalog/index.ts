import type {
    SkillCatalogItemV1,
    SkillCatalogV1,
    VendorPluginCatalogItemV1,
    VendorPluginCatalogV1,
} from '@happier-dev/plugin-sdk/agents/runtime';

type MetadataRecord = Record<string, unknown>;
const CODEX_CATALOG_BACKEND_ID = 'codex';

export type CodexAppServerCatalogClient = Readonly<{
    request: (method: string, params: unknown) => Promise<unknown>;
}>;

export type CodexVendorPluginCatalogEntry = VendorPluginCatalogItemV1 & Readonly<{
    name: string;
    installed: boolean;
    enabled: boolean;
    mentionable: boolean;
}>;

export type CodexVendorPluginCatalog = Omit<VendorPluginCatalogV1, 'backendId' | 'items'> & Readonly<{
    backendId: string;
    items: readonly CodexVendorPluginCatalogEntry[];
}>;

export type CodexSkillCatalogEntry = SkillCatalogItemV1 & Readonly<{
    v: 1;
    id: string;
    origin: 'vendor';
    name: string;
    backendId: string;
    path: string;
    enabled: boolean;
}>;

export type CodexSkillCatalog = Omit<SkillCatalogV1, 'backendId' | 'items'> & Readonly<{
    backendId: string;
    items: readonly CodexSkillCatalogEntry[];
}>;

function asRecord(value: unknown): MetadataRecord | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as MetadataRecord : null;
}

function asArray(value: unknown): unknown[] {
    if (Array.isArray(value)) return value;
    const record = asRecord(value);
    const data = record?.data ?? record?.plugins ?? record?.skills;
    return Array.isArray(data) ? data : [];
}

function readArrayProperty(record: MetadataRecord | null, key: string): unknown[] {
    const value = record?.[key];
    return Array.isArray(value) ? value : [];
}

function readString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
    return typeof value === 'boolean' ? value : fallback;
}

function readNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readCode(error: unknown): number | string | null {
    const errorRecord = asRecord(error);
    const code = errorRecord?.code;
    if (typeof code === 'number' && Number.isFinite(code)) return code;
    if (typeof code === 'string' && code.trim()) return code.trim();
    const nestedCode = asRecord(errorRecord?.error)?.code;
    if (typeof nestedCode === 'number' && Number.isFinite(nestedCode)) return nestedCode;
    if (typeof nestedCode === 'string' && nestedCode.trim()) return nestedCode.trim();
    return null;
}

function readMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error ?? '');
}

function isCodexAppServerMethodNotFoundError(error: unknown): boolean {
    if (readCode(error) === -32601) return true;
    return /method\s+not\s+found/i.test(readMessage(error));
}

function readMarketplaceName(record: MetadataRecord): string | null {
    const direct = readString(record.marketplaceName ?? record.marketplace);
    if (direct) return direct;
    const source = asRecord(record.source);
    return readString(source?.marketplace ?? source?.marketplaceName ?? source?.name);
}

function normalizePlugin(record: MetadataRecord): CodexVendorPluginCatalogEntry | null {
    const name = readString(record.name);
    if (!name) return null;
    const marketplaceName = readMarketplaceName(record);
    const id = readString(record.id);
    const vendorPluginRef = readString(record.vendorPluginRef ?? record.mentionPath)
        ?? (id?.startsWith('plugin://') ? id : null)
        ?? (marketplaceName ? `plugin://${name}@${marketplaceName}` : readString(record.path));
    if (!vendorPluginRef) return null;
    const installed = readBoolean(record.installed, false);
    const enabled = readBoolean(record.enabled, false);
    const pluginInterface = asRecord(record.interface);
    const description = readString(
        record.description
            ?? record.shortDescription
            ?? pluginInterface?.shortDescription
            ?? pluginInterface?.longDescription,
    );
    const displayName = readString(record.displayName ?? record.title ?? pluginInterface?.displayName) ?? name;
    const updatedAt = readNumber(record.updatedAt);
    return {
        v: 1,
        backendId: CODEX_CATALOG_BACKEND_ID,
        vendorPluginRef,
        displayName,
        name,
        ...(description ? { description } : {}),
        ...(marketplaceName ? { marketplaceId: marketplaceName } : {}),
        installed,
        enabled,
        mentionable: readBoolean(record.mentionable, installed && enabled),
        ...(updatedAt !== null ? { updatedAt } : {}),
    };
}

function normalizeSkill(record: MetadataRecord): CodexSkillCatalogEntry | null {
    const name = readString(record.name);
    const path = readString(record.path ?? record.location);
    if (!name || !path) return null;
    const skillInterface = asRecord(record.interface);
    const description = readString(
        skillInterface?.shortDescription
            ?? record.shortDescription
            ?? record.description,
    );
    const updatedAt = readNumber(record.updatedAt);
    return {
        v: 1,
        id: `vendor:${CODEX_CATALOG_BACKEND_ID}:${name}`,
        origin: 'vendor',
        name,
        backendId: CODEX_CATALOG_BACKEND_ID,
        displayName: readString(record.displayName ?? record.title ?? skillInterface?.displayName) ?? name,
        ...(description ? { description } : {}),
        path,
        enabled: readBoolean(record.enabled, true),
        ...(updatedAt !== null ? { updatedAt } : {}),
    };
}

function readPluginCatalogEntries(response: unknown): MetadataRecord[] {
    const responseRecord = asRecord(response);
    const marketplaces = readArrayProperty(responseRecord, 'marketplaces');
    if (marketplaces.length === 0) {
        return asArray(response).map((entry) => asRecord(entry)).filter((entry): entry is MetadataRecord => entry !== null);
    }

    const entries: MetadataRecord[] = [];
    for (const marketplaceValue of marketplaces) {
        const marketplace = asRecord(marketplaceValue);
        if (!marketplace) continue;
        const marketplaceName = readString(marketplace.name);
        for (const pluginValue of readArrayProperty(marketplace, 'plugins')) {
            const plugin = asRecord(pluginValue);
            if (!plugin) continue;
            entries.push(marketplaceName ? { ...plugin, marketplaceName } : plugin);
        }
    }
    return entries;
}

function readSkillCatalogEntries(response: unknown): MetadataRecord[] {
    const responseRecord = asRecord(response);
    const data = readArrayProperty(responseRecord, 'data');
    if (data.length === 0) {
        return asArray(response).map((entry) => asRecord(entry)).filter((entry): entry is MetadataRecord => entry !== null);
    }

    const entries: MetadataRecord[] = [];
    for (const listEntryValue of data) {
        const listEntry = asRecord(listEntryValue);
        if (!listEntry) continue;
        for (const skillValue of readArrayProperty(listEntry, 'skills')) {
            const skill = asRecord(skillValue);
            if (skill) entries.push(skill);
        }
    }
    return entries;
}

export async function listCodexVendorPlugins(params: Readonly<{
    client: CodexAppServerCatalogClient;
    cwd: string;
}>): Promise<Readonly<{
    supported: boolean;
    catalog?: CodexVendorPluginCatalog;
    vendorPlugins: readonly CodexVendorPluginCatalogEntry[];
    diagnostic?: string;
}>> {
    try {
        const response = await params.client.request('plugin/list', { cwds: [params.cwd] });
        const byVendorPluginRef = new Map<string, CodexVendorPluginCatalogEntry>();
        for (const entry of readPluginCatalogEntries(response)) {
            const plugin = normalizePlugin(entry);
            if (!plugin || byVendorPluginRef.has(plugin.vendorPluginRef)) continue;
            byVendorPluginRef.set(plugin.vendorPluginRef, plugin);
        }
        const vendorPlugins = [...byVendorPluginRef.values()];
        return {
            supported: true,
            catalog: {
                v: 1,
                backendId: CODEX_CATALOG_BACKEND_ID,
                updatedAt: Date.now(),
                items: vendorPlugins,
            },
            vendorPlugins,
        };
    } catch (error) {
        if (isCodexAppServerMethodNotFoundError(error)) {
            return {
                supported: false,
                vendorPlugins: [],
                diagnostic: error instanceof Error ? error.message : String(error),
            };
        }
        throw error;
    }
}

export async function listCodexAppServerSkills(params: Readonly<{
    client: CodexAppServerCatalogClient;
    cwd: string;
}>): Promise<Readonly<{
    supported: boolean;
    catalog?: CodexSkillCatalog;
    skills: readonly CodexSkillCatalogEntry[];
    diagnostic?: string;
}>> {
    try {
        const response = await params.client.request('skills/list', { cwds: [params.cwd] });
        const byName = new Map<string, CodexSkillCatalogEntry>();
        for (const entry of readSkillCatalogEntries(response)) {
            const skill = normalizeSkill(entry);
            if (!skill) continue;
            const key = skill.name.toLowerCase();
            const existing = byName.get(key);
            if (!existing || (!existing.enabled && skill.enabled)) {
                byName.set(key, skill);
            }
        }
        const skills = [...byName.values()];
        return {
            supported: true,
            catalog: {
                v: 1,
                backendId: CODEX_CATALOG_BACKEND_ID,
                updatedAt: Date.now(),
                items: skills,
            },
            skills,
        };
    } catch (error) {
        if (isCodexAppServerMethodNotFoundError(error)) {
            return {
                supported: false,
                skills: [],
                diagnostic: error instanceof Error ? error.message : String(error),
            };
        }
        throw error;
    }
}
