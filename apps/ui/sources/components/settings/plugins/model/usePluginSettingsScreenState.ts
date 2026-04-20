import * as React from 'react';

import { usePrimaryMachineFromActiveSelection } from '@/components/settings/server/hooks/usePrimaryMachineFromActiveSelection';
import { useMachineCapabilitiesCache } from '@/hooks/server/useMachineCapabilitiesCache';
import { useMachineCapabilityInvokeWithAlerts } from '@/hooks/machine/useMachineCapabilityInvokeWithAlerts';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { getActiveServerId } from '@/sync/domains/server/serverProfiles';
import {
    machineMarketplaceSourceRegistryGet,
    resolvePreferredMachineMarketplaceSource,
} from '@/sync/ops/machineMarketplaceSources';
import { type MarketplaceSourceRegistryV1 } from '@happier-dev/protocol';
import { t } from '@/text';

import { readPluginMarketplaceCatalog, type PluginMarketplaceCatalog } from '../readPluginMarketplaceCatalog';
import {
    MARKETPLACE_CAPABILITY_ID,
    readInstalledPlugins,
    resolveInstalledPluginUpdateSourceUrl,
    resolvePluginMarketplaceErrorMessage,
    type InstalledPluginEntry,
    type PluginMarketplaceActionRequest,
    isUpdateAvailable,
    readInstalledPluginCatalogVersion,
} from './pluginMarketplaceModel';

export type InstalledPluginUpdateState = Readonly<{
    canUpdate: boolean;
    sourceUrl: string | null;
    updateAvailable: boolean;
    catalogVersion: string | null;
}>;

export type PluginSettingsScreenState = Readonly<{
    activeServerId: string;
    primaryMachineId: string | null;
    catalog: PluginMarketplaceCatalog | null;
    catalogError: string | null;
    catalogUrl: string;
    canLoadCatalog: boolean;
    canRefreshInstalledPlugins: boolean;
    installedPluginById: ReadonlyMap<string, InstalledPluginEntry>;
    installedPlugins: readonly InstalledPluginEntry[];
    isPluginActionInFlight: (pluginId: string) => boolean;
    loadCatalog: () => Promise<void>;
    loadedCatalogFooter: string;
    loadedCatalogTitle: string;
    loadingCatalog: boolean;
    pluginProjectionById: ReturnType<typeof useDaemonMergedProjectionInputs>['inputs'] extends infer TInputs
        ? TInputs extends { pluginProjectionById: infer TProjectionById }
            ? TProjectionById
            : Record<string, never>
        : Record<string, never>;
    readInstalledPluginUpdateState: (pluginId: string) => InstalledPluginUpdateState;
    registryDiagnostics: ReturnType<typeof useDaemonMergedProjectionInputs>['inputs'] extends infer TInputs
        ? TInputs extends { registryDiagnostics: infer TDiagnostics }
            ? TDiagnostics
            : readonly []
        : readonly [];
    resolvedCatalogUrl: string;
    runCatalogAction: (params: PluginMarketplaceActionRequest) => void;
    runInstalledPluginAction: (action: 'reload' | 'update' | 'enable' | 'disable', pluginId: string) => void;
    setCatalogUrl: (value: string) => void;
}>;

