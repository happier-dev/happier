import {
  defineProtocolObject,
  defineProtocolLiteral,
  defineProtocolUnion,
  defineProtocolString,
  type ProtocolComposableSchema,
} from '../plugins/actions/protocolComposableSchema.js';
import {
  PluginContributionIdentityV1Schema,
} from '../plugins/contributionIdentity.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import { PluginSourceCustodyV1ProtocolSchema, pluginSourceCustodyV1Equal } from '../plugins/runtime/sourceCustody.js';

export const HOST_CONNECTED_ACCOUNT_SERVICE_REF_V1 = Object.freeze({
  pluginId: 'happier', localId: 'mcp-sign-in',
} as const);

/** Host services are reserved Connected Account identities, never Plugin ids. */
export const ConnectedAccountServiceIdentityV1Schema = defineProtocolUnion([
  PluginContributionIdentityV1Schema,
  defineProtocolObject({
    pluginId: defineProtocolLiteral(HOST_CONNECTED_ACCOUNT_SERVICE_REF_V1.pluginId),
    localId: defineProtocolLiteral(HOST_CONNECTED_ACCOUNT_SERVICE_REF_V1.localId),
  }, { policy: 'closed' }),
]);

/** Built-in host callbacks belong to the running host, not an installed plugin. */
const ConnectedAccountSourceCustodyV1ProtocolSchema = defineProtocolUnion([
  PluginSourceCustodyV1ProtocolSchema,
  defineProtocolObject({ kind: defineProtocolLiteral('host') }, { policy: 'closed' }),
]);
export const ConnectedAccountSourceCustodyV1Schema: ReturnType<typeof asProtocolZod<
  Parameters<typeof ConnectedAccountSourceCustodyV1ProtocolSchema.parse>[0],
  ReturnType<typeof ConnectedAccountSourceCustodyV1ProtocolSchema.parse>
>> = asProtocolZod(ConnectedAccountSourceCustodyV1ProtocolSchema);
export type ConnectedAccountSourceCustodyV1 = ReturnType<typeof ConnectedAccountSourceCustodyV1Schema.parse>;

export function connectedAccountSourceCustodyV1Equal(
  left: ConnectedAccountSourceCustodyV1,
  right: ConnectedAccountSourceCustodyV1,
): boolean {
  if (left.kind === 'host' || right.kind === 'host') return left.kind === right.kind;
  return pluginSourceCustodyV1Equal(left, right);
}

export const QualifiedConnectedAccountIdSchema = defineProtocolString({
  minLength: 1,
  maxLength: 256,
  pattern: '^(?!\\s)[\\s\\S]*\\S$(?![\\s\\S])',
});

/**
 * The annotation states the identity shape structurally rather than naming
 * `PluginContributionIdentityV1`. A public feature-protocol package composes
 * this schema through the SDK and emits its own declarations; a named
 * Protocol alias here would surface as `import("@happier-dev/protocol")` in
 * that package's `.d.ts`, which external authors never install. The shape is
 * still compiler-bound to `ConnectedAccountServiceIdentityV1Schema` below.
 */
export const QualifiedConnectedAccountRefSchema: ProtocolComposableSchema<{
  service: { pluginId: string; localId: string };
  accountId: string;
}> = defineProtocolObject({
  service: ConnectedAccountServiceIdentityV1Schema,
  accountId: QualifiedConnectedAccountIdSchema,
}, { policy: 'closed' });

/** Canonical portable JSON Schema projection of the qualified account ref. */
export const QualifiedConnectedAccountRefJsonSchema = /* @__PURE__ */ (() => QualifiedConnectedAccountRefSchema.jsonSchema)();

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
