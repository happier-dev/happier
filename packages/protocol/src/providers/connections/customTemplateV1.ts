import { z } from 'zod';

import { ProviderCompatibilityCapabilitiesV1Schema, ProviderWireProtocolSchema } from '../capabilities/v1.js';
import { ProviderCatalogProbeV1Schema } from '../catalog/descriptorV1.js';
import { ProviderLocalIdSchema } from '../ids.js';
import {
  addProviderCredentialTransportIssues,
  ProviderCredentialTransportV1Schema,
} from '../credentials/v1.js';
import { normalizeProviderCredentialHeaderName } from '../safety/index.js';
import { ProviderEndpointUrlSyntaxSchema } from '../endpointUrlSchema.js';
import { ProviderHttpsUrlSchema } from '../httpsUrlSchema.js';
import { ProviderPublicHeadersV1Schema } from '../publicHeadersSchema.js';

const UnknownCapabilitiesSchema = ProviderCompatibilityCapabilitiesV1Schema.superRefine((value, ctx) => {
  for (const [key, support] of Object.entries(value)) {
    if (support !== 'unknown') ctx.addIssue({ code: 'custom', path: [key], message: 'Custom provider capabilities must remain unknown' });
  }
});

export const CustomProviderEndpointTemplateV1Schema = z.object({
  id: ProviderLocalIdSchema,
  protocol: ProviderWireProtocolSchema,
  baseUrl: ProviderEndpointUrlSyntaxSchema,
  publicHeaders: ProviderPublicHeadersV1Schema.optional(),
  capabilities: UnknownCapabilitiesSchema,
}).strict();
export type CustomProviderEndpointTemplateV1 = z.infer<typeof CustomProviderEndpointTemplateV1Schema>;

export const CustomProviderCredentialTransportV1Schema = ProviderCredentialTransportV1Schema.safeExtend({
  uses: z.array(z.enum(['probe', 'runtime'])).min(1).max(2),
  destination: z.object({
    kind: z.literal('httpHeader'),
    name: z.string().transform((value, ctx) => {
      try { return normalizeProviderCredentialHeaderName(value); } catch (error) {
        ctx.addIssue({ code: 'custom', message: error instanceof Error ? error.message : 'Invalid credential header name' });
        return z.NEVER;
      }
    }),
    format: z.enum(['raw', 'bearer']),
  }).strict(),
}).strict();
export type CustomProviderCredentialTransportV1 = z.infer<typeof CustomProviderCredentialTransportV1Schema>;

export const CustomProviderApiKeyCredentialRequirementV1Schema = z.object({
  kind: z.literal('apiKey'),
  slotId: z.literal('apiKey').default('apiKey'),
  required: z.boolean().default(true),
  keyUrl: ProviderHttpsUrlSchema.optional(),
  transports: z.array(CustomProviderCredentialTransportV1Schema).min(1).max(8),
}).strict().superRefine((value, ctx) => {
  addProviderCredentialTransportIssues(value.transports, ctx);
});

export const CustomProviderCatalogDeclarationV1Schema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('manual'), manualModelPolicy: z.literal('allowed') }).strict(),
  z.object({
    source: z.literal('probe'),
    manualModelPolicy: z.enum(['allowed', 'catalog-only']),
    probes: z.array(ProviderCatalogProbeV1Schema).min(1).max(3),
  }).strict(),
]);

export const CustomProviderTemplateV1Schema = z.object({
  v: z.literal(1),
  name: z.string().trim().min(1).max(128),
  endpointTemplates: z.array(CustomProviderEndpointTemplateV1Schema).min(1).max(4),
  credential: CustomProviderApiKeyCredentialRequirementV1Schema.optional(),
  catalog: CustomProviderCatalogDeclarationV1Schema,
}).strict().superRefine((value, ctx) => {
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
});
export type CustomProviderTemplateV1 = z.infer<typeof CustomProviderTemplateV1Schema>;
