import {
    FileMentionSuggestion,
    SkillMentionSuggestion,
    VendorPluginMentionSuggestion,
} from '@/components/sessions/agentInput/components/AgentInputSuggestionView';
import * as React from 'react';
import type { FileItem } from '@/sync/domains/input/suggestionFile';
import { storage } from '@/sync/domains/state/storage';
import { ensureSessionSuggestionCatalogs } from '@/sync/ops/sessionCatalogs';
import type { AutocompleteSuggestion } from './autocompleteTypes';
import { getCommandSuggestions } from './commandSuggestions';

type VendorPluginCatalogItem = Readonly<{
    name: string;
    displayName?: string;
    description?: string;
    vendorPluginRef: string;
    marketplace?: string;
    source?: string;
    installed?: boolean;
    enabled?: boolean;
    mentionable?: boolean;
    backendId?: string;
    agentId?: string;
}>;

type SkillCatalogItem = Readonly<{
    id?: string;
    name: string;
    displayName?: string;
    description?: string;
    path?: string;
    enabled?: boolean;
    origin?: string;
    source?: string;
    projectionKind?: string;
    projectionRef?: string;
    backendId?: string;
    agentId?: string;
}>;

type SuggestionCatalogOverrides = Readonly<{
    files?: readonly FileItem[];
    vendorPlugins?: readonly VendorPluginCatalogItem[];
    skills?: readonly SkillCatalogItem[];
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readArray(value: unknown, keys: readonly string[]): readonly unknown[] {
    if (Array.isArray(value)) return value;
    if (!isRecord(value)) return [];
    const catalog = value.catalog;
    if (isRecord(catalog) && Array.isArray(catalog.items)) return catalog.items;
    for (const key of keys) {
        const child = value[key];
        if (Array.isArray(child)) return child;
    }
    return [];
}

function readString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
    return typeof value === 'boolean' ? value : undefined;
}

