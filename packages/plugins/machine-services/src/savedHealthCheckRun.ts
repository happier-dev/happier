import { HEALTH_CHECK_BUILTIN_PLUGIN_ID_V1, HealthCheckKindCatalogV1ProtocolSchema,
    HealthCheckResultV1ProtocolSchema, createHealthCheckSourceInstanceIdV1,
    type HealthCheckKindCatalogV1, type HealthCheckResultV1, type HealthCheckSetupInputV1, type HealthCheckSubjectV1,
    type JsonValue, type PluginContributionRef } from '@happier-dev/plugin-sdk';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { readSavedBuiltinHealthCheckAction } from './actionIds.js';
import { HEALTH_KINDS_ACTION_ID } from './healthCatalog.js';

export type SavedHealthCheckRunInput = Readonly<{ subject: HealthCheckSubjectV1;
    check: Pick<HealthCheckSetupInputV1['checks'][number], 'checkId' | 'kind'>;
    signal: AbortSignal; catalog?: HealthCheckKindCatalogV1 | null }>;
type Execute = (action: PluginContributionRef, input: JsonValue, options: Readonly<{ signal: AbortSignal }>) => Promise<unknown>;

/** Plugin and core controls use the saved kind's public Action, never a second probe runner. */
export async function runSavedHealthCheck(input: SavedHealthCheckRunInput, execute: Execute): Promise<Readonly<{
    catalog: HealthCheckKindCatalogV1 | null; result: HealthCheckResultV1;
}>> {
    let action = readSavedBuiltinHealthCheckAction(input.check.kind);
    let catalog = input.catalog ?? null;
    if (!action) {
        catalog ??= HealthCheckKindCatalogV1ProtocolSchema.parse(await execute(
            { pluginId: HEALTH_CHECK_BUILTIN_PLUGIN_ID_V1, localId: HEALTH_KINDS_ACTION_ID }, {}, { signal: input.signal }));
        const kind = catalog.find(item => item.pluginId === input.check.kind.pluginId && item.id === input.check.kind.localId);
        if (!kind) throw new PluginError({ code: 'health_check_result_unavailable', message: 'The saved health check kind is unavailable' });
        action = { pluginId: kind.pluginId, localId: kind.action };
    }
    input.signal.throwIfAborted();
    const result = HealthCheckResultV1ProtocolSchema.parse(await execute(action,
        { sourceInstanceId: createHealthCheckSourceInstanceIdV1(input.subject), checkId: input.check.checkId }, { signal: input.signal }));
    return { catalog, result };
}
