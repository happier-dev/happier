import * as React from 'react';
import { usePathname } from 'expo-router';
import Fuse from 'fuse.js';

import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useLocalSetting, useSetting } from '@/sync/domains/state/storage';
import { getPreferredLanguage, t } from '@/text';
import { isTauriDesktop } from '@/utils/platform/tauri';
import { useAppShellPluginUiProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';

import { SETTINGS_PAGE_CATALOG, flattenSettingsPageCatalog } from '../pageCatalog';
import { SETTINGS_ROUTES } from '../routes';
import type { ResolvedSettingsPageNode, SettingsPageId, SettingsPageNode, SettingsPageSearchResult } from '../types';
import { mergeAdmittedPluginSettingsPages } from './pluginSettingsPageCatalog';

type ResolvedCatalog = Readonly<{
    tree: readonly ResolvedSettingsPageNode[];
    activePageId: SettingsPageId | null;
    search: (query: string) => readonly SettingsPageSearchResult[];
}>;

type SettingsPageSearchDoc = Readonly<{
    id: SettingsPageId;
    route: string;
    title: string;
    subtitle: string;
    keywords: readonly string[];
    pathTokens: readonly string[];
}>;

function resolveGateVisibility(node: SettingsPageNode, ctx: Readonly<{
    useProfiles: boolean;
    devModeEnabled: boolean;
    tauriDesktop: boolean;
    features: Readonly<Record<string, boolean>>;
}>): boolean {
    const gate = node.gate;
    if (!gate) return true;
    if (gate.featureId && ctx.features[gate.featureId] !== true) return false;
    if (gate.requiresProfiles && !ctx.useProfiles) return false;
    if (gate.requiresDevMode && !ctx.devModeEnabled) return false;
    if (gate.requiresTauriDesktop && !ctx.tauriDesktop) return false;
    return true;
}

function resolveTree(nodes: readonly SettingsPageNode[], ctx: Readonly<{
    useProfiles: boolean;
    devModeEnabled: boolean;
    tauriDesktop: boolean;
    features: Readonly<Record<string, boolean>>;
}>): ResolvedSettingsPageNode[] {
    const out: ResolvedSettingsPageNode[] = [];
    for (const node of nodes) {
        if (!resolveGateVisibility(node, ctx)) continue;
        const children = node.children ? resolveTree(node.children, ctx) : undefined;
        out.push({
            id: node.id,
            titleKey: node.titleKey,
            title: node.title ?? (node.titleKey ? String(t(node.titleKey)) : node.id),
            subtitleKey: node.subtitleKey,
            ...(node.subtitle
                ? { subtitle: node.subtitle }
                : node.subtitleKey
                    ? { subtitle: String(t(node.subtitleKey)) }
                    : {}),
            route: node.route,
            keywords: node.keywords ?? [],
            icon: node.icon,
            pluginSettingsPage: node.pluginSettingsPage,
            ...(children && children.length > 0 ? { children } : {}),
        });
    }
    return out;
}

function flattenResolvedTree(nodes: readonly ResolvedSettingsPageNode[]): ResolvedSettingsPageNode[] {
    const out: ResolvedSettingsPageNode[] = [];
    const visit = (items: readonly ResolvedSettingsPageNode[]) => {
        for (const item of items) {
            out.push(item);
            if (item.children) {
                visit(item.children);
            }
        }
    };
    visit(nodes);
    return out;
}

function buildSearchDocs(nodes: readonly ResolvedSettingsPageNode[]): SettingsPageSearchDoc[] {
    const out: SettingsPageSearchDoc[] = [];
    const visit = (items: readonly ResolvedSettingsPageNode[], ancestors: readonly string[]) => {
        for (const item of items) {
            const title = item.title ?? (item.titleKey ? String(t(item.titleKey)) : item.id);
            const subtitle = item.subtitle ?? (item.subtitleKey ? String(t(item.subtitleKey)) : '');
            const nextAncestors = title ? [...ancestors, title] : ancestors;

            if (typeof item.route === 'string' && item.route.length > 0) {
                out.push({
                    id: item.id,
                    route: item.route,
                    title,
                    subtitle,
                    keywords: item.keywords ?? [],
                    pathTokens: ancestors,
                });
            }

            if (item.children) {
                visit(item.children, nextAncestors);
            }
        }
    };

    visit(nodes, []);
    return out;
}

function pathnameIsAtOrBelowRoute(pathname: string, route: string): boolean {
    return pathname === route || pathname.startsWith(`${route}/`);
}

function isQualifiedPluginSettingsPagePathname(pathname: string): boolean {
    const prefix = `${SETTINGS_ROUTES.plugins}/`;
    if (!pathname.startsWith(prefix)) return false;
    return pathname.slice(prefix.length).split('/').filter(Boolean).length >= 2;
}

function resolveActivePageIdFromPathname(
    pathname: string,
    flat: readonly ResolvedSettingsPageNode[]
): SettingsPageId | null {
    const exact = flat.find((node) => node.route && node.route === pathname);
    if (exact) return exact.id;

    // The generic plugin Settings route is a qualified leaf identity. If its
    // admission has retired, retain no active catalog page instead of making
    // the unavailable route look like an admitted page or the Marketplace.
    if (isQualifiedPluginSettingsPagePathname(pathname)) return null;

    // Fallback: choose the longest Settings route on a segment boundary. The
    // Settings overview is an exact-only index page, not an owner for every
    // unmatched /settings child route.
    let best: ResolvedSettingsPageNode | null = null;
    for (const node of flat) {
        if (!node.route || node.route === SETTINGS_ROUTES.general) continue;
        if (!pathnameIsAtOrBelowRoute(pathname, node.route)) continue;
        if (!best || (best.route && node.route.length > best.route.length)) {
            best = node;
        }
    }
    return best?.id ?? null;
}

export function useResolvedSettingsPageCatalog(): ResolvedCatalog {
    const pathname = usePathname();
    const appShellPluginUiProjection = useAppShellPluginUiProjection();
    const useProfiles = Boolean(useSetting('useProfiles'));
    const devModeEnabled = Boolean(useLocalSetting('devModeEnabled'));
    const tauriDesktop = isTauriDesktop();

    const usageReportingEnabled = useFeatureEnabled('usage.reporting');
    const executionRunsEnabled = useFeatureEnabled('execution.runs');
    const memorySearchEnabled = useFeatureEnabled('memory.search');
    const voiceEnabled = useFeatureEnabled('voice');
    const sourceControlEnabled = useFeatureEnabled('scm.writeOperations');
    const attachmentsUploadsEnabled = useFeatureEnabled('attachments.uploads');
    const promptsLibraryEnabled = useFeatureEnabled('prompts.library');
    const mcpServersEnabled = useFeatureEnabled('mcp.servers');
    const petsCompanionEnabled = useFeatureEnabled('pets.companion');
    const remoteHostsManagementEnabled = useFeatureEnabled('remoteHosts.management');
    const providersEnabled = useFeatureEnabled('providers');
    const externalSessionsEnabled = useFeatureEnabled('sessions.direct');
    const locale = getPreferredLanguage();

    const featureSnapshot = React.useMemo(() => {
        return {
            'usage.reporting': usageReportingEnabled,
            'execution.runs': executionRunsEnabled,
            'memory.search': memorySearchEnabled,
            voice: voiceEnabled,
            'scm.writeOperations': sourceControlEnabled,
            'attachments.uploads': attachmentsUploadsEnabled,
            'prompts.library': promptsLibraryEnabled,
            'mcp.servers': mcpServersEnabled,
            'pets.companion': petsCompanionEnabled,
            'remoteHosts.management': remoteHostsManagementEnabled,
            providers: providersEnabled,
            'sessions.direct': externalSessionsEnabled,
        } as const;
    }, [
        attachmentsUploadsEnabled,
        executionRunsEnabled,
        externalSessionsEnabled,
        mcpServersEnabled,
        memorySearchEnabled,
        petsCompanionEnabled,
        promptsLibraryEnabled,
        providersEnabled,
        remoteHostsManagementEnabled,
        sourceControlEnabled,
        usageReportingEnabled,
        voiceEnabled,
    ]);

    const tree = React.useMemo(() => {
        const catalog = mergeAdmittedPluginSettingsPages({
            baseCatalog: SETTINGS_PAGE_CATALOG,
            projection: appShellPluginUiProjection.pluginUiProjection,
            locale,
        });
        return resolveTree(catalog, {
            useProfiles,
            devModeEnabled,
            tauriDesktop,
            features: featureSnapshot,
        });
    }, [
        appShellPluginUiProjection.pluginUiProjection,
        devModeEnabled,
        featureSnapshot,
        locale,
        tauriDesktop,
        useProfiles,
    ]);

    const flat = React.useMemo(() => flattenResolvedTree(tree), [tree]);

    const activePageId = React.useMemo(() => {
        return resolveActivePageIdFromPathname(pathname ?? '/', flat);
    }, [flat, pathname]);

    const searchDocs = React.useMemo(() => buildSearchDocs(tree), [tree]);

    const fuse = React.useMemo(() => {
        return new Fuse(searchDocs, {
            includeScore: false,
            ignoreLocation: true,
            threshold: 0.35,
            keys: [
                { name: 'title', weight: 0.6 },
                { name: 'keywords', weight: 0.3 },
                { name: 'pathTokens', weight: 0.2 },
                { name: 'subtitle', weight: 0.1 },
            ],
        });
    }, [searchDocs]);

    const search = React.useCallback((query: string): readonly SettingsPageSearchResult[] => {
        const q = String(query ?? '').trim().toLowerCase();
        if (!q) return [];

        return fuse.search(q, { limit: 20 }).map((result) => ({
            id: result.item.id,
            route: result.item.route,
        }));
    }, [fuse]);

    return {
        tree,
        activePageId,
        search,
    };
}

export const __testables = {
    flattenSettingsPageCatalog,
};
