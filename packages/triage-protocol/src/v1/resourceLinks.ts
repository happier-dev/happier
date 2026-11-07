import { defineProtocolLiteral, defineProtocolObject, defineProtocolUnion, PluginUiResourceIntentV1Schema,
  type ProtocolComposableSchema } from '@happier-dev/plugin-sdk/protocol';
import { TriageConfiguredSourceInstanceV1Schema, TriageConfiguredSourceConnectedAccountInstanceV1Schema,
  TriageConfiguredSourceCredentialInstanceV1Schema } from './instances.js';
import { TriageSourceEntryLocalRefV1Schema, TriageEntryLocatorV1Schema } from './identity.js';
import { TriageSourceFailureV1Schema } from './diagnostics.js';

function resourceInput<I, O>(instance: ProtocolComposableSchema<I, O>) {
  return defineProtocolObject({ v: defineProtocolLiteral(1), instance, resource: PluginUiResourceIntentV1Schema }, { policy: 'closed' });
}

/** Optional exact URL lookup. Sources own URL semantics and immutable native identity. */
export const TriageResolveResourceInputV1Schema = resourceInput(TriageConfiguredSourceInstanceV1Schema);
export const TriageResolveResourceConnectedAccountInputV1Schema = resourceInput(TriageConfiguredSourceConnectedAccountInstanceV1Schema);
export const TriageResolveResourceCredentialInputV1Schema = resourceInput(TriageConfiguredSourceCredentialInstanceV1Schema);
export const TriageResolveResourceResultV1Schema = defineProtocolUnion([
  defineProtocolObject({ kind: defineProtocolLiteral('resolved'), localRef: TriageSourceEntryLocalRefV1Schema,
    locator: TriageEntryLocatorV1Schema }, { policy: 'closed' }),
  defineProtocolObject({ kind: defineProtocolLiteral('unavailable'), failure: TriageSourceFailureV1Schema }, { policy: 'closed' }),
]);
export type TriageResolveResourceResultV1 = ReturnType<typeof TriageResolveResourceResultV1Schema.parse>;
