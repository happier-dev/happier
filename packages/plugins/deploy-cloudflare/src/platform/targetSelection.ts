import { deploymentTargetRoleWithNativeSelectorV1 } from '@happier-dev/plugin-sdk';
import { defineProtocolLiteral, defineProtocolObject, defineProtocolString, defineProtocolUnion,
  type ProtocolSchemaOutput } from '@happier-dev/plugin-sdk/protocol';

const closed = { policy: 'closed' } as const;
const identifier = defineProtocolString({ minLength: 1 });
const production = defineProtocolObject({ kind: defineProtocolLiteral('production') }, closed);
const branch = defineProtocolObject({ kind: defineProtocolLiteral('preview'), gitBranch: identifier.optional() }, closed);
const script = defineProtocolObject({ kind: defineProtocolLiteral('script'), scriptName: identifier }, closed);
const preview = defineProtocolObject({ kind: defineProtocolLiteral('preview'), scriptName: identifier, previewName: identifier }, closed);
const workers = defineProtocolUnion([script, preview]);
const pages = defineProtocolUnion([production, branch]);
const both = defineProtocolUnion([script, preview, production, branch]);
export type CloudflareSelection = ProtocolSchemaOutput<typeof both>;
export type WorkerSelection = ProtocolSchemaOutput<typeof workers>;
export type PagesSelection = ProtocolSchemaOutput<typeof pages>;
export type CloudflareRoleInput<T, TSelection extends CloudflareSelection = CloudflareSelection> =
  Omit<T, 'providerEnvironment'> & { providerEnvironment: { kind: 'native'; selection: TSelection } };

const selectorByScope = { workers: workers.jsonSchema, pages: pages.jsonSchema,
  script: script.jsonSchema, preview: preview.jsonSchema, production: production.jsonSchema, both: both.jsonSchema };
export const workersSelectorSchema = selectorByScope.workers;
export const pagesSelectorSchema = selectorByScope.pages;

export function cloudflareRoleSchema(base: Parameters<typeof deploymentTargetRoleWithNativeSelectorV1>[0],
  scope: keyof typeof selectorByScope) {
  return deploymentTargetRoleWithNativeSelectorV1(base, selectorByScope[scope]);
}
