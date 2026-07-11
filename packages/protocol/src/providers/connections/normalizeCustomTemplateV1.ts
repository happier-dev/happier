import { z } from 'zod';

import { ProviderWireProtocolSchema, type ProviderWireProtocol } from '../capabilities/v1.js';
import { ProviderCatalogParserV1Schema } from '../catalog/descriptorV1.js';
import { ProviderOriginRelativePathSchema } from '../originRelativePathSchema.js';
import { CustomProviderTemplateV1Schema, type CustomProviderTemplateV1 } from './customTemplateV1.js';

export const CustomProviderCredentialStyleV1Schema = z.enum([
  'bearer',
  'x-api-key',
  'api-key',
  'custom-header',
  'custom-header-bearer',
]);
export type CustomProviderCredentialStyleV1 = z.infer<typeof CustomProviderCredentialStyleV1Schema>;

export const CustomProviderSimpleFormV1Schema = z.object({
  name: z.string().trim().min(1).max(128),
  protocol: ProviderWireProtocolSchema.extract(['openai-chat', 'openai-responses', 'anthropic']),
  baseUrl: z.string().trim().min(1),
  credentialStyle: CustomProviderCredentialStyleV1Schema.optional(),
  credentialHeader: z.string().trim().min(1).optional(),
  catalog: z.enum(['manual', 'probe']),
  modelsPath: ProviderOriginRelativePathSchema.optional(),
}).strict().superRefine((value, ctx) => {
  if ((value.credentialStyle === 'custom-header' || value.credentialStyle === 'custom-header-bearer') && !value.credentialHeader) {
    ctx.addIssue({ code: 'custom', path: ['credentialHeader'], message: 'A credential header is required for custom-header credentials' });
  }
  if (value.credentialStyle !== 'custom-header' && value.credentialStyle !== 'custom-header-bearer' && value.credentialHeader) {
    ctx.addIssue({ code: 'custom', path: ['credentialHeader'], message: 'credentialHeader is only valid with custom-header credentials' });
  }
  if (value.catalog === 'probe' && !value.modelsPath) {
    ctx.addIssue({ code: 'custom', path: ['modelsPath'], message: 'A models path is required for probe catalogs' });
  }
});
export type CustomProviderSimpleFormV1 = z.infer<typeof CustomProviderSimpleFormV1Schema>;

const CustomProviderAdvancedEndpointFormV1Schema = z.object({
  protocol: ProviderWireProtocolSchema.extract(['openai-chat', 'openai-responses', 'anthropic']),
  baseUrl: z.string().trim().min(1),
  publicHeaders: z.record(z.string(), z.string()).optional(),
  credentialStyle: CustomProviderCredentialStyleV1Schema.optional(),
  credentialHeader: z.string().trim().min(1).optional(),
}).strict().superRefine((value, ctx) => {
  if ((value.credentialStyle === 'custom-header' || value.credentialStyle === 'custom-header-bearer') && !value.credentialHeader) {
    ctx.addIssue({ code: 'custom', path: ['credentialHeader'], message: 'A credential header is required for custom-header credentials' });
  }
  if (value.credentialStyle !== 'custom-header' && value.credentialStyle !== 'custom-header-bearer' && value.credentialHeader) {
    ctx.addIssue({ code: 'custom', path: ['credentialHeader'], message: 'credentialHeader is only valid with custom-header credentials' });
  }
});

export const CustomProviderAdvancedFormV1Schema = z.object({
  name: z.string().trim().min(1).max(128),
  endpoints: z.array(CustomProviderAdvancedEndpointFormV1Schema).min(1).max(3),
  probes: z.array(z.object({
    protocol: ProviderWireProtocolSchema.extract(['openai-chat', 'openai-responses', 'anthropic']),
    path: ProviderOriginRelativePathSchema,
    parser: ProviderCatalogParserV1Schema,
  }).strict()).max(3),
}).strict().superRefine((value, ctx) => {
  const protocols = new Set<ProviderWireProtocol>();
  value.endpoints.forEach((endpoint, index) => {
    if (protocols.has(endpoint.protocol)) {
      ctx.addIssue({ code: 'custom', path: ['endpoints', index, 'protocol'], message: 'Duplicate endpoint protocol' });
    }
    protocols.add(endpoint.protocol);
  });
  const probes = new Set<string>();
  value.probes.forEach((probe, index) => {
    if (!protocols.has(probe.protocol)) {
      ctx.addIssue({ code: 'custom', path: ['probes', index, 'protocol'], message: 'Probe protocol must reference a declared endpoint' });
    }
    const key = `${probe.protocol}\u0000${probe.path}\u0000${probe.parser}`;
    if (probes.has(key)) {
      ctx.addIssue({ code: 'custom', path: ['probes', index], message: 'Duplicate provider probe' });
    }
    probes.add(key);
  });
});
export type CustomProviderAdvancedFormV1 = z.infer<typeof CustomProviderAdvancedFormV1Schema>;

