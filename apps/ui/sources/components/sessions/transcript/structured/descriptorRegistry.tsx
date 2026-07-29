import type { PluginUiProjectionModel, PluginUiStructuredMessageProjection } from '@/sync/domains/plugins/ui/projection';

import {
    findStructuredMessageRenderer,
    type StructuredMessageRegistryEntry,
} from './structuredMessageRegistry';

export function findBuiltInStructuredMessageEntry(kind: string): StructuredMessageRegistryEntry<unknown> | null {
    return findStructuredMessageRenderer(kind);
}

export function findPluginStructuredMessageDescriptor(params: Readonly<{
    kind: string;
    pluginUiProjection?: PluginUiProjectionModel | null;
}>): PluginUiStructuredMessageProjection | null {
    return params.pluginUiProjection?.structuredMessagesByKind[params.kind] ?? null;
}
