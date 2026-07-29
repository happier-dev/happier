import * as React from 'react';
import {
    PLUGIN_SESSION_HOOK_STATUS_INVENTORY_MAX_ROWS,
    type PluginSessionHookInstallInputV1,
    type PluginSessionHookInstallResponseV1,
    type PluginSessionHookInstallationMutationInputV1,
    type PluginSessionHookInstallationStatusV1,
    type PluginSessionHookStatusInputV1,
    type PluginSessionHookStatusResponseV1,
    type PluginSessionHookToggleResponseV1,
    type PluginSessionHookUninstallResponseV1,
} from '@happier-dev/protocol';

import {
    machinePluginSessionHookDisable,
    machinePluginSessionHookEnable,
    machinePluginSessionHookInstall,
    machinePluginSessionHookStatusGet,
    machinePluginSessionHookUninstall,
} from '@/sync/ops/machinePluginSessionHooks';

import {
    isExternalSessionsIntegrationInventoryActionable,
    type ExternalSessionsIntegrationDescriptor,
    type ExternalSessionsIntegrationOperations,
    type ExternalSessionsQualifiedAgent,
} from './externalSessionsIntegrationModel';

type ServerScoped<TInput> = Readonly<TInput & { serverId?: string | null }>;
type ExternalSessionsInventoryRefreshIntent =
    Extract<
        PluginSessionHookStatusInputV1['intent'],
        'passive_inventory' | 'install_preview' | 'installation_recheck'
    >;
const EXTERNAL_SESSIONS_STATUS_INVENTORY_MAX_PAGES = 50;

export type ExternalSessionsHookManagementTransport = Readonly<{
    status: (
        input: ServerScoped<PluginSessionHookStatusInputV1>,
    ) => Promise<PluginSessionHookStatusResponseV1>;
    install: (
        input: ServerScoped<PluginSessionHookInstallInputV1>,
    ) => Promise<PluginSessionHookInstallResponseV1>;
    disable: (
        input: ServerScoped<PluginSessionHookInstallationMutationInputV1>,
    ) => Promise<PluginSessionHookToggleResponseV1>;
    enable: (
        input: ServerScoped<PluginSessionHookInstallationMutationInputV1>,
    ) => Promise<PluginSessionHookToggleResponseV1>;
    uninstall: (
        input: ServerScoped<PluginSessionHookInstallationMutationInputV1>,
    ) => Promise<PluginSessionHookUninstallResponseV1>;
}>;

export type ExternalSessionsKnownAgent = Readonly<{
    agent: ExternalSessionsQualifiedAgent;
    agentTitle: string;
}>;

export type ExternalSessionsIntegrationInventoryState = Readonly<{
    status: 'idle' | 'loading' | 'ready' | 'partial' | 'error';
    diagnosticCodes: readonly string[];
}>;

export type ExternalSessionsIntegrationControllerState = Readonly<{
    integrations: readonly ExternalSessionsIntegrationDescriptor[] | null;
    operations: ExternalSessionsIntegrationOperations | null;
    inventoryState: ExternalSessionsIntegrationInventoryState;
    retryInventory: () => Promise<void>;
}>;

export const machineExternalSessionsHookManagementTransport: ExternalSessionsHookManagementTransport = {
    status: machinePluginSessionHookStatusGet,
    install: machinePluginSessionHookInstall,
    disable: machinePluginSessionHookDisable,
    enable: machinePluginSessionHookEnable,
    uninstall: machinePluginSessionHookUninstall,
};

function integrationKey(
    machineId: string,
    agent: ExternalSessionsQualifiedAgent,
    status: PluginSessionHookInstallationStatusV1,
    nonInstallationOrdinal: number,
): string {
    const statusIdentity = 'installationId' in status && status.installationId
        ? `installation:${status.installationId}`
        : `status:${status.state}:${nonInstallationOrdinal}`;
    return [machineId, agent.pluginId, agent.localId, statusIdentity].join('\u0000');
}

function sameAgent(
    left: ExternalSessionsQualifiedAgent,
    right: ExternalSessionsQualifiedAgent,
): boolean {
    return left.pluginId === right.pluginId && left.localId === right.localId;
}

function fallbackAgentTitle(agent: ExternalSessionsQualifiedAgent): string {
    return `${agent.localId} (${agent.pluginId})`;
}

