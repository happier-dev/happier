import type { useMachineCapabilitiesCache } from '@/hooks/server/useMachineCapabilitiesCache';
import { type CapabilityId } from '@/sync/api/capabilities/capabilitiesProtocol';
import { t } from '@/text';

import type { PluginMarketplaceCatalog } from '../readPluginMarketplaceCatalog';

export const MARKETPLACE_CAPABILITY_ID = 'tool.plugins' as CapabilityId;

export type InstalledPluginDiagnostic = Readonly<{
    code: string;
    message: string;
}>;

export type InstalledPluginEntry = Readonly<{
    pluginId: string;
    title: string;
    description: string | null;
    version: string;
    enabled: boolean;
    source: Readonly<{
        kind: string;
        locator: string;
        trustPolicy?: string;
        installPolicy?: string;
        resolvedPath?: string;
        resolvedDigest?: string | null;
    }>;
    install: Readonly<{
        mode: string;
        manifestVersion: string;
        manifestDigest?: string | null;
        installedPath?: string | null;
    }>;
    compatibility: Readonly<{
        status: string;
        diagnostics: readonly InstalledPluginDiagnostic[];
    }>;
    diagnostics: readonly InstalledPluginDiagnostic[];
}>;

export type PluginMarketplaceActionRequest = Readonly<{
    method: 'install' | 'update' | 'enable' | 'disable' | 'reload';
    pluginId: string;
    sourceUrl?: string;
}>;

type MarketplaceCapabilitySnapshot = Readonly<{
    response: {
        protocolVersion: 1;
        results: Partial<Record<CapabilityId, Readonly<{
            ok: true;
            checkedAt: number;
            data?: { installedPlugins?: readonly InstalledPluginEntry[] } | null;
        }>>>;
    };
}>;

export function resolvePluginMarketplaceErrorMessage(error: unknown): string {
    if (error instanceof Error && error.message.trim().length > 0) {
        return error.message;
    }
    return t('errors.unknownError');
}

export function readInstalledPlugins(
    state: ReturnType<typeof useMachineCapabilitiesCache>['state'],
): readonly InstalledPluginEntry[] {
    const snapshot = state.status === 'loaded' || state.status === 'loading' || state.status === 'error'
        ? state.snapshot
        : null;
    if (!snapshot) return [];

    const toolPlugins = (snapshot as MarketplaceCapabilitySnapshot).response.results[MARKETPLACE_CAPABILITY_ID];
    if (!toolPlugins?.ok || !toolPlugins.data || typeof toolPlugins.data !== 'object') return [];

    const installedPlugins = toolPlugins.data.installedPlugins;
    return Array.isArray(installedPlugins) ? installedPlugins : [];
}

export function formatCatalogEntryVersion(version: string | null): string | undefined {
    return version ?? undefined;
}

function normalizeSourceUrl(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

export function resolveInstalledPluginUpdateSourceUrl(installed: InstalledPluginEntry): string | null {
    if (installed.source.kind !== 'catalog') {
        return null;
    }
    return normalizeSourceUrl(installed.source.locator);
}

export function isCatalogAuthoritativeForInstalledPlugin(
    installed: InstalledPluginEntry,
    catalog: PluginMarketplaceCatalog | null,
): boolean {
    const updateSourceUrl = resolveInstalledPluginUpdateSourceUrl(installed);
    const catalogSourceUrl = normalizeSourceUrl(catalog?.sourceUrl);
    return updateSourceUrl !== null && catalogSourceUrl !== null && updateSourceUrl === catalogSourceUrl;
}

export function readInstalledPluginCatalogVersion(
    installed: InstalledPluginEntry,
    catalog: PluginMarketplaceCatalog | null,
): string | null {
    if (!isCatalogAuthoritativeForInstalledPlugin(installed, catalog)) {
        return null;
    }
    return catalog?.entries.find((entry) => entry.id === installed.pluginId)?.version ?? null;
}

export function isUpdateAvailable(installed: InstalledPluginEntry, catalog: PluginMarketplaceCatalog | null): boolean {
    const remoteVersion = readInstalledPluginCatalogVersion(installed, catalog);
    if (!remoteVersion) return false;
    return remoteVersion !== installed.version;
}

export function readCatalogVersion(pluginId: string, catalog: PluginMarketplaceCatalog | null): string | null {
    return catalog?.entries.find((entry) => entry.id === pluginId)?.version ?? null;
}

export function formatInstalledSubtitle(entry: InstalledPluginEntry): string {
    const diagnostics = [...entry.diagnostics, ...entry.compatibility.diagnostics];
    const parts = [
        entry.enabled ? t('common.enabled') : t('common.disabled'),
        `${entry.source.kind}: ${entry.source.locator}`,
    ];
    if (entry.compatibility.status !== 'compatible') {
        parts.push(entry.compatibility.status);
    }
    if (diagnostics.length > 0) {
        parts.push(diagnostics[0].message);
    }
    return parts.join(' | ');
}

export function formatCatalogSubtitle(params: Readonly<{
    catalog: PluginMarketplaceCatalog;
    installed: InstalledPluginEntry | null;
}>): string {
    if (!params.installed) {
        return params.catalog.description ?? t('deps.ui.notInstalled');
    }

    const installedVersion = params.installed.version;
    const remoteVersion = readInstalledPluginCatalogVersion(params.installed, params.catalog);
    if (remoteVersion && remoteVersion !== installedVersion) {
        return t('deps.ui.installedUpdateAvailable', { installedVersion, latestVersion: remoteVersion });
    }

    return t('deps.ui.installedWithVersion', { version: installedVersion });
}