const UNKNOWN_CAPABILITIES = Object.freeze({
  streaming: 'unknown' as const,
  toolRoundTrips: 'unknown' as const,
  statefulResponses: 'unknown' as const,
  reasoningControls: 'unknown' as const,
});

function credentialDestination(style: CustomProviderCredentialStyleV1, header: string | undefined) {
  switch (style) {
    case 'bearer': return { kind: 'httpHeader' as const, name: 'Authorization', format: 'bearer' as const };
    case 'x-api-key': return { kind: 'httpHeader' as const, name: 'x-api-key', format: 'raw' as const };
    case 'api-key': return { kind: 'httpHeader' as const, name: 'api-key', format: 'raw' as const };
    case 'custom-header': return { kind: 'httpHeader' as const, name: header!, format: 'raw' as const };
    case 'custom-header-bearer': return { kind: 'httpHeader' as const, name: header!, format: 'bearer' as const };
  }
}

function catalogParser(protocol: ProviderWireProtocol): 'openai-models' {
  if (protocol !== 'openai-chat' && protocol !== 'openai-responses') {
    throw new TypeError('Anthropic custom providers do not have a standard model-list parser');
  }
  return 'openai-models';
}

/** Canonical owner shared by CLI and UI advanced custom-provider authoring. */
export function normalizeCustomProviderAdvancedTemplateV1(input: CustomProviderAdvancedFormV1): CustomProviderTemplateV1 {
  const form = CustomProviderAdvancedFormV1Schema.parse(input);
  const probedProtocols = new Set(form.probes.map((probe) => probe.protocol));
  return CustomProviderTemplateV1Schema.parse({
    v: 1,
    name: form.name,
    endpointTemplates: form.endpoints.map((endpoint) => ({
      id: endpoint.protocol,
      protocol: endpoint.protocol,
      baseUrl: endpoint.baseUrl,
      ...(endpoint.publicHeaders && Object.keys(endpoint.publicHeaders).length > 0
        ? { publicHeaders: endpoint.publicHeaders }
        : {}),
      capabilities: UNKNOWN_CAPABILITIES,
    })),
    ...(form.endpoints.some((endpoint) => endpoint.credentialStyle) ? {
      credential: {
        kind: 'apiKey',
        slotId: 'apiKey',
        required: true,
        transports: form.endpoints.flatMap((endpoint) => endpoint.credentialStyle ? [{
          id: `${endpoint.protocol}-runtime${probedProtocols.has(endpoint.protocol) ? '-probe' : ''}`,
          protocols: [endpoint.protocol],
          uses: probedProtocols.has(endpoint.protocol) ? ['probe', 'runtime'] as const : ['runtime'] as const,
          destination: credentialDestination(endpoint.credentialStyle, endpoint.credentialHeader),
        }] : []),
      },
    } : {}),
    catalog: form.probes.length === 0
      ? { source: 'manual', manualModelPolicy: 'allowed' }
      : {
          source: 'probe',
          manualModelPolicy: 'allowed',
          probes: form.probes.map((probe) => ({
            endpointTemplateId: probe.protocol,
            path: probe.path,
            parser: probe.parser,
          })),
        },
  });
}

/** Canonical simple preset normalization delegates to the advanced owner. */
export function normalizeCustomProviderTemplateV1(input: CustomProviderSimpleFormV1): CustomProviderTemplateV1 {
  const form = CustomProviderSimpleFormV1Schema.parse(input);
  return normalizeCustomProviderAdvancedTemplateV1({
    name: form.name,
    endpoints: [{
      protocol: form.protocol,
      baseUrl: form.baseUrl,
      ...(form.credentialStyle ? { credentialStyle: form.credentialStyle } : {}),
      ...(form.credentialHeader ? { credentialHeader: form.credentialHeader } : {}),
    }],
    probes: form.catalog === 'manual' ? [] : [{
      protocol: form.protocol,
      path: form.modelsPath!,
      parser: catalogParser(form.protocol),
    }],
  });
}
