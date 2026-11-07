import {
  defineProtocolLiteral,
  defineProtocolObject,
  defineProtocolUnion,
  PluginUiResourceIntentV1Schema,
} from '@happier-dev/plugin-sdk/protocol';
import {
  TriageEntryLocatorV1Schema,
  TriageEntryRefV1Schema,
  TriageSourceInstanceRefV1Schema,
} from '@happier-dev/triage-protocol/v1';

export const TRIAGE_RESOLVE_RESOURCE_ACTION_LOCAL_ID_V1 = 'entries/resolve-resource-v1';

export const TriageResolveResourceActionInputV1Schema = defineProtocolObject({
  v: defineProtocolLiteral(1),
  resource: PluginUiResourceIntentV1Schema,
}, { policy: 'closed' });

export const TriageResolveResourceActionResultV1Schema = defineProtocolUnion([
  defineProtocolObject({
    kind: defineProtocolLiteral('resolved'),
    entryRef: TriageEntryRefV1Schema,
    sourceInstance: TriageSourceInstanceRefV1Schema,
    locator: TriageEntryLocatorV1Schema,
  }, { policy: 'closed' }),
  defineProtocolObject({ kind: defineProtocolLiteral('unavailable') }, { policy: 'closed' }),
]);

export type TriageResolveResourceActionInputV1 = ReturnType<typeof TriageResolveResourceActionInputV1Schema.parse>;
export type TriageResolveResourceActionResultV1 = ReturnType<typeof TriageResolveResourceActionResultV1Schema.parse>;
