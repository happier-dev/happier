import type {
    PluginDiagnosticDataV1,
    PluginSessionHookInstallPreviewV1,
    PluginSessionHookInstallationStatusV1,
} from '@happier-dev/protocol';

export type ExternalSessionsQualifiedAgent = Readonly<{
    pluginId: string;
    localId: string;
}>;

type ExternalSessionsIntegrationDescriptorBase = Readonly<{
    key: string;
    machineId: string;
    agent: ExternalSessionsQualifiedAgent;
    agentTitle: string;
    detail?: string;
}>;

export type ExternalSessionsIntegrationDescriptor = Readonly<
    ExternalSessionsIntegrationDescriptorBase & PluginSessionHookInstallationStatusV1
>;

export type ExternalSessionsAutoLinkSourceDescriptor = Readonly<{
    machineId: string;
    agent: ExternalSessionsQualifiedAgent;
    agentTitle: string;
    sourcePolicyId: string;
    sourceDisplayLabel?: string;
    enabled: boolean;
    canChange: boolean;
    setEnabled: (enabled: boolean) => Promise<void>;
}>;

export type ExternalSessionsIntegrationOperations = Readonly<{
    reviewAndInstall: (
        integration: ExternalSessionsIntegrationDescriptor,
        confirm: (
            preview: PluginSessionHookInstallPreviewV1,
        ) => Promise<boolean>,
    ) => Promise<void>;
    disable: (integration: ExternalSessionsIntegrationDescriptor) => Promise<void>;
    enable: (integration: ExternalSessionsIntegrationDescriptor) => Promise<void>;
    uninstall: (integration: ExternalSessionsIntegrationDescriptor) => Promise<void>;
    checkAgain: (integration: ExternalSessionsIntegrationDescriptor) => Promise<void>;
}>;

export type ExternalSessionsIntegrationAction =
    | 'review_install'
    | 'disable'
    | 'enable'
    | 'uninstall'
    | 'check_again';

export function isExternalSessionsIntegrationInventoryActionable(
    status: 'idle' | 'loading' | 'ready' | 'partial' | 'error',
): boolean {
    return status === 'ready' || status === 'partial';
}

function sameAgent(
    left: ExternalSessionsQualifiedAgent,
    right: ExternalSessionsQualifiedAgent,
): boolean {
    return left.pluginId === right.pluginId && left.localId === right.localId;
}

export function filterExternalSessionsIntegrations(params: Readonly<{
    integrations: readonly ExternalSessionsIntegrationDescriptor[];
    machineId: string | null;
    agent: ExternalSessionsQualifiedAgent | null;
}>): ExternalSessionsIntegrationDescriptor[] {
    if (!params.machineId) return [];
    return params.integrations.filter((integration) => (
        integration.machineId === params.machineId
        && (params.agent === null || sameAgent(integration.agent, params.agent))
    ));
}

export function filterExternalSessionsAutoLinkSources(params: Readonly<{
    sources: readonly ExternalSessionsAutoLinkSourceDescriptor[];
    machineId: string | null;
    agent: ExternalSessionsQualifiedAgent | null;
}>): ExternalSessionsAutoLinkSourceDescriptor[] {
    if (!params.machineId) return [];
    return params.sources.filter((source) => (
        source.machineId === params.machineId
        && (params.agent === null || sameAgent(source.agent, params.agent))
    ));
}

export function resolveExternalSessionsIntegrationActions(
    integration: ExternalSessionsIntegrationDescriptor,
    operations: ExternalSessionsIntegrationOperations | null | undefined,
): ExternalSessionsIntegrationAction[] {
    if (!operations) return [];
    switch (integration.state) {
        case 'not_installed':
            return ['review_install'];
        case 'installed_enabled':
            return ['disable', 'uninstall', 'check_again'];
        case 'installed_disabled':
            return ['enable', 'uninstall', 'check_again'];
        case 'needs_attention':
            if (integration.installationId) return ['uninstall'];
            return ['review_install'];
        case 'unsupported':
            return [];
        case 'unavailable':
            return ['uninstall'];
    }
}

export function readExternalSessionsIntegrationDiagnostic(
    integration: ExternalSessionsIntegrationDescriptor,
): PluginDiagnosticDataV1 | null {
    return integration.state === 'needs_attention'
        ? integration.diagnostic
        : null;
}