export function usePluginSettingsScreenState(): PluginSettingsScreenState {
    const primaryMachineId = usePrimaryMachineFromActiveSelection();
    const activeServerId = getActiveServerId();
    const { invokeWithAlerts } = useMachineCapabilityInvokeWithAlerts();
    const selectedMachineScopeKey = primaryMachineId ? `${activeServerId}:${primaryMachineId}` : null;

    const [catalogUrl, setCatalogUrlState] = React.useState('');
    const [catalog, setCatalog] = React.useState<PluginMarketplaceCatalog | null>(null);
    const [loadingCatalog, setLoadingCatalog] = React.useState(false);
    const [catalogError, setCatalogError] = React.useState<string | null>(null);
    const [marketplaceSourceRegistry, setMarketplaceSourceRegistry] = React.useState<MarketplaceSourceRegistryV1 | null>(null);
    const [projectionRefreshKey, setProjectionRefreshKey] = React.useState(0);
    const [pluginActionCountById, setPluginActionCountById] = React.useState<Readonly<Record<string, number>>>({});

    const catalogRequestIdRef = React.useRef(0);
    const marketplaceSourceRegistryRequestIdRef = React.useRef(0);
    const catalogUrlTouchedRef = React.useRef(false);
    const lastSelectedMachineScopeKeyRef = React.useRef<string | null>(selectedMachineScopeKey);

    const capabilityRequest = React.useMemo(() => ({
        requests: [{ id: MARKETPLACE_CAPABILITY_ID }],
    }), []);

    const machineCapabilities = useMachineCapabilitiesCache({
        machineId: primaryMachineId ?? null,
        serverId: activeServerId,
        enabled: Boolean(primaryMachineId),
        request: capabilityRequest,
        timeoutMs: 12_000,
    });
    const daemonMergedProjection = useDaemonMergedProjectionInputs({
        machineId: primaryMachineId ?? null,
        serverId: activeServerId,
        enabled: Boolean(primaryMachineId),
        refreshKey: projectionRefreshKey,
    });

    const installedPlugins = React.useMemo(() => readInstalledPlugins(machineCapabilities.state), [machineCapabilities.state]);
    const installedPluginById = React.useMemo(
        () => new Map(installedPlugins.map((entry) => [entry.pluginId, entry] as const)),
        [installedPlugins],
    );
    const pluginProjectionById = daemonMergedProjection.inputs?.pluginProjectionById ?? {};
    const registryDiagnostics = daemonMergedProjection.inputs?.registryDiagnostics ?? [];
    const preferredMarketplaceSource = React.useMemo(() => {
        if (!marketplaceSourceRegistry) return null;
        return resolvePreferredMachineMarketplaceSource(marketplaceSourceRegistry);
    }, [marketplaceSourceRegistry]);
    const resolvedCatalogUrl = React.useMemo(() => {
        return catalogUrl.trim() || preferredMarketplaceSource?.sourceUrl?.trim() || '';
    }, [catalogUrl, preferredMarketplaceSource]);
    const canRefreshInstalledPlugins = Boolean(primaryMachineId);
    const canLoadCatalog = resolvedCatalogUrl.length > 0 && !loadingCatalog;
    const loadedCatalogTitle = catalog?.title ?? t('settingsPlugins.title');
    const loadedCatalogFooter = catalog?.description ?? t('settingsPlugins.emptySubtitle');

    React.useEffect(() => {
        if (lastSelectedMachineScopeKeyRef.current === selectedMachineScopeKey) {
            return;
        }

        lastSelectedMachineScopeKeyRef.current = selectedMachineScopeKey;
        marketplaceSourceRegistryRequestIdRef.current += 1;
        setMarketplaceSourceRegistry(null);
        if (!catalogUrlTouchedRef.current) {
            catalogRequestIdRef.current += 1;
            setLoadingCatalog(false);
            setCatalog(null);
            setCatalogError(null);
            setCatalogUrlState('');
        }
    }, [selectedMachineScopeKey]);

    React.useEffect(() => {
        if (!primaryMachineId) {
            setMarketplaceSourceRegistry(null);
            return;
        }

        const requestId = ++marketplaceSourceRegistryRequestIdRef.current;
        void (async () => {
            try {
                const nextRegistry = await machineMarketplaceSourceRegistryGet(primaryMachineId, {
                    serverId: activeServerId,
                });
                if (marketplaceSourceRegistryRequestIdRef.current !== requestId) return;
                setMarketplaceSourceRegistry(nextRegistry);
            } catch {
                if (marketplaceSourceRegistryRequestIdRef.current !== requestId) return;
                setMarketplaceSourceRegistry(null);
            }
        })();
    }, [activeServerId, primaryMachineId]);

    React.useEffect(() => {
        if (catalogUrlTouchedRef.current) return;
        if (!preferredMarketplaceSource?.sourceUrl) return;
        const nextUrl = preferredMarketplaceSource.sourceUrl.trim();
        if (!nextUrl || catalogUrl.trim() === nextUrl) return;
        setCatalogUrlState(nextUrl);
    }, [catalogUrl, preferredMarketplaceSource]);

    const setCatalogUrl = React.useCallback((value: string) => {
        catalogUrlTouchedRef.current = true;
        setCatalogUrlState(value);
    }, []);

    const markPluginActionStarted = React.useCallback((pluginId: string) => {
        setPluginActionCountById((prev) => ({
            ...prev,
            [pluginId]: (prev[pluginId] ?? 0) + 1,
        }));
    }, []);

    const markPluginActionFinished = React.useCallback((pluginId: string) => {
        setPluginActionCountById((prev) => {
            const nextCount = (prev[pluginId] ?? 0) - 1;
            if (nextCount > 0) {
                return { ...prev, [pluginId]: nextCount };
            }
            const nextState = { ...prev };
            delete nextState[pluginId];
            return nextState;
        });
    }, []);

    const isPluginActionInFlight = React.useCallback((pluginId: string) => {
        return (pluginActionCountById[pluginId] ?? 0) > 0;
    }, [pluginActionCountById]);

    const runCatalogAction = React.useCallback((params: PluginMarketplaceActionRequest) => {
        if (!primaryMachineId) {
            return;
        }

        void (async () => {
            markPluginActionStarted(params.pluginId);
            try {
                const response = await invokeWithAlerts({
                    machineId: primaryMachineId,
                    serverId: activeServerId,
                    request: {
                        id: MARKETPLACE_CAPABILITY_ID,
                        method: params.method,
                        params: {
                            pluginId: params.pluginId,
                            ...(params.sourceUrl ? { sourceUrl: params.sourceUrl } : {}),
                        },
                    },
                    timeoutMs: 5 * 60_000,
                    alerts: {
                        errorTitle: t('common.error'),
                        successTitle: t('common.success'),
                        unsupportedMessage: (reason) => reason === 'not-supported' ? t('common.unavailable') : t('common.requestFailed'),
                        successMessage: t('common.done'),
                    },
                });

                if (!('response' in response)) {
                    return;
                }
                if (response.response.ok) {
                    machineCapabilities.refresh({ bypassCache: true });
                    setProjectionRefreshKey((prev) => prev + 1);
                }
            } finally {
                markPluginActionFinished(params.pluginId);
            }
        })();
    }, [activeServerId, invokeWithAlerts, machineCapabilities, markPluginActionFinished, markPluginActionStarted, primaryMachineId]);

    const runInstalledPluginAction = React.useCallback((action: 'reload' | 'update' | 'enable' | 'disable', pluginId: string) => {
        const installed = installedPluginById.get(pluginId) ?? null;
        if (!installed) {
            return;
        }
        const sourceUrl = action === 'update' ? resolveInstalledPluginUpdateSourceUrl(installed) : null;
        if (action === 'update' && !sourceUrl) {
            return;
        }
        runCatalogAction({
            method: action,
            pluginId,
            ...(sourceUrl ? { sourceUrl } : {}),
        });
    }, [installedPluginById, runCatalogAction]);

    const loadCatalog = React.useCallback(async () => {
        const nextUrl = resolvedCatalogUrl.trim();
        if (!nextUrl || loadingCatalog) {
            return;
        }

        const requestId = ++catalogRequestIdRef.current;
        setLoadingCatalog(true);
        setCatalogError(null);

        try {
            const nextCatalog = await readPluginMarketplaceCatalog(nextUrl);
            if (catalogRequestIdRef.current !== requestId) return;
            setCatalog(nextCatalog);
        } catch (error) {
            if (catalogRequestIdRef.current !== requestId) return;
            setCatalogError(resolvePluginMarketplaceErrorMessage(error));
        } finally {
            if (catalogRequestIdRef.current === requestId) {
                setLoadingCatalog(false);
            }
        }
    }, [loadingCatalog, resolvedCatalogUrl]);

    const readInstalledPluginUpdateState = React.useCallback((pluginId: string): InstalledPluginUpdateState => {
        const installed = installedPluginById.get(pluginId) ?? null;
        if (!installed) {
            return {
                canUpdate: false,
                sourceUrl: null,
                updateAvailable: false,
                catalogVersion: null,
            };
        }

        const sourceUrl = resolveInstalledPluginUpdateSourceUrl(installed);
        const catalogVersion = readInstalledPluginCatalogVersion(installed, catalog);
        return {
            canUpdate: sourceUrl !== null,
            sourceUrl,
            updateAvailable: isUpdateAvailable(installed, catalog),
            catalogVersion,
        };
    }, [catalog, installedPluginById]);

    return {
        activeServerId,
        primaryMachineId,
        catalog,
        catalogError,
        catalogUrl,
        canLoadCatalog,
        canRefreshInstalledPlugins,
        installedPluginById,
        installedPlugins,
        isPluginActionInFlight,
        loadCatalog,
        loadedCatalogFooter,
        loadedCatalogTitle,
        loadingCatalog,
        pluginProjectionById,
        readInstalledPluginUpdateState,
        registryDiagnostics,
        resolvedCatalogUrl,
        runCatalogAction,
        runInstalledPluginAction,
        setCatalogUrl,
    };
}
