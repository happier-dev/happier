import { PLUGIN_HOST_ACCESS_CAPABILITY_CATALOG_V2 } from '@happier-dev/protocol/plugins/manifest/v2';
import type { PluginHostAccessRequestV2 } from '@happier-dev/protocol';

import {
    createDefaultPluginAccessScopeRegistry,
    type PluginAccessSelection,
} from '@/plugins/store/install/accessScopeRegistry';

const HOST_RESOURCE_SELECTION_CAPABILITIES = new Set<string>(
    PLUGIN_HOST_ACCESS_CAPABILITY_CATALOG_V2
        .filter(({ authorizationClass }) => authorizationClass === 'hostResourceSelection')
        .map(({ capability }) => capability),
);
const HOST_ACCESS_SCOPE_REGISTRY = createDefaultPluginAccessScopeRegistry();

export function isPluginHostAccessRequestAuthorizedBySelection(input: Readonly<{
    pluginId: string;
    request: PluginHostAccessRequestV2;
    required: boolean;
    optionalAccess: readonly PluginAccessSelection[];
}>): boolean {
    if (input.required) return true;
    if (!HOST_RESOURCE_SELECTION_CAPABILITIES.has(input.request.capability)) return false;
    const matchingSelections = input.optionalAccess.filter((selection) => (
        selection.pluginId === input.pluginId
        && selection.accessId === input.request.id
        && selection.capability === input.request.capability
        && HOST_ACCESS_SCOPE_REGISTRY.validateSelection(selection)
    ));
    if (matchingSelections.length !== 1) return false;
    // The same covering relation that admits a narrowed update without review:
    // callers enforce the current declaration's scope, never the selection's.
    return HOST_ACCESS_SCOPE_REGISTRY.isWithinGrantedScope(
        input.request.capability,
        input.request.scope,
        matchingSelections[0]!.normalizedScope,
    );
}