type ExternalSessionsIntegrationInventoryLoadResult = Readonly<{
    status: 'ready' | 'partial' | 'error';
    integrations: readonly ExternalSessionsIntegrationDescriptor[];
    diagnosticCodes: readonly string[];
}>;

async function loadExternalSessionsIntegrationInventory(params: Readonly<{
    machineId: string;
    intent?: ExternalSessionsInventoryRefreshIntent;
    installationId?: string;
    serverId?: string | null;
    agent?: ExternalSessionsKnownAgent | null;
    knownAgents?: readonly ExternalSessionsKnownAgent[];
    transport?: ExternalSessionsHookManagementTransport;
}>): Promise<ExternalSessionsIntegrationInventoryLoadResult> {
    const transport = params.transport ?? machineExternalSessionsHookManagementTransport;
    const rows: ExternalSessionsIntegrationDescriptor[] = [];
    try {
        const seenCursors = new Set<string>();
        const diagnosticCodes = new Set<string>();
        const nonInstallationCountByAgentState = new Map<string, number>();
        let cursor: string | undefined;
        let pageCount = 0;
        do {
            pageCount += 1;
            if (pageCount > EXTERNAL_SESSIONS_STATUS_INVENTORY_MAX_PAGES) {
                return {
                    status: 'error',
                    integrations: rows,
                    diagnosticCodes: [
                        ...diagnosticCodes,
                        'inventory_page_limit_exceeded',
                    ],
                };
            }
            const common = {
                machineId: params.machineId,
                serverId: params.serverId,
                ...(cursor ? { cursor } : {}),
                limit: PLUGIN_SESSION_HOOK_STATUS_INVENTORY_MAX_ROWS,
            };
            const result = params.intent === 'install_preview'
                ? params.agent
                    ? await transport.status({
                        machineId: params.machineId,
                        serverId: params.serverId,
                        intent: 'install_preview',
                        agent: params.agent.agent,
                    })
                    : {
                        ok: false as const,
                        diagnostic: {
                            code: 'operation_failed' as const,
                            retryable: false,
                        },
                    }
                : params.intent === 'installation_recheck'
                    ? params.agent && params.installationId
                        ? await transport.status({
                            machineId: params.machineId,
                            serverId: params.serverId,
                            intent: 'installation_recheck',
                            agent: params.agent.agent,
                            installationId: params.installationId,
                        })
                        : {
                            ok: false as const,
                            diagnostic: {
                                code: 'operation_failed' as const,
                                retryable: false,
                            },
                        }
                    : await transport.status({
                        ...common,
                        intent: 'passive_inventory',
                        ...(params.agent ? { agent: params.agent.agent } : {}),
                    });
            if (!result.ok) {
                return {
                    status: 'error',
                    integrations: rows,
                    diagnosticCodes: [result.diagnostic.code],
                };
            }
            rows.push(...result.rows.map((row) => {
                const projectedAgent = params.knownAgents?.find((knownAgent) => (
                    sameAgent(knownAgent.agent, row.agent)
                )) ?? null;
                const nonInstallationGroupKey = [
                    row.agent.pluginId,
                    row.agent.localId,
                    row.status.state,
                ].join('\u0000');
                const nonInstallationOrdinal =
                    nonInstallationCountByAgentState.get(nonInstallationGroupKey) ?? 0;
                if (!('installationId' in row.status) || !row.status.installationId) {
                    nonInstallationCountByAgentState.set(
                        nonInstallationGroupKey,
                        nonInstallationOrdinal + 1,
                    );
                }
                return {
                    key: integrationKey(
                        params.machineId,
                        row.agent,
                        row.status,
                        nonInstallationOrdinal,
                    ),
                    machineId: params.machineId,
                    agent: row.agent,
                    agentTitle: params.agent && sameAgent(params.agent.agent, row.agent)
                        ? params.agent.agentTitle
                        : projectedAgent?.agentTitle ?? fallbackAgentTitle(row.agent),
                    ...row.status,
                } satisfies ExternalSessionsIntegrationDescriptor;
            }));
            for (const diagnostic of result.diagnostics) {
                diagnosticCodes.add(diagnostic.code);
            }
            if (params.intent && params.intent !== 'passive_inventory') {
                if (
                    rows.length !== 1
                    || result.nextCursor !== null
                    || result.diagnostics.length > 0
                ) {
                    return {
                        status: 'error',
                        integrations: [],
                        diagnosticCodes: ['operation_failed'],
                    };
                }
                break;
            }
            if (result.nextCursor === null) break;
            if (seenCursors.has(result.nextCursor)) {
                return {
                    status: 'error',
                    integrations: rows,
                    diagnosticCodes: [
                        ...diagnosticCodes,
                        'inventory_cursor_repeated',
                    ],
                };
            }
            seenCursors.add(result.nextCursor);
            cursor = result.nextCursor;
        } while (cursor);
        return {
            status: diagnosticCodes.size > 0 ? 'partial' : 'ready',
            integrations: rows,
            diagnosticCodes: [...diagnosticCodes],
        };
    } catch {
        return {
            status: 'error',
            integrations: rows,
            diagnosticCodes: ['operation_failed'],
        };
    }
}

