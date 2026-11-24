import { compilePluginJsonSchema } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import { isValidPluginJsonSchemaValue } from '@happier-dev/protocol/plugins/actions/protocol-composable-schema';
import { sameStrictJsonValue, type JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { freezePluginDeclarativeDataNodeV1, type PluginDeclarativeDataNodeV1 } from '@happier-dev/protocol/plugins/contributions/ui/declarativeDataV1';
import type { PluginUiResourceReference, PluginUiResourceSnapshot } from '@happier-dev/plugin-ui/hostApi';
import type { PluginUiProjectionModel, PluginUiResourceProjection } from '@/sync/domains/plugins/ui/projection';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type { PluginContextualResourceBinding } from './PluginContextualResourceStoreProvider';
import { resolvePluginContextualResourceBinding } from './pluginResourceBinding';

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

type DeclarativeDataResourceBindingResult = Readonly<{ ok: true; binding: PluginContextualResourceBinding;
    resource: PluginUiResourceReference; declaration: PluginUiResourceProjection }>
    | Readonly<{ ok: false; errorCode: 'plugin_surface_retired' | 'plugin_resource_not_found' | 'plugin_resource_admission_unavailable'
        | 'plugin_resource_context_unavailable' | 'declarative_data_content_type_invalid' | 'invalid_parameters' }>;

/** The current declaration and plugin occurrence, never author metadata, choose transport. */
export function resolveDeclarativeDataResourceBinding(input: DeclarativeDataResourceAdmission,
    node: PluginDeclarativeDataNodeV1, mountInstanceKey?: string): DeclarativeDataResourceBindingResult {
    if (!input.accountLifetime.isCurrent() || !input.isCurrent()) return { ok: false, errorCode: 'plugin_surface_retired' };
    if (node.data.kind !== 'resource') return { ok: false, errorCode: 'invalid_parameters' };
    if (!input.projection) return { ok: false, errorCode: 'plugin_resource_admission_unavailable' };
    const source = node.data;
    const declarations = Object.values(input.projection.resourcesById).filter(row => row.pluginId === source.resource.pluginId
        && row.id === source.resource.localId);
    if (declarations.length === 0) return { ok: false, errorCode: 'plugin_resource_not_found' };
    const declaration = declarations.length === 1 ? declarations[0] : undefined;
    if (!declaration) return { ok: false, errorCode: 'plugin_resource_admission_unavailable' };
    if (declaration.contentType !== 'application/json') return { ok: false, errorCode: 'declarative_data_content_type_invalid' };
    try {
        if (!isValidPluginJsonSchemaValue(compilePluginJsonSchema(source.inputSchema), input.input)
            || source.input !== undefined && !sameStrictJsonValue(source.input, input.input)) return { ok: false, errorCode: 'invalid_parameters' };
    } catch { return { ok: false, errorCode: 'invalid_parameters' }; }
    const context = declaration.scope === 'global' ? { kind: 'global' as const }
        : declaration.scope === 'session' && input.sessionId ? { kind: 'session' as const, sessionId: input.sessionId }
        : declaration.scope === 'surface' && mountInstanceKey
            ? { kind: 'surface' as const, mountInstanceKey, launchInput: { ...input.input } } : null;
    if (!context) return { ok: false, errorCode: 'plugin_resource_context_unavailable' };
    const binding = resolvePluginContextualResourceBinding(input, declaration, context);
    return binding ? { ok: true, resource: source.resource, declaration, binding }
        : { ok: false, errorCode: 'plugin_resource_admission_unavailable' };
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
