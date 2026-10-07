import { compilePluginJsonSchema } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import { isValidPluginJsonSchemaValue } from '@happier-dev/protocol/plugins/actions/protocol-composable-schema';
import { sameStrictJsonValue, type JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { freezePluginDeclarativeDataNodeV1, type PluginDeclarativeDataNodeV1 } from '@happier-dev/protocol/plugins/contributions/ui/declarativeDataV1';
import type { PluginUiResourceSnapshot } from '@happier-dev/plugin-ui/hostApi';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import { readPluginUiContributionOrigin } from '@/sync/domains/plugins/ui/projectionUnion';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type { PluginContextualResourceBinding } from './PluginContextualResourceStoreProvider';

export type DeclarativeDataResourceAdmission = Readonly<{
    projection: PluginUiProjectionModel | null;
    machineId: string | null;
    serverId: string | null;
    input: Readonly<Record<string, JsonValue>>;
    accountLifetime: ActiveServerAccountScopeLifetime;
    sessionId?: string;
    /** A retained declaration may display old bytes, but cannot start Refresh. */
    requireReadAuthority?: boolean;
    isCurrent(): boolean;
}>;

/** The current declaration and plugin occurrence, never author metadata, choose transport. */
export function resolveDeclarativeDataResourceBinding(input: DeclarativeDataResourceAdmission,
    node: PluginDeclarativeDataNodeV1, mountInstanceKey?: string): PluginContextualResourceBinding | null {
    if (node.data.kind !== 'resource' || !input.accountLifetime.isCurrent() || !input.isCurrent()) return null;
    const source = node.data;
    const declarations = Object.values(input.projection?.resourcesById ?? {}).filter(row => row.pluginId === source.resource.pluginId
        && row.id === source.resource.localId);
    const declaration = declarations.length === 1 ? declarations[0] : null;
    const plugin = input.projection?.installedPackagesById[source.resource.pluginId];
    if (!declaration || declaration.pluginId !== source.resource.pluginId || declaration.id !== source.resource.localId
        || declaration.contentType !== 'application/json' || !declaration.scope || !plugin?.enabled
        || typeof plugin.occurrenceId !== 'string' || !plugin.occurrenceId
        || declaration.occurrenceId !== undefined && declaration.occurrenceId !== plugin.occurrenceId) return null;
    const origin = readPluginUiContributionOrigin(declaration);
    if (input.requireReadAuthority && origin && (origin.phase !== 'current' || !origin.interactionEnabled)) return null;
    const packageOrigin = readPluginUiContributionOrigin(plugin);
    const machineId = input.machineId ?? origin?.machineId;
    const serverId = input.serverId ?? origin?.serverId;
    if (!machineId || serverId !== input.accountLifetime.scope.serverId
        || origin && (origin.machineId !== machineId || origin.serverId !== serverId)
        || packageOrigin && (packageOrigin.machineId !== machineId || packageOrigin.serverId !== serverId)) return null;
    try {
        if (!isValidPluginJsonSchemaValue(compilePluginJsonSchema(source.inputSchema), input.input)
            || source.input !== undefined && !sameStrictJsonValue(source.input, input.input)) return null;
    } catch { return null; }
    const context = declaration.scope === 'global' ? { kind: 'global' as const }
        : declaration.scope === 'session' && input.sessionId ? { kind: 'session' as const, sessionId: input.sessionId }
        : declaration.scope === 'surface' && mountInstanceKey
            ? { kind: 'surface' as const, mountInstanceKey, launchInput: { ...input.input } } : null;
    if (!context) return null;
    return { pluginId: source.resource.pluginId, expectedCallerOccurrenceId: plugin.occurrenceId, machineId,
        serverId, context, accountLifetime: input.accountLifetime };
}

export type DeclarativeDataSourceProjection = Readonly<{
    node: PluginDeclarativeDataNodeV1 | null;
    freshness: PluginUiResourceSnapshot['freshness'];
    pending: PluginUiResourceSnapshot['pending'];
    errorCode?: string;
    digest?: string;
}>;

/** Decode only admitted Resource bytes; the incumbent store owns all reads and retirement. */
export function projectDeclarativeDataResourceSnapshot(
    node: PluginDeclarativeDataNodeV1,
    resource: PluginUiResourceSnapshot | null,
    isCurrent: boolean,
    lastGood?: DeclarativeDataSourceProjection | null,
): DeclarativeDataSourceProjection {
    if (!isCurrent) return { node: null, freshness: 'unknown', pending: 'idle', errorCode: 'plugin_surface_retired' };
    if (node.data.kind === 'value') return { node, freshness: 'fresh', pending: 'idle' };
    if (!resource?.value) return { node: null, freshness: resource?.freshness ?? 'unknown', pending: resource?.pending ?? 'initial',
        ...(resource?.error?.code ? { errorCode: resource.error.code } : {}) };
    try {
        if (resource.value.contentType !== 'application/json') throw new Error('declarative_data_content_type_invalid');
        const output: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(resource.value.bytes));
        return { node: freezePluginDeclarativeDataNodeV1(node, output), freshness: resource.freshness, pending: resource.pending,
            digest: resource.digest, ...(resource.error?.code ? { errorCode: resource.error.code } : {}) };
    } catch {
        return { node: lastGood?.node ?? null, freshness: lastGood?.node ? 'stale' : 'unknown',
            pending: resource.pending, errorCode: 'declarative_data_output_invalid',
            ...(lastGood?.digest ? { digest: lastGood.digest } : {}) };
    }
}
