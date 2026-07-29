export {
    PLUGIN_HOOK_CATALOG_V1,
    PLUGIN_HOOK_IDS_V1,
    PLUGIN_HOOK_PAYLOAD_SCHEMAS_BY_ID_V1,
    getPluginHookDefinitionV1,
    validatePluginHookPayloadV1,
    validatePluginHookResultV1,
} from '@happier-dev/protocol/plugins/hooks';
export type {
    PluginHookAggregationKindV1,
    PluginHookDefinitionV1,
    PluginHookDecisionResultV1,
    PluginHookFailureModeV1,
    PluginHookIdV1,
    PluginHookPayloadSchemaMapV1,
    PluginHookPayloadMapV1,
    PluginHookPurityV1,
    PluginHookScopeV1,
    PluginHookSupportedRuntimeFamilyV1,
} from '@happier-dev/protocol/plugins/hooks';

export type PluginHookPayloadEnvelope = Readonly<{ payload?: unknown }>;

export function toPluginHookPayloadEnvelope<
    TEnvelope extends PluginHookPayloadEnvelope = PluginHookPayloadEnvelope,
>(value: unknown): TEnvelope {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return {} as TEnvelope;
    }
    const record = value as Readonly<Record<string, unknown>>;
    return (
        Object.prototype.hasOwnProperty.call(record, 'payload')
            ? { payload: record.payload }
            : { payload: value }
    ) as TEnvelope;
}

export function toPluginHookObjectContext<TContext>(value: unknown): TContext | undefined {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as TContext
        : undefined;
}