export async function refreshExternalSessionsIntegrationStatuses(params: Readonly<{
    machineId: string;
    serverId?: string | null;
    agent?: ExternalSessionsKnownAgent | null;
    knownAgents?: readonly ExternalSessionsKnownAgent[];
    transport?: ExternalSessionsHookManagementTransport;
}>): Promise<ExternalSessionsIntegrationDescriptor[] | null> {
    const result = await loadExternalSessionsIntegrationInventory(params);
    return result.status === 'ready' ? [...result.integrations] : null;
}

function requireInstallationId(integration: ExternalSessionsIntegrationDescriptor): string {
    if (
        !('installationId' in integration)
        || typeof integration.installationId !== 'string'
        || integration.installationId.length === 0
    ) {
        throw new Error('external_session_hook_installation_missing');
    }
    return integration.installationId;
}

function assertMutationSucceeded(
    result:
        | PluginSessionHookInstallResponseV1
        | PluginSessionHookToggleResponseV1
        | PluginSessionHookUninstallResponseV1,
): void {
    if (!result.ok) {
        throw new Error(result.diagnostic.code);
    }
}

export function createExternalSessionsIntegrationOperations(params: Readonly<{
    serverId?: string | null;
    transport?: ExternalSessionsHookManagementTransport;
    refresh: (
        integration: ExternalSessionsIntegrationDescriptor,
        intent?: ExternalSessionsInventoryRefreshIntent,
    ) => void | Promise<void>;
    applyStatus: (
        integration: ExternalSessionsIntegrationDescriptor,
        status: PluginSessionHookInstallationStatusV1,
    ) => void;
    startRequest?: () => () => boolean;
    isCurrentScope?: () => boolean;
}>): ExternalSessionsIntegrationOperations {
    const transport = params.transport ?? machineExternalSessionsHookManagementTransport;

    async function toggle(
        integration: ExternalSessionsIntegrationDescriptor,
        operation: (
            input: ServerScoped<PluginSessionHookInstallationMutationInputV1>,
        ) => Promise<PluginSessionHookToggleResponseV1>,
    ): Promise<void> {
        const result = await operation({
            machineId: integration.machineId,
            serverId: params.serverId,
            agent: integration.agent,
            installationId: requireInstallationId(integration),
        });
        if (params.isCurrentScope && !params.isCurrentScope()) return;
        assertMutationSucceeded(result);
        if (result.ok) params.applyStatus(integration, result.status);
    }

    return {
        reviewAndInstall: async (integration, confirm) => {
            const mayRequestPreview = integration.state === 'not_installed'
                || (
                    integration.state === 'needs_attention'
                    && !integration.installationId
                );
            if (!mayRequestPreview) {
                throw new Error(
                    'external_session_hook_install_preview_unavailable',
                );
            }
            const requestIsCurrent = params.startRequest?.() ?? (() => true);
            const previewResult =
                await loadExternalSessionsIntegrationInventory({
                    machineId: integration.machineId,
                    intent: 'install_preview',
                    serverId: params.serverId,
                    agent: {
                        agent: integration.agent,
                        agentTitle: integration.agentTitle,
                    },
                    transport,
                });
            if (!requestIsCurrent()) return;
            if (
                previewResult.status !== 'ready'
                || previewResult.integrations.length !== 1
                || previewResult.integrations[0]!.state
                    !== 'not_installed'
            ) {
                if (
                    previewResult.diagnosticCodes.includes(
                        'concurrent_edit',
                    )
                    || previewResult.diagnosticCodes.includes(
                        'installation_replaced',
                    )
                ) {
                    await params.refresh(integration);
                    return;
                }
                throw new Error(
                    previewResult.diagnosticCodes[0]
                    ?? 'external_session_hook_install_preview_unavailable',
                );
            }
            const candidate = previewResult.integrations[0]!;
            if (
                candidate.state !== 'not_installed'
                || !candidate.installPreview
            ) {
                throw new Error(
                    'external_session_hook_install_preview_unavailable',
                );
            }
            if (!await confirm(candidate.installPreview)) return;
            if (!requestIsCurrent()) return;
            const result = await transport.install({
                machineId: candidate.machineId,
                serverId: params.serverId,
                agent: candidate.agent,
                expectedPreviewId: candidate.installPreview.previewId,
            });
            if (params.isCurrentScope && !params.isCurrentScope()) return;
            if (!result.ok) {
                if (
                    result.diagnostic.code === 'concurrent_edit'
                    || result.diagnostic.code === 'installation_replaced'
                ) {
                    await params.refresh(integration);
                    return;
                }
                throw new Error(result.diagnostic.code);
            }
            params.applyStatus(integration, result.status);
        },
        disable: async (integration) => {
            await toggle(integration, transport.disable);
        },
        enable: async (integration) => {
            await toggle(integration, transport.enable);
        },
        uninstall: async (integration) => {
            const result = await transport.uninstall({
                machineId: integration.machineId,
                serverId: params.serverId,
                agent: integration.agent,
                installationId: requireInstallationId(integration),
            });
            if (params.isCurrentScope && !params.isCurrentScope()) return;
            assertMutationSucceeded(result);
            if (result.ok) params.applyStatus(integration, result.status);
        },
        checkAgain: async (integration) => {
            await params.refresh(integration, 'installation_recheck');
        },
    };
}

