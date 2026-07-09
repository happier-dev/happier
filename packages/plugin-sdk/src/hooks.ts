export {
    PLUGIN_HOOK_CATALOG_V1,
    PLUGIN_HOOK_IDS_V1,
    PLUGIN_HOOK_PAYLOAD_SCHEMAS_BY_ID_V1,
    getPluginHookDefinitionV1,
    validatePluginHookPayloadV1,
} from '@happier-dev/protocol/plugins/hooks';
export type {
    PluginHookAggregationKindV1,
    PluginHookDefinitionV1,
    PluginHookFailureModeV1,
    PluginHookIdV1,
    PluginHookPayloadSchemaMapV1,
    PluginHookPurityV1,
    PluginHookScopeV1,
    PluginHookSupportedRuntimeFamilyV1,
    SubagentEndedHookPayloadV1,
    SubagentStartedHookPayloadV1,
} from '@happier-dev/protocol/plugins/hooks';
export type {
    PluginApiHookRegistrationV1,
    PluginHookHandler,
    PluginHookHandlerContextV1,
    PluginHookPayloadEnvelopeV1,
    PluginHookPayloadMapV1,
    PluginHookResultMapV1,
} from './api.js';
export {
    toPluginHookObjectContext,
    toPluginHookPayloadEnvelope,
} from './api.js';
