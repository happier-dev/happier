import { z } from 'zod';

import type { ProviderWireProtocol } from '../capabilities/v1.js';
import { BundledProviderCatalogParserV1Schema, type BundledProviderCatalogParserV1 } from '../catalog/descriptorV1.js';
import { ProviderOriginRelativePathSchema } from '../originRelativePathSchema.js';
import { CustomProviderTemplateV1Schema, type CustomProviderTemplateV1 } from './customTemplateV1.js';

/**
 * The wire protocols the custom-provider authoring form offers.
 *
 * This is a user-authoring preset vocabulary, not a plugin capability ceiling:
 * a Provider plugin declares any protocol it speaks through
 * `ProviderWireProtocolSchema`, which is open. A custom template is authored by
 * a person against an API-compatible endpoint, so the form offers the protocols
 * a person can actually fill in a base URL and models path for. Widen this list
 * when the authoring UI grows a picker for a protocol contributed by an
 * installed Agent plugin's `acceptsProtocols`.
 */
export const CUSTOM_PROVIDER_AUTHORING_PROTOCOLS_V1 = Object.freeze([
  'openai-chat',
  'openai-responses',
  'anthropic',
] as const);
export const CustomProviderAuthoringProtocolV1Schema = z.enum(
  CUSTOM_PROVIDER_AUTHORING_PROTOCOLS_V1,
);
export type CustomProviderAuthoringProtocolV1 = z.infer<
  typeof CustomProviderAuthoringProtocolV1Schema
>;

/**
 * The credential shapes the custom-provider authoring form offers.
 *
 * This is a user-authoring preset vocabulary, not a plugin capability ceiling:
 * a Provider plugin declares its credential transport directly through
 * `ProviderCredentialDestinationV1Schema`, which already accepts an HTTP header
 * or query parameter of any validated name with a `raw`, `bearer`, or
 * `{secret}`-template format. These five presets cover an HTTP header of any
 * name in `raw` or `bearer` form; the first three are named shorthands for the
 * two `custom-header` entries.
 */
export const CustomProviderCredentialStyleV1Schema = z.enum([
  'bearer',
  'x-api-key',
  'api-key',
  'custom-header',
  'custom-header-bearer',
]);
export type CustomProviderCredentialStyleV1 = z.infer<typeof CustomProviderCredentialStyleV1Schema>;

/**
 * Canonical preset default for "which bundled catalog format does a custom
 * connection on this protocol probe with". It is the single owner of that
 * default: the authoring form may always carry an explicit `catalogParser`, and
 * an explicit choice is never re-derived or overridden here.
 */
export function defaultCustomProviderCatalogParserV1(
  protocol: CustomProviderAuthoringProtocolV1,
): BundledProviderCatalogParserV1 {
  return protocol === 'anthropic' ? 'anthropic-models' : 'openai-models';
}

export const CustomProviderSimpleFormV1Schema = z.object({
  name: z.string().trim().min(1).max(128),
  protocol: CustomProviderAuthoringProtocolV1Schema,
  baseUrl: z.string().trim().min(1),
  credentialStyle: CustomProviderCredentialStyleV1Schema.optional(),
  credentialHeader: z.string().trim().min(1).optional(),
  catalog: z.enum(['manual', 'probe']),
  modelsPath: ProviderOriginRelativePathSchema.optional(),
  // An authored choice always wins; omitting it takes the canonical preset
  // default. The parser is never re-derived from the protocol afterwards.
  catalogParser: BundledProviderCatalogParserV1Schema.optional(),
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
  protocol: CustomProviderAuthoringProtocolV1Schema,
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
    protocol: CustomProviderAuthoringProtocolV1Schema,
    path: ProviderOriginRelativePathSchema,
    // A user-authored custom template has no plugin behind it, so only a
    // catalog format the host bundles can ever serve it. A contributed format
    // is declared by the Provider plugin that also implements it.
    parser: BundledProviderCatalogParserV1Schema,
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
    case 'custom-header':
    case 'custom-header-bearer': {
      // The form schema already requires a header name for both custom styles;
      // fail loudly rather than emitting an undefined destination name if a
      // caller ever reaches this owner without going through that schema.
      if (!header) throw new TypeError('A credential header is required for custom-header credentials');
      return {
        kind: 'httpHeader' as const,
        name: header,
        format: style === 'custom-header-bearer' ? 'bearer' as const : 'raw' as const,
      };
    }
  }
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
      ...(form.protocol === 'anthropic'
        ? { publicHeaders: { 'anthropic-version': '2023-06-01' } }
        : {}),
      ...(form.credentialStyle ? { credentialStyle: form.credentialStyle } : {}),
      ...(form.credentialHeader ? { credentialHeader: form.credentialHeader } : {}),
    }],
    probes: form.catalog === 'manual' ? [] : [{
      protocol: form.protocol,
      path: form.modelsPath!,
      parser: form.catalogParser ?? defaultCustomProviderCatalogParserV1(form.protocol),
    }],
  });
}
