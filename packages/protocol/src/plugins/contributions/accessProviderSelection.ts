import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { SharedSavedSecretReferenceSelectionV1Schema } from '../../account/settings/savedSecretReferenceV1.js';
import { QualifiedConnectedAccountRefSchema } from '../../connect/qualifiedConnectedAccountPersistence.js';
import { PluginContributionIdentityV1Schema } from '../contributionIdentity.js';
import { asProtocolZod, projectZodProtocolSchema } from '../actions/internalProtocolZodAdapter.js';
import { defineProtocolJsonValue, type ProtocolComposableSchema } from '../actions/protocolComposableSchema.js';

const text = () => z.string().check(z.trim(), z.minLength(1));
export const SharedSavedSecretReferenceSelectionProtocolV1Schema = projectZodProtocolSchema(SharedSavedSecretReferenceSelectionV1Schema);
/** Built-in identities are stable catalog keys, never a second provider registry. */
export const AccessProviderRefV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ kind: z.literal('builtin'), id: text() }),
  asProtocolZod(PluginContributionIdentityV1Schema),
]));
export type AccessProviderRefV1 = z.infer<typeof AccessProviderRefV1Schema>;
export function accessProviderRefsEqualV1(left: AccessProviderRefV1, right: AccessProviderRefV1): boolean {
  if ('kind' in left || 'kind' in right) return 'kind' in left && 'kind' in right && left.id === right.id;
  return left.pluginId === right.pluginId && left.localId === right.localId;
}
export const AccessCredentialPurposeRefV1Schema = lazyZodSchema(() => z.strictObject({
  purpose: text(),
  credentialRef: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('savedSecret'), ...SharedSavedSecretReferenceSelectionV1Schema.shape }),
    z.strictObject({ kind: z.literal('connectedAccount'), account: asProtocolZod(QualifiedConnectedAccountRefSchema) }),
  ]),
}));
export type AccessCredentialPurposeRefV1 = z.infer<typeof AccessCredentialPurposeRefV1Schema>;
export const AccessProviderSelectionV1Schema = lazyZodSchema(() => z.strictObject({
  provider: AccessProviderRefV1Schema, config: asProtocolZod(defineProtocolJsonValue()),
  credentialRefs: z.array(AccessCredentialPurposeRefV1Schema).check(z.refine(
    refs => new Set(refs.map(ref => ref.purpose)).size === refs.length,
    'A credential purpose is selected once.',
  )),
}));
export type AccessProviderSelectionV1 = z.infer<typeof AccessProviderSelectionV1Schema>;
export const AccessProviderRefProtocolV1Schema: ProtocolComposableSchema<AccessProviderRefV1> = projectZodProtocolSchema(AccessProviderRefV1Schema);
export const AccessProviderSelectionProtocolV1Schema: ProtocolComposableSchema<AccessProviderSelectionV1> = projectZodProtocolSchema(AccessProviderSelectionV1Schema);
