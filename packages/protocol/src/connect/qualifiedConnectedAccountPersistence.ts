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

/**
 * The one equality for a qualified connected-account ref.
 *
 * A ref is three fields, and every caller that has ever compared two of them —
 * quota source resolution, and now selected-pull-request review scope
 * production — needs the same answer to "is this the account I authorized as".
 * Comparing them inline is how two callers end up disagreeing about whether
 * the contribution identity takes part, so the comparison lives beside the
 * schema that defines the shape.
 */
export function sameQualifiedConnectedAccountRef(
  left: QualifiedConnectedAccountRef,
  right: QualifiedConnectedAccountRef,
): boolean {
  return left.service.pluginId === right.service.pluginId
    && left.service.localId === right.service.localId
    && left.accountId === right.accountId;
}
