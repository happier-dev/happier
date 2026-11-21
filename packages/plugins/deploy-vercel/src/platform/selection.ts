import { deploymentTargetRoleWithNativeSelectorV1 } from '@happier-dev/plugin-sdk';
import { defineProtocolLiteral, defineProtocolObject, defineProtocolString, defineProtocolUnion,
  type ProtocolSchemaOutput } from '@happier-dev/plugin-sdk/protocol';

const closed = { policy: 'closed' } as const;
const identifier = defineProtocolString({ minLength: 1 });
const selector = defineProtocolUnion([
  defineProtocolObject({ kind: defineProtocolLiteral('production') }, closed),
  defineProtocolObject({ kind: defineProtocolLiteral('preview'), gitBranch: identifier.optional() }, closed),
  defineProtocolObject({ kind: defineProtocolLiteral('custom'), id: identifier }, closed),
]);
export type VercelSelection = ProtocolSchemaOutput<typeof selector>;
export type VercelEnvironment = { kind: 'native'; selection: VercelSelection };
export type VercelRoleInput<T> = Omit<T, 'providerEnvironment'> & { providerEnvironment: VercelEnvironment };
export const vercelSelectorSchema = selector.jsonSchema;

export function vercelRoleSchema(base: Parameters<typeof deploymentTargetRoleWithNativeSelectorV1>[0]) {
  return deploymentTargetRoleWithNativeSelectorV1(base, vercelSelectorSchema);
}
