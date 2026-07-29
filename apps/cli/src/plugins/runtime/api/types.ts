import type {
    PluginNotificationCategoryContributionV2,
    PluginNotificationChannelContributionV2,
} from '@happier-dev/protocol';
import type {
    McpDiscoveryProviderReturnV1,
    McpResolveForSessionInputV1,
    McpServerSpecV1,
} from '@happier-dev/plugin-sdk/experimental/mcp';
import type { ScmBackendRuntimeRegistration } from '@happier-dev/plugin-sdk/experimental/scm/backend';
import type { ScmHostingProviderRuntimeRegistration } from '@happier-dev/plugin-sdk/experimental/scm/hostingProvider';
import type {
    ConnectedServiceDaemonAuthBridgeRegistration,
} from '@/daemon/connectedServices/daemonAuthBridgeTypes';

export type PluginDisposable = (() => void | Promise<void>) | Readonly<{
    dispose(): void | Promise<void>;
}>;

export type PluginApiDaemonAuthBridgeRegistration = ConnectedServiceDaemonAuthBridgeRegistration;
export type PluginApiNotificationCategoryRegistration = Readonly<{
    id: string;
    kind?: PluginNotificationCategoryContributionV2['kind'];
    title?: string;
    description?: string | null;
    eventIds?: PluginNotificationCategoryContributionV2['eventIds'];
    defaultChannelIds?: readonly string[];
}>;
export type PluginApiNotificationChannelRegistration = Readonly<{
    id: string;
    kind?: PluginNotificationChannelContributionV2['kind'];
    title?: string;
    description?: string | null;
    configurable?: PluginNotificationChannelContributionV2['configurable'];
    defaultEnabled?: PluginNotificationChannelContributionV2['defaultEnabled'];
    send(request: Readonly<{
        categoryId: string;
        channelId: string;
        title: string;
        body?: string | null;
        payload?: unknown;
    }>): Promise<Readonly<{ delivered: boolean }>> | Readonly<{ delivered: boolean }>;
}>;
export type PluginApiScmHostingProviderRegistration = ScmHostingProviderRuntimeRegistration;
export type PluginApiScmBackendRegistration = ScmBackendRuntimeRegistration;
export type PluginApiMcpServerRegistration = McpServerSpecV1;
export type PluginApiMcpDiscoveryProviderRegistration = Readonly<{
    id: string;
    discover(input?: McpResolveForSessionInputV1): Promise<McpDiscoveryProviderReturnV1> | McpDiscoveryProviderReturnV1;
}>;
