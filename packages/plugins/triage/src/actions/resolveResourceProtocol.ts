import {
  defineProtocolLiteral,
  defineProtocolNumber,
  defineProtocolObject,
  defineProtocolString,
  defineProtocolUnion,
  PluginUiResourceIntentV1Schema,
} from '@happier-dev/plugin-sdk/protocol';
import {
  TriageEntryLocatorV1Schema,
  TriageEntryRefV1Schema,
  TriageSourceInstanceRefV1Schema,
} from '@happier-dev/triage-protocol/v1';

export const TRIAGE_RESOLVE_RESOURCE_ACTION_LOCAL_ID_V1 = 'entries/resolve-resource-v1';

export const TriageResolveResourceActionInputV1Schema = defineProtocolUnion([
  defineProtocolObject({
    v: defineProtocolLiteral(1),
    resource: PluginUiResourceIntentV1Schema,
  }, { policy: 'closed' }),
  defineProtocolObject({
    v: defineProtocolLiteral(1),
    kind: defineProtocolLiteral('pullRequestForSession'),
    reference: defineProtocolUnion([
      defineProtocolString({ minLength: 1 }),
      defineProtocolNumber({ integer: true, minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    ]),
    sessionId: defineProtocolString({ minLength: 1 }),
  }, { policy: 'closed' }),
]);

export const TriageResolveResourceActionResultV1Schema = defineProtocolUnion([
  defineProtocolObject({
    kind: defineProtocolLiteral('resolved'),
    entryRef: TriageEntryRefV1Schema,
    sourceInstance: TriageSourceInstanceRefV1Schema,
    locator: TriageEntryLocatorV1Schema,
  }, { policy: 'closed' }),
  defineProtocolObject({
    kind: defineProtocolLiteral('unavailable'),
    code: defineProtocolLiteral('sourceUnavailable'),
    remedy: defineProtocolString({ minLength: 1 }),
  }, { policy: 'closed' }),
]);

export type TriageResolveResourceActionInputV1 = ReturnType<typeof TriageResolveResourceActionInputV1Schema.parse>;
export type TriageResolveResourceActionResultV1 = ReturnType<typeof TriageResolveResourceActionResultV1Schema.parse>;
