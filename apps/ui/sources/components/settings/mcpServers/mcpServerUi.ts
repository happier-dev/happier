import type {
    DaemonMcpServersDetectWarningV1,
    DetectedMcpPreviewEntryV1,
    ManagedMcpPreviewEntryV1,
    McpServerCatalogEntryTransportV1,
    McpPreviewAuthModeV1,
    McpPreviewScopeKindV1,
    McpServerBindingV1,
    McpServerCatalogEntryV1,
} from '@happier-dev/protocol';
import type { AgentToolsDelivery } from '@happier-dev/agents';

import { getAgentCore, resolveAgentIdFromFlavor } from '@/agents/registry/registryCore';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { t, type TranslationKeyNoParams } from '@/text';
import { inferMcpServerAuthModeV1 } from '@happier-dev/protocol';

export function describeMachine(machineId: string, machines: readonly Machine[]): string {
    const machine = machines.find((item) => item.id === machineId) ?? null;
    return machine?.metadata?.displayName || machine?.metadata?.host || machineId;
}

export function summarizeBindings(bindings: ReadonlyArray<McpServerBindingV1>, machines: readonly Machine[]): string {
    const enabled = bindings.filter((binding) => binding.enabled);
    const hasAll = enabled.some((binding) => binding.target.t === 'allMachines');
    const machineTargets = enabled.filter((binding) => binding.target.t === 'machine');
    const workspaceTargets = enabled.filter((binding) => binding.target.t === 'workspace');

    const parts: string[] = [];
    if (hasAll) parts.push(t('settings.mcpServersBindingSummaryAllMachines'));
    if (machineTargets.length > 0) {
        const firstMachineId = machineTargets[0]?.target.t === 'machine' ? machineTargets[0].target.machineId : null;
        parts.push(machineTargets.length === 1 && firstMachineId
            ? describeMachine(firstMachineId, machines)
            : t('settings.mcpServersBindingSummaryMachines', { count: machineTargets.length }));
    }
    if (workspaceTargets.length > 0) {
        parts.push(t('settings.mcpServersBindingSummaryWorkspaces', { count: workspaceTargets.length }));
    }
    return parts.length > 0 ? parts.join(' · ') : t('settings.mcpServersBindingSummaryNone');
}

export function describeConfiguredServerEndpoint(server: McpServerCatalogEntryV1): string {
    if (server.transport === 'stdio') {
        return [server.stdio?.command ?? '', ...(server.stdio?.args ?? [])]
            .filter((part) => part.trim().length > 0)
            .join(' ');
    }
    return server.remote?.url ?? '';
}

export function resolveBindingBadgeLabels(bindings: ReadonlyArray<McpServerBindingV1>, machines: readonly Machine[]): string[] {
    return bindings
        .filter((binding) => binding.enabled)
        .map((binding) => {
            if (binding.target.t === 'allMachines') return t('settings.mcpServersBindingSummaryAllMachines');
            if (binding.target.t === 'machine') return describeMachine(binding.target.machineId, machines);
            return binding.target.workspaceRoot;
        });
}

export function resolveAuthBadgeLabel(authMode: McpPreviewAuthModeV1 | ReturnType<typeof inferMcpServerAuthModeV1>): string {
    switch (authMode) {
        case 'savedSecret':
            return t('settings.mcpServersAuthSavedSecret');
        case 'machineEnv':
            return t('settings.mcpServersAuthMachineEnv');
        case 'plainText':
            return t('settings.mcpServersAuthPlainText');
        case 'unknown':
            return t('settings.mcpServersAuthUnknown');
        default:
            return t('settings.mcpServersAuthNone');
    }
}

export function resolveManagedServerAuthMode(server: Pick<McpServerCatalogEntryV1, 'env' | 'remote'>): string {
    return resolveAuthBadgeLabel(inferMcpServerAuthModeV1(server));
}

export function formatDetectedWarning(warning: DaemonMcpServersDetectWarningV1): string {
    const base = `${warning.provider} · ${warning.code}`;
    if (warning.path) return `${base} · ${warning.path}`;
    if (warning.detail) return `${base} · ${warning.detail}`;
    return base;
}

export function resolvePreviewScopeLabel(scopeKind: McpPreviewScopeKindV1): string {
    switch (scopeKind) {
        case 'allMachines':
            return t('settings.mcpServersScopeAllMachines');
        case 'machine':
            return t('settings.mcpServersScopeMachine');
        case 'workspace':
            return t('settings.mcpServersScopeWorkspace');
        case 'providerProject':
            return t('settings.mcpServersScopeProviderProject');
        case 'providerUser':
            return t('settings.mcpServersScopeProviderUser');
        default:
            return t('settings.mcpServersScopeBuiltIn');
    }
}

export function resolveManagedAvailabilityLabel(entry: ManagedMcpPreviewEntryV1): string {
    if (entry.availability === 'active') return t('settings.mcpServersStatusActive');
    if (entry.availability === 'available') return t('settings.mcpServersStatusAvailable');
    return t('settings.mcpServersStatusUnavailable');
}

export function resolveDetectedAvailabilityLabel(entry: DetectedMcpPreviewEntryV1): string {
    return resolveDetectedServerStatusLabel(entry.provider, entry.enabled);
}

export function resolveDetectedProviderName(provider: string): string {
    const agentId = resolveAgentIdFromFlavor(provider);
    if (!agentId) return provider;
    return t(getAgentCore(agentId).displayNameKey);
}

export function resolveDetectedServerStatusLabel(provider: string, enabled: boolean | null): string {
    const providerName = resolveDetectedProviderName(provider);
    return enabled === false
        ? t('settings.mcpServersStatusDisabledInProvider', { provider: providerName })
        : t('settings.mcpServersStatusDetected', { provider: providerName });
}

export function resolveTransportLabel(transport: McpServerCatalogEntryTransportV1): string {
    switch (transport) {
        case 'stdio':
            return t('settings.mcpServersTransportLocalTitle');
        case 'http':
            return t('settings.mcpServersTransportHttpTitle');
        case 'sse':
            return t('settings.mcpServersTransportSseTitle');
        default:
            return transport;
    }
}

export function resolveTransportIconName(transport: McpServerCatalogEntryTransportV1) {
    if (transport === 'stdio') return 'terminal-outline' as const;
    if (transport === 'sse') return 'radio-outline' as const;
    return 'cloud-outline' as const;
}

export function resolveAgentToolsDeliveryLabel(delivery: AgentToolsDelivery): string {
    const key = (() => {
        switch (delivery) {
            case 'native_mcp':
                return 'settings.mcpServersDeliveryNativeTitle';
            case 'shell_bridge':
                return 'settings.mcpServersDeliveryShellBridgeTitle';
            default:
                return 'settings.mcpServersDeliveryUnsupportedTitle';
        }
    })() as TranslationKeyNoParams;

    return t(key);
}

export function resolveAgentToolsDeliveryDescription(delivery: AgentToolsDelivery): string {
    const key = (() => {
        switch (delivery) {
            case 'native_mcp':
                return 'settings.mcpServersDeliveryNativeSubtitle';
            case 'shell_bridge':
                return 'settings.mcpServersDeliveryShellBridgeSubtitle';
            default:
                return 'settings.mcpServersDeliveryUnsupportedSubtitle';
        }
    })() as TranslationKeyNoParams;

    return t(key);
}
