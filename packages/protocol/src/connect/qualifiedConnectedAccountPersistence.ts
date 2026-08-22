import {
  defineProtocolObject,
  defineProtocolString,
  type ProtocolComposableSchema,
} from '../plugins/actions/protocolComposableSchema.js';
import {
  PluginContributionIdentityV1Schema,
} from '../plugins/contributionIdentity.js';

export const QualifiedConnectedAccountIdSchema = defineProtocolString({
  minLength: 1,
  maxLength: 256,
  pattern: '^(?!\\s)[\\s\\S]*\\S$',
});

/**
 * The annotation states the identity shape structurally rather than naming
 * `PluginContributionIdentityV1`. A public feature-protocol package composes
 * this schema through the SDK and emits its own declarations; a named
 * Protocol alias here would surface as `import("@happier-dev/protocol")` in
 * that package's `.d.ts`, which external authors never install. The shape is
 * still compiler-bound to `PluginContributionIdentityV1Schema` below.
 */
export const QualifiedConnectedAccountRefSchema: ProtocolComposableSchema<{
  service: { pluginId: string; localId: string };
  accountId: string;
}> = defineProtocolObject({
  service: PluginContributionIdentityV1Schema,
  accountId: QualifiedConnectedAccountIdSchema,
}, { policy: 'closed' });

/** Canonical portable JSON Schema projection of the qualified account ref. */
export const QualifiedConnectedAccountRefJsonSchema = QualifiedConnectedAccountRefSchema.jsonSchema;

export type QualifiedConnectedAccountRef = ReturnType<typeof QualifiedConnectedAccountRefSchema.parse>;