function knownAgentSignature(agent: ExternalSessionsKnownAgent | null | undefined): string {
    return agent
        ? [agent.agent.pluginId, agent.agent.localId, agent.agentTitle].join('\u0000')
        : '*';
}

function knownAgentsSignature(agents: readonly ExternalSessionsKnownAgent[] | null | undefined): string {
    return (agents ?? [])
        .map((agent) => knownAgentSignature(agent))
        .sort()
        .join('\u0001');
}

export function useExternalSessionsIntegrationController(params: Readonly<{
    machineId: string | null;
    serverId?: string | null;
    projectionGeneration: string | number | null;
    agent?: ExternalSessionsKnownAgent | null;
    knownAgents?: readonly ExternalSessionsKnownAgent[];
    enabled?: boolean;
    transport?: ExternalSessionsHookManagementTransport;
}>): ExternalSessionsIntegrationControllerState {
    const enabled = params.enabled !== false;
    const agentSignature = knownAgentSignature(params.agent);
    const projectedAgentsSignature = knownAgentsSignature(params.knownAgents);
    const scopeSignature = JSON.stringify([
        enabled,
        params.machineId,
        params.serverId ?? null,
        params.projectionGeneration,
        agentSignature,
        projectedAgentsSignature,
    ]);
    const scopeSignatureRef = React.useRef(scopeSignature);
    scopeSignatureRef.current = scopeSignature;
    const agentRef = React.useRef(params.agent);
    agentRef.current = params.agent;
    const knownAgentsRef = React.useRef(params.knownAgents);
    knownAgentsRef.current = params.knownAgents;
    const requestRevisionRef = React.useRef(0);
    const [integrations, setIntegrations] = React.useState<
        readonly ExternalSessionsIntegrationDescriptor[] | null
    >(null);
    const [loadedMachineId, setLoadedMachineId] = React.useState<string | null>(null);
    const [inventoryState, setInventoryState] =
        React.useState<ExternalSessionsIntegrationInventoryState>({
            status: 'idle',
            diagnosticCodes: [],
        });

    const refresh = React.useCallback(async (
        integration?: ExternalSessionsIntegrationDescriptor,
        intent: ExternalSessionsInventoryRefreshIntent = 'passive_inventory',
    ) => {
        const machineId = params.machineId;
        if (!enabled || !machineId) return;
        const requestRevision = ++requestRevisionRef.current;
        setInventoryState((current) => ({
            status: 'loading',
            diagnosticCodes: current.diagnosticCodes,
        }));
        const agent = integration
            ? {
                agent: integration.agent,
                agentTitle: integration.agentTitle,
            }
            : agentRef.current;
        const result = await loadExternalSessionsIntegrationInventory({
            machineId,
            intent,
            serverId: params.serverId,
            agent,
            ...(intent === 'installation_recheck' && integration
                ? { installationId: requireInstallationId(integration) }
                : {}),
            knownAgents: knownAgentsRef.current,
            transport: params.transport,
        });
        if (requestRevisionRef.current !== requestRevision) return;
        const refreshed = result.integrations;
        if (result.status === 'error' && refreshed.length === 0) {
            setInventoryState({
                status: 'error',
                diagnosticCodes: result.diagnosticCodes,
            });
            return;
        }
        if (!integration) {
            setLoadedMachineId(machineId);
            setIntegrations(refreshed);
            setInventoryState({
                status: result.status,
                diagnosticCodes: result.diagnosticCodes,
            });
            return;
        }
        setLoadedMachineId(machineId);
        setIntegrations((current) => {
            const refreshedKeys = new Set(refreshed.map((entry) => entry.key));
            const retained = (current ?? []).filter((entry) => (
                entry.key !== integration.key && !refreshedKeys.has(entry.key)
            ));
            const next = [...retained, ...refreshed];
            return next;
        });
        setInventoryState((current) => (
            intent === 'installation_recheck'
            && current.diagnosticCodes.length > 0
                ? {
                    status: 'partial',
                    diagnosticCodes: current.diagnosticCodes,
                }
                : {
                    status: result.status,
                    diagnosticCodes: result.diagnosticCodes,
                }
        ));
    }, [enabled, params.machineId, params.serverId, params.transport]);

    const applyStatus = React.useCallback((
        integration: ExternalSessionsIntegrationDescriptor,
        status: PluginSessionHookInstallationStatusV1,
    ) => {
        requestRevisionRef.current += 1;
        const next: ExternalSessionsIntegrationDescriptor = {
            key: integrationKey(
                integration.machineId,
                integration.agent,
                status,
                0,
            ),
            machineId: integration.machineId,
            agent: integration.agent,
            agentTitle: integration.agentTitle,
            ...(integration.detail ? { detail: integration.detail } : {}),
            ...status,
        };
        setIntegrations((current) => [
            ...(current ?? []).filter((candidate) =>
                candidate.key !== integration.key
                && candidate.key !== next.key),
            next,
        ]);
        setInventoryState((current) => (
            current.status === 'loading'
                ? {
                    status: current.diagnosticCodes.length > 0
                        ? 'partial'
                        : 'ready',
                    diagnosticCodes: current.diagnosticCodes,
                }
                : current
        ));
    }, []);

    const startRequest = React.useCallback(() => {
        const requestRevision = ++requestRevisionRef.current;
        return () => requestRevisionRef.current === requestRevision;
    }, []);

    React.useEffect(() => {
        if (!enabled || !params.machineId) {
            requestRevisionRef.current += 1;
            setLoadedMachineId(null);
            setIntegrations(null);
            setInventoryState({
                status: 'idle',
                diagnosticCodes: [],
            });
            return;
        }
        void refresh();
    }, [
        agentSignature,
        projectedAgentsSignature,
        enabled,
        params.machineId,
        params.projectionGeneration,
        refresh,
    ]);

    const operations = React.useMemo(() => (
        enabled
        && params.machineId
        && isExternalSessionsIntegrationInventoryActionable(inventoryState.status)
            ? createExternalSessionsIntegrationOperations({
                serverId: params.serverId,
                transport: params.transport,
                refresh,
                applyStatus,
                startRequest,
                isCurrentScope: () =>
                    scopeSignatureRef.current === scopeSignature,
            })
            : null
    ), [
        enabled,
        inventoryState.status,
        params.machineId,
        params.serverId,
        params.transport,
        applyStatus,
        refresh,
        scopeSignature,
        startRequest,
    ]);

    const retryInventory = React.useCallback(async () => {
        await refresh();
    }, [refresh]);

    const scopedIntegrations = React.useMemo(() => (
        enabled && loadedMachineId === params.machineId
            ? integrations?.filter((integration) => integration.machineId === params.machineId) ?? null
            : null
    ), [enabled, integrations, loadedMachineId, params.machineId]);

    return {
        integrations: scopedIntegrations,
        operations,
        inventoryState,
        retryInventory,
    };
}