function deriveVendorPluginName(vendorPluginRef: string): string {
    const withoutScheme = vendorPluginRef.replace(/^plugin:\/\//, '');
    const markerIndex = withoutScheme.indexOf('@');
    return markerIndex > 0 ? withoutScheme.slice(0, markerIndex) : withoutScheme;
}

function normalizeVendorPlugin(value: unknown): VendorPluginCatalogItem | null {
    if (!isRecord(value)) return null;
    const vendorPluginRef = readString(value.vendorPluginRef)
        ?? readString(value.mentionPath)
        ?? readString(value.path)
        ?? readString(value.ref);
    if (!vendorPluginRef) return null;
    const displayName = readString(value.displayName);
    const name = readString(value.name) ?? deriveVendorPluginName(vendorPluginRef);
    const description = readString(value.description);
    const marketplace = readString(value.marketplace ?? value.marketplaceId);
    const source = readString(value.source);
    const backendId = readString(value.backendId);
    const agentId = readString(value.agentId);
    const installed = readBoolean(value.installed);
    const enabled = readBoolean(value.enabled);
    const mentionable = readBoolean(value.mentionable);
    return {
        name,
        vendorPluginRef,
        ...(displayName ? { displayName } : {}),
        ...(description ? { description } : {}),
        ...(marketplace ? { marketplace } : {}),
        ...(source ? { source } : {}),
        ...(installed !== undefined ? { installed } : {}),
        ...(enabled !== undefined ? { enabled } : {}),
        ...(mentionable !== undefined ? { mentionable } : {}),
        ...(backendId ? { backendId } : {}),
        ...(agentId ? { agentId } : {}),
    };
}

function normalizeSkillOrigin(value: string | undefined): Readonly<{
    origin?: string;
    backendId?: string;
    projectionRef?: string;
}> {
    if (value === 'vendor' || value === 'happier') return { origin: value };
    if (value === 'codex_native') return { origin: 'vendor', backendId: 'codex' };
    if (value === 'opencode_native') return { origin: 'vendor', backendId: 'opencode' };
    if (value === 'claude_native') return { origin: 'vendor', backendId: 'claude' };
    if (value === 'pi_native') return { origin: 'vendor', backendId: 'pi' };
    if (value === 'happier_projected' || value === 'text_fallback_only') {
        return { origin: 'happier', projectionRef: value };
    }
    return {};
}

function normalizeSkill(value: unknown): SkillCatalogItem | null {
    if (!isRecord(value)) return null;
    const id = readString(value.id);
    const name = readString(value.name);
    if (!name) return null;
    const displayName = readString(value.displayName);
    const description = readString(value.description);
    const path = readString(value.path);
    const originMetadata = normalizeSkillOrigin(
        readString(value.origin) ?? readString(value.source) ?? readString(value.projectionKind),
    );
    const source = readString(value.source);
    const projectionKind = readString(value.projectionKind);
    const projectionRef = readString(value.projectionRef) ?? originMetadata.projectionRef;
    const backendId = readString(value.backendId) ?? originMetadata.backendId;
    const agentId = readString(value.agentId);
    return {
        ...(id ? { id } : {}),
        name,
        ...(displayName ? { displayName } : {}),
        ...(description ? { description } : {}),
        ...(path ? { path } : {}),
        ...(value.enabled === false ? { enabled: false } : {}),
        ...(originMetadata.origin ? { origin: originMetadata.origin } : {}),
        ...(source ? { source } : {}),
        ...(projectionKind ? { projectionKind } : {}),
        ...(projectionRef ? { projectionRef } : {}),
        ...(backendId ? { backendId } : {}),
        ...(agentId ? { agentId } : {}),
    };
}

function readCatalogsFromSession(sessionId: string): SuggestionCatalogOverrides {
    const metadata = storage.getState().sessions[sessionId]?.metadata;
    if (!metadata || typeof metadata !== 'object') return {};
    const record = metadata as Record<string, unknown>;
    const vendorPluginRaw = record.sessionVendorPluginCatalogV1 ?? record.vendorPluginCatalogV1 ?? record.vendorPlugins;
    const skillsRaw = record.sessionSkillCatalogV1 ?? record.skillCatalogV1 ?? record.skills;
    return {
        vendorPlugins: readArray(vendorPluginRaw, ['vendorPlugins', 'plugins', 'items'])
            .map(normalizeVendorPlugin)
            .filter((item): item is VendorPluginCatalogItem => item !== null),
        skills: readArray(skillsRaw, ['skills', 'items'])
            .map(normalizeSkill)
            .filter((item): item is SkillCatalogItem => item !== null),
    };
}

function matchesQuery(value: string, query: string): boolean {
    const haystack = value.trim().toLowerCase();
    const needle = query.trim().toLowerCase();
    return needle.length === 0 || haystack.includes(needle);
}

function isPathLikeAtQuery(queryWithoutPrefix: string): boolean {
    return (
        queryWithoutPrefix.startsWith('/')
        || queryWithoutPrefix.startsWith('\\')
        || queryWithoutPrefix.startsWith('.')
        || queryWithoutPrefix.startsWith('~')
        || queryWithoutPrefix.includes('/')
        || queryWithoutPrefix.includes('\\')
    );
}

function getPluginQuery(query: string): { pluginOnly: boolean; searchTerm: string } {
    const withoutAt = query.startsWith('@') ? query.slice(1) : query;
    if (withoutAt.startsWith('plugin:')) {
        return { pluginOnly: true, searchTerm: withoutAt.slice('plugin:'.length) };
    }
    if (withoutAt.startsWith('plugins:')) {
        return { pluginOnly: true, searchTerm: withoutAt.slice('plugins:'.length) };
    }
    return { pluginOnly: false, searchTerm: withoutAt };
}

function buildFileSuggestion(file: FileItem): AutocompleteSuggestion {
    return {
        key: `file-${file.fullPath}`,
        text: `@${file.fullPath}`,
        component: () => React.createElement(FileMentionSuggestion, {
            fileName: file.fileName,
            filePath: file.filePath,
            fileType: file.fileType,
        }),
    };
}

function resolveCatalogRequestForQuery(query: string): { vendorPlugins?: boolean; skills?: boolean } | null {
    if (query.startsWith('@')) {
        const pluginQuery = getPluginQuery(query);
        const queryWithoutAt = query.slice(1);
        if (pluginQuery.pluginOnly || !isPathLikeAtQuery(queryWithoutAt)) {
            return { vendorPlugins: true };
        }
    }

    if (query.startsWith('$')) {
        return { skills: true };
    }

    return null;
}

async function searchSuggestionFiles(sessionId: string, searchTerm: string): Promise<readonly FileItem[]> {
    const { searchFiles } = await import('@/sync/domains/input/suggestionFile');
    return searchFiles(sessionId, searchTerm, { limit: 12 });
}

export async function getFileMentionSuggestions(sessionId: string, query: string): Promise<AutocompleteSuggestion[]> {
    // Remove the "@" prefix for searching
    const searchTerm = query.slice(1);
    
    try {
        // Use the file search cache with fuzzy matching
        const files = await searchSuggestionFiles(sessionId, searchTerm);

        // Convert FileItem to suggestion format
        return files.map(buildFileSuggestion);
    } catch {
        return [];
    }
}

function getVendorPluginMentionSuggestions(
    query: string,
    catalogs: SuggestionCatalogOverrides,
): AutocompleteSuggestion[] {
    const { searchTerm } = getPluginQuery(query);
    const seen = new Set<string>();
    const out: AutocompleteSuggestion[] = [];
    for (const plugin of catalogs.vendorPlugins ?? []) {
        const mentionable = plugin.mentionable ?? (plugin.installed === true && plugin.enabled === true);
        if (!mentionable) continue;
        if (seen.has(plugin.vendorPluginRef)) continue;
        const label = plugin.displayName ?? plugin.name;
        if (!matchesQuery(plugin.name, searchTerm) && !matchesQuery(label, searchTerm)) continue;
        seen.add(plugin.vendorPluginRef);
        out.push({
            key: `vendor-plugin-${plugin.vendorPluginRef}`,
            text: `@${plugin.name}`,
            structuredInput: {
                kind: 'vendorPlugin',
                vendorPluginRef: plugin.vendorPluginRef,
                label,
                ...(plugin.backendId ? { backendId: plugin.backendId } : {}),
                ...(plugin.agentId ? { agentId: plugin.agentId } : {}),
            },
            component: () => React.createElement(VendorPluginMentionSuggestion, {
                name: plugin.name,
                displayName: label,
                description: plugin.description,
                source: plugin.marketplace ?? plugin.source,
            }),
        });
    }
    return out;
}

function getSkillMentionSuggestions(query: string, catalogs: SuggestionCatalogOverrides): AutocompleteSuggestion[] {
    const searchTerm = query.startsWith('$') ? query.slice(1) : query;
    const seen = new Set<string>();
    const out: AutocompleteSuggestion[] = [];
    for (const skill of catalogs.skills ?? []) {
        if (skill.enabled === false) continue;
        const identity = [
            skill.id,
            skill.origin ?? skill.source,
            skill.backendId,
            skill.agentId,
            skill.projectionRef ?? skill.projectionKind,
            skill.path,
            skill.name,
        ]
            .map((value) => typeof value === 'string' ? value.trim() : '')
            .filter((value) => value.length > 0)
            .join(':')
            .toLowerCase();
        const suggestionKey = typeof skill.id === 'string' && skill.id.trim().length > 0
            ? skill.id.trim()
            : identity;
        if (seen.has(identity)) continue;
        const label = skill.displayName ?? skill.name;
        if (!matchesQuery(skill.name, searchTerm) && !matchesQuery(label, searchTerm)) continue;
        seen.add(identity);
        out.push({
            key: `skill-${suggestionKey}`,
            text: `$${skill.name}`,
            structuredInput: {
                kind: 'skill',
                ...(skill.id ? { id: skill.id } : {}),
                name: skill.name,
                ...(skill.path ? { path: skill.path } : {}),
                ...(skill.displayName ? { displayName: skill.displayName } : {}),
                ...(skill.description ? { description: skill.description } : {}),
                ...(skill.origin ?? skill.source ? { origin: skill.origin ?? skill.source } : {}),
                ...(skill.projectionKind ? { projectionKind: skill.projectionKind } : {}),
                ...(skill.projectionRef ?? skill.projectionKind ? { projectionRef: skill.projectionRef ?? skill.projectionKind } : {}),
                ...(skill.backendId ? { backendId: skill.backendId } : {}),
                ...(skill.agentId ? { agentId: skill.agentId } : {}),
            },
            component: () => React.createElement(SkillMentionSuggestion, {
                name: skill.name,
                displayName: label,
                description: skill.description,
                source: skill.origin ?? skill.source ?? skill.projectionRef ?? skill.projectionKind,
            }),
        });
    }
    return out;
}

async function getAtMentionSuggestions(
    sessionId: string,
    query: string,
    catalogs: SuggestionCatalogOverrides,
): Promise<AutocompleteSuggestion[]> {
    const pluginQuery = getPluginQuery(query);
    const queryWithoutAt = query.startsWith('@') ? query.slice(1) : query;
    const isPathLikeQuery = isPathLikeAtQuery(queryWithoutAt);
    const vendorPluginSuggestions = getVendorPluginMentionSuggestions(query, catalogs);

    if (pluginQuery.pluginOnly) {
        return vendorPluginSuggestions;
    }

    if (!isPathLikeQuery && !catalogs.files) {
        return vendorPluginSuggestions;
    }

    const fileSuggestions = catalogs.files
        ? catalogs.files.map(buildFileSuggestion)
        : await getFileMentionSuggestions(sessionId, query);
    if (isPathLikeQuery) {
        return fileSuggestions;
    }
    return [
        ...fileSuggestions,
        ...vendorPluginSuggestions,
    ];
}

export async function getSuggestions(
    sessionId: string,
    query: string,
    catalogOverrides?: SuggestionCatalogOverrides,
): Promise<AutocompleteSuggestion[]> {
    if (!query || query.length === 0) {
        return [];
    }
    if (!catalogOverrides) {
        const catalogRequest = resolveCatalogRequestForQuery(query);
        if (catalogRequest) {
            await ensureSessionSuggestionCatalogs(sessionId, catalogRequest);
        }
    }
    const catalogs = catalogOverrides ?? readCatalogsFromSession(sessionId);
    
    // Check if it's a command (starts with /)
    if (query.startsWith('/')) {
        return await getCommandSuggestions(sessionId, query);
    }
    
    // Check if it's a file mention (starts with @)
    if (query.startsWith('@')) {
        return await getAtMentionSuggestions(sessionId, query, catalogs);
    }

    if (query.startsWith('$')) {
        return getSkillMentionSuggestions(query, catalogs);
    }
    
    // No suggestions for other queries
    return [];
}
