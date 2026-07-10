import { z } from 'zod';

import { ProviderCompatibilityCapabilitiesV1Schema, ProviderCompatibilityOverrideV1Schema, ProviderWireProtocolSchema } from '../capabilities/v1.js';
import { ProviderCatalogDeclarationV1Schema } from '../catalog/descriptorV1.js';
import { ProviderApiKeyCredentialRequirementV1Schema } from '../credentials/v1.js';
import { ProviderDetectionDescriptorV1Schema } from '../detection/v1.js';
import { ProviderAgentTargetKeySchema, ProviderLocalIdSchema } from '../ids.js';
import { ProviderOriginRelativePathSchema } from '../originRelativePathSchema.js';
import { ProviderEndpointUrlSyntaxSchema } from '../endpointUrlSchema.js';
import { ProviderHttpsUrlSchema } from '../httpsUrlSchema.js';
import { ProviderPublicHeadersV1Schema } from '../publicHeadersSchema.js';

export const ProviderEndpointTemplateV1Schema = z.object({
  id: ProviderLocalIdSchema,
  protocol: ProviderWireProtocolSchema,
  baseUrl: ProviderEndpointUrlSyntaxSchema.optional(),
  localUrlCandidates: z.array(ProviderEndpointUrlSyntaxSchema).min(1).max(16).optional(),
  publicHeaders: ProviderPublicHeadersV1Schema.optional(),
  capabilities: ProviderCompatibilityCapabilitiesV1Schema,
}).strict().superRefine((value, ctx) => {
  if (Boolean(value.baseUrl) === Boolean(value.localUrlCandidates)) {
    ctx.addIssue({ code: 'custom', message: 'Exactly one of baseUrl or localUrlCandidates is required' });
  }
});
export type ProviderEndpointTemplateV1 = z.infer<typeof ProviderEndpointTemplateV1Schema>;

export const ProviderModelLoadDescriptorV1Schema = z.object({
  endpointTemplateId: ProviderLocalIdSchema,
  path: ProviderOriginRelativePathSchema,
  request: z.literal('json-model-id-v1'),
  confirmation: z.literal('refresh-catalog-load-state'),
  preflightPolicy: z.enum(['advisory', 'required']),
}).strict();
export type ProviderModelLoadDescriptorV1 = z.infer<typeof ProviderModelLoadDescriptorV1Schema>;

export const ProviderContributionV1Schema = z.object({
  v: z.literal(1),
  id: ProviderLocalIdSchema,
  name: z.string().trim().min(1).max(128),
  icon: z.string().trim().min(1).max(512).optional(),
  websiteUrl: ProviderHttpsUrlSchema.optional(),
  kind: z.enum(['frontier', 'aggregator', 'cloud', 'local']),
  endpointTemplates: z.array(ProviderEndpointTemplateV1Schema).min(1).max(4),
  credential: ProviderApiKeyCredentialRequirementV1Schema.optional(),
  catalog: ProviderCatalogDeclarationV1Schema,
  modelLoad: ProviderModelLoadDescriptorV1Schema.optional(),
  discovery: ProviderDetectionDescriptorV1Schema.optional(),
  compatibilityOverrides: z.record(ProviderAgentTargetKeySchema, ProviderCompatibilityOverrideV1Schema).optional(),
}).strict().superRefine((value, ctx) => {
  const endpointIds = new Set<string>();
  const protocols = new Set<string>();
  value.endpointTemplates.forEach((endpoint, index) => {
    if (endpointIds.has(endpoint.id)) ctx.addIssue({ code: 'custom', path: ['endpointTemplates', index, 'id'], message: 'Duplicate endpoint id' });
    if (protocols.has(endpoint.protocol)) ctx.addIssue({ code: 'custom', path: ['endpointTemplates', index, 'protocol'], message: 'Only one endpoint per protocol is allowed' });
    endpointIds.add(endpoint.id);
    protocols.add(endpoint.protocol);
    if (value.kind !== 'local' && endpoint.localUrlCandidates) {
      ctx.addIssue({ code: 'custom', path: ['endpointTemplates', index, 'localUrlCandidates'], message: 'Local URL candidates are local-contribution only' });
    }
    if (endpoint.localUrlCandidates
      && new Set(endpoint.localUrlCandidates).size !== endpoint.localUrlCandidates.length) {
      ctx.addIssue({ code: 'custom', path: ['endpointTemplates', index, 'localUrlCandidates'], message: 'Local URL candidates must be unique after normalization' });
    }
  });
  value.credential?.transports.forEach((transport, index) => {
    transport.protocols.forEach((protocol) => {
      if (!protocols.has(protocol)) ctx.addIssue({ code: 'custom', path: ['credential', 'transports', index, 'protocols'], message: 'Credential transport protocol is undeclared' });
    });
  });
  if ('probes' in value.catalog) {
    value.catalog.probes.forEach((probe, index) => {
      if (!endpointIds.has(probe.endpointTemplateId)) ctx.addIssue({ code: 'custom', path: ['catalog', 'probes', index, 'endpointTemplateId'], message: 'Catalog probe endpoint is not declared' });
    });
  }
  if (value.modelLoad) {
    if (value.kind !== 'local') ctx.addIssue({ code: 'custom', path: ['modelLoad'], message: 'Model loading is local-contribution only' });
    if (!endpointIds.has(value.modelLoad.endpointTemplateId)) ctx.addIssue({ code: 'custom', path: ['modelLoad', 'endpointTemplateId'], message: 'Model load endpoint is not declared' });
    const loadEndpoint = value.endpointTemplates.find((endpoint) => endpoint.id === value.modelLoad?.endpointTemplateId);
    const hasManagementTransport = !value.credential || Boolean(loadEndpoint && value.credential.transports.some((transport) =>
      transport.uses.includes('management') && transport.protocols.includes(loadEndpoint.protocol)));
    if (!hasManagementTransport) ctx.addIssue({ code: 'custom', path: ['modelLoad'], message: 'Authenticated model loading requires a management credential transport' });
    const hasLoadStateParser = 'probes' in value.catalog && value.catalog.probes.some((probe) =>
      probe.endpointTemplateId === value.modelLoad?.endpointTemplateId && probe.parser === 'lmstudio-native-models');
    if (!hasLoadStateParser) ctx.addIssue({ code: 'custom', path: ['modelLoad'], message: 'Model loading requires a catalog parser that reports load state' });
  }
  if (value.discovery) {
    if (value.kind !== 'local') {
      ctx.addIssue({ code: 'custom', path: ['discovery'], message: 'Discovery is local-contribution only' });
    }
    if (!endpointIds.has(value.discovery.availabilityProbe.endpointTemplateId)) {
      ctx.addIssue({ code: 'custom', path: ['discovery', 'availabilityProbe', 'endpointTemplateId'], message: 'Discovery availability endpoint is not declared' });
    }
  }
});
export type ProviderContributionV1 = z.infer<typeof ProviderContributionV1Schema>;
