import type { PluginUiOpenResourceIntentV1 } from '@happier-dev/protocol/plugins/ui';
import { artifactViewRoute } from '@/components/artifacts/artifactBrowserModel';

/** Native resource identities use their canonical viewer in the invoking Home. */
export function artifactResourceRoute(resource: Extract<PluginUiOpenResourceIntentV1, { kind: 'artifact' }>, serverId?: string): string {
    return `${artifactViewRoute(resource.artifactId)}${serverId ? `?serverId=${encodeURIComponent(serverId)}` : ''}`;
}

/** An Automation opens where its old links already resolve: the route that reads it and opens its trigger editor. */
export function automationResourceRoute(resource: Extract<PluginUiOpenResourceIntentV1, { kind: 'automation' }>, serverId?: string): string {
    return `/automations/${encodeURIComponent(resource.automationId)}${serverId ? `?serverId=${encodeURIComponent(serverId)}` : ''}`;
}
