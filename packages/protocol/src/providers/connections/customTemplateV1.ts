import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';

import { ProviderCompatibilityCapabilitiesV1Schema, ProviderWireProtocolSchema } from '../capabilities/v1.js';
import { ProviderCatalogProbeV1Schema } from '../catalog/descriptorV1.js';
import { ProviderLocalIdSchema } from '../ids.js';
import {
  addProviderCredentialTransportIssues,
  ProviderCredentialTransportV1Schema,
} from '../credentials/v1.js';
import { normalizeProviderCredentialHeaderName } from '../safety/headers.js';
import { ProviderEndpointUrlSyntaxSchema } from '../endpointUrlSchema.js';
import { ProviderHttpsUrlSchema } from '../httpsUrlSchema.js';
import { ProviderPublicHeadersV1Schema } from '../publicHeadersSchema.js';
import { ProviderEndpointPolicyV1Shape } from '../endpointPolicyV1.js';

const UnknownCapabilitiesSchema = lazyZodSchema(() => ProviderCompatibilityCapabilitiesV1Schema.check(z.superRefine((value, ctx) => {
  for (const [key, support] of Object.entries(value)) {
    if (support !== 'unknown') ctx.addIssue({ code: 'custom', path: [key], message: 'Custom provider capabilities must remain unknown' });
  }
})));

export const CustomProviderEndpointTemplateV1Schema = lazyZodSchema(() => z.strictObject({
  id: ProviderLocalIdSchema,
  protocol: ProviderWireProtocolSchema,
  baseUrl: z.optional(ProviderEndpointUrlSyntaxSchema),
  requiresEndpointOverride: ProviderEndpointPolicyV1Shape.requiresEndpointOverride,
  publicHeaders: z.optional(ProviderPublicHeadersV1Schema),
  addressConstraint: ProviderEndpointPolicyV1Shape.addressConstraint,
  modelIdPattern: ProviderEndpointPolicyV1Shape.modelIdPattern,
  requiredPublicHeaders: ProviderEndpointPolicyV1Shape.requiredPublicHeaders,
  publicHeaderHints: ProviderEndpointPolicyV1Shape.publicHeaderHints,
  capabilities: UnknownCapabilitiesSchema,
}).check(z.refine(value => Boolean(value.baseUrl) !== Boolean(value.requiresEndpointOverride), 'Exactly one endpoint location is required')));
export type CustomProviderEndpointTemplateV1 = z.infer<typeof CustomProviderEndpointTemplateV1Schema>;

export const CustomProviderCredentialTransportV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.safeExtend(ProviderCredentialTransportV1Schema, {
  uses: z.array(z.enum(['probe', 'runtime'])).check(z.minLength(1), z.maxLength(2)),
  destination: z.strictObject({
    kind: z.literal('httpHeader'),
    name: z.pipe(z.string(), z.transform((value, ctx) => {
      try { return normalizeProviderCredentialHeaderName(value); } catch (error) {
        ctx.issues.push({ code: 'custom', message: error instanceof Error ? error.message : 'Invalid credential header name', input: ctx.value });
        return z.NEVER;
      }
    })),
    format: z.enum(['raw', 'bearer']),
  }),
})));
export type CustomProviderCredentialTransportV1 = z.infer<typeof CustomProviderCredentialTransportV1Schema>;

export const CustomProviderApiKeyCredentialRequirementV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('apiKey'),
  slotId: z._default(z.literal('apiKey'), 'apiKey'),
  required: z._default(z.boolean(), true),
  keyUrl: z.optional(ProviderHttpsUrlSchema),
  transports: z.array(CustomProviderCredentialTransportV1Schema).check(z.minLength(1), z.maxLength(8)),
}).check(z.superRefine((value, ctx) => {
  addProviderCredentialTransportIssues(value.transports, ctx);
})));

export const CustomProviderCatalogDeclarationV1Schema = lazyZodSchema(() => z.discriminatedUnion('source', [
  z.strictObject({ source: z.literal('manual'), manualModelPolicy: z.literal('allowed') }),
  z.strictObject({
    source: z.literal('probe'),
    manualModelPolicy: z.enum(['allowed', 'catalog-only']),
    probes: z.array(ProviderCatalogProbeV1Schema).check(z.minLength(1), z.maxLength(3)),
  }),
]));

export const CustomProviderTemplateV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  name: z.string().check(z.trim(), z.minLength(1), z.maxLength(128)),
  endpointTemplates: z.array(CustomProviderEndpointTemplateV1Schema).check(z.minLength(1), z.maxLength(4)),
  credential: z.optional(CustomProviderApiKeyCredentialRequirementV1Schema),
  catalog: CustomProviderCatalogDeclarationV1Schema,
}).check(z.superRefine((value, ctx) => {
  const endpointIds = new Set<string>();
  const protocols = new Set<string>();
  value.endpointTemplates.forEach((endpoint, index) => {
    if (endpointIds.has(endpoint.id)) ctx.addIssue({ code: 'custom', path: ['endpointTemplates', index, 'id'], message: 'Duplicate endpoint id' });
    if (protocols.has(endpoint.protocol)) ctx.addIssue({ code: 'custom', path: ['endpointTemplates', index, 'protocol'], message: 'Only one endpoint per protocol is allowed' });
    endpointIds.add(endpoint.id);
    protocols.add(endpoint.protocol);
  });
  value.credential?.transports.forEach((transport, index) => {
    for (const protocol of transport.protocols) {
      if (!protocols.has(protocol)) ctx.addIssue({ code: 'custom', path: ['credential', 'transports', index, 'protocols'], message: 'Credential protocol must reference a declared endpoint protocol' });
    }
  });
  if (value.catalog.source === 'probe') {
    value.catalog.probes.forEach((probe, index) => {
      if (!endpointIds.has(probe.endpointTemplateId)) ctx.addIssue({ code: 'custom', path: ['catalog', 'probes', index, 'endpointTemplateId'], message: 'Catalog probe endpoint is not declared' });
    });
  }
})));
export type CustomProviderTemplateV1 = z.infer<typeof CustomProviderTemplateV1Schema>;
