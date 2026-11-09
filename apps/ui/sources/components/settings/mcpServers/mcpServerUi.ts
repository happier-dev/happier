import type {
    DaemonMcpServersDetectWarningV1} from '@happier-dev/protocol/mcp/servers/daemonRpcV1';
import type {
    DetectedMcpPreviewEntryV1,
    McpPreviewAuthModeV1,
    McpPreviewScopeKindV1} from '@happier-dev/protocol/mcp/servers/previewV1';
import type {
    McpServerCatalogEntryTransportV1,
    McpServerRuleV1,
    McpServerCatalogEntryV1,
} from '@happier-dev/protocol/mcp/servers/settingsV1';
import type { AgentToolsDelivery } from '@happier-dev/agents';

import { resolveAgentIdFromFlavor } from '@/agents/registry/registryCore';
import { resolveAgentCatalogTitle } from '@/agents/backendCatalog/agentCatalogProjection';
import type { IconName } from '@/components/ui/icons/Icon';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { getMachineDisplayName } from '@/utils/sessions/machineDisplayNames';
import { t, type TranslationKeyNoParams } from '@/text';
import { inferMcpServerAuthModeV1 } from '@happier-dev/protocol/mcp/servers/authModeV1';

export function describeMachine(machineId: string, machines: readonly Machine[]): string {
    const machine = machines.find((item) => item.id === machineId) ?? null;
    // A machine missing from the inventory has no name to show, so its id is the only truthful label.
    return getMachineDisplayName(machine) ?? machineId;
}

export function describeConfiguredServerEndpoint(server: McpServerCatalogEntryV1): string {
    if (server.transport === 'stdio') {
        return [server.stdio?.command ?? '', ...(server.stdio?.args ?? [])]
            .filter((part) => part.trim().length > 0)
            .join(' ');
    }
    return server.remote?.url ?? '';
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

/** A Found warning in words: what went wrong and whose settings, then where or why, never its raw code. */
export function formatDetectedWarning(warning: DaemonMcpServersDetectWarningV1): string {
    // A warning that no agent owns names no agent, rather than an absent agent id.
    const agent = warning.provider ? resolveDetectedProviderName(warning.provider) : null;
    const base = (() => {
        switch (warning.code) {
            case 'read_failed':
                return agent ? t('capabilities.mcpFound.warningReadFailed', { agent }) : t('capabilities.mcpFound.warningReadFailedNoAgent');
            case 'parse_failed':
                return agent ? t('capabilities.mcpFound.warningParseFailed', { agent }) : t('capabilities.mcpFound.warningParseFailedNoAgent');
            case 'unsupported':
                return agent ? t('capabilities.mcpFound.warningUnsupported', { agent }) : t('capabilities.mcpFound.warningUnsupportedNoAgent');
        }
    })();
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

export function resolveDetectedAvailabilityLabel(entry: DetectedMcpPreviewEntryV1): string {
    return resolveDetectedServerStatusLabel(entry.provider, entry.enabled);
}

export function resolveDetectedProviderName(provider: string): string {
    const agentId = resolveAgentIdFromFlavor(provider);
    if (!agentId) return provider;
    return resolveAgentCatalogTitle(agentId);
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

export function resolveTransportIconName(transport: McpServerCatalogEntryTransportV1): IconName {
    if (transport === 'stdio') return 'terminal';
    if (transport === 'sse') return 'radio';
    return 'cloud';
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
